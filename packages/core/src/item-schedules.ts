import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { readInputs } from './capture.js';
import { assertNotMerged, projectIdSchema, readProjects } from './projects.js';
import { activeResolutions, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection } from './item-resolutions.js';
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
/** 1件の記録は項目の日付の全体（期日と見直す日）を表す。両方nullは日付を外した記録。 */
export const itemScheduleSchema = z.object({
  schema_version: z.literal(1), id: scheduleIdSchema, project_id: projectIdSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, due: scheduleDateSchema.nullable(), review_after: scheduleDateSchema.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemSchedule = z.infer<typeof itemScheduleSchema>;

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
/** 項目ごとに最後の記録だけを有効にする。最後の記録が日付を外したものなら含めない。 */
export function activeSchedules(records: ItemSchedule[], projectId?: string): Map<string, ItemSchedule> {
  const latest = new Map<string, ItemSchedule>();
  for (const r of records) if (!projectId || r.project_id === projectId) latest.set(r.item_key, r);
  for (const [key, r] of latest) if (r.due === null && r.review_after === null) latest.delete(key);
  return latest;
}

/**
 * 今のNOW項目に効く日付と、付け直しが必要な日付。
 * 項目キーの記録を優先する。キーの記録がない項目は、NOWから外れた記録のうち同じ欄・同じ本文のもの（最新）を引き継ぐ。
 * 作業要約が届くたびに次の一手の根拠（入力ID）が変わり、同じ本文でも別の項目になるため。
 * 引き継ぎ先のない記録だけを付け直しの対象として返す。解決済み・完了の項目の記録は返さない。
 */
export function effectiveSchedules(records: ItemSchedule[], projectId: string, items: { key: string; section: string; text: string; resolution: unknown }[], resolvedKeys: { has(key: string): boolean }): { byKey: Map<string, ItemSchedule>; orphaned: ItemSchedule[] } {
  const active = activeSchedules(records, projectId), keys = new Set(items.map(i => i.key)), byKey = new Map<string, ItemSchedule>();
  // 項目自身のキーで記録があれば（日付を外した記録を含む）、それが本人の最新の判断なので引き継ぎより優先する。
  const own = new Set(records.filter(r => r.project_id === projectId).map(r => r.item_key));
  const loose = [...active.values()].filter(r => !keys.has(r.item_key) && !resolvedKeys.has(r.item_key));
  const same = (r: ItemSchedule, i: { section: string; text: string }) => r.section === i.section && r.text === i.text;
  for (const item of items) {
    if (item.resolution) continue;
    const direct = active.get(item.key), carried = own.has(item.key) ? undefined : loose.filter(r => same(r, item)).at(-1);
    if (direct ?? carried) byKey.set(item.key, (direct ?? carried)!);
  }
  const orphaned = loose.filter(r => !items.some(i => !i.resolution && same(r, i)));
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
/** NOW・HOMEで項目の後ろに付ける日付の表示。 */
export function scheduleLabel(schedule: Pick<ItemSchedule, 'due' | 'review_after'>): string {
  return [schedule.due ? `期日 ${schedule.due}` : '', schedule.review_after ? `見直す日 ${schedule.review_after}` : ''].filter(Boolean).join('・');
}

export interface ItemScheduleRequest { projectId: string; itemKey: string; due: string | null; reviewAfter: string | null; source: string; sourceEventId?: string }
export interface ItemScheduleResult { projectId: string; itemKey: string; scheduleId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: projectIdSchema, itemKey: digest, due: scheduleDateSchema.nullable(), reviewAfter: scheduleDateSchema.nullable(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict();

/**
 * 直近に生成したNOW項目の一覧にある項目へ、期日と見直す日を付ける（両方nullで外す）。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemSchedule(config: HubConfig, request: ItemScheduleRequest): Promise<ItemScheduleResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  // NOWの再生成はviews.tsに依存するため、循環を避けて遅延読込する。
  const { rebuildNowLocked, readReceipts } = await import('./views.js');
  return vault.withLock(async () => {
    const projects = await readProjects(config);
    if (!projects.some(p => p.id === r.projectId)) throw new Error('プロジェクトが見つかりません');
    const { records } = await readItemSchedules(vault);
    const rebuild = async () => { await rebuildNowLocked(vault, config, r.projectId, await readInputs(config), await readReceipts(config)); };
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      const previous = (await readItemSchedules(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        // 引き継いだ日付を外した記録は、引き継ぎ元のキーで残る。
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && (r.due !== null || r.reviewAfter !== null)) || previous.due !== r.due || previous.review_after !== r.reviewAfter) throw new Error('同じ受付IDで別の日付が記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, scheduleId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertNotMerged(projects, r.projectId);
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const clearing = r.due === null && r.reviewAfter === null, { byKey, orphaned } = effectiveSchedules(records, r.projectId, list, resolved);
    const item = list.find(i => i.key === r.itemKey), orphan = orphaned.find(o => o.item_key === r.itemKey);
    // NOWから外れて付け直しを促している日付は、外すことだけを受け付ける。
    if (!item && !(clearing && orphan)) throw new Error('NOWに該当する項目がありません。最新のNOWで確認してください');
    const current = item ? byKey.get(r.itemKey) : orphan;
    if (!clearing && resolved.has(r.itemKey)) throw new Error('解決済み・完了の項目には日付を付けられません');
    if (clearing && !current) throw new Error('この項目に外す日付はありません');
    if (current && current.due === r.due && current.review_after === r.reviewAfter) throw new Error('この項目には既に同じ日付が付いています');
    // 引き継いだ日付を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = clearing && current && current.item_key !== r.itemKey ? current : item ?? orphan!;
    const record: ItemSchedule = {
      schema_version: 1, id: `SCH-${ulid()}`, project_id: r.projectId, item_key: 'item_key' in target ? target.item_key : target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      due: r.due, review_after: r.reviewAfter, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(schedulePath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('日付の記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, scheduleId: record.id, deduped: false };
  });
}
