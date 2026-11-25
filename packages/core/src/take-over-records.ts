import { ulid } from 'ulid';
import { z } from 'zod';
import { Vault } from './storage.js';
import { readProjects, resolveProject } from './projects.js';
import { readInputs } from './capture.js';
import { actionSource } from './actions.js';
import { ItemTargetError, UNASSIGNED_SCOPE, activeResolutions, itemKey, readItemResolutions, readNowItems, type NowItem } from './item-resolutions.js';
import { effectiveItemRecords, effectiveSchedules, readItemSchedules, takeOverEvent, type ItemSchedule } from './item-schedules.js';
import { itemEffortSchema, readItemEfforts, type ItemEffort, type ItemEffortRecord } from './item-efforts.js';
import { contextCleared, contextPath, contextTagsSchema, readItemContexts, type ItemContextRecord } from './item-contexts.js';
import { readItemWaits, waitCleared, waitPath, type ItemWaitRecord } from './item-waits.js';
import { readItemSomedays, somedayCleared, somedayPath, type ItemSomedayRecord } from './item-somedays.js';
import { readItemSteps, stepsCleared, stepsPath, type ItemStepsRecord } from './item-steps.js';
import { blocksCleared, blocksPath, readItemBlocks, type ItemBlockRecord } from './item-blocks.js';
import { progressCleared, progressPath, readItemProgress, type ItemProgressRecord } from './item-progress.js';
import type { HubConfig } from './types.js';

/** 引き取った行動。scopeは行動の置き場のプロジェクト（省略はプロジェクト未定）、textは保存した行動の本文。 */
export interface TakenOverAction { inputId: string; scope?: string; text: string; fromKey: string; source: string }

/**
 * AIの行を「自分の行動にする」で引き取ったとき、元の行に効いていた期日・見直す日・繰り返しと手間の目安、場所・道具の札、連絡待ちの印、「いつかやる」、手順、取りかかり中の印、
 * 先に済ませること（行動をプロジェクトに置くときだけ）を、行動の記録として写す（Writerロック内）。
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
  const contexts = await readItemContexts(vault), context = effectiveItemRecords(contexts.records, source.scope, source.items, resolved, contextCleared).byKey.get(action.fromKey);
  if (context && !contexts.records.some(r => r.source_event_id === takeOverEvent(action.inputId, context.id))) {
    const record: ItemContextRecord = { ...base, id: `CTX-${ulid()}`, contexts: context.contexts, source_event_id: takeOverEvent(action.inputId, context.id) };
    if (!await vault.create(contextPath(record.id), JSON.stringify(sorted(record, contextOrder), null, 2) + '\n')) throw new Error('札の記録が競合しました');
  }
  const waits = await readItemWaits(vault), wait = effectiveItemRecords(waits.records, source.scope, source.items, resolved, waitCleared).byKey.get(action.fromKey);
  if (wait && !waits.records.some(r => r.source_event_id === takeOverEvent(action.inputId, wait.id))) {
    const record: ItemWaitRecord = { ...base, id: `WAIT-${ulid()}`, waiting: wait.waiting, source_event_id: takeOverEvent(action.inputId, wait.id) };
    if (!await vault.create(waitPath(record.id), JSON.stringify(sorted(record, waitOrder), null, 2) + '\n')) throw new Error('連絡待ちの記録が競合しました');
  }
  const steps = await readItemSteps(vault), step = effectiveItemRecords(steps.records, source.scope, source.items, resolved, stepsCleared).byKey.get(action.fromKey);
  if (step && !steps.records.some(r => r.source_event_id === takeOverEvent(action.inputId, step.id))) {
    const record: ItemStepsRecord = { ...base, id: `STP-${ulid()}`, steps: step.steps, source_event_id: takeOverEvent(action.inputId, step.id) };
    if (!await vault.create(stepsPath(record.id), JSON.stringify(sorted(record, stepsOrder), null, 2) + '\n')) throw new Error('手順の記録が競合しました');
  }
  const progress = await readItemProgress(vault), started = effectiveItemRecords(progress.records, source.scope, source.items, resolved, progressCleared).byKey.get(action.fromKey);
  if (started && !progress.records.some(r => r.source_event_id === takeOverEvent(action.inputId, started.id))) {
    const record: ItemProgressRecord = { ...base, id: `PROG-${ulid()}`, progress: started.progress, source_event_id: takeOverEvent(action.inputId, started.id) };
    if (!await vault.create(progressPath(record.id), JSON.stringify(sorted(record, progressOrder), null, 2) + '\n')) throw new Error('取りかかり中の記録が競合しました');
  }
  // 先に済ませることは、プロジェクトの項目にだけ付けられる（プロジェクト未定へ引き取った行動には写さない）。
  if (scope !== UNASSIGNED_SCOPE) {
    const blocks = await readItemBlocks(vault), block = effectiveItemRecords(blocks.records, source.scope, source.items, resolved, blocksCleared).byKey.get(action.fromKey);
    if (block && !blocks.records.some(r => r.source_event_id === takeOverEvent(action.inputId, block.id))) {
      const record: ItemBlockRecord = { ...base, id: `BLK-${ulid()}`, after: block.after, source_event_id: takeOverEvent(action.inputId, block.id) };
      if (!await vault.create(blocksPath(record.id), JSON.stringify(sorted(record, blocksOrder), null, 2) + '\n')) throw new Error('先に済ませることの記録が競合しました');
    }
  }
  const somedays = await readItemSomedays(vault), someday = effectiveItemRecords(somedays.records, source.scope, source.items, resolved, somedayCleared).byKey.get(action.fromKey);
  if (someday && !somedays.records.some(r => r.source_event_id === takeOverEvent(action.inputId, someday.id))) {
    const record: ItemSomedayRecord = { ...base, id: `SMD-${ulid()}`, someday: someday.someday, source_event_id: takeOverEvent(action.inputId, someday.id) };
    if (!await vault.create(somedayPath(record.id), JSON.stringify(sorted(record, somedayOrder), null, 2) + '\n')) throw new Error('「いつかやる」の記録が競合しました');
  }
}

/** 行動の追加に添えて付ける手間の目安と場所・道具の札（どちらも任意）。 */
export const actionTagsSchema = z.object({ effort: itemEffortSchema.optional(), contexts: contextTagsSchema.optional() }).strict();
/** 行動の追加に添えた手間の目安・札の記録の受付ID（行動の入力ID）。 */
const actionTagEvent = (inputId: string) => `action-add:${inputId}`;
/**
 * 行動の追加に添えて本人が選んだ手間の目安と場所・道具の札を、追加した行動の記録として書く（Writerロック内。NOWの再生成の前に呼ぶ）。
 * 行動の項目キーは置き場・入力ID・本文で決まるので、NOWの再生成を待たずに書ける。
 * 同じ行動の再送では、元の行から写した記録を除き、その種類の記録が行動に1件でもあれば何もしない（先に書いた値や、その後に本人が付け直した値を、再送で戻さない）。
 * 元の行から写した記録は先に書かれていて、この記録が後から効く（写した記録は、元の行の記録を引き取った印として残す）。
 */
export async function writeActionTagsLocked(vault: Vault, action: { inputId: string; scope?: string; text: string; source: string; effort?: ItemEffort; contexts?: string[] }): Promise<void> {
  const scope = action.scope ?? UNASSIGNED_SCOPE, event = actionTagEvent(action.inputId), now = new Date().toISOString();
  const base = { schema_version: 1 as const, project_id: scope, item_key: itemKey(scope, 'next', action.inputId, action.text), section: 'next' as const, text: action.text, input_id: action.inputId, source: action.source, source_event_id: event, created_at: now };
  if (action.effort !== undefined && !(await readItemEfforts(vault, { raw: true })).records.some(r => r.input_id === action.inputId && !r.source_event_id?.startsWith('take-over:'))) {
    const record: ItemEffortRecord = { ...base, id: `EFF-${ulid()}`, effort: action.effort };
    if (!await vault.create(`90_system/item-efforts/${record.id}.json`, JSON.stringify(sorted(record, effortOrder), null, 2) + '\n')) throw new Error('手間の目安の記録が競合しました');
  }
  if (action.contexts !== undefined && !(await readItemContexts(vault, { raw: true })).records.some(r => r.input_id === action.inputId && !r.source_event_id?.startsWith('take-over:'))) {
    const record: ItemContextRecord = { ...base, id: `CTX-${ulid()}`, contexts: action.contexts };
    if (!await vault.create(contextPath(record.id), JSON.stringify(sorted(record, contextOrder), null, 2) + '\n')) throw new Error('札の記録が競合しました');
  }
}

/**
 * 本人が追加した行動を指す行動の追加（行動を別の置き場へ移す依頼）を、保存の前に確かめる（Writerロック内）。
 * 元の行動が今の一覧に未解決で載っていて、まだ移していないときだけ受け付け、元の行動の今の項目キーを返す
 * （端末の一覧が古く、文面を直す前のキーを指していても、今の行から記録を写すため）。
 * 元の行が行動でない（AIの行を行動にする）依頼と、同じ出典・受付IDの再送はundefined（再送は保存済みの入力を返すだけ）。
 */
export async function movedActionSourceLocked(config: HubConfig, vault: Vault, request: { source: string; sourceEventId?: string; meta?: Record<string, string> }): Promise<string | undefined> {
  const from = actionSource({ kind: 'action', meta: request.meta });
  if (!from) return undefined;
  const inputs = await readInputs(config), original = inputs.find(i => i.id === from.input_id && i.kind === 'action');
  if (!original) return undefined;
  if (request.sourceEventId !== undefined && inputs.some(i => i.source === request.source && i.source_event_id === request.sourceEventId)) return undefined;
  // 同じ行動を2回移すと、行動が2つになり、後の行動には記録が写らない。
  if (inputs.some(i => actionSource(i)?.input_id === original.id)) throw new ItemTargetError({ code: 'item-missing' }, 'この行動は既に別の置き場へ移しています。再読込して、移した先で操作してください');
  const scope = original.project === undefined ? UNASSIGNED_SCOPE : resolveProject(await readProjects(config), original.project);
  let items: NowItem[] = [];
  try { items = (await readNowItems(vault, scope))?.items ?? []; } catch { /* 壊れた一覧では元の行動を確かめられない。 */ }
  const item = items.find(i => i.action && i.input_id === original.id);
  if (!item) throw new ItemTargetError({ code: 'item-missing' }, '移す行動が一覧にありません。再読込して確かめてください');
  // 片付けた行動は移さない（移すと元の完了・却下の記録が一覧から消え、移した先に未解決として出るため）。
  if (item.resolution) {
    const state = item.resolution.action === 'exclude' ? 'excluded' as const : 'resolved' as const;
    throw new ItemTargetError({ code: 'item-closed', state }, `この行動は既に${state === 'excluded' ? '却下' : '完了'}しています。未解決へ戻してから移してください`);
  }
  return item.key;
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
const stepsOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'steps', 'source', 'source_event_id', 'created_at'];
const somedayOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'someday', 'source', 'source_event_id', 'created_at'];
const blocksOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'after', 'source', 'source_event_id', 'created_at'];
const progressOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'progress', 'source', 'source_event_id', 'created_at'];
const waitOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'waiting', 'source', 'source_event_id', 'created_at'];
const contextOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'contexts', 'source', 'source_event_id', 'created_at'];
const effortOrder = ['schema_version', 'id', 'project_id', 'item_key', 'section', 'text', 'input_id', 'effort', 'source', 'source_event_id', 'created_at'];
function sorted<T extends object>(record: T, order: string[]): T {
  return Object.fromEntries(order.flatMap(k => k in record ? [[k, (record as Record<string, unknown>)[k]]] : [])) as T;
}
