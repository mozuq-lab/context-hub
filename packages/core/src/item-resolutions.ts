import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash } from './storage.js';
import { readInputs } from './capture.js';
import { projectIdSchema, readProjects } from './projects.js';
import type { HubConfig } from './types.js';

/** NOWの「次の一手」「未解決」の項目を、本人が完了・解決と報告した記録。原文と整理結果は変えない。 */
export const itemSections = ['next', 'open'] as const;
export type ItemSection = typeof itemSections[number];
export const itemActions = ['resolve', 'reopen'] as const;
export type ItemAction = typeof itemActions[number];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const resolutionIdSchema = z.string().regex(/^RES-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
export const itemKeySchema = digest;
export const itemActionSchema = z.enum(itemActions);
export const itemResolutionSchema = z.object({
  schema_version: z.literal(1), id: resolutionIdSchema, project_id: projectIdSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, action: z.enum(itemActions), source: z.string().min(1).max(200),
  source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemResolution = z.infer<typeof itemResolutionSchema>;
const nowItemSchema = z.object({
  key: digest, section: z.enum(itemSections), label: z.string().max(200), text: z.string().max(4000), input_id: inputIdSchema,
  resolution: z.object({ id: resolutionIdSchema, at: z.string().datetime({ offset: true }), source: z.string().max(200) }).strict().nullable(),
}).strict();
export type NowItem = z.infer<typeof nowItemSchema>;
export const nowItemsSchema = z.object({ schema_version: z.literal(1), project: projectIdSchema, generated_at: z.string().datetime({ offset: true }), items: z.array(nowItemSchema) }).strict();
export type NowItems = z.infer<typeof nowItemsSchema>;

const resolutionDir = '90_system/item-resolutions';
export const nowItemsPath = (projectId: string) => `90_system/now-items/${projectId}.json`;

/** 項目の同一性。同じ入力の同じ欄・同じ本文だけを同じ項目とし、新しい報告で同じ本文が出た場合は別の項目になる。 */
export function itemKey(projectId: string, section: ItemSection, inputId: string, text: string): string {
  return hash(`${projectId}\n${section}\n${inputId}\n${text}`);
}

export async function readItemResolutions(vault: Vault): Promise<ItemResolution[]> {
  const result: ItemResolution[] = [];
  for (const path of await vault.files(resolutionDir)) {
    if (!/^90_system\/item-resolutions\/RES-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    let record: ItemResolution;
    try { record = itemResolutionSchema.parse(JSON.parse((await vault.read(path))!)); } catch { throw new Error(`解決記録が不正です: ${path}`); }
    if (path !== `${resolutionDir}/${record.id}.json`) throw new Error(`解決記録とパスが一致しません: ${path}`);
    result.push(record);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
/** 項目ごとに最後の記録だけを有効にする。最後が解決なら解決済み、再開なら未解決へ戻す。 */
export function activeResolutions(records: ItemResolution[], projectId?: string): Map<string, ItemResolution> {
  const latest = new Map<string, ItemResolution>();
  for (const r of records) if (!projectId || r.project_id === projectId) latest.set(r.item_key, r);
  for (const [key, r] of latest) if (r.action !== 'resolve') latest.delete(key);
  return latest;
}
export async function readNowItems(vault: Vault, projectId: string): Promise<NowItems | undefined> {
  const raw = await vault.read(nowItemsPath(projectId));
  if (raw === undefined) return undefined;
  const parsed = nowItemsSchema.parse(JSON.parse(raw));
  if (parsed.project !== projectId) throw new Error('NOW項目の記録とプロジェクトが一致しません');
  return parsed;
}

export interface ItemResolutionRequest { projectId: string; itemKey: string; action: ItemAction; source: string; sourceEventId?: string }
export interface ItemResolutionResult { projectId: string; itemKey: string; action: ItemAction; resolutionId: string; deduped: boolean }
const requestSchema = z.object({ projectId: projectIdSchema, itemKey: digest, action: z.enum(itemActions), source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional() }).strict();

/**
 * 直近に生成したNOW項目の一覧にある項目だけを、完了・解決または未解決へ戻す。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemResolution(config: HubConfig, request: ItemResolutionRequest): Promise<ItemResolutionResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  // NOWの再生成はviews.tsに依存するため、循環を避けて遅延読込する。
  const { rebuildNowLocked, readReceipts } = await import('./views.js');
  return vault.withLock(async () => {
    if (!(await readProjects(config)).some(p => p.id === r.projectId)) throw new Error('プロジェクトが見つかりません');
    const records = await readItemResolutions(vault);
    const rebuild = async () => { await rebuildNowLocked(vault, config, r.projectId, await readInputs(config), await readReceipts(config)); };
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.item_key !== r.itemKey || previous.action !== r.action) throw new Error('同じ受付IDで別の解決報告が記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, action: r.action, resolutionId: previous.id, deduped: true };
      }
    }
    const items = await readNowItems(vault, r.projectId);
    const item = items?.items.find(i => i.key === r.itemKey);
    if (!item) throw new Error('NOWに該当する項目がありません。最新のNOWで確認してください');
    const active = activeResolutions(records, r.projectId).has(r.itemKey);
    if (r.action === 'resolve' && active) throw new Error('この項目は既に解決済みです');
    if (r.action === 'reopen' && !active) throw new Error('この項目は解決済みではありません');
    const record: ItemResolution = {
      schema_version: 1, id: `RES-${ulid()}`, project_id: r.projectId, item_key: r.itemKey, section: item.section, text: item.text, input_id: item.input_id,
      action: r.action, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(`${resolutionDir}/${record.id}.json`, JSON.stringify(record, null, 2) + '\n')) throw new Error('解決記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, action: r.action, resolutionId: record.id, deduped: false };
  });
}
