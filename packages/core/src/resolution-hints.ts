import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { readInputs } from './capture.js';
import { assertNotMerged, projectIdSchema, readProjects } from './projects.js';
import { itemKeySchema } from './item-resolutions.js';
import type { HubConfig } from './types.js';

/**
 * 「片付いたかも」（整理のときAIが示した、メモで片付いた可能性のある次の一手・未解決）を、
 * 本人が「違う」と見送った記録。項目と根拠のメモの組ごとに残し、同じメモから同じ項目へ再び示さない。
 * 完了・解決そのものは item-resolutions の本人報告だけで決まり、この記録は表示を変えるだけ。
 */
const dismissalIdSchema = z.string().regex(/^HDM-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
export const hintDismissalIdSchema = dismissalIdSchema;
export const hintDismissalSchema = z.object({
  schema_version: z.literal(1), id: dismissalIdSchema, project_id: projectIdSchema, item_key: itemKeySchema, input_id: inputIdSchema,
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type HintDismissal = z.infer<typeof hintDismissalSchema>;
const dismissalDir = '90_system/hint-dismissals';

export async function readHintDismissals(vault: Vault): Promise<HintDismissal[]> {
  const result: HintDismissal[] = [];
  for (const path of await vault.files(dismissalDir)) {
    if (!/^90_system\/hint-dismissals\/HDM-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    let record: HintDismissal;
    try { record = hintDismissalSchema.parse(JSON.parse((await vault.read(path))!)); } catch { throw new Error(`見送りの記録が不正です: ${path}`); }
    if (path !== `${dismissalDir}/${record.id}.json`) throw new Error(`見送りの記録とパスが一致しません: ${path}`);
    result.push(record);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
export const dismissalKey = (projectId: string, itemKey: string, inputId: string) => `${projectId}\n${itemKey}\n${inputId}`;

export interface HintDismissRequest { projectId: string; itemKey: string; inputId: string; source: string; sourceEventId?: string }
// 受付記録では inputId が「入力を保存した」結果を表すため、根拠のメモは hintInputId と呼ぶ。
export interface HintDismissResult { projectId: string; itemKey: string; hintInputId: string; dismissalId: string; deduped: boolean }
const requestSchema = z.object({ projectId: projectIdSchema, itemKey: itemKeySchema, inputId: inputIdSchema, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional() }).strict();

/**
 * 指定のメモから示された（または示される）「片付いたかも」を見送る。候補が既に消えていても受け付ける。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function dismissResolutionHint(config: HubConfig, request: HintDismissRequest): Promise<HintDismissResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  // NOWの再生成はviews.tsに依存するため、循環を避けて遅延読込する。
  const { rebuildNowLocked, readReceipts } = await import('./views.js');
  return vault.withLock(async () => {
    const projects = await readProjects(config);
    if (!projects.some(p => p.id === r.projectId)) throw new Error('プロジェクトが見つかりません');
    const records = await readHintDismissals(vault);
    const rebuild = async () => { await rebuildNowLocked(vault, config, r.projectId, await readInputs(config), await readReceipts(config)); };
    const result = (id: string, deduped: boolean): HintDismissResult => ({ projectId: r.projectId, itemKey: r.itemKey, hintInputId: r.inputId, dismissalId: id, deduped });
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.item_key !== r.itemKey || previous.input_id !== r.inputId) throw new Error('同じ受付IDで別の見送りが記録されています');
        await rebuild();
        return result(previous.id, true);
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertNotMerged(projects, r.projectId);
    // 別の経路で既に見送っていれば、新しい記録は作らない。
    const same = records.find(x => dismissalKey(x.project_id, x.item_key, x.input_id) === dismissalKey(r.projectId, r.itemKey, r.inputId));
    if (same) { await rebuild(); return result(same.id, true); }
    // 依頼の後に項目が完了・解決された、メモが訂正された、などで候補が既に消えていても見送りは害がないため記録して受け付ける。
    // 記録が残れば、同じメモから同じ項目へ再び示すこともない。
    const record: HintDismissal = {
      schema_version: 1, id: `HDM-${ulid()}`, project_id: r.projectId, item_key: r.itemKey, input_id: r.inputId,
      source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(`${dismissalDir}/${record.id}.json`, JSON.stringify(record, null, 2) + '\n')) throw new Error('見送りの記録が競合しました');
    await rebuild();
    return result(record.id, false);
  });
}
