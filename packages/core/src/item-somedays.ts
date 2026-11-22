import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { ItemTargetError, activeResolutions, itemScopeSchema, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection } from './item-resolutions.js';
import { addDays, assertRecordTarget, effectiveItemRecords, itemRecordScope, scheduleDateSchema, todayIn } from './item-schedules.js';
import type { HubConfig } from './types.js';

/**
 * NOWの「次の一手」「未解決」の項目を、本人が「いつかやる」へ移した記録（GTDの「いつかやる／多分やる」）。
 * 今はやらないが捨てたくもない項目を、HOMEの「次の一手」の一覧と件数から外し、「いつかやる」の一覧で定期的に見直す。
 * 期日・連絡待ちと同じく、AIは移さず本人の指定だけを記録する。原文・整理結果・解決報告は変えない。
 * sinceは移した日、reviewedは最後に見直した日（「そのまま」を選んだ日。省くと移した日）。どちらも設定のタイムゾーンでの暦日。
 */
export const itemSomedaySchema = z.object({ since: scheduleDateSchema, reviewed: scheduleDateSchema.optional() }).strict()
  .refine(v => v.reviewed === undefined || v.reviewed >= v.since, '見直した日は移した日より前にできません');
export type ItemSomeday = z.infer<typeof itemSomedaySchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const somedayIdSchema = z.string().regex(/^SMD-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/** 1件の記録は項目の「いつかやる」の全体（移した日と最後に見直した日）。somedayがnullは元の欄へ戻した記録。 */
export const itemSomedayRecordSchema = z.object({
  schema_version: z.literal(1), id: somedayIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, someday: itemSomedaySchema.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemSomedayRecord = z.infer<typeof itemSomedayRecordSchema>;
export const somedayDir = '90_system/item-somedays';
export const somedayPath = (id: string) => `${somedayDir}/${id}.json`;
export const somedayCleared = (r: Pick<ItemSomedayRecord, 'someday'>) => r.someday === null;

/** 項目一覧（now-items）に載せる「いつかやる」。idは効いている記録、reviewedは最後に見直した日（見直していなければ移した日）。 */
export interface NowItemSomeday { id: string; since: string; reviewed: string }

/**
 * 「いつかやる」を受け付けられない理由。同じ内容で送り直しても結果は変わらないため、受付は再試行しない。
 * waiting: 連絡待ちの項目は移せない（先に印を外す） / someday: 「いつかやる」の項目には連絡待ちの印を付けられない（先に戻す） /
 * not-someday: 「いつかやる」にない項目は見直し・戻しができない / missing: アイデア・プロジェクトが見つからない /
 * not-listed: 「いつかやる」に置いていないアイデア / listed: 既に「いつかやる」に置いたアイデア / not-paused: 休止中でないプロジェクト。
 */
export const somedayRefusalCauses = ['waiting', 'someday', 'not-someday', 'missing', 'not-listed', 'listed', 'not-paused'] as const;
export type SomedayReason = { code: 'someday-refused'; cause: typeof somedayRefusalCauses[number] };
export class SomedayError extends Error {
  constructor(readonly reason: SomedayReason) {
    super(somedayMessage(reason));
    this.name = 'SomedayError';
  }
}
export function somedayMessage(reason: SomedayReason): string {
  return {
    waiting: '連絡待ちの項目は「いつかやる」へ移せません。先に連絡待ちの印を外してください。',
    someday: '「いつかやる」の項目には連絡待ちの印を付けられません。先に元の欄へ戻してください。',
    'not-someday': 'この項目は「いつかやる」にありません。同期して表示を確認し直してください。',
    missing: '対象のアイデアかプロジェクトが見つかりません。同期して「いつかやる」の一覧を確認し直してください。',
    'not-listed': 'このアイデアは「いつかやる」に置いていません。同期して一覧を確認し直してください。',
    listed: 'このアイデアは既に「いつかやる」に置いています。',
    'not-paused': 'このプロジェクトは休止中ではありません。同期して一覧を確認し直してください。',
  }[reason.cause];
}

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、HOMEとdoctorで示す。
 * 統合元のプロジェクトで移した項目は、日付と同じく統合先の項目の記録として読み替える（rawを指定すると記録のまま）。
 */
export async function readItemSomedays(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemSomedayRecord[]; problems: string[] }> {
  const records: ItemSomedayRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(somedayDir)) {
    if (!/^90_system\/item-somedays\/SMD-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemSomedayRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== somedayPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}

/**
 * 今のNOW項目に効く「いつかやる」。引き継ぎの規則は期日・連絡待ちと同じ（作業要約が届いて根拠が変わっても、同じ欄・同じ本文なら引き継ぐ）。
 * 引き継ぎ先のない記録は、連絡待ちと同じく付け直しを求めない（項目がNOWから外れたら、置いておく理由も一緒に外れたため）。
 */
export function effectiveSomedays(records: ItemSomedayRecord[], projectId: string, items: Parameters<typeof effectiveItemRecords>[2], resolvedKeys: { has(key: string): boolean }): Map<string, NowItemSomeday> {
  const { byKey } = effectiveItemRecords(records, projectId, items, resolvedKeys, somedayCleared);
  return new Map([...byKey].flatMap(([key, r]) => r.someday ? [[key, { id: r.id, since: r.someday.since, reviewed: r.someday.reviewed ?? r.someday.since }] as const] : []));
}

/** 項目一覧を作り直した後に、「いつかやる」の一覧も作り直す（Writerロック内）。someday.tsはこのファイルを読むため、循環を避けて遅延読込する。 */
async function rebuildSomedayList(config: HubConfig, vault: Vault): Promise<void> {
  const { rebuildSomedayLocked } = await import('./someday.js');
  await rebuildSomedayLocked(config, vault);
}

/** NOWの行末に付ける表示。 */
export const SOMEDAY_LABEL = 'いつかやる';

export interface ItemSomedayRequest { projectId: string; itemKey: string; someday: ItemSomeday | null; source: string; sourceEventId?: string; /** 今日（検証用）。 */ now?: Date }
export interface ItemSomedayResult { projectId: string; itemKey: string; somedayId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, someday: itemSomedaySchema.nullable(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), now: z.date().optional(),
}).strict();
/** 見直した日を省いた記録は、移した日に見直したものとして比べる。 */
const sameSomeday = (a: ItemSomeday | null, b: ItemSomeday | null) => a === null ? b === null : b !== null && a.since === b.since && (a.reviewed ?? a.since) === (b.reviewed ?? b.since);

/**
 * 直近に生成したNOW項目の一覧にある、片付いていない項目を「いつかやる」へ移す（nullで元の欄へ戻す）。
 * 「そのまま」（見直したが今は始めない）は、移した日を変えずに見直した日だけを進めた記録にする。
 * 日付は今日まで（端末とのタイムゾーンの違いを見込み、翌日までは受け付ける）。連絡待ちの項目は移さない（先に印を外す）。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemSomeday(config: HubConfig, request: ItemSomedayRequest): Promise<ItemSomedayResult> {
  const r = requestSchema.parse(request), vault = new Vault(config), limit = addDays(todayIn(config.timezone, r.now), 1);
  if (r.someday && (r.someday.since > limit || (r.someday.reviewed ?? r.someday.since) > limit)) throw new Error('「いつかやる」の日付に先の日付は付けられません');
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      // 引き継いだ記録を戻した記録は、引き継ぎ元のキーで残る。
      const previous = (await readItemSomedays(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && r.someday !== null) || !sameSomeday(previous.someday, r.someday)) throw new Error('同じ受付IDで別の「いつかやる」が記録されています');
        await rebuild();
        await rebuildSomedayList(config, vault);
        return { projectId: r.projectId, itemKey: r.itemKey, somedayId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    assertRecordTarget(unassigned, item);
    // 片付いた項目は移しも戻しもしない（未解決へ戻したときは、片付ける前の状態のまま戻る）。
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    const { records } = await readItemSomedays(vault), current = effectiveItemRecords(records, r.projectId, list, resolved, somedayCleared).byKey.get(r.itemKey);
    const unchanged = sameSomeday(current?.someday ?? null, r.someday);
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の状態と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      const latest = current ?? records.filter(x => x.project_id === r.projectId && x.item_key === r.itemKey).at(-1);
      if (latest) return { projectId: r.projectId, itemKey: r.itemKey, somedayId: latest.id, deduped: true };
    }
    if (r.someday === null && !current) throw new SomedayError({ code: 'someday-refused', cause: 'not-someday' });
    if (unchanged) throw new Error('この項目は既に同じ日付で「いつかやる」にあります');
    // 連絡待ちの項目は、自分では進められないが待つ相手がいる。「いつかやる」とは別の扱いなので、先に印を外してもらう。
    if (r.someday !== null && !current && item.waiting) throw new SomedayError({ code: 'someday-refused', cause: 'waiting' });
    // 見直した記録（移した日を変えない）は、今「いつかやる」にある項目にだけ付ける。
    if (r.someday !== null && current?.someday && r.someday.since !== current.someday.since) throw new Error('移した日は変えられません。見直した日だけを送ってください');
    // 引き継いだ記録を戻すときは、引き継ぎ元の記録を戻す（項目のキーで戻しても引き継ぎ元が残るため）。
    const target = r.someday === null && current && current.item_key !== r.itemKey ? { key: current.item_key, section: current.section, text: current.text, input_id: current.input_id } : item;
    const record: ItemSomedayRecord = {
      schema_version: 1, id: `SMD-${ulid()}`, project_id: r.projectId, item_key: target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      someday: r.someday ? { since: r.someday.since, ...(r.someday.reviewed !== undefined && r.someday.reviewed !== r.someday.since ? { reviewed: r.someday.reviewed } : {}) } : null,
      source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(somedayPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('「いつかやる」の記録が競合しました');
    await rebuild();
    await rebuildSomedayList(config, vault);
    return { projectId: r.projectId, itemKey: r.itemKey, somedayId: record.id, deduped: false };
  });
}
