import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { ItemTargetError, activeResolutions, itemScopeSchema, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection } from './item-resolutions.js';
import { assertRecordTarget, effectiveItemRecords, itemRecordScope } from './item-schedules.js';
import type { HubConfig } from './types.js';

/**
 * NOWの「次の一手」「未解決」の項目に本人が付けた手間の目安。空いた時間に合う項目を選ぶ手掛かりにする。
 * 期日と同じく、AIは推測せず本人の指定だけを記録する。原文・整理結果・解決報告は変えない。
 * quick: すぐ（15分ほど） / hour: 1時間ほど / half-day: 半日以上。
 */
export const itemEfforts = ['quick', 'hour', 'half-day'] as const;
export type ItemEffort = typeof itemEfforts[number];
export const itemEffortSchema = z.enum(itemEfforts);
/** NOW・HOME・CLIで使う表示。 */
export const itemEffortLabels: Record<ItemEffort, string> = { quick: '15分ほど', hour: '1時間ほど', 'half-day': '半日以上' };
/** NOW・HOMEで項目の後ろに付ける手間の表示。 */
export const effortLabel = (effort: ItemEffort): string => `手間 ${itemEffortLabels[effort]}`;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const effortIdSchema = z.string().regex(/^EFF-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/** 1件の記録は項目の手間の目安の全体。effortがnullは目安を外した記録。 */
export const itemEffortRecordSchema = z.object({
  schema_version: z.literal(1), id: effortIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, effort: itemEffortSchema.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemEffortRecord = z.infer<typeof itemEffortRecordSchema>;
const effortDir = '90_system/item-efforts';
const effortPath = (id: string) => `${effortDir}/${id}.json`;
const effortCleared = (r: ItemEffortRecord) => r.effort === null;

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、doctorで示す。
 * 統合元のプロジェクトで付けた目安は、日付と同じく統合先の項目の記録として読み替える（rawを指定すると記録のまま）。
 */
export async function readItemEfforts(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemEffortRecord[]; problems: string[] }> {
  const records: ItemEffortRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(effortDir)) {
    if (!/^90_system\/item-efforts\/EFF-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemEffortRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== effortPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}

/**
 * 今のNOW項目に効く手間の目安。引き継ぎの規則は期日と同じ（作業要約が届いて根拠が変わっても、同じ欄・同じ本文なら引き継ぐ）。
 * 引き継ぎ先のない目安は付け直しを求めず、そのまま使わない（期日と違い、過ぎて困るものではないため）。
 */
export function effectiveEfforts(records: ItemEffortRecord[], projectId: string, items: Parameters<typeof effectiveItemRecords>[2], resolvedKeys: { has(key: string): boolean }): Map<string, ItemEffort> {
  const { byKey } = effectiveItemRecords(records, projectId, items, resolvedKeys, effortCleared);
  return new Map([...byKey].flatMap(([key, r]) => r.effort ? [[key, r.effort] as const] : []));
}

export interface ItemEffortRequest { projectId: string; itemKey: string; effort: ItemEffort | null; source: string; sourceEventId?: string }
export interface ItemEffortResult { projectId: string; itemKey: string; effortId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, effort: itemEffortSchema.nullable(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict();

/**
 * 直近に生成したNOW項目の一覧にある、片付いていない項目へ手間の目安を付ける（nullで外す）。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemEffort(config: HubConfig, request: ItemEffortRequest): Promise<ItemEffortResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      // 引き継いだ目安を外した記録は、引き継ぎ元のキーで残る。
      const previous = (await readItemEfforts(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && r.effort !== null) || previous.effort !== r.effort) throw new Error('同じ受付IDで別の手間の目安が記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, effortId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    assertRecordTarget(unassigned, item);
    // 片付いた項目の目安は付けも外しもしない（戻したときは、片付ける前の目安のまま戻る）。
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    const { records } = await readItemEfforts(vault), current = effectiveItemRecords(records, r.projectId, list, resolved, effortCleared).byKey.get(r.itemKey);
    const unchanged = r.effort === null ? !current : current?.effort === r.effort;
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の目安と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      // 再試行し続けないよう、今の目安の記録（外した依頼なら、この項目の最後の記録）を返す。
      const latest = current ?? records.filter(x => x.project_id === r.projectId && x.item_key === r.itemKey).at(-1);
      if (latest) return { projectId: r.projectId, itemKey: r.itemKey, effortId: latest.id, deduped: true };
    }
    if (r.effort === null && !current) throw new Error('この項目に外す手間の目安はありません');
    if (current && current.effort === r.effort) throw new Error('この項目には既に同じ手間の目安が付いています');
    // 引き継いだ目安を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = r.effort === null && current && current.item_key !== r.itemKey ? { key: current.item_key, section: current.section, text: current.text, input_id: current.input_id } : item;
    const record: ItemEffortRecord = {
      schema_version: 1, id: `EFF-${ulid()}`, project_id: r.projectId, item_key: target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      effort: r.effort, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(effortPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('手間の目安の記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, effortId: record.id, deduped: false };
  });
}
