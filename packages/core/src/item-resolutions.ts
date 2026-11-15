import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash } from './storage.js';
import { readInputs } from './capture.js';
import { projectIdSchema, readProjects } from './projects.js';
import type { HubConfig } from './types.js';

/**
 * NOWの「次の一手」「未解決」の項目を、本人が完了・解決と報告した記録と、AIの読み違いなどの「誤り」として外した記録。
 * 原文と整理結果は変えない。誤りとして外した項目は完了・解決とは数えず、理由と一言を残して次の整理に渡す。
 */
export const itemSections = ['next', 'open'] as const;
export type ItemSection = typeof itemSections[number];
export const itemActions = ['resolve', 'reopen', 'exclude'] as const;
export type ItemAction = typeof itemActions[number];
/** 誤りとして外す理由。wrong-project: このプロジェクトの話ではない / misread: AIの読み違い / outdated: もう古い。 */
export const exclusionReasons = ['wrong-project', 'misread', 'outdated'] as const;
export type ExclusionReason = typeof exclusionReasons[number];
export const exclusionReasonSchema = z.enum(exclusionReasons);
export const exclusionReasonLabels: Record<ExclusionReason, string> = { 'wrong-project': '別のプロジェクトの話', misread: '読み違い', outdated: 'もう古い' };
export const EXCLUSION_NOTE_CHARS = 200;
/** 本人の一言。1行で、制御文字を含めない（NOWの1行とモデルへ渡す資料に載せるため）。 */
export const exclusionNoteSchema = z.string().min(1).max(EXCLUSION_NOTE_CHARS).regex(/^[^\p{Cc}]+$/u).refine(v => v.trim() === v, '前後の空白は付けられません');
/** 理由は「外す」にだけ必須で、一言は「外す」にだけ付けられる。 */
const exclusionFields = (v: { action: ItemAction; reason?: ExclusionReason; note?: string }) => v.action === 'exclude' ? v.reason !== undefined : v.reason === undefined && v.note === undefined;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const resolutionIdSchema = z.string().regex(/^RES-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
export const itemKeySchema = digest;
export const itemActionSchema = z.enum(itemActions);
export const itemResolutionSchema = z.object({
  schema_version: z.literal(1), id: resolutionIdSchema, project_id: projectIdSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, action: z.enum(itemActions), source: z.string().min(1).max(200),
  source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
  reason: exclusionReasonSchema.optional(), note: exclusionNoteSchema.optional(),
}).strict().refine(exclusionFields, '理由は誤りとして外す記録にだけ指定します');
export type ItemResolution = z.infer<typeof itemResolutionSchema>;
const nowItemSchema = z.object({
  key: digest, section: z.enum(itemSections), label: z.string().max(200), text: z.string().max(4000), input_id: inputIdSchema,
  // 完了・解決（actionなし）か、誤りとして外した記録（action: exclude と理由・一言）。どちらも欄からは外れる。
  resolution: z.object({ id: resolutionIdSchema, at: z.string().datetime({ offset: true }), source: z.string().max(200), action: z.literal('exclude').optional(), reason: exclusionReasonSchema.optional(), note: exclusionNoteSchema.optional() }).strict().nullable(),
  // 本人が付けた期日・見直す日（item-schedules）。旧版の一覧にはない。
  schedule: z.object({ id: z.string().regex(/^SCH-[0-9A-HJKMNP-TV-Z]{26}$/), due: z.string().nullable(), review_after: z.string().nullable() }).strict().nullable().optional(),
  // 本人がプロジェクトを指定したメモから、AIが「片付いたかも」と示したもの。未確認で、完了・解決ではない。片付いていない項目にだけ付く。
  hints: z.array(z.object({ input_id: inputIdSchema, quote: z.string().min(1).max(200), at: z.string().datetime({ offset: true }) }).strict()).max(20).optional(),
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
/** 項目ごとに最後の記録だけを有効にする。最後が解決・誤りとして外すなら欄から外れたまま、再開なら未解決へ戻す。 */
export function activeResolutions(records: ItemResolution[], projectId?: string): Map<string, ItemResolution> {
  const latest = new Map<string, ItemResolution>();
  for (const r of records) if (!projectId || r.project_id === projectId) latest.set(r.item_key, r);
  for (const [key, r] of latest) if (r.action === 'reopen') latest.delete(key);
  return latest;
}
/** 今も有効な「誤りとして外す」記録（全プロジェクト、古い順）。項目はプロジェクトごとなので、プロジェクトと項目キーの組で最後の記録を見る。 */
export function activeExclusions(records: ItemResolution[]): ItemResolution[] {
  const latest = new Map<string, ItemResolution>();
  for (const r of records) latest.set(`${r.project_id}\n${r.item_key}`, r);
  return [...latest.values()].filter(r => r.action === 'exclude').sort((a, b) => a.id.localeCompare(b.id));
}
/**
 * 入力ごとの、本人が「別のプロジェクトの話」として外したプロジェクト。
 * AIが推定した帰属（帰属候補）だけを取り消すために使い、本人が指定したプロジェクトは変えない。
 */
export function wrongProjectsByInput(exclusions: ItemResolution[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const r of exclusions) if (r.reason === 'wrong-project') { const set = result.get(r.input_id); if (set) set.add(r.project_id); else result.set(r.input_id, new Set([r.project_id])); }
  return result;
}
export async function readNowItems(vault: Vault, projectId: string): Promise<NowItems | undefined> {
  const raw = await vault.read(nowItemsPath(projectId));
  if (raw === undefined) return undefined;
  const parsed = nowItemsSchema.parse(JSON.parse(raw));
  if (parsed.project !== projectId) throw new Error('NOW項目の記録とプロジェクトが一致しません');
  return parsed;
}

export interface ItemResolutionRequest { projectId: string; itemKey: string; action: ItemAction; source: string; sourceEventId?: string; /** 誤りとして外す理由（action: exclude のときだけ、必須）。 */ reason?: ExclusionReason; /** 本人の一言（任意）。 */ note?: string }
export interface ItemResolutionResult { projectId: string; itemKey: string; action: ItemAction; resolutionId: string; deduped: boolean }
const requestSchema = z.object({ projectId: projectIdSchema, itemKey: digest, action: z.enum(itemActions), source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), reason: exclusionReasonSchema.optional(), note: exclusionNoteSchema.optional() }).strict();

/**
 * 直近に生成したNOW項目の一覧にある項目だけを、完了・解決にする、誤りとして外す、または未解決へ戻す。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 * 「別のプロジェクトの話」として外した入力は、AIが推定した帰属からそのプロジェクトが外れる（views・associationsが記録から決める）。
 */
export async function setItemResolution(config: HubConfig, request: ItemResolutionRequest): Promise<ItemResolutionResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  if (!exclusionFields(r)) throw new Error(r.action === 'exclude' ? '誤りとして外す理由を指定してください' : '理由と一言は、誤りとして外すときだけ指定できます');
  // NOWの再生成はviews.tsに依存するため、循環を避けて遅延読込する。
  const { rebuildNowLocked, rebuildNowsForInputLocked, readReceipts } = await import('./views.js');
  return vault.withLock(async () => {
    const projects = await readProjects(config);
    if (!projects.some(p => p.id === r.projectId)) throw new Error('プロジェクトが見つかりません');
    const records = await readItemResolutions(vault);
    // 誤りとして外す・それを戻す操作は、読み直しの結果や帰属の取り消しを通じてほかのプロジェクトのNOWにも及ぶ。
    const rebuild = async (inputId?: string) => {
      const inputs = await readInputs(config), receipts = await readReceipts(config);
      if (inputId) await rebuildNowsForInputLocked(vault, config, projects.map(p => p.id), inputId, r.projectId, inputs, receipts);
      else await rebuildNowLocked(vault, config, r.projectId, inputs, receipts);
    };
    const wide = (record: ItemResolution, undone?: ItemResolution) => record.action === 'exclude' || undone?.action === 'exclude' ? record.input_id : undefined;
    const before = (record: ItemResolution) => records.filter(x => x.project_id === record.project_id && x.item_key === record.item_key && x.id < record.id).at(-1);
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.item_key !== r.itemKey || previous.action !== r.action || previous.reason !== r.reason || previous.note !== r.note) throw new Error('同じ受付IDで別の解決報告が記録されています');
        await rebuild(wide(previous, before(previous)));
        return { projectId: r.projectId, itemKey: r.itemKey, action: r.action, resolutionId: previous.id, deduped: true };
      }
    }
    const items = await readNowItems(vault, r.projectId);
    const item = items?.items.find(i => i.key === r.itemKey);
    if (!item) throw new Error('NOWに該当する項目がありません。最新のNOWで確認してください');
    const active = activeResolutions(records, r.projectId).get(r.itemKey);
    if (r.action !== 'reopen' && active) throw new Error(active.action === 'exclude' ? 'この項目は既に誤りとして外しています。変えるときは未解決に戻してから操作してください' : 'この項目は既に解決済みです');
    if (r.action === 'reopen' && !active) throw new Error('この項目は解決済みではありません');
    const record: ItemResolution = {
      schema_version: 1, id: `RES-${ulid()}`, project_id: r.projectId, item_key: r.itemKey, section: item.section, text: item.text, input_id: item.input_id,
      action: r.action, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
      ...(r.reason ? { reason: r.reason } : {}), ...(r.note ? { note: r.note } : {}),
    };
    if (!await vault.create(`${resolutionDir}/${record.id}.json`, JSON.stringify(record, null, 2) + '\n')) throw new Error('解決記録が競合しました');
    await rebuild(wide(record, active));
    return { projectId: r.projectId, itemKey: r.itemKey, action: r.action, resolutionId: record.id, deduped: false };
  });
}
