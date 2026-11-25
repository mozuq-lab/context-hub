import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { ItemTargetError, UNASSIGNED_SCOPE, activeResolutions, itemScopeSchema, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection, type NowItem } from './item-resolutions.js';
import { addDays, assertRecordTarget, effectiveItemRecords, itemRecordScope, scheduleDateSchema, todayIn } from './item-schedules.js';
import { blockSettled, prerequisiteLists, prerequisiteState } from './item-blocks.js';
import { waitingDays } from './item-waits.js';
import { readProjects } from './projects.js';
import type { HubConfig } from './types.js';

/**
 * 次の一手に本人が付けた「取りかかり中」の印（始めた日と、どこまで進んだかのひとこと）。
 * 数日かけて進めている項目を、まだ手を付けていない項目と分けて示し、途中で止めた項目に戻るときの手がかりにする。
 * 期日・連絡待ちと同じく、AIは付けず本人の指定だけを記録する。原文・整理結果・解決報告は変えない。
 * ひとことは本人のためのもので、NOW.md（別AI向けのcontext・bundleの元）と整理用のモデルへ渡す資料には載せない。
 * NOWには印と始めた日だけを示し、ひとことは項目一覧（now-items）・HOME・ふりかえり・週次レビューとアプリにだけ示す。
 * 付けられるのは「次の一手」の項目だけで、連絡待ち・「いつかやる」・先待ち（先に済ませることが残っている）の項目には付けない（どれも今は手を動かせないため）。
 */
export const PROGRESS_NOTE_CHARS = 80;
/** どこまで進んだかのひとこと。1行で、制御文字を含めず、前後に空白を付けない。 */
export const progressNoteSchema = z.string().min(1, 'ひとことが空です').max(PROGRESS_NOTE_CHARS, `ひとことは${PROGRESS_NOTE_CHARS}文字以内にしてください`)
  .regex(/^[^\p{Cc}\u2028\u2029]+$/u, 'ひとことは1行で書いてください').refine(v => v.trim() === v, 'ひとことの前後に空白は付けられません');
/** 印の全体。sinceは始めた日（設定のタイムゾーンでの暦日）、noteはどこまで進んだか（任意）。 */
export const itemProgressSchema = z.object({ since: scheduleDateSchema, note: progressNoteSchema.optional() }).strict();
export type ItemProgress = z.infer<typeof itemProgressSchema>;

/** HOMEで「取りかかり中が多い」と添える件数（これを超えたら添える。止めはしない）。 */
export const PROGRESS_LIMIT = 3;
/** 印もひとことも更新しないまま、この日数が過ぎた項目を「止まった取りかかり中」として週次レビューとふりかえりに出す。 */
export const PROGRESS_STALE_DAYS = 14;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const progressIdSchema = z.string().regex(/^PROG-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/** 1件の記録は項目の印の全体（始めた日とひとこと）。progressがnullは印を外した記録。 */
export const itemProgressRecordSchema = z.object({
  schema_version: z.literal(1), id: progressIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, progress: itemProgressSchema.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemProgressRecord = z.infer<typeof itemProgressRecordSchema>;
export const progressDir = '90_system/item-progress';
export const progressPath = (id: string) => `${progressDir}/${id}.json`;
export const progressCleared = (r: Pick<ItemProgressRecord, 'progress'>) => r.progress === null;
const sameProgress = (a: ItemProgress | null, b: ItemProgress | null) => a === null ? b === null : b !== null && a.since === b.since && a.note === b.note;

/** 項目一覧（now-items）に載せる取りかかり中の印。idは効いている記録、updatedはその記録を書いた日（設定のタイムゾーンでの暦日）。 */
export interface NowItemProgress { id: string; since: string; updated: string; note?: string }

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、doctorで示す。
 * 統合元のプロジェクトで付けた印は、日付と同じく統合先の項目の記録として読み替える（rawを指定すると記録のまま）。
 */
export async function readItemProgress(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemProgressRecord[]; problems: string[] }> {
  const records: ItemProgressRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(progressDir)) {
    if (!/^90_system\/item-progress\/PROG-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemProgressRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== progressPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}

/**
 * 今のNOW項目に効く取りかかり中の印。引き継ぎの規則は期日と同じ（作業要約が届いて根拠が変わっても、同じ欄・同じ本文なら引き継ぐ）。
 * 引き継ぎ先のない印は、連絡待ちと同じく付け直しを求めず、そのまま使わない。
 */
export function effectiveProgress(records: ItemProgressRecord[], projectId: string, items: Parameters<typeof effectiveItemRecords>[2], resolvedKeys: { has(key: string): boolean }, timezone: string): Map<string, NowItemProgress> {
  const { byKey } = effectiveItemRecords(records, projectId, items, resolvedKeys, progressCleared);
  return new Map([...byKey].flatMap(([key, r]) => r.progress ? [[key, { id: r.id, since: r.progress.since, updated: updatedOn(r, timezone), ...(r.progress.note !== undefined ? { note: r.progress.note } : {}) }] as const] : []));
}
/** 記録を書いた日。始めた日より前にはしない（始めた日を後から前へ直したときも、更新は始めた日以降として数える）。 */
function updatedOn(record: Pick<ItemProgressRecord, 'created_at' | 'progress'>, timezone: string): string {
  const on = todayIn(timezone, new Date(record.created_at)), since = record.progress?.since;
  return since && since > on ? since : on;
}

/** NOWの行末に付ける表示。ひとことは載せない（NOWは別AI向けの資料の元になるため）。 */
export const progressLabel = (progress: Pick<NowItemProgress, 'since'>): string => `取りかかり中 ${progress.since}から`;
/** 印もひとことも、PROGRESS_STALE_DAYS日以上更新していないか。 */
export const progressStale = (progress: Pick<NowItemProgress, 'updated'>, today: string): boolean => waitingDays(progress.updated, today) >= PROGRESS_STALE_DAYS;
/** HOME・ふりかえり・CLIでの表示（始めてからの日数と、ひとこと）。 */
export function progressDetail(progress: Pick<NowItemProgress, 'since' | 'updated' | 'note'>, today: string): string {
  const days = waitingDays(progress.since, today), quiet = waitingDays(progress.updated, today);
  return `${progress.since}から${days}日${quiet >= PROGRESS_STALE_DAYS ? `・${quiet}日更新なし` : ''}${progress.note ? `・どこまで: ${progress.note}` : ''}`;
}

/**
 * 受け付けられない理由。同じ内容の依頼は何度送っても同じ結果になるため、受付は再試行しない。
 * not-next: 「次の一手」でない項目（未解決）には付けない。waiting: 連絡待ちの項目。someday: 「いつかやる」へ移した項目。
 * blocked: 先に済ませることが残っている項目。changed: 本人が見た印（expected）と今の印が違う（別の端末で付け直した）。
 * 古い表示から送った依頼で、新しいひとことを上書きしない。
 */
export const itemProgressRefusalCauses = ['not-next', 'waiting', 'someday', 'blocked', 'changed'] as const;
export type ItemProgressReason = { code: 'progress-refused'; cause: typeof itemProgressRefusalCauses[number] };
export class ItemProgressError extends Error {
  constructor(readonly reason: ItemProgressReason) { super(itemProgressMessage(reason)); this.name = 'ItemProgressError'; }
}
export function itemProgressMessage(reason: ItemProgressReason): string {
  switch (reason.cause) {
    case 'not-next': return '取りかかり中にできるのは「次の一手」の項目だけです。未解決は、次の一手を足してから取りかかってください。';
    case 'waiting': return 'この項目は連絡待ちです。返事が来て印を外してから、取りかかり中にしてください。';
    case 'someday': return 'この項目は「いつかやる」へ移しています。元の欄へ戻してから、取りかかり中にしてください。';
    case 'blocked': return 'この項目には、まだ済んでいない「先に済ませること」があります。先の項目を片付けるか、印を外してから取りかかってください。';
    case 'changed': return 'この項目の取りかかり中の印は、確かめた後に別の端末などで変わっています。同期して今の印を確かめてから、もう一度操作してください。';
  }
}

/** expectedは本人が見た今の印（なければnull）。指定すると、今の印と違うときは断る（省くと確かめない）。 */
export interface ItemProgressRequest { projectId: string; itemKey: string; progress: ItemProgress | null; expected?: ItemProgress | null; source: string; sourceEventId?: string; /** 今日（検証用）。 */ now?: Date }
export interface ItemProgressResult { projectId: string; itemKey: string; progressId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, progress: itemProgressSchema.nullable(), expected: itemProgressSchema.nullable().optional(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), now: z.date().optional(),
}).strict();

/** 先に済ませることが、まだ1つでも残っているか（先待ち）。一覧を読めない先の項目は「見当たらない」として待たない。 */
/** 行動に引き取った・移した先の項目はほかの置き場にあることがあるため、HOMEと同じくすべての置き場の一覧から探す。 */
async function blockedItem(config: HubConfig, vault: Vault, item: NowItem): Promise<boolean> {
  if (!item.after) return false;
  const prerequisites = await prerequisiteLists(vault, [UNASSIGNED_SCOPE, ...(await readProjects(config)).map(p => p.id)]);
  return !blockSettled(item.after.items.map(a => prerequisiteState(a, prerequisites.lists, prerequisites.resolutions, prerequisites.targets)));
}

/**
 * 直近に生成したNOW項目の一覧にある、片付いていない次の一手に「取りかかり中」の印を付ける（nullで外す）。ひとことを書き直すのも、全体を送る。
 * 始めた日は今日まで（端末とのタイムゾーンの違いを見込み、翌日までは受け付ける）。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemProgress(config: HubConfig, request: ItemProgressRequest): Promise<ItemProgressResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  if (r.progress && r.progress.since > addDays(todayIn(config.timezone, r.now), 1)) throw new Error('始めた日に先の日付は付けられません');
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      const previous = (await readItemProgress(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && r.progress !== null) || !sameProgress(previous.progress, r.progress)) throw new Error('同じ受付IDで別の取りかかり中の印が記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, progressId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    assertRecordTarget(unassigned, item);
    if (item.section !== 'next') throw new ItemProgressError({ code: 'progress-refused', cause: 'not-next' });
    // 片付いた項目の印は付けも外しもしない（戻したときは、片付ける前の印のまま戻る）。
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    const { records } = await readItemProgress(vault), current = effectiveItemRecords(records, r.projectId, list, resolved, progressCleared).byKey.get(r.itemKey);
    const unchanged = sameProgress(current?.progress ?? null, r.progress);
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の印と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      const latest = current ?? records.filter(x => x.project_id === r.projectId && x.item_key === r.itemKey).at(-1);
      if (latest) return { projectId: r.projectId, itemKey: r.itemKey, progressId: latest.id, deduped: true };
    }
    if (r.expected !== undefined && !sameProgress(current?.progress ?? null, r.expected)) throw new ItemProgressError({ code: 'progress-refused', cause: 'changed' });
    if (r.progress === null && !current) throw new Error('この項目は取りかかり中ではありません');
    // 今は手を動かせない項目には、新しく付けない（付いている印のひとことの書き直しと、外すのは受け付ける）。
    if (r.progress !== null && !current) {
      if (item.waiting) throw new ItemProgressError({ code: 'progress-refused', cause: 'waiting' });
      if (item.someday) throw new ItemProgressError({ code: 'progress-refused', cause: 'someday' });
      if (await blockedItem(config, vault, item)) throw new ItemProgressError({ code: 'progress-refused', cause: 'blocked' });
    }
    if (unchanged) throw new Error('この項目には既に同じ取りかかり中の印が付いています');
    // 引き継いだ印を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = r.progress === null && current && current.item_key !== r.itemKey ? { key: current.item_key, section: current.section, text: current.text, input_id: current.input_id } : item;
    const record: ItemProgressRecord = {
      schema_version: 1, id: `PROG-${ulid()}`, project_id: r.projectId, item_key: target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      progress: r.progress ? { since: r.progress.since, ...(r.progress.note !== undefined ? { note: r.progress.note } : {}) } : null,
      source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(progressPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('取りかかり中の記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, progressId: record.id, deduped: false };
  });
}

/**
 * 片付いた項目について、片付けた時点で効いていた最後の印。ふりかえりで「始めてから何日で済んだか」を示すのに使う。
 * 印は作業要約が届いてキーが変わっても同じ欄・同じ本文で引き継ぐため、キーか本文で探す。
 * 片付けた記録より後に書いた記録（未解決へ戻した後に付け直したもの）は数えない。
 */
export function progressBeforeResolution(records: ItemProgressRecord[], item: { projectId: string; itemKey: string; section: ItemSection; text: string }, resolvedAt: string): ItemProgress | undefined {
  const at = Date.parse(resolvedAt);
  const latest = records.filter(r => r.project_id === item.projectId && (r.item_key === item.itemKey || (r.section === item.section && r.text === item.text)) && Date.parse(r.created_at) <= at).at(-1);
  return latest?.progress ?? undefined;
}
