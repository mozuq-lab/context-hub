import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { readInputs } from './capture.js';
import { assertNotMerged, readProjects } from './projects.js';
import { ItemTargetError, UNASSIGNED_SCOPE, activeResolutions, itemScopeSchema, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection, type NowItem } from './item-resolutions.js';
import type { HubConfig } from './types.js';

/**
 * NOWの「次の一手」「未解決」の項目に本人が付けた期日と「次に見直す日」。原文・整理結果・解決報告は変えない。
 * 日付はAIが推測せず、本人の指定だけを記録する。日付は設定のタイムゾーンでの暦日として扱う。
 */
const DAY = 86_400_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 2000〜2099年の実在する暦日（YYYY-MM-DD）。 */
export const scheduleDateSchema = z.string().refine(value => {
  const m = datePattern.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (year < 2000 || year > 2099) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}, '日付はYYYY-MM-DDの実在する日で指定してください（2000〜2099年）');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const scheduleIdSchema = z.string().regex(/^SCH-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/**
 * 定例の繰り返し。unitとeveryで間隔を決める（例: week・1は毎週、day・14は14日ごと）。期日のある項目にだけ付けられる。
 * dayは毎月の繰り返しで、本人が付けた期日の日（1〜31）。31日のように短い月にない日は月末に丸め、次の月では元の日へ戻す。
 */
export const repeatUnits = ['day', 'week', 'month'] as const;
export type RepeatUnit = typeof repeatUnits[number];
export const REPEAT_EVERY_MAX = 12;
export const repeatRuleSchema = z.object({ unit: z.enum(repeatUnits), every: z.number().int().min(1).max(REPEAT_EVERY_MAX) }).strict();
export type RepeatRule = z.infer<typeof repeatRuleSchema>;
export const scheduleRepeatSchema = z.object({ unit: z.enum(repeatUnits), every: z.number().int().min(1).max(REPEAT_EVERY_MAX), day: z.number().int().min(1).max(31).optional() }).strict()
  .refine(r => r.unit === 'month' ? r.day !== undefined : r.day === undefined, '日は毎月の繰り返しにだけ付けます');
export type ScheduleRepeat = z.infer<typeof scheduleRepeatSchema>;
/**
 * 1件の記録は項目の日付の全体（期日と見直す日、繰り返し）を表す。期日と見直す日が両方nullは日付を外した記録。
 * project_idは項目の置き場。プロジェクトIDか、プロジェクト未定（_unassigned）の本人が追加した行動。
 */
export const itemScheduleSchema = z.object({
  schema_version: z.literal(1), id: scheduleIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, due: scheduleDateSchema.nullable(), review_after: scheduleDateSchema.nullable(),
  // 繰り返しのない記録（旧版を含む）にはない。
  repeat: scheduleRepeatSchema.nullable().optional(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict().refine(r => !r.repeat || r.due !== null, '繰り返しには期日が必要です');
export type ItemSchedule = z.infer<typeof itemScheduleSchema>;
/** 記録の繰り返し（なければnull）。 */
export const repeatOf = (schedule: Pick<ItemSchedule, 'repeat'>): ScheduleRepeat | null => schedule.repeat ?? null;
const sameRule = (a: RepeatRule | null, b: RepeatRule | null) => (a === null && b === null) || (a !== null && b !== null && a.unit === b.unit && a.every === b.every);
const sameRepeat = (a: ScheduleRepeat | null, b: ScheduleRepeat | null) => (a === null && b === null) || (a !== null && b !== null && a.unit === b.unit && a.every === b.every && a.day === b.day);

const scheduleDir = '90_system/item-schedules';
const schedulePath = (id: string) => `${scheduleDir}/${id}.json`;

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、HOMEとdoctorで示す。
 * 統合元のプロジェクトで付けた日付は、完了報告と同じく統合先の項目の記録として読み替える（rawを指定すると記録のまま）。
 */
export async function readItemSchedules(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemSchedule[]; problems: string[] }> {
  const records: ItemSchedule[] = [], problems: string[] = [];
  for (const path of await vault.files(scheduleDir)) {
    if (!/^90_system\/item-schedules\/SCH-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemScheduleSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== schedulePath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}
/** 項目に結び付けた本人の記録（日付・手間の目安・連絡待ちなど）に共通する欄。idは種類ごとの接頭辞とULIDで、同じ種類では作った順に並ぶ。 */
export interface ItemRecordLike { id: string; project_id: string; item_key: string; section: string; text: string; input_id: string; source_event_id?: string }
/** 「自分の行動にする」で元の行の記録を行動へ写した記録の受付ID（行動の入力IDと、写した元の記録のID）。take-over-records.tsが書く。 */
export const takeOverEvent = (inputId: string, recordId: string) => `take-over:${inputId}:${recordId}`;
const takeOverPattern = /^take-over:IN-[0-9A-HJKMNP-TV-Z]{26}:((?:SCH|EFF|WAIT)-[0-9A-HJKMNP-TV-Z]{26})$/;
/** 行動へ写された（引き取られた）元の記録のID。元の置き場では、外した記録と同じに扱う。 */
export function takenOverRecordIds(records: Pick<ItemRecordLike, 'source_event_id'>[]): Set<string> {
  const ids = new Set<string>();
  for (const r of records) { const m = r.source_event_id ? takeOverPattern.exec(r.source_event_id) : null; if (m) ids.add(m[1]!); }
  return ids;
}
/** 同じ種類の記録の作った順。接頭辞を除いたULIDで比べる。 */
const recordOrder = (r: Pick<ItemRecordLike, 'id'>) => r.id.slice(r.id.indexOf('-') + 1);
/** 日付の記録が、日付を外した記録か。 */
const scheduleCleared = (r: Pick<ItemSchedule, 'due' | 'review_after'>) => r.due === null && r.review_after === null;
/** 項目ごとに最後の記録だけを有効にする。最後の記録が外した記録（clearedが真）なら含めない。 */
export function activeItemRecords<T extends ItemRecordLike>(records: T[], cleared: (r: T) => boolean, projectId?: string): Map<string, T> {
  const latest = new Map<string, T>();
  for (const r of records) if (!projectId || r.project_id === projectId) latest.set(r.item_key, r);
  for (const [key, r] of latest) if (cleared(r)) latest.delete(key);
  return latest;
}
/** 項目ごとに最後の記録だけを有効にする。最後の記録が日付を外したものなら含めない。 */
export function activeSchedules(records: ItemSchedule[], projectId?: string): Map<string, ItemSchedule> {
  return activeItemRecords(records, scheduleCleared, projectId);
}

/**
 * 今のNOW項目に効く日付と、付け直しが必要な日付。
 * 項目キーの記録を優先する。キーの記録がない項目は、NOWから外れた記録のうち同じ欄・同じ本文のもの（最新）を引き継ぐ。
 * 作業要約が届くたびに次の一手の根拠（入力ID）が変わり、同じ本文でも別の項目になるため。
 * 引き継ぎ先のない記録だけを付け直しの対象として返す。解決済み・完了の項目の記録は返さない。
 */
type EffectiveItem = { key: string; section: string; text: string; resolution: unknown; input_id?: string; action?: { from?: { input_id: string; text: string; key?: string } } };
export function effectiveSchedules(records: ItemSchedule[], projectId: string, items: EffectiveItem[], resolvedKeys: { has(key: string): boolean }): { byKey: Map<string, ItemSchedule>; orphaned: ItemSchedule[] } {
  return effectiveItemRecords(records, projectId, items, resolvedKeys, scheduleCleared);
}
/**
 * effectiveSchedulesと同じ引き継ぎの規則を、項目に結び付けたほかの本人の記録（手間の目安など）にも使う。clearedは「外した記録」の判定。
 */
export function effectiveItemRecords<T extends ItemRecordLike>(records: T[], projectId: string, items: EffectiveItem[], resolvedKeys: { has(key: string): boolean }, clearedRecord: (r: T) => boolean): { byKey: Map<string, T>; orphaned: T[] } {
  // 行動へ写された元の記録は、元の行が引き取られたので、外した記録と同じに扱う（同じ本文の行が出直しても引き継がず、付け直しも求めない）。
  const taken = takenOverRecordIds(records), cleared = (r: T) => clearedRecord(r) || taken.has(r.id);
  const active = activeItemRecords(records, cleared, projectId), keys = new Set(items.map(i => i.key)), byKey = new Map<string, T>();
  // 項目自身のキーで記録があれば（日付を外した記録を含む）、それが本人の最新の判断なので引き継ぎより優先する。
  const own = new Set(records.filter(r => r.project_id === projectId).map(r => r.item_key));
  const loose = [...active.values()].filter(r => !keys.has(r.item_key) && !resolvedKeys.has(r.item_key));
  // 本人が追加した行動は、文面を直しても同じ行動（同じ入力）なので、直す前の文面に付けた日付を引き継ぐ。
  // AIの行を引き取った行動は、引き取った元の行（キー・本文）に付けた日付も同じ行動の日付として扱う。
  type Item = typeof items[number];
  const lineage = (r: T, i: Item) => i.action !== undefined && (r.input_id === i.input_id || (i.action.from !== undefined && (r.item_key === i.action.from.key || r.text === i.action.from.text)));
  const same = (r: T, i: Item) => r.section === i.section && (r.text === i.text || lineage(r, i));
  // 引き継ぎの候補は、NOWから外れた同じ欄・同じ本文の記録のうち、日付を外した記録も含めて最新のもの。
  // 最新が日付を外した記録なら、それより前の古い日付を引き継がない（K1で付けK2で外した後、K3へ移った場合など）。
  const latestPerKey = new Map<string, T>();
  for (const r of records) if (r.project_id === projectId) { latestPerKey.delete(r.item_key); latestPerKey.set(r.item_key, r); }
  const detached = [...latestPerKey.values()].filter(r => !keys.has(r.item_key) && !resolvedKeys.has(r.item_key));
  const isCleared = cleared;
  for (const item of items) {
    if (item.resolution) continue;
    // 行動は、同じ行動の記録（直す前の文面・引き取った元の行を含む）のうち最新のものが効く。文面を前の形へ戻しても、古いキーの古い日付に戻らない。
    if (item.action !== undefined) {
      // 引き取った元の行に効いていた記録は、引き取ったときに行動の記録として写してある（take-over-records.ts。別の置き場の行でも）。
      const mine = [...latestPerKey.values()]
        .filter(r => r.section === item.section && lineage(r, item) && (r.item_key === item.key || (!keys.has(r.item_key) && !resolvedKeys.has(r.item_key))))
        .sort((a, b) => recordOrder(a).localeCompare(recordOrder(b))).at(-1);
      if (mine && !isCleared(mine)) byKey.set(item.key, mine);
      continue;
    }
    const latest = own.has(item.key) ? undefined : detached.filter(r => same(r, item)).at(-1);
    const direct = active.get(item.key), carried = latest && !isCleared(latest) ? latest : undefined;
    if (direct ?? carried) byKey.set(item.key, (direct ?? carried)!);
  }
  // 行動の日付は、文面を直した後の行動を完了・外したときも、その行動のものとして付け直しを求めない（同じ入力の記録）。
  const orphaned = loose.filter(r => !items.some(i => same(r, i) && (!i.resolution || lineage(r, i))));
  return { byKey, orphaned };
}

/** 設定のタイムゾーンでの今日（YYYY-MM-DD）。 */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + days * DAY).toISOString().slice(0, 10);
}
/** 今日を含む7日間（今日〜6日後）を「今週」として扱う。 */
export const SCHEDULE_WEEK_DAYS = 7;
export type ScheduleBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
export const scheduleBucketLabels: Record<Exclude<ScheduleBucket, 'later' | 'none'>, string> = { overdue: '期限切れ', today: '今日', week: '7日以内' };
/**
 * 期日による区分と、見直す日まで隠すかどうか。期日が今週までに来る項目は、見直す日が先でも隠さない。
 */
export function scheduleBucket(schedule: Pick<ItemSchedule, 'due' | 'review_after'> | undefined, today: string): { bucket: ScheduleBucket; hidden: boolean } {
  if (!schedule) return { bucket: 'none', hidden: false };
  const weekEnd = addDays(today, SCHEDULE_WEEK_DAYS - 1), due = schedule.due;
  const bucket: ScheduleBucket = due === null ? 'none' : due < today ? 'overdue' : due === today ? 'today' : due <= weekEnd ? 'week' : 'later';
  const hidden = schedule.review_after !== null && schedule.review_after > today && (bucket === 'none' || bucket === 'later');
  return { bucket, hidden };
}
/** 繰り返しの表示（毎日・毎週・毎月・N日ごと・N週ごと・Nか月ごと）。 */
export function repeatLabel(repeat: Pick<ScheduleRepeat, 'unit' | 'every'>): string {
  if (repeat.every === 1) return { day: '毎日', week: '毎週', month: '毎月' }[repeat.unit];
  return `${repeat.every}${{ day: '日', week: '週', month: 'か月' }[repeat.unit]}ごと`;
}
/** NOW・HOMEで項目の後ろに付ける日付の表示。 */
export function scheduleLabel(schedule: Pick<ItemSchedule, 'due' | 'review_after' | 'repeat'>): string {
  const repeat = repeatOf(schedule);
  return [schedule.due ? `期日 ${schedule.due}${repeat ? `（${repeatLabel(repeat)}）` : ''}` : '', schedule.review_after ? `見直す日 ${schedule.review_after}` : ''].filter(Boolean).join('・');
}
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
/** 期日から繰り返しの間隔を1回分進めた日。毎月は本人が付けた日（day）を短い月では月末に丸める。 */
export function advanceDue(due: string, repeat: ScheduleRepeat): string {
  if (repeat.unit === 'day') return addDays(due, repeat.every);
  if (repeat.unit === 'week') return addDays(due, repeat.every * 7);
  const [y, m] = due.split('-').map(Number), index = y! * 12 + (m! - 1) + repeat.every, year = Math.floor(index / 12), month = index % 12 + 1;
  const day = Math.min(repeat.day ?? Number(due.slice(8)), daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
/**
 * 今回を完了・見送ったときの次の期日。期日から間隔ずつ進め、今日より後になった最初の日にする。
 * 遅れて完了しても過ぎた回をためず、早めに完了したときは次の回（今の期日の次）へ進む。
 */
export function nextOccurrenceDue(due: string, repeat: ScheduleRepeat, today: string): string {
  let next = advanceDue(due, repeat);
  // 2099年までの範囲に収める（毎日でも数万回で止まる）。
  for (let guard = 0; next <= today && guard < 40_000; guard++) next = advanceDue(next, repeat);
  return next;
}
/** 依頼の繰り返し（間隔だけ）から記録の繰り返しを作る。毎月は期日の日を覚えておく。 */
export function scheduleRepeatFor(rule: RepeatRule, due: string): ScheduleRepeat {
  return rule.unit === 'month' ? { unit: 'month', every: rule.every, day: Number(due.slice(8)) } : { unit: rule.unit, every: rule.every };
}

/**
 * 項目に本人の記録（日付・定例の回・手間の目安）を付けるときの、置き場の確かめと一覧の作り直し。Writerロック内で使う。
 * プロジェクト未定（_unassigned）は、プロジェクトの定義を見ず、その一覧（unassigned-actions）だけを作り直す。
 * プロジェクトは、存在を確かめ、そのNOWを作り直す。統合済みかどうかは呼び出し側が、再送の照合の後に確かめる。
 */
export async function itemRecordScope(config: HubConfig, vault: Vault, projectId: string): Promise<{ unassigned: boolean; rebuild: () => Promise<void>; assertOpen: () => void }> {
  if (projectId === UNASSIGNED_SCOPE) {
    const { rebuildUnassignedLocked } = await import('./unassigned-actions.js');
    return { unassigned: true, rebuild: () => rebuildUnassignedLocked(config, vault), assertOpen: () => {} };
  }
  // NOWの再生成はviews.tsに依存するため、循環を避けて遅延読込する。
  const { rebuildNowLocked, readReceipts } = await import('./views.js');
  const projects = await readProjects(config);
  if (!projects.some(p => p.id === projectId)) throw new Error('プロジェクトが見つかりません');
  return { unassigned: false, rebuild: async () => { await rebuildNowLocked(vault, config, projectId, await readInputs(config), await readReceipts(config)); }, assertOpen: () => assertNotMerged(projects, projectId) };
}
/** プロジェクト未定の行のうち、本人の記録を付けられるのは本人が追加した行動だけ（AIの行は、先に行動にしてもらう）。 */
export function assertRecordTarget(unassigned: boolean, item: Pick<NowItem, 'action'>): void {
  if (unassigned && item.action === undefined) throw new Error('プロジェクト未定の行に期日・手間の目安を付けられるのは、本人が追加した行動だけです。先に「自分の行動にする」で行動にしてください');
}

/**
 * repeatは繰り返しの全体。nullで外し、省略すると今の繰り返しを保つ（期日を外すと繰り返しも外れる）。
 * 繰り返しを知らない版のアプリが期日だけを送っても、定例が外れないようにするため。
 */
export interface ItemScheduleRequest { projectId: string; itemKey: string; due: string | null; reviewAfter: string | null; repeat?: RepeatRule | null; source: string; sourceEventId?: string }
export interface ItemScheduleResult { projectId: string; itemKey: string; scheduleId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, due: scheduleDateSchema.nullable(), reviewAfter: scheduleDateSchema.nullable(), repeat: repeatRuleSchema.nullable().optional(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict().refine(r => !r.repeat || r.due !== null, '繰り返しには期日が必要です');

/**
 * 直近に生成したNOW項目の一覧にある項目へ、期日と見直す日を付ける（両方nullで外す）。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemSchedule(config: HubConfig, request: ItemScheduleRequest): Promise<ItemScheduleResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    const { records } = await readItemSchedules(vault);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      const previous = (await readItemSchedules(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        // 引き継いだ日付を外した記録は、引き継ぎ元のキーで残る。繰り返しを省略した依頼は、記録した繰り返しを問わない。
        // 毎月の日（day）は期日を変えなかったときに前の記録から引き継ぐため、照合は間隔だけで行う。
        const recorded = repeatOf(previous), repeatDiffers = r.repeat !== undefined && !sameRule(recorded, r.repeat && r.due ? r.repeat : null);
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && (r.due !== null || r.reviewAfter !== null)) || previous.due !== r.due || previous.review_after !== r.reviewAfter || repeatDiffers) throw new Error('同じ受付IDで別の日付が記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, scheduleId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const clearing = r.due === null && r.reviewAfter === null, { byKey, orphaned } = effectiveSchedules(records, r.projectId, list, resolved);
    const item = list.find(i => i.key === r.itemKey), orphan = orphaned.find(o => o.item_key === r.itemKey);
    // NOWから外れて付け直しを促している日付は、外すことだけを受け付ける。
    if (!item && !(clearing && orphan)) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    if (item) assertRecordTarget(unassigned, item);
    const current = item ? byKey.get(r.itemKey) : orphan;
    if (!clearing && resolved.has(r.itemKey)) throw new Error('解決済み・完了の項目には日付を付けられません');
    if (clearing && !current) throw new Error('この項目に外す日付はありません');
    // 繰り返しは、省略なら今のものを保つ。毎月の繰り返しは期日の日を覚え直す（期日を変えたときに付いていく）。
    // 期日を変えずに同じ間隔を送ったときは、覚えている日を保つ（31日の毎月が月末に丸められた期日のまま、日を30日に覚え直さない）。
    const kept = current ? repeatOf(current) : null, rule = r.repeat === undefined ? kept : r.repeat;
    const repeat = !rule || !r.due ? null : kept && current?.due === r.due && sameRule(kept, rule) ? kept : scheduleRepeatFor(rule, r.due);
    if (current && current.due === r.due && current.review_after === r.reviewAfter && sameRepeat(kept, repeat)) throw new Error('この項目には既に同じ日付が付いています');
    // 引き継いだ日付を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = clearing && current && current.item_key !== r.itemKey ? current : item ?? orphan!;
    const record: ItemSchedule = {
      schema_version: 1, id: `SCH-${ulid()}`, project_id: r.projectId, item_key: 'item_key' in target ? target.item_key : target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      due: r.due, review_after: r.reviewAfter, ...(repeat ? { repeat } : {}), source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(schedulePath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('日付の記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, scheduleId: record.id, deduped: false };
  });
}

/**
 * 定例の1回分の記録。done: 今回を完了 / skip: 今回だけ見送る。どちらも項目は欄に残し、期日を次の回へ進める。
 * dueは片付けた回の期日、next_dueは次の回の期日、schedule_idは次の回の期日を付けた日付の記録、repeatはそのときの繰り返し。
 * 完了・解決の報告（item-resolutions）とは別で、項目を「解決済み・完了」へは移さない。
 */
export const occurrenceActions = ['done', 'skip'] as const;
export type OccurrenceAction = typeof occurrenceActions[number];
export const occurrenceActionSchema = z.enum(occurrenceActions);
export const occurrenceIdSchema = z.string().regex(/^OCC-[0-9A-HJKMNP-TV-Z]{26}$/);
export const itemOccurrenceSchema = z.object({
  schema_version: z.literal(1), id: occurrenceIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, action: occurrenceActionSchema, due: scheduleDateSchema, next_due: scheduleDateSchema, schedule_id: scheduleIdSchema, repeat: scheduleRepeatSchema,
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemOccurrence = z.infer<typeof itemOccurrenceSchema>;
const occurrenceDir = '90_system/item-occurrences';
const occurrencePath = (id: string) => `${occurrenceDir}/${id}.json`;

/** 定例の記録。読めない記録はproblemsに返す（NOW・HOME・経緯の生成を止めない）。統合の読み替えは完了報告と同じ。 */
export async function readItemOccurrences(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemOccurrence[]; problems: string[] }> {
  const records: ItemOccurrence[] = [], problems: string[] = [];
  for (const path of await vault.files(occurrenceDir)) {
    if (!/^90_system\/item-occurrences\/OCC-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemOccurrenceSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== occurrencePath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}

/**
 * 定例の回を片付けられない理由。同じ依頼を何度受け付けても同じ結果になるため、受付は再試行しない。
 * occurrence-changed: 確認した回の期日が今の期日と違う（別の端末で先に片付けた）/ not-repeating: 繰り返しが付いていない。
 */
export type OccurrenceReason = { code: 'occurrence-changed'; due: string | null } | { code: 'not-repeating' } | { code: 'occurrence-out-of-range' };
export class OccurrenceError extends Error {
  constructor(readonly reason: OccurrenceReason, message: string) {
    super(message);
    this.name = 'OccurrenceError';
  }
}
export function occurrenceMessage(reason: OccurrenceReason): string {
  if (reason.code === 'occurrence-out-of-range') return '次の回の期日が記録できる範囲（2099年まで）を超えるため、進めませんでした。繰り返しを外すか、期日を付け直してください。';
  if (reason.code === 'not-repeating') return 'この項目には繰り返しが付いていませんでした。繰り返しが外されたか、日付が変わった可能性があります。再読込して確認してください。';
  return `この回は既に片付いているか、期日が変わっていました${reason.due ? `（今の期日は ${reason.due}）` : ''}。再読込して確認してください。`;
}

export interface OccurrenceRequest { projectId: string; itemKey: string; action: OccurrenceAction; /** 本人が確認した回の期日。今の期日と違えば受け付けない。 */ due: string; source: string; sourceEventId?: string; /** 今日（検証用）。 */ now?: Date }
export interface OccurrenceResult { projectId: string; itemKey: string; action: OccurrenceAction; occurrenceId: string; nextDue: string; deduped: boolean }
const occurrenceRequestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, action: occurrenceActionSchema, due: scheduleDateSchema,
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), now: z.date().optional(),
}).strict();

/**
 * 定例の項目の今回を完了にする、または見送る。記録を残して期日を次の回へ進め、項目は欄に残す。
 * 確認した回の期日（due）が今の期日と同じときだけ受け付ける。2台の端末から同じ回を片付けても、2回分進めない。
 * 回の記録を先に作り、次の回の日付の記録はその中のIDで作る。間で停止した場合は同じ受付IDの再送で続きを作る。
 */
export async function completeOccurrence(config: HubConfig, request: OccurrenceRequest): Promise<OccurrenceResult> {
  const r = occurrenceRequestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    // 次の回の日付の記録がなければ作る（回の記録の直後に停止した場合の続き）。
    const ensureNext = async (occurrence: ItemOccurrence) => {
      if (await vault.read(schedulePath(occurrence.schedule_id)) !== undefined) return;
      const next: ItemSchedule = {
        schema_version: 1, id: occurrence.schedule_id, project_id: occurrence.project_id, item_key: occurrence.item_key, section: occurrence.section, text: occurrence.text, input_id: occurrence.input_id,
        due: occurrence.next_due, review_after: null, repeat: occurrence.repeat, source: occurrence.source, created_at: occurrence.created_at,
      };
      if (!await vault.create(schedulePath(next.id), JSON.stringify(next, null, 2) + '\n')) throw new Error('日付の記録が競合しました');
    };
    if (r.sourceEventId) {
      const previous = (await readItemOccurrences(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.item_key !== r.itemKey || previous.action !== r.action || previous.due !== r.due) throw new Error('同じ受付IDで別の定例の報告が記録されています');
        await ensureNext(previous);
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, action: r.action, occurrenceId: previous.id, nextDue: previous.next_due, deduped: true };
      }
    }
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    assertRecordTarget(unassigned, item);
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    const { records } = await readItemSchedules(vault), current = effectiveSchedules(records, r.projectId, list, resolved).byKey.get(r.itemKey);
    const repeat = current ? repeatOf(current) : null;
    if (!current || !repeat || current.due === null) throw new OccurrenceError({ code: 'not-repeating' }, 'この項目には繰り返しが付いていません');
    if (current.due !== r.due) throw new OccurrenceError({ code: 'occurrence-changed', due: current.due }, `確認した回の期日（${r.due}）が今の期日（${current.due}）と違います`);
    const nextDue = nextOccurrenceDue(current.due, repeat, todayIn(config.timezone, r.now));
    // 期日は2099年までしか記録できない。読めない記録を残さないよう、先に断る。
    if (!scheduleDateSchema.safeParse(nextDue).success) throw new OccurrenceError({ code: 'occurrence-out-of-range' }, '次の回の期日が記録できる範囲（2099年まで）を超えます');
    const occurrence: ItemOccurrence = {
      schema_version: 1, id: `OCC-${ulid()}`, project_id: r.projectId, item_key: item.key, section: item.section, text: item.text, input_id: item.input_id,
      action: r.action, due: current.due, next_due: nextDue, schedule_id: `SCH-${ulid()}`,
      repeat, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(occurrencePath(occurrence.id), JSON.stringify(occurrence, null, 2) + '\n')) throw new Error('定例の記録が競合しました');
    await ensureNext(occurrence);
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, action: r.action, occurrenceId: occurrence.id, nextDue: occurrence.next_due, deduped: false };
  });
}
