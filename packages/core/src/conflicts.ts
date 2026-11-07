import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash, markdown, parseMarkdown } from './storage.js';
import { capture, readInputs } from './capture.js';
import { projectIdSchema, readProjects } from './projects.js';
import { autoRegion, nowBaselinePath, readReceipts, rebuildNowLocked } from './views.js';
import type { HubConfig } from './types.js';

/**
 * 生成物の競合（自動領域・生成物を人が書き換えたため、本体が上書きせずに新版を退避した状態）の確認と片付け。
 * 退避は対象ごとにまとめ、本人が確認したハッシュに結び付けて生成版へ戻す。戻す前の内容は記録に残す。
 */
export const conflictDir = '90_system/conflicts';
export const conflictArchiveDir = '90_system/conflict-archive';
const resolutionDir = '90_system/conflict-resolutions';
const ulidPart = '[0-9A-HJKMNP-TV-Z]{26}';
export type ConflictKind = 'now' | 'home' | 'review' | 'other';
export interface ConflictTarget { kind: ConflictKind; target: string; projectId?: string }
/** 戻せる対象。NOWとHOME・REVIEWは入力から作り直せる派生物なので、生成版へ戻しても正本は失われない。 */
export const resolvableTargetSchema = z.union([z.string().regex(/^10_projects\/[a-z0-9][a-z0-9-]{1,40}\/NOW\.md$/), z.enum(['HOME.md', 'REVIEW.md'])]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const conflictResolutionIdSchema = z.string().regex(new RegExp(`^CRS-${ulidPart}$`));

/** 退避ファイル名から、どの生成物の競合かを決める。 */
export function conflictTargetOf(path: string): ConflictTarget {
  const name = path.startsWith(`${conflictDir}/`) ? path.slice(conflictDir.length + 1) : path;
  const now = new RegExp(`^NOW\\.([a-z0-9][a-z0-9-]{1,40})\\.${ulidPart}\\.md$`).exec(name);
  if (now) return { kind: 'now', target: `10_projects/${now[1]}/NOW.md`, projectId: now[1] };
  if (new RegExp(`^HOME\\.md\\.${ulidPart}\\.md$`).test(name)) return { kind: 'home', target: 'HOME.md' };
  if (new RegExp(`^REVIEW\\.md\\.${ulidPart}\\.md$`).test(name)) return { kind: 'review', target: 'REVIEW.md' };
  return { kind: 'other', target: name };
}
/** 同じ対象の既存の退避（名前順＝作成順）。新しい退避を増やさず最新を書き直すために使う。 */
export async function conflictFilesFor(vault: Vault, target: string): Promise<string[]> {
  return (await vault.files(conflictDir)).filter(p => !p.slice(conflictDir.length + 1).includes('/') && conflictTargetOf(p).target === target && conflictTargetOf(p).kind !== 'other');
}

export interface ConflictGroup {
  kind: ConflictKind; target: string; projectId?: string; title?: string;
  /** 退避ファイル。古い順。最後が最新の生成版。 */
  files: string[]; latest: string;
  /** 対象ファイルの現在の内容のハッシュ。resolveの--hashに使う。対象がなければnull。 */
  targetHash: string | null;
  /** 対象ファイルが最後に生成された時点。ここから更新が止まっている。 */
  stoppedAt: string | null;
  /** NOWで手で変えた（最後に書いた生成版にない）行。HOME・REVIEWは派生の一覧なので求めない。 */
  manualLines: string[];
  /** 手で変えた行を求めた基準。generated: 手で変える前の生成版、latest: 基準が残っていないため最新の退避。 */
  baseline: 'generated' | 'latest' | null;
  resolvable: boolean;
}

function editableText(raw: string | undefined, kind: ConflictKind): string {
  if (raw === undefined) return '';
  try {
    const { text } = parseMarkdown(raw);
    if (kind === 'now') return autoRegion(text)?.auto ?? text;
    return text;
  } catch { return raw; }
}
/** 現在の内容のうち、最新の生成版にない行。並べ替えや削除は数えない。 */
export function manualLines(current: string, generated: string): string[] {
  const known = new Set(generated.split(/\r?\n/).map(l => l.trim()));
  return [...new Set(current.split(/\r?\n/).map(l => l.trim()).filter(l => l && !known.has(l)))];
}
/** 手で変える前に書いた自動領域。NOWのgenerated_hashと一致する基準がなければ最新の退避と比べる。 */
async function nowManualLines(vault: Vault, target: string, raw: string | undefined, latest: string): Promise<{ lines: string[]; baseline: 'generated' | 'latest' }> {
  const projectId = target.split('/')[1]!;
  let expected: unknown; try { expected = raw === undefined ? undefined : parseMarkdown(raw).meta.generated_hash; } catch { expected = undefined; }
  try {
    const base = z.object({ schema_version: z.literal(1), project: z.string(), generated_hash: z.string(), auto: z.string() }).strict().parse(JSON.parse((await vault.read(nowBaselinePath(projectId))) ?? 'null'));
    if (base.project === projectId && typeof expected === 'string' && base.generated_hash === expected && `sha256:${hash(base.auto)}` === expected) return { lines: manualLines(editableText(raw, 'now'), base.auto), baseline: 'generated' };
  } catch { /* 基準がない旧版のNOWは、最新の退避と比べる。 */ }
  return { lines: manualLines(editableText(raw, 'now'), editableText(await vault.read(latest), 'now')), baseline: 'latest' };
}
function generatedAt(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try { const value = parseMarkdown(raw).meta.generated_at; return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null; } catch { return null; }
}

export async function listConflicts(config: HubConfig): Promise<ConflictGroup[]> {
  const vault = new Vault(config), groups = new Map<string, ConflictGroup>();
  const projects = await readProjects(config).catch(() => []);
  for (const path of await vault.files(conflictDir)) {
    const t = conflictTargetOf(path), key = `${t.kind}:${t.target}`;
    const group = groups.get(key) ?? { ...t, ...(t.projectId ? { title: projects.find(p => p.id === t.projectId)?.title } : {}), files: [], latest: path, targetHash: null, stoppedAt: null, manualLines: [], baseline: null, resolvable: t.kind !== 'other' };
    group.files.push(path); groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.files.sort(); group.latest = group.files.at(-1)!;
    if (group.kind === 'other') continue;
    const raw = await vault.read(group.target);
    group.targetHash = raw === undefined ? null : hash(raw);
    group.stoppedAt = generatedAt(raw);
    if (group.kind === 'now') { const found = await nowManualLines(vault, group.target, raw, group.latest); group.manualLines = found.lines; group.baseline = found.baseline; }
  }
  return [...groups.values()].sort((a, b) => a.target.localeCompare(b.target));
}

export const conflictResolutionSchema = z.object({
  schema_version: z.literal(1), id: conflictResolutionIdSchema, target: resolvableTargetSchema, kind: z.enum(['now', 'home', 'review']),
  before_hash: digest, replaced_text: z.string(), conflict_files: z.array(z.string()).min(1), memo_input_id: z.string().regex(new RegExp(`^IN-${ulidPart}$`)).optional(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(1000).optional(), resolved_at: z.string().datetime({ offset: true }),
}).strict();
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;
export interface ConflictResolveRequest { target: string; expectedHash: string; source: string; sourceEventId?: string; saveManualAsMemo?: boolean }
export interface ConflictResolveResult { target: string; conflictResolutionId: string; memoInputId?: string; archived: number; deduped: boolean }
const requestSchema = z.object({ target: resolvableTargetSchema, expectedHash: digest, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(1000).optional(), saveManualAsMemo: z.boolean().optional() }).strict();

/** 片付けの失敗理由。受付では理由付きで記録し、HOMEとアプリで次の操作を示す。 */
export class ConflictResolveError extends Error {
  constructor(readonly reason: { code: 'conflict-target-changed' } | { code: 'conflict-missing' }) {
    super(reason.code === 'conflict-target-changed' ? '確認後に対象が変更されています。差分を確認し直してください' : '片付ける競合がありません');
  }
}

export async function readConflictResolutions(vault: Vault): Promise<ConflictResolution[]> {
  const result: ConflictResolution[] = [];
  for (const path of await vault.files(resolutionDir)) {
    if (!new RegExp(`^${resolutionDir}/CRS-${ulidPart}\\.json$`).test(path)) continue;
    const record = conflictResolutionSchema.parse(JSON.parse((await vault.read(path))!));
    if (path !== `${resolutionDir}/${record.id}.json`) throw new Error('競合の片付けの記録とパスが一致しません');
    result.push(record);
  }
  return result;
}

function kindOf(target: string): 'now' | 'home' | 'review' { return target === 'HOME.md' ? 'home' : target === 'REVIEW.md' ? 'review' : 'now'; }
function memoText(target: string, title: string | undefined, lines: string[], max: number): string | undefined {
  if (!lines.length) return undefined;
  const head = `${title ? `プロジェクト「${title}」の` : ''}NOW.md（${target}）の自動領域を手で次のように書き換えていました。生成版に戻す前に、手で変えた行を残したメモです。\n\n`;
  const kept: string[] = []; let length = head.length;
  for (const line of lines) {
    const row = `${line}\n`;
    if (length + row.length + 40 > max) { kept.push(`（ほか${lines.length - kept.length}行は競合の片付けの記録に保存しました）`); break; }
    kept.push(line); length += row.length;
  }
  return head + kept.join('\n');
}

/**
 * 本人が確認した対象ファイルのハッシュに結び付けて、生成物を最新の入力から作り直し、退避を片付ける。
 * NOWでは手で変えた行をメモ（memo、同じプロジェクト）として先に保存する。置き換えた内容は記録に全文残す。
 * 同じ受付IDの再送では、途中で止まった手順だけを続ける。
 */
export async function resolveConflict(config: HubConfig, request: ConflictResolveRequest): Promise<ConflictResolveResult> {
  const r = requestSchema.parse(request), vault = new Vault(config), kind = kindOf(r.target);
  const projectId = kind === 'now' ? projectIdSchema.parse(r.target.split('/')[1]) : undefined;
  const findPrevious = async () => r.sourceEventId ? (await readConflictResolutions(vault)).find(x => x.source === r.source && x.source_event_id === r.sourceEventId) : undefined;
  // 1. 対象と退避を確認し、手で変えた行を求める。モデルは呼ばない。
  const plan = await vault.withLock(async () => {
    const previous = await findPrevious();
    if (previous) {
      if (previous.target !== r.target || previous.before_hash !== r.expectedHash) throw new Error('同じ受付IDで別の競合の片付けが記録されています');
      return { previous };
    }
    const raw = await vault.read(r.target), files = await conflictFilesFor(vault, r.target);
    if (raw === undefined || hash(raw) !== r.expectedHash) throw new ConflictResolveError({ code: 'conflict-target-changed' });
    if (!files.length) throw new ConflictResolveError({ code: 'conflict-missing' });
    const title = projectId ? (await readProjects(config)).find(p => p.id === projectId)?.title : undefined;
    if (projectId && title === undefined) throw new Error('プロジェクトが見つかりません');
    if (kind !== 'now' || r.saveManualAsMemo === false) return { memo: undefined };
    const { lines } = await nowManualLines(vault, r.target, raw, files.at(-1)!);
    return { memo: memoText(r.target, title, lines, config.capture.maxInputChars) };
  });
  // 2. 手で変えた行をメモとして保存する（captureは自身でロックを取り、同じイベントIDの再送では重複保存しない）。
  let memoInputId = 'previous' in plan ? plan.previous?.memo_input_id : undefined;
  if ('memo' in plan && plan.memo) {
    const eventId = r.sourceEventId ? `${r.sourceEventId}:now-manual-edit` : `conflict:${r.target}:${r.expectedHash}`;
    memoInputId = (await capture(config, { source: r.source, sourceEventId: eventId, text: plan.memo, kind: 'memo', occurredAt: new Date().toISOString(), project: projectId })).inputId;
  }
  // 3. 記録を先に作り、作り直しと退避の片付けを行う。
  return vault.withLock(async () => {
    let record = await findPrevious(), deduped = true;
    const raw = await vault.read(r.target);
    if (!record) {
      deduped = false;
      if (raw === undefined || hash(raw) !== r.expectedHash) throw new ConflictResolveError({ code: 'conflict-target-changed' });
      const files = await conflictFilesFor(vault, r.target);
      if (!files.length) throw new ConflictResolveError({ code: 'conflict-missing' });
      record = { schema_version: 1, id: `CRS-${ulid()}`, target: r.target, kind, before_hash: r.expectedHash, replaced_text: raw, conflict_files: files, ...(memoInputId ? { memo_input_id: memoInputId } : {}), source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), resolved_at: new Date().toISOString() };
      if (!await vault.create(`${resolutionDir}/${record.id}.json`, JSON.stringify(record, null, 2) + '\n')) throw new Error('競合の片付けの記録が競合しました');
    }
    // 記録時点の内容のままなら作り直す。既に作り直した後の再送では、残った退避の片付けだけを行う。
    if (raw !== undefined && hash(raw) === record.before_hash) await regenerateLocked(config, vault, record.target, raw);
    let archived = 0;
    for (const path of new Set([...record.conflict_files, ...await conflictFilesFor(vault, record.target)])) {
      const content = await vault.read(path); if (content === undefined) continue;
      await vault.create(`${conflictArchiveDir}/${record.id}/${path.slice(conflictDir.length + 1)}`, content);
      await vault.remove(path); archived++;
    }
    return { target: record.target, conflictResolutionId: record.id, ...(record.memo_input_id ? { memoInputId: record.memo_input_id } : {}), archived, deduped };
  });
}

async function regenerateLocked(config: HubConfig, vault: Vault, target: string, raw: string): Promise<void> {
  const kind = kindOf(target);
  if (kind === 'now') {
    const projectId = target.split('/')[1]!;
    // 自動領域の外（人が書く手動領域）を残すため、今の自動領域のハッシュを付け直してから通常の再生成で置き換える。
    let region: ReturnType<typeof autoRegion>, meta: Record<string, unknown> | undefined;
    try { const parsed = parseMarkdown(raw); meta = parsed.meta; region = autoRegion(parsed.text); if (region) await vault.write(target, markdown({ ...meta, generated_hash: `sha256:${hash(region.auto)}` }, parsed.text)); } catch { region = undefined; }
    if (!region) await vault.remove(target);
    const written = await rebuildNowLocked(vault, config, projectId, await readInputs(config), await readReceipts(config));
    if (written.conflict) throw new Error('NOWを作り直せませんでした。doctorで確認してください');
    return;
  }
  await vault.remove(target);
  if (kind === 'home') {
    const { rebuildDashboardLocked } = await import('./dashboard.js');
    if ((await rebuildDashboardLocked(config, vault)).conflict) throw new Error('HOMEを作り直せませんでした');
  } else {
    let days: number | undefined;
    try { const d = parseMarkdown(raw).meta.period_days; if (typeof d === 'number' && Number.isSafeInteger(d) && d > 0) days = d; } catch { /* 読めないふりかえりは設定の日数で作り直す。 */ }
    const { rebuildDigestLocked } = await import('./digest.js');
    if ((await rebuildDigestLocked(config, vault, days ? { days } : {})).conflict) throw new Error('ふりかえりを作り直せませんでした');
  }
}
