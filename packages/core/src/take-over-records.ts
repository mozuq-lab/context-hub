import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { readProjects } from './projects.js';
import { UNASSIGNED_SCOPE, activeResolutions, itemKey, readItemResolutions, readNowItems, type NowItem } from './item-resolutions.js';
import { effectiveItemRecords, effectiveSchedules, readItemSchedules, takeOverEvent, type ItemSchedule } from './item-schedules.js';
import { readItemEfforts, type ItemEffortRecord } from './item-efforts.js';
import { readItemWaits, waitCleared, waitPath, type ItemWaitRecord } from './item-waits.js';
import { readItemSomedays, somedayCleared, somedayPath, type ItemSomedayRecord } from './item-somedays.js';
import type { HubConfig } from './types.js';

/** 引き取った行動。scopeは行動の置き場のプロジェクト（省略はプロジェクト未定）、textは保存した行動の本文。 */
export interface TakenOverAction { inputId: string; scope?: string; text: string; fromKey: string; source: string }

/**
 * AIの行を「自分の行動にする」で引き取ったとき、元の行に効いていた期日・見直す日・繰り返しと手間の目安、連絡待ちの印、「いつかやる」を、行動の記録として写す（Writerロック内）。
 * 元の行と行動は置き場もキーも違うことがあり（別のプロジェクト・プロジェクト未定）、元の行の日付は作業要約が届くたびに別のキーの記録から引き継がれているため、
 * 読むたびに元の行をたどるのではなく、引き取った時点で効いている記録を行動の記録にする。
 * 写した記録の受付IDは元の記録のIDを含み（takeOverEvent）、元の記録は引き取られた記録として、元の置き場では外した記録と同じに扱う（同じ本文の行が後から出直しても日付を二重に付けない）。
 * 同じ行動の再送では、写した記録があれば何もしない。元の行が一覧から外れた後の再送も何もしない。
 */
export async function carryTakenOverRecordsLocked(config: HubConfig, vault: Vault, action: TakenOverAction): Promise<void> {
  const source = await findSourceRow(config, vault, action.fromKey);
  if (!source || source.item.resolution) return;
  const scope = action.scope ?? UNASSIGNED_SCOPE, key = itemKey(scope, 'next', action.inputId, action.text), now = new Date().toISOString();
  const resolved = activeResolutions(await readItemResolutions(vault), source.scope), base = { schema_version: 1 as const, project_id: scope, item_key: key, section: 'next' as const, text: action.text, input_id: action.inputId, source: action.source, created_at: now };
  const schedules = await readItemSchedules(vault), schedule = effectiveSchedules(schedules.records, source.scope, source.items, resolved).byKey.get(action.fromKey);
  if (schedule && !schedules.records.some(r => r.source_event_id === takeOverEvent(action.inputId, schedule.id))) {
    const record: ItemSchedule = { ...base, id: `SCH-${ulid()}`, due: schedule.due, review_after: schedule.review_after, ...(schedule.repeat ? { repeat: schedule.repeat } : {}), source_event_id: takeOverEvent(action.inputId, schedule.id) };
    if (!await vault.create(`90_system/item-schedules/${record.id}.json`, JSON.stringify(sorted(record, scheduleOrder), null, 2) + '\n')) throw new Error('日付の記録が競合しました');
  }
  const efforts = await readItemEfforts(vault), effort = effectiveItemRecords(efforts.records, source.scope, source.items, resolved, r => r.effort === null).byKey.get(action.fromKey);
  if (effort && !efforts.records.some(r => r.source_event_id === takeOverEvent(action.inputId, effort.id))) {
    const record: ItemEffortRecord = { ...base, id: `EFF-${ulid()}`, effort: effort.effort, source_event_id: takeOverEvent(action.inputId, effort.id) };
    if (!await vault.create(`90_system/item-efforts/${record.id}.json`, JSON.stringify(sorted(record, effortOrder), null, 2) + '\n')) throw new Error('手間の目安の記録が競合しました');
  }
  const waits = await readItemWaits(vault), wait = effectiveItemRecords(waits.records, source.scope, source.items, resolved, waitCleared).byKey.get(action.fromKey);
  if (wait && !waits.records.some(r => r.source_event_id === takeOverEvent(action.inputId, wait.id))) {
    const record: ItemWaitRecord = { ...base, id: `WAIT-${ulid()}`, waiting: wait.waiting, source_event_id: takeOverEvent(action.inputId, wait.id) };
    if (!await vault.create(waitPath(record.id), JSON.stringify(sorted(record, waitOrder), null, 2) + '\n')) throw new Error('連絡待ちの記録が競合しました');
  }
  const somedays = await readItemSomedays(vault), someday = effectiveItemRecords(somedays.records, source.scope, source.items, resolved, somedayCleared).byKey.get(action.fromKey);
  if (someday && !somedays.records.some(r => r.source_event_id === takeOverEvent(action.inputId, someday.id))) {
    const record: ItemSomedayRecord = { ...base, id: `SMD-${ulid()}`, someday: someday.someday, source_event_id: takeOverEvent(action.inputId, someday.id) };
    if (!await vault.create(somedayPath(record.id), JSON.stringify(sorted(record, somedayOrder), null, 2) + '\n')) throw new Error('「いつかやる」の記録が競合しました');
  }
}

/** 元の行が載っている置き場と、その項目一覧。キーは置き場ごとに異なるので、見つかるのは1か所だけ。 */
async function findSourceRow(config: HubConfig, vault: Vault, key: string): Promise<{ scope: string; items: NowItem[]; item: NowItem } | undefined> {
  for (const scope of [UNASSIGNED_SCOPE, ...(await readProjects(config)).map(p => p.id)]) {
    let items: NowItem[];
    try { items = (await readNowItems(vault, scope))?.items ?? []; } catch { continue; }
    const item = items.find(i => i.key === key);
    if (item) return { scope, items, item };
  }
  return undefined;
}

/** 本人が付けた記録と同じ欄の順で書く。 */
const scheduleOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'due', 'review_after', 'repeat', 'source', 'source_event_id', 'created_at'];
const somedayOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'someday', 'source', 'source_event_id', 'created_at'];
const waitOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'waiting', 'source', 'source_event_id', 'created_at'];
const effortOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'effort', 'source', 'source_event_id', 'created_at'];
function sorted<T extends object>(record: T, order: string[]): T {
  return Object.fromEntries(order.flatMap(k => k in record ? [[k, (record as Record<string, unknown>)[k]]] : [])) as T;
}
