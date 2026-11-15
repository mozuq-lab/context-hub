import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { Vault } from './storage.js';
import { readPolicies, formatPolicies } from './policies.js';
import { readProjects } from './projects.js';
import { candidateProjects } from './project-status.js';
import { activeExclusions, readItemResolutions, wrongProjectsByInput, type ItemResolution } from './item-resolutions.js';
import { rereadResultSchema, type ExcludedItemRef, type RereadResult } from './llm.js';
import { evidenceUnchangedLocked } from './associations.js';
import type { EffectiveInput } from './effective-inputs.js';
import type { HubConfig, OrganizeResult, Project, Receipt } from './types.js';

/**
 * 本人が「誤り」として外した項目の入力を、理由と一言を添えてAIに読み直させた結果。
 * 処理記録（receipt）は書き換えず、要約・分類・帰属候補・抽出だけを上から重ねる派生の記録にする。
 * 知識・プロジェクト案の候補とアイデアは処理記録に結び付いているため、読み直しでは作り直さない。
 * 重ねるのは、同じ根拠・同じ処理記録・同じ「外す」記録の組に対する読み直しだけ。外す記録を戻せば元の解釈に戻る。
 */
const inputId = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/), resolutionId = z.string().regex(/^RES-[0-9A-HJKMNP-TV-Z]{26}$/);
export const rereadSchema = z.object({
  schema_version: z.literal(1), input_id: inputId, latest_input_id: inputId, evidence_hash: z.string().regex(/^[a-f0-9]{64}$/), receipt_organized_at: z.string().datetime({ offset: true }),
  resolution_ids: z.array(resolutionId).min(1).max(200), status: z.enum(['reread', 'failed']), attempts: z.number().int().min(1), result: rereadResultSchema.nullable(), error: z.string().nullable(),
  reread_at: z.string().datetime({ offset: true }), model: z.string(),
  // 読み直しを保存した後、関わるNOWを作り直し終えたか。途中で止まった場合は次の実行で作り直す。
  views_complete: z.boolean(),
}).strict().refine(r => r.status === 'reread' ? r.result !== null && r.error === null : r.result === null && r.error !== null);
export type Reread = z.infer<typeof rereadSchema>;
const rereadDir = '90_system/item-rereads';
export const rereadPath = (rootId: string) => `${rereadDir}/${rootId}.json`;

/** 読み直しの記録。壊れた記録は使わず（元の解釈のまま表示して次の実行で読み直す）、パスを返してdoctorとHOMEで示す。 */
export async function readRereads(vault: Vault): Promise<{ records: Map<string, Reread>; problems: string[] }> {
  const records = new Map<string, Reread>(), problems: string[] = [];
  for (const path of await vault.files(rereadDir)) {
    if (!path.endsWith('.json')) continue;
    try {
      const record = rereadSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== rereadPath(record.input_id)) throw new Error();
      records.set(record.input_id, record);
    } catch { problems.push(path); }
  }
  return { records, problems };
}

/** 本人の「誤りとして外す」記録が、整理結果の読み方に及ぼす上書き。 */
export interface ExclusionOverlays { exclusions: ItemResolution[]; wrongProjects: Map<string, Set<string>>; rereads: Map<string, Reread>; problems: string[] }
export async function readExclusionOverlays(vault: Vault): Promise<ExclusionOverlays> {
  const exclusions = activeExclusions(await readItemResolutions(vault));
  // 外す記録が1件もなければ、読み直しの記録は使われない。
  const { records, problems } = exclusions.length ? await readRereads(vault) : { records: new Map<string, Reread>(), problems: [] };
  return { exclusions, wrongProjects: wrongProjectsByInput(exclusions), rereads: records, problems };
}
/**
 * 読み直しを求める「外す」記録のID（古い順）。読み違いと、AIが推定した帰属に対する「別のプロジェクトの話」が対象。
 * 「もう古い」と、本人が指定したプロジェクトでの「別のプロジェクトの話」は、項目を外すだけで読み直さない。
 * 今の処理記録より前の記録は、その整理のときに既にモデルへ渡しているため含めない（訂正が届いて整理し直した後など）。
 */
export function rereadResolutionIds(exclusions: ItemResolution[], root: { id: string; project?: string }, organizedAt: string): string[] {
  const since = Date.parse(organizedAt);
  return exclusions.filter(r => r.input_id === root.id && Date.parse(r.created_at) >= since && (r.reason === 'misread' || (r.reason === 'wrong-project' && r.project_id !== root.project))).map(r => r.id);
}
/** この有効解釈に今も重ねる読み直し。訂正待ちの間は、訂正を含めた整理を待つため重ねない。 */
export function appliedReread(overlays: ExclusionOverlays, unit: EffectiveInput): Reread | undefined {
  const { chain, receipt, pendingCorrection } = unit, record = overlays.rereads.get(chain.root.id);
  if (!record || record.status !== 'reread' || pendingCorrection || !receipt?.result || receipt.input_id !== chain.latest.id) return undefined;
  if (record.latest_input_id !== chain.latest.id || record.evidence_hash !== chain.evidenceHash || record.receipt_organized_at !== receipt.organized_at) return undefined;
  return isDeepStrictEqual(record.resolution_ids, rereadResolutionIds(overlays.exclusions, chain.root, receipt.organized_at)) ? record : undefined;
}
/**
 * 処理記録の結果へ読み直しを重ねる。アイデアとして保存した入力は、アイデアの本文（要約）と食い違わないよう分類と要約を変えない。
 * 読み直しでアイデアへ変わった場合も、アイデアのファイルは作らないため分類と要約は元のままにする。
 */
export function overlayReread(result: OrganizeResult, reread: RereadResult): OrganizeResult {
  const keep = result.category === 'idea' || reread.category === 'idea';
  return { ...result, ...(keep ? {} : { category: reread.category, summary: reread.summary }), project_candidates: reread.project_candidates, next_action_suggestions: reread.next_action_suggestions, extracted: reread.extracted };
}

const EXCLUDED_OWN_MAX = 10, EXCLUDED_OTHERS_MAX = 10, EXCLUDED_TEXT_CHARS = 200;
/**
 * 整理・読み直しのときにモデルへ見せる、本人が誤りとして外した項目。
 * この入力から外された項目はすべて、ほかの入力の例は読み違いと「別のプロジェクトの話」だけを新しい順に見せる。
 * 本人がプロジェクトを指定した入力にはそのプロジェクトの例だけ、指定のない入力には帰属候補として示すプロジェクトの例を見せる。
 */
export function excludedRefsFor(exclusions: ItemResolution[], root: { id: string; project?: string }, offeredProjectIds: string[]): ExcludedItemRef[] {
  const ref = (own: boolean) => (r: ItemResolution): ExcludedItemRef => ({ project: r.project_id, section: r.section, reason: r.reason!, text: r.text.slice(0, EXCLUDED_TEXT_CHARS), ...(r.note ? { note: r.note } : {}), own });
  const scope = new Set(root.project ? [root.project] : offeredProjectIds);
  const own = exclusions.filter(r => r.input_id === root.id && r.reason).slice(-EXCLUDED_OWN_MAX);
  const others = exclusions.filter(r => r.input_id !== root.id && scope.has(r.project_id) && (r.reason === 'misread' || r.reason === 'wrong-project')).slice(-EXCLUDED_OTHERS_MAX).reverse();
  return [...own.map(ref(true)), ...others.map(ref(false))];
}
/** この入力について、本人が「別のプロジェクトの話」として外したプロジェクト。本人が指定したプロジェクトは含めない。 */
export function wrongProjectsFor(overlays: Pick<ExclusionOverlays, 'wrongProjects'>, root: { id: string; project?: string }): Set<string> {
  return new Set([...(overlays.wrongProjects.get(root.id) ?? [])].filter(id => id !== root.project));
}

/** ロック内で確定した読み直しの対象。モデル呼び出しはロック外で行い、確定時に同じ根拠・定義・方針・外す記録かを再検査する。 */
export interface RereadPlan { effective: EffectiveInput; projects: Project[]; snapshot: string; record: Reread; policyText: string; policyRevision: string; excludedItems: ExcludedItemRef[]; wrongProjects: Set<string> }
/**
 * 読み直しが要るかを決める。'recover'は、読み直しを保存した後のNOWの作り直しが途中で止まっているもの。
 * 失敗した読み直しは、同じ「外す」記録の組に対しては --retry-failed のときだけ、上限回数まで試す。
 */
export async function prepareRereadLocked(config: HubConfig, effective: EffectiveInput, projects: Project[], overlays: ExclusionOverlays, options: { retryFailed?: boolean } = {}): Promise<RereadPlan | 'recover' | undefined> {
  const { chain, receipt, pendingCorrection } = effective;
  if (pendingCorrection || !receipt?.result || receipt.status !== 'organized' || receipt.input_id !== chain.latest.id) return undefined;
  const ids = rereadResolutionIds(overlays.exclusions, chain.root, receipt.organized_at);
  if (!ids.length) return undefined;
  const existing = overlays.rereads.get(chain.root.id);
  const bound = existing && existing.latest_input_id === chain.latest.id && existing.evidence_hash === chain.evidenceHash && existing.receipt_organized_at === receipt.organized_at && isDeepStrictEqual(existing.resolution_ids, ids) ? existing : undefined;
  if (bound?.status === 'reread') return bound.views_complete ? undefined : 'recover';
  if (bound && !(options.retryFailed && bound.attempts < config.organize.maxAttempts)) return undefined;
  const policies = await readPolicies(config, chain.root.project), wrongProjects = wrongProjectsFor(overlays, chain.root);
  const offered = candidateProjects(projects, chain.root.project).filter(p => !wrongProjects.has(p.id)).map(p => p.id);
  const record: Reread = {
    schema_version: 1, input_id: chain.root.id, latest_input_id: chain.latest.id, evidence_hash: chain.evidenceHash, receipt_organized_at: receipt.organized_at, resolution_ids: ids,
    status: 'reread', attempts: (bound?.attempts ?? 0) + 1, result: null, error: null, reread_at: new Date().toISOString(), model: config.organize.llm.model ?? (config.organize.llm.provider === 'mock' ? 'mock' : 'inherited-unverified'), views_complete: false,
  };
  return { effective, projects, snapshot: JSON.stringify(projects), record, policyText: formatPolicies(policies), policyRevision: policies.revision, excludedItems: excludedRefsFor(overlays.exclusions, chain.root, offered), wrongProjects };
}
async function receiptOrganizedAt(vault: Vault, id: string): Promise<string | undefined> {
  const raw = await vault.read(`90_system/receipts/${id}.json`);
  if (raw === undefined) return undefined;
  try { const value = JSON.parse(raw) as Partial<Receipt>; return value.status === 'organized' && typeof value.organized_at === 'string' ? value.organized_at : undefined; } catch { return undefined; }
}
/**
 * 根拠・最新訂正・処理記録・プロジェクト定義・方針・外す記録がモデル呼び出し前と同じときだけ保存する。
 * 変わっていればundefinedを返し、次回の実行に任せる。失敗の記録も同じ条件で残し、同じ組への再試行を数える。
 */
export async function commitRereadLocked(config: HubConfig, vault: Vault, plan: RereadPlan, record: Reread, options: { inboxUnchanged?: boolean } = {}): Promise<Reread | undefined> {
  const { chain } = plan.effective;
  if (!await evidenceUnchangedLocked(config, vault, plan.effective, options.inboxUnchanged)) return undefined;
  if (plan.snapshot !== JSON.stringify(await readProjects(config))) return undefined;
  let revision: string | undefined; try { revision = (await readPolicies(config, chain.root.project)).revision; } catch { revision = undefined; }
  if (revision !== plan.policyRevision) return undefined;
  if (await receiptOrganizedAt(vault, chain.latest.id) !== record.receipt_organized_at) return undefined;
  // 待機中に本人が外す記録を足した・戻した場合は、古い組への読み直しを保存しない。
  if (!isDeepStrictEqual(rereadResolutionIds(activeExclusions(await readItemResolutions(vault)), chain.root, record.receipt_organized_at), record.resolution_ids)) return undefined;
  const committed: Reread = { ...record, reread_at: new Date().toISOString(), views_complete: false };
  await vault.write(rereadPath(chain.root.id), JSON.stringify(committed, null, 2) + '\n');
  return committed;
}
/** 関わるNOWを作り直し終えたことを記録する。作り直しの間に記録が変わっていれば何もしない。 */
export async function markRereadViewsCompleteLocked(vault: Vault, record: Reread): Promise<void> {
  const raw = await vault.read(rereadPath(record.input_id));
  if (raw === undefined) return;
  let current: Reread; try { current = rereadSchema.parse(JSON.parse(raw)); } catch { return; }
  if (current.reread_at !== record.reread_at || current.views_complete) return;
  await vault.write(rereadPath(record.input_id), JSON.stringify({ ...current, views_complete: true }, null, 2) + '\n');
}
