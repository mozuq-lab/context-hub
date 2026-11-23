import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { actionTextSchema } from './actions.js';
import { nowText } from './markdown-text.js';
import { ItemTargetError, activeResolutions, itemScopeSchema, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection } from './item-resolutions.js';
import { assertRecordTarget, effectiveItemRecords, itemRecordScope } from './item-schedules.js';
import type { HubConfig } from './types.js';

/**
 * 大きな次の一手に本人が付けた手順（2〜10個）と、終えた手順の数。一覧には今の1歩（終えた数の次の手順）だけを添えて出し、
 * 終えたと報告すると次の手順へ進む。最後の手順を終えても、元の項目の完了は本人の報告だけで行う。
 * 期日・手間の目安と同じく、AIは手順を作らず推測もしない。本人の指定だけを記録し、原文・整理結果・解決報告は変えない。
 * 付けられるのは「次の一手」の項目だけ（未解決は、行動ではないため）。
 */
export const ITEM_STEPS_MIN = 2;
export const ITEM_STEPS_MAX = 10;
/** 手順1つの文面。行動と同じく1行・200文字以内。 */
export const stepTextSchema = actionTextSchema;
export const itemStepsSchema = z.array(stepTextSchema).min(ITEM_STEPS_MIN, `手順は${ITEM_STEPS_MIN}つ以上にしてください`).max(ITEM_STEPS_MAX, `手順は${ITEM_STEPS_MAX}個までです`);
/** 項目の手順の全体。doneは終えた手順の数（0〜手順の数。手順の数と同じなら、すべて終えた）。 */
export const itemStepsValueSchema = z.object({ items: itemStepsSchema, done: z.number().int().min(0).max(ITEM_STEPS_MAX) }).strict().refine(v => v.done <= v.items.length, '終えた手順の数が手順の数を超えています');
export type ItemStepsValue = z.infer<typeof itemStepsValueSchema>;

/** 今の手順の表示（NOW・HOME・CLI）。すべて終えたときは、元の項目の完了を促す。 */
export function stepsLabel(steps: ItemStepsValue): string {
  return steps.done >= steps.items.length ? `手順 ${steps.items.length}/${steps.items.length} 済み・項目の完了を確かめる` : `手順 ${steps.done + 1}/${steps.items.length}: ${steps.items[steps.done]}`;
}
/** NOWの行末に置く表示（手順の文面はNOWの1行として書けるよう整える）。 */
export const nowStepsLabel = (steps: ItemStepsValue): string => nowText(stepsLabel(steps));

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const stepsIdSchema = z.string().regex(/^STP-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/** 1件の記録は項目の手順の全体。stepsがnullは手順を外した記録。 */
export const itemStepsRecordSchema = z.object({
  schema_version: z.literal(1), id: stepsIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, steps: itemStepsValueSchema.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemStepsRecord = z.infer<typeof itemStepsRecordSchema>;
export const stepsDir = '90_system/item-steps';
export const stepsPath = (id: string) => `${stepsDir}/${id}.json`;
export const stepsCleared = (r: Pick<ItemStepsRecord, 'steps'>) => r.steps === null;
const sameSteps = (a: ItemStepsValue | null, b: ItemStepsValue | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、doctorで示す。
 * 統合元のプロジェクトで付けた手順は、日付と同じく統合先の項目の記録として読み替える（rawを指定すると記録のまま）。
 */
export async function readItemSteps(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemStepsRecord[]; problems: string[] }> {
  const records: ItemStepsRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(stepsDir)) {
    if (!/^90_system\/item-steps\/STP-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemStepsRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== stepsPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}

/**
 * 今のNOW項目に効く手順。引き継ぎの規則は期日と同じ（作業要約が届いて根拠が変わっても、同じ欄・同じ本文なら引き継ぐ）。
 * 引き継ぎ先のない手順は、手間の目安と同じく付け直しを求めず、そのまま使わない。
 */
export function effectiveSteps(records: ItemStepsRecord[], projectId: string, items: Parameters<typeof effectiveItemRecords>[2], resolvedKeys: { has(key: string): boolean }): Map<string, ItemStepsValue & { id: string }> {
  const { byKey } = effectiveItemRecords(records, projectId, items, resolvedKeys, stepsCleared);
  return new Map([...byKey].flatMap(([key, r]) => r.steps ? [[key, { id: r.id, items: [...r.steps.items], done: r.steps.done }] as const] : []));
}

/**
 * 受け付けられない理由。同じ内容の依頼は何度送っても同じ結果になるため、受付は再試行しない。
 * not-next: 「次の一手」でない項目（未解決）には手順を付けない。
 * changed: 本人が見た手順（expected）と今の手順が違う（別の端末で進めた・直した）。古い表示から送った依頼で進み具合を巻き戻さない。
 */
export const itemStepsRefusalCauses = ['not-next', 'changed'] as const;
export type ItemStepsReason = { code: 'steps-refused'; cause: typeof itemStepsRefusalCauses[number] };
export class ItemStepsError extends Error {
  constructor(readonly reason: ItemStepsReason) { super(itemStepsMessage(reason)); this.name = 'ItemStepsError'; }
}
export function itemStepsMessage(reason: ItemStepsReason): string {
  return reason.cause === 'changed'
    ? 'この項目の手順は、確かめた後に別の端末などで変わっています。同期して今の手順を確かめてから、もう一度操作してください。'
    : '手順を付けられるのは「次の一手」の項目だけです。未解決は、次の一手を足してから手順に分けてください。';
}

/** expectedは本人が見た今の手順（なければnull）。指定すると、今の手順と違うときは断る（省くと確かめない）。 */
export interface ItemStepsRequest { projectId: string; itemKey: string; steps: ItemStepsValue | null; expected?: ItemStepsValue | null; source: string; sourceEventId?: string }
export interface ItemStepsResult { projectId: string; itemKey: string; stepsId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, steps: itemStepsValueSchema.nullable(), expected: itemStepsValueSchema.nullable().optional(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict();

/**
 * 直近に生成したNOW項目の一覧にある、片付いていない次の一手の手順を、指定した全体（手順と終えた数）に置き換える（nullで外す）。
 * 手順を進める・戻すのも、終えた数を変えた全体を送る。別の端末で同じ所まで進めた依頼が重なっても、同じ全体なので記録は増えない。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemSteps(config: HubConfig, request: ItemStepsRequest): Promise<ItemStepsResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      const previous = (await readItemSteps(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && r.steps !== null) || !sameSteps(previous.steps, r.steps)) throw new Error('同じ受付IDで別の手順が記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, stepsId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    assertRecordTarget(unassigned, item);
    if (item.section !== 'next') throw new ItemStepsError({ code: 'steps-refused', cause: 'not-next' });
    // 片付いた項目の手順は付けも外しもしない（戻したときは、片付ける前の手順のまま戻る）。
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    const { records } = await readItemSteps(vault), current = effectiveItemRecords(records, r.projectId, list, resolved, stepsCleared).byKey.get(r.itemKey);
    const unchanged = sameSteps(current?.steps ?? null, r.steps);
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の手順と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      const latest = current ?? records.filter(x => x.project_id === r.projectId && x.item_key === r.itemKey).at(-1);
      if (latest) return { projectId: r.projectId, itemKey: r.itemKey, stepsId: latest.id, deduped: true };
    }
    if (r.expected !== undefined && !sameSteps(current?.steps ?? null, r.expected)) throw new ItemStepsError({ code: 'steps-refused', cause: 'changed' });
    if (r.steps === null && !current) throw new Error('この項目に外す手順はありません');
    if (unchanged) throw new Error('この項目には既に同じ手順が付いています');
    // 引き継いだ手順を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = r.steps === null && current && current.item_key !== r.itemKey ? { key: current.item_key, section: current.section, text: current.text, input_id: current.input_id } : item;
    const record = await writeStepsRecordLocked(vault, { projectId: r.projectId, key: target.key, section: target.section as ItemSection, text: target.text, inputId: target.input_id, steps: r.steps, source: r.source, ...(r.sourceEventId ? { sourceEventId: r.sourceEventId } : {}) });
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, stepsId: record.id, deduped: false };
  });
}

/** 手順の記録を1件書く（Writerロック内）。 */
export async function writeStepsRecordLocked(vault: Vault, value: { projectId: string; key: string; section: ItemSection; text: string; inputId: string; steps: ItemStepsValue | null; source: string; sourceEventId?: string }): Promise<ItemStepsRecord> {
  const record: ItemStepsRecord = {
    schema_version: 1, id: `STP-${ulid()}`, project_id: value.projectId, item_key: value.key, section: value.section, text: value.text, input_id: value.inputId,
    steps: value.steps, source: value.source, ...(value.sourceEventId ? { source_event_id: value.sourceEventId } : {}), created_at: new Date().toISOString(),
  };
  if (!await vault.create(stepsPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('手順の記録が競合しました');
  return record;
}

/** 定例の回を終えたときに手順を最初に戻した記録の受付ID（回の記録のID）。 */
const occurrenceEvent = (occurrenceId: string) => `occurrence:${occurrenceId}`;
/**
 * 定例の今回を完了・見送りにしたとき、項目に手順があり1つでも終えていれば、手順を最初に戻す記録を書く（Writerロック内。NOWの再生成の前に呼ぶ）。
 * 同じ回の記録で既に戻していれば何もしない。手順の記録を読めないときは戻さない（doctorで示す）。
 */
export async function resetStepsForOccurrenceLocked(vault: Vault, occurrence: { id: string; project_id: string; item_key: string; section: ItemSection; text: string; input_id: string; source: string; created_at: string }): Promise<void> {
  let records: ItemStepsRecord[];
  try { records = (await readItemSteps(vault)).records; } catch { return; }
  if (records.some(r => r.source_event_id === occurrenceEvent(occurrence.id))) return;
  const list = (await readNowItems(vault, occurrence.project_id))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), occurrence.project_id);
  const current = effectiveItemRecords(records, occurrence.project_id, list, resolved, stepsCleared).byKey.get(occurrence.item_key);
  if (!current?.steps || current.steps.done === 0) return;
  // 回を片付けた後に手順を付け直した・進めた（回の依頼の再送が遅れて届いた）ときは、その後の進み具合を戻さない。
  if (Date.parse(current.created_at) > Date.parse(occurrence.created_at)) return;
  await writeStepsRecordLocked(vault, { projectId: occurrence.project_id, key: occurrence.item_key, section: occurrence.section, text: occurrence.text, inputId: occurrence.input_id, steps: { items: current.steps.items, done: 0 }, source: occurrence.source, sourceEventId: occurrenceEvent(occurrence.id) });
}
