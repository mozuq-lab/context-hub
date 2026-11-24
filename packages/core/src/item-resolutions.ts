import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash, readOncePerLock } from './storage.js';
import { readInputs } from './capture.js';
import { assertNotMerged, inspectProjects, mergeTargets, projectIdSchema, readProjects } from './projects.js';
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
/**
 * どのプロジェクトにも結び付いていないメモの行（HOMEとアプリの「プロジェクト未定」）を指す、項目の置き場。
 * プロジェクトIDの形（英小文字・数字で始まる）と重ならないよう、下線で始める。完了・誤りとして外す記録と項目一覧で、プロジェクトIDの代わりに使う。
 */
export const UNASSIGNED_SCOPE = '_unassigned';
export const itemScopeSchema = z.union([projectIdSchema, z.literal(UNASSIGNED_SCOPE)]);
/** プロジェクト未定の行のうち、本人が外せる理由。行動ではない・もうやらない行を一覧から外すだけで、メモは読み直さない。 */
export const UNASSIGNED_EXCLUSION_REASON: ExclusionReason = 'outdated';
export const itemActionSchema = z.enum(itemActions);
export const itemResolutionSchema = z.object({
  schema_version: z.literal(1), id: resolutionIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
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
  // repeatは定例の繰り返し（unit・every、毎月はday）。繰り返しのない項目と旧版の一覧にはない。
  schedule: z.object({ id: z.string().regex(/^SCH-[0-9A-HJKMNP-TV-Z]{26}$/), due: z.string().nullable(), review_after: z.string().nullable(), repeat: z.object({ unit: z.enum(['day', 'week', 'month']), every: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31).optional() }).strict().optional() }).strict().nullable().optional(),
  // 本人が付けた手間の目安（item-efforts）。quick: 15分ほど / hour: 1時間ほど / half-day: 半日以上。目安のない項目と旧版の一覧にはない。
  effort: z.enum(['quick', 'hour', 'half-day']).optional(),
  // 本人が付けた場所・道具の札（item-contexts）。付けた順。札のない項目と旧版の一覧にはない。
  contexts: z.array(z.string().min(1).max(20)).min(1).max(8).optional(),
  // 本人が付けた手順（item-steps）。itemsは手順、doneは終えた手順の数。手順のない項目と旧版の一覧にはない。
  steps: z.object({ id: z.string().regex(/^STP-[0-9A-HJKMNP-TV-Z]{26}$/), items: z.array(z.string().min(1).max(200)).min(2).max(10), done: z.number().int().min(0).max(10) }).strict().optional(),
  // 本人が付けた連絡待ちの印（item-waits）。sinceは頼んだ日、whoは相手（任意）。印のない項目と旧版の一覧にはない。
  waiting: z.object({ id: z.string().regex(/^WAIT-[0-9A-HJKMNP-TV-Z]{26}$/), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), who: z.string().min(1).max(40).optional() }).strict().optional(),
  // 本人が付けた「先に済ませること」（item-blocks）。itemsは先の項目（置き場・キー・欄・本文・根拠の入力。根拠は統合先への読み替えに使う）。先の項目の今の状態は、読む側が先の項目の一覧から決める。印のない項目と旧版の一覧にはない。
  after: z.object({ id: z.string().regex(/^BLK-[0-9A-HJKMNP-TV-Z]{26}$/), items: z.array(z.object({ project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections), text: z.string().max(4000), input_id: inputIdSchema }).strict()).min(1).max(3) }).strict().optional(),
  // 本人が「いつかやる」へ移した項目（item-somedays）。sinceは移した日、reviewedは最後に見直した日（見直していなければ移した日）。移していない項目と旧版の一覧にはない。
  someday: z.object({ id: z.string().regex(/^SMD-[0-9A-HJKMNP-TV-Z]{26}$/), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().optional(),
  // 本人がプロジェクトを指定したメモから、AIが「片付いたかも」と示したもの。未確認で、完了・解決ではない。片付いていない項目にだけ付く。
  hints: z.array(z.object({ input_id: inputIdSchema, quote: z.string().min(1).max(200), at: z.string().datetime({ offset: true }) }).strict()).max(20).optional(),
  // 本人が直接追加した行動（入力の種類action）。fromはAIが読み取った行を行動にしたときの元の行（根拠の入力ID・直す前の本文・項目キー）。旧版の一覧にはない。
  action: z.object({ from: z.object({ input_id: inputIdSchema, text: z.string().min(1).max(2000), key: digest.optional() }).strict().optional() }).strict().optional(),
}).strict();
export type NowItem = z.infer<typeof nowItemSchema>;
export const nowItemsSchema = z.object({ schema_version: z.literal(1), project: itemScopeSchema, generated_at: z.string().datetime({ offset: true }), items: z.array(nowItemSchema) }).strict();
export type NowItems = z.infer<typeof nowItemsSchema>;

/**
 * 依頼した項目の今の状態では受け付けられない理由。同じ内容の依頼は何度受け付けても同じ結果になるため、受付は再試行しない。
 * item-missing: NOWに項目がない / item-closed: 既に解決済み・誤りとして外した / item-open: 解決済みではない（戻す依頼）。
 */
export type ItemTargetReason = { code: 'item-missing' } | { code: 'item-closed'; state: 'resolved' | 'excluded' } | { code: 'item-open' };
export class ItemTargetError extends Error {
  constructor(readonly reason: ItemTargetReason, message: string) {
    super(message);
    this.name = 'ItemTargetError';
  }
}
/** 受付ファイルで依頼した本人とHOMEへ示す文。CLIの例外文とは別に、何が起きた可能性があるかと次の操作を示す。 */
export function itemTargetMessage(reason: ItemTargetReason): string {
  if (reason.code === 'item-missing') return 'NOWにこの項目がありませんでした。先に届いた依頼で片付いたか、同じメモの別の項目を「別のプロジェクトの話」として外し、メモごとプロジェクトから外れた可能性があります。再読込してNOWを確認してください。';
  if (reason.code === 'item-closed') return `この項目は既に${reason.state === 'excluded' ? '誤りとして外されていました' : '解決済み・完了になっていました'}。変える場合は未解決に戻してから操作してください。`;
  return 'この項目は解決済みではありませんでした。既に未解決に戻っている可能性があります。再読込してNOWを確認してください。';
}

const resolutionDir = '90_system/item-resolutions';
export const nowItemsPath = (projectId: string) => `90_system/now-items/${projectId}.json`;

/** 項目の同一性。同じ入力の同じ欄・同じ本文だけを同じ項目とし、新しい報告で同じ本文が出た場合は別の項目になる。 */
export function itemKey(projectId: string, section: ItemSection, inputId: string, text: string): string {
  return hash(`${projectId}\n${section}\n${inputId}\n${text}`);
}

/** 統合元→統合先。定義を読めないときは読み替えない（定義の不正はHOMEとdoctorで示す）。 */
export async function itemMergeTargets(vault: Vault): Promise<Map<string, string>> {
  try { return mergeTargets((await inspectProjects(vault.config)).projects); } catch { return new Map(); }
}
/**
 * 統合元のプロジェクトで付けた記録を、統合先の項目の記録として読み替える。項目キーはプロジェクトIDを含むため、
 * 記録に残した欄・根拠・本文から統合先でのキーを求め直す。ファイルは書き換えず、統合を取り消せば元に戻る。
 */
export function retargetItemRecord<T extends { project_id: string; item_key: string; section: ItemSection; input_id: string; text: string }>(record: T, targets: Map<string, string>): T {
  const target = targets.get(record.project_id);
  return target ? { ...record, project_id: target, item_key: itemKey(target, record.section, record.input_id, record.text) } : record;
}
/** 統合していた期間。startは統合の記録の日時、endは取り消しの記録の日時（記録がなく手で外した統合は無限）。 */
export interface MergeWindow { from: string; into: string; start: number; end: number }
/**
 * 終わった統合の期間を、統合先のプロジェクトごとに返す。いまも統合されている期間は含めない（統合先への読み替えで扱う）。
 * 統合の記録が読めなくても、項目の記録の読取は止めない（不正な記録はdoctorが示す）。
 */
export async function closedMergeWindows(vault: Vault, targets: Map<string, string>): Promise<Map<string, MergeWindow[]>> {
  const records: { id: string; action: string; from_id: string; into_id: string; changed_at: number; merge_id?: string }[] = [];
  for (const path of await vault.files('90_system/project-merges')) {
    if (!/^90_system\/project-merges\/PMG-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const r = JSON.parse((await vault.read(path))!) as Record<string, unknown>, at = typeof r.changed_at === 'string' ? Date.parse(r.changed_at) : NaN;
      if (typeof r.id !== 'string' || typeof r.action !== 'string' || typeof r.from_id !== 'string' || typeof r.into_id !== 'string' || !Number.isFinite(at)) continue;
      records.push({ id: r.id, action: r.action, from_id: r.from_id, into_id: r.into_id, changed_at: at, ...(typeof r.merge_id === 'string' ? { merge_id: r.merge_id } : {}) });
    } catch { /* 読めない記録は使わない。 */ }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  const windows = new Map<string, MergeWindow[]>();
  for (const m of records) {
    if (m.action !== 'merge') continue;
    const undo = records.find(u => u.action === 'unmerge' && u.id > m.id && (u.merge_id === m.id || (u.merge_id === undefined && u.from_id === m.from_id && u.into_id === m.into_id)));
    // 取り消しの記録がなく、いまも同じ統合先に統合されていれば、続いている統合。
    if (!undo && targets.get(m.from_id) === m.into_id) continue;
    const list = windows.get(m.into_id) ?? [];
    list.push({ from: m.from_id, into: m.into_id, start: m.changed_at, end: undo?.changed_at ?? Number.POSITIVE_INFINITY });
    windows.set(m.into_id, list);
  }
  return windows;
}
/** 記録の日時が、その統合先へfromが統合されていた期間に入るか。 */
export const withinMergeWindow = (windows: Map<string, MergeWindow[]>, into: string, from: string, at: string) => {
  const t = Date.parse(at);
  return windows.get(into)?.some(w => w.from === from && t >= w.start && t < w.end) === true;
};
/**
 * 項目の記録を、いまの統合の状態に合わせて読み替える。
 * - 統合元のプロジェクトで付けた記録は、統合先の項目の記録として読む。
 * - 統合を取り消した後は、統合していた間に統合先で付けた記録のうち、本人が統合元を指定した入力から出た項目のものを、
 *   統合元の項目の記録として読む（根拠の入力が統合元へ戻るため）。統合の前や取り消しの後に統合先で付けた記録は移さない。
 */
export async function settleItemRecords<T extends { project_id: string; item_key: string; section: ItemSection; input_id: string; text: string; created_at: string }>(vault: Vault, records: T[]): Promise<T[]> {
  const targets = await itemMergeTargets(vault), forward = targets.size ? records.map(r => retargetItemRecord(r, targets)) : records;
  const windows = await closedMergeWindows(vault, targets);
  if (!forward.some(r => windows.has(r.project_id))) return forward;
  const owners = new Map((await readInputs(vault.config)).map(i => [i.id, i.project]));
  return forward.map(r => {
    const owner = owners.get(r.input_id), home = owner === undefined ? undefined : targets.get(owner) ?? owner;
    return owner !== undefined && home !== undefined && home !== r.project_id && withinMergeWindow(windows, r.project_id, owner, r.created_at) ? { ...r, project_id: home, item_key: itemKey(home, r.section, r.input_id, r.text) } : r;
  });
}
/** rawを指定すると、統合の読み替えをせず記録のままを返す（同じ受付IDの再送の照合に使う）。 */
export async function readItemResolutions(vault: Vault, options: { raw?: boolean } = {}): Promise<ItemResolution[]> {
  // NOWの作り直しでは直接・外す記録・統合の読み替えの3か所から読むため、Writerロックの1区間では1回だけ読む。
  const result = await readOncePerLock(vault.config, 'item-resolutions', [resolutionDir], () => loadItemResolutions(vault));
  return options.raw ? result : settleItemRecords(vault, result);
}
async function loadItemResolutions(vault: Vault): Promise<ItemResolution[]> {
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
const requestSchema = z.object({ projectId: itemScopeSchema, itemKey: digest, action: z.enum(itemActions), source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), reason: exclusionReasonSchema.optional(), note: exclusionNoteSchema.optional() }).strict();

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
  const unassigned = r.projectId === UNASSIGNED_SCOPE;
  // プロジェクト未定の行は、メモの読み直しや関連の変更をしない。外す理由は「もう古い」（行動ではない・もうやらない）だけ。
  if (unassigned && r.action === 'exclude' && r.reason !== UNASSIGNED_EXCLUSION_REASON) throw new Error('プロジェクト未定の行は、「もう古い」としてだけ外せます（メモの読み直しはしません）');
  const { rebuildUnassignedLocked } = unassigned ? await import('./unassigned-actions.js') : { rebuildUnassignedLocked: undefined };
  return vault.withLock(async () => {
    const projects = await readProjects(config);
    if (!unassigned && !projects.some(p => p.id === r.projectId)) throw new Error('プロジェクトが見つかりません');
    const records = await readItemResolutions(vault);
    // 誤りとして外す・それを戻す操作は、読み直しの結果や帰属の取り消しを通じてほかのプロジェクトのNOWにも及ぶ。
    // プロジェクト未定の行は、その一覧だけを作り直す。
    const rebuild = async (inputId?: string) => {
      if (rebuildUnassignedLocked) { await rebuildUnassignedLocked(config, vault); return; }
      const inputs = await readInputs(config), receipts = await readReceipts(config);
      if (inputId) await rebuildNowsForInputLocked(vault, config, projects.map(p => p.id), inputId, r.projectId, inputs, receipts);
      else await rebuildNowLocked(vault, config, r.projectId, inputs, receipts);
    };
    const wide = (record: ItemResolution, undone?: ItemResolution) => record.action === 'exclude' || undone?.action === 'exclude' ? record.input_id : undefined;
    const before = (record: ItemResolution) => records.filter(x => x.project_id === record.project_id && x.item_key === record.item_key && x.id < record.id).at(-1);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      const previous = (await readItemResolutions(vault, { raw: true })).find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.item_key !== r.itemKey || previous.action !== r.action || previous.reason !== r.reason || previous.note !== r.note) throw new Error('同じ受付IDで別の解決報告が記録されています');
        await rebuild(wide(previous, before(previous)));
        return { projectId: r.projectId, itemKey: r.itemKey, action: r.action, resolutionId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    if (!unassigned) assertNotMerged(projects, r.projectId);
    const items = await readNowItems(vault, r.projectId);
    const item = items?.items.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    const active = activeResolutions(records, r.projectId).get(r.itemKey);
    if (r.action !== 'reopen' && active) throw new ItemTargetError({ code: 'item-closed', state: active.action === 'exclude' ? 'excluded' : 'resolved' }, active.action === 'exclude' ? 'この項目は既に誤りとして外しています。変えるときは未解決に戻してから操作してください' : 'この項目は既に解決済みです');
    if (r.action === 'reopen' && !active) throw new ItemTargetError({ code: 'item-open' }, 'この項目は解決済みではありません');
    // 本人が追加した行動はAIの読み取りではないため、読み違い・別のプロジェクトの話としては外さない（その例をモデルへ渡さないため）。
    if (r.action === 'exclude' && item.action && r.reason !== 'outdated') throw new Error('本人が追加した行動は、「もう古い」としてだけ外せます（読み違い・別のプロジェクトの話はAIの読み取りに使います）');
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
