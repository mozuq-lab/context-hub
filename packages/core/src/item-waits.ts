import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { ItemTargetError, activeResolutions, itemScopeSchema, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection } from './item-resolutions.js';
import { addDays, assertRecordTarget, effectiveItemRecords, itemRecordScope, scheduleDateSchema, todayIn } from './item-schedules.js';
import { SomedayError } from './item-somedays.js';
import type { HubConfig } from './types.js';

/**
 * NOWの「次の一手」「未解決」の項目に本人が付けた「連絡待ち」の印（人に頼んだこと・返事を待っていること）。
 * 期日・手間の目安と同じく、AIは付けず本人の指定だけを記録する。原文・整理結果・解決報告は変えない。
 * whoは待っている相手（任意の短い文字列）、sinceは頼んだ日（設定のタイムゾーンでの暦日）。
 * 相手の名前は本人のためのもので、NOW.md（別AI向けのcontext・bundleの元）と整理用のモデルへ渡す資料には載せない。
 * 項目一覧（now-items）・HOME・ふりかえりとアプリにだけ示す。
 */
export const WAIT_WHO_CHARS = 40;
/** 相手。1行で、制御文字を含めず、前後に空白を付けない。 */
export const waitWhoSchema = z.string().min(1, '相手が空です').max(WAIT_WHO_CHARS, `相手は${WAIT_WHO_CHARS}文字以内にしてください`)
  .regex(/^[^\p{Cc}\u2028\u2029]+$/u, '相手は1行で書いてください').refine(v => v.trim() === v, '相手の前後に空白は付けられません');
export const itemWaitingSchema = z.object({ who: waitWhoSchema.optional(), since: scheduleDateSchema }).strict();
export type ItemWaiting = z.infer<typeof itemWaitingSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const waitIdSchema = z.string().regex(/^WAIT-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/** 1件の記録は項目の連絡待ちの全体（相手と頼んだ日）。waitingがnullは印を外した記録。 */
export const itemWaitRecordSchema = z.object({
  schema_version: z.literal(1), id: waitIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, waiting: itemWaitingSchema.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemWaitRecord = z.infer<typeof itemWaitRecordSchema>;
export const waitDir = '90_system/item-waits';
export const waitPath = (id: string) => `${waitDir}/${id}.json`;
export const waitCleared = (r: Pick<ItemWaitRecord, 'waiting'>) => r.waiting === null;

/** 項目一覧（now-items）に載せる連絡待ち。idは効いている記録。 */
export interface NowItemWaiting { id: string; since: string; who?: string }

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、doctorで示す。
 * 統合元のプロジェクトで付けた印は、日付と同じく統合先の項目の記録として読み替える（rawを指定すると記録のまま）。
 */
export async function readItemWaits(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemWaitRecord[]; problems: string[] }> {
  const records: ItemWaitRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(waitDir)) {
    if (!/^90_system\/item-waits\/WAIT-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemWaitRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== waitPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}

/**
 * 今のNOW項目に効く連絡待ち。引き継ぎの規則は期日と同じ（作業要約が届いて根拠が変わっても、同じ欄・同じ本文なら引き継ぐ）。
 * 引き継ぎ先のない印は、手間の目安と同じく付け直しを求めず、そのまま使わない（項目がNOWから外れたら、待つ理由も一緒に外れたため）。
 */
export function effectiveWaits(records: ItemWaitRecord[], projectId: string, items: Parameters<typeof effectiveItemRecords>[2], resolvedKeys: { has(key: string): boolean }): Map<string, NowItemWaiting> {
  const { byKey } = effectiveItemRecords(records, projectId, items, resolvedKeys, waitCleared);
  return new Map([...byKey].flatMap(([key, r]) => r.waiting ? [[key, { id: r.id, since: r.waiting.since, ...(r.waiting.who !== undefined ? { who: r.waiting.who } : {}) }] as const] : []));
}

/** NOWの行末に付ける表示。相手の名前は載せない（NOWは別AI向けの資料の元になるため）。 */
export const waitingLabel = (waiting: Pick<NowItemWaiting, 'since'>): string => `連絡待ち ${waiting.since}から`;
/** 頼んだ日から今日までの日数（今日頼んだなら0）。 */
export function waitingDays(since: string, today: string): number {
  const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.max(0, Math.round((at(today) - at(since)) / 86_400_000));
}
/** ふりかえりで「長く待っている」とする日数。 */
export const WAITING_LONG_DAYS = 14;

export interface ItemWaitRequest { projectId: string; itemKey: string; waiting: ItemWaiting | null; source: string; sourceEventId?: string; /** 今日（検証用）。 */ now?: Date }
export interface ItemWaitResult { projectId: string; itemKey: string; waitId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, waiting: itemWaitingSchema.nullable(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), now: z.date().optional(),
}).strict();
const sameWaiting = (a: ItemWaiting | null, b: ItemWaiting | null) => a === null ? b === null : b !== null && a.since === b.since && a.who === b.who;

/**
 * 直近に生成したNOW項目の一覧にある、片付いていない項目に連絡待ちの印を付ける（nullで外す）。
 * 頼んだ日は今日まで（端末とのタイムゾーンの違いを見込み、翌日までは受け付ける）。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemWait(config: HubConfig, request: ItemWaitRequest): Promise<ItemWaitResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  if (r.waiting && r.waiting.since > addDays(todayIn(config.timezone, r.now), 1)) throw new Error('頼んだ日に先の日付は付けられません');
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      // 引き継いだ印を外した記録は、引き継ぎ元のキーで残る。
      const previous = (await readItemWaits(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && r.waiting !== null) || !sameWaiting(previous.waiting, r.waiting)) throw new Error('同じ受付IDで別の連絡待ちが記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, waitId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    assertRecordTarget(unassigned, item);
    // 片付いた項目の印は付けも外しもしない（戻したときは、片付ける前の印のまま戻る）。
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    const { records } = await readItemWaits(vault), current = effectiveItemRecords(records, r.projectId, list, resolved, waitCleared).byKey.get(r.itemKey);
    const unchanged = sameWaiting(current?.waiting ?? null, r.waiting);
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の印と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      // 再試行し続けないよう、今の印の記録（外した依頼なら、この項目の最後の記録）を返す。
      const latest = current ?? records.filter(x => x.project_id === r.projectId && x.item_key === r.itemKey).at(-1);
      if (latest) return { projectId: r.projectId, itemKey: r.itemKey, waitId: latest.id, deduped: true };
    }
    if (r.waiting === null && !current) throw new Error('この項目は連絡待ちではありません');
    // 「いつかやる」へ移した項目は、今は取り組まない項目。待つ相手がいるなら、先に元の欄へ戻してもらう。
    if (r.waiting !== null && !current && item.someday) throw new SomedayError({ code: 'someday-refused', cause: 'someday' });
    if (unchanged) throw new Error('この項目には既に同じ連絡待ちが付いています');
    // 引き継いだ印を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = r.waiting === null && current && current.item_key !== r.itemKey ? { key: current.item_key, section: current.section, text: current.text, input_id: current.input_id } : item;
    const record: ItemWaitRecord = {
      schema_version: 1, id: `WAIT-${ulid()}`, project_id: r.projectId, item_key: target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      waiting: r.waiting ? { ...(r.waiting.who !== undefined ? { who: r.waiting.who } : {}), since: r.waiting.since } : null,
      source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(waitPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('連絡待ちの記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, waitId: record.id, deduped: false };
  });
}
