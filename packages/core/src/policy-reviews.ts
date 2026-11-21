import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, parseMarkdown } from './storage.js';
import { collectPolicyState, type PolicyEntry } from './policy-manifest.js';
import { knowledgeIdSchema } from './knowledge-scope.js';
import { reviewRead } from './knowledge-candidates.js';
import type { HubConfig, Input } from './types.js';

/**
 * 採用した方針（判断・好み）の見直し。方針は本人が適用停止するまでAIに渡り続けるため、採用から（または前回「まだ有効」と
 * 確かめてから）一定日数が過ぎた方針を本人に見せる。見直しは知らせるだけで、期限が来ても方針を止めない。
 * 「まだ有効」の記録は作るだけで書き換えず、確かめた方針の内容のハッシュに結び付ける。参考知識（knowledge）は対象にしない。
 */
const DAY = 86_400_000;
export const DEFAULT_POLICY_REVIEW_DAYS = 90;
/** HOMEに並べる見直す方針の件数。導入直後に古い方針が一度に並ばないよう、古い順にこの件数だけ出す。 */
export const POLICY_REVIEW_ROWS = 3;
export const policyReviewIdSchema = z.string().regex(/^PREV-[0-9A-HJKMNP-TV-Z]{26}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const policyReviewSchema = z.object({
  schema_version: z.literal(1), id: policyReviewIdSchema, knowledge_id: knowledgeIdSchema, knowledge_hash: digest,
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), reviewed_at: z.string().datetime({ offset: true }),
}).strict();
export type PolicyReview = z.infer<typeof policyReviewSchema>;
const reviewDir = '90_system/policy-reviews';
const reviewPath = (id: string) => `${reviewDir}/${id}.json`;

export function policyReviewDays(config: Pick<HubConfig, 'policy'>): number { return config.policy.reviewDays ?? DEFAULT_POLICY_REVIEW_DAYS; }

/** 記録と、読めなかった記録のパス。不正な記録があってもHOMEの生成は止めず、HOMEとdoctorで示す。 */
export async function readPolicyReviews(vault: Vault): Promise<{ records: PolicyReview[]; problems: string[] }> {
  const records: PolicyReview[] = [], problems: string[] = [];
  for (const path of await vault.files(reviewDir)) {
    if (!/^90_system\/policy-reviews\/PREV-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = policyReviewSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== reviewPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  return { records: records.sort((a, b) => Date.parse(a.reviewed_at) - Date.parse(b.reviewed_at) || a.id.localeCompare(b.id)), problems };
}

export interface PolicyReviewItem {
  knowledgeId: string; kind: PolicyEntry['kind']; claim: string; path: string; hash: string;
  /** 共通の方針はnull。 */ projectId: string | null;
  approvedAt: string; /** 今の内容で最後に「まだ有効」と確かめた日時。 */ confirmedAt?: string;
  /** 採用か、最後に確かめた日時のうち新しい方。見直しの日数はここから数える。 */ since: string;
  due: boolean; days: number;
  /** プロジェクトの方針だけ。since以降に届いた、このプロジェクトを指定したメモ・作業要約の件数（考えが変わったかもしれない手がかり）。 */
  newInputs?: number;
}
/**
 * 有効な方針ごとの見直しの状態。見直しの日数が0なら空。方針の集約を読めないときは例外を投げる（呼び出し元がHOMEで示す）。
 * inputsを渡すと、プロジェクトの方針にsince以降のメモの件数を添える。
 */
export async function policyReviewItems(config: HubConfig, vault: Vault, options: { now?: Date; inputs?: Input[] } = {}): Promise<{ items: PolicyReviewItem[]; problems: string[] }> {
  const days = policyReviewDays(config), now = options.now ?? new Date();
  if (days <= 0) return { items: [], problems: [] };
  const state = await collectPolicyState(vault), reviews = await readPolicyReviews(vault);
  const entries: [PolicyEntry, string | null][] = [...state.global.map(e => [e, null] as [PolicyEntry, null]), ...Object.entries(state.projects).flatMap(([id, list]) => list.map(e => [e, id] as [PolicyEntry, string]))];
  const items: PolicyReviewItem[] = [];
  for (const [entry, projectId] of entries) {
    const hash = state.dependencies[entry.path], raw = await reviewRead(vault, entry.path);
    if (hash === undefined || raw === undefined) continue;
    const approvedAt = parseMarkdown(raw).meta.approved_at;
    if (typeof approvedAt !== 'string' || !Number.isFinite(Date.parse(approvedAt))) continue;
    const confirmedAt = reviews.records.filter(r => r.knowledge_id === entry.id && r.knowledge_hash === hash).at(-1)?.reviewed_at;
    const since = confirmedAt !== undefined && Date.parse(confirmedAt) > Date.parse(approvedAt) ? confirmedAt : approvedAt;
    const elapsed = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / DAY));
    const newInputs = projectId !== null && options.inputs ? options.inputs.filter(i => i.project === projectId && i.kind !== 'correction' && Date.parse(i.received_at) > Date.parse(since)).length : undefined;
    items.push({ knowledgeId: entry.id, kind: entry.kind, claim: entry.claim, path: entry.path, hash, projectId, approvedAt, ...(confirmedAt ? { confirmedAt } : {}), since, due: elapsed >= days, days: elapsed, ...(newInputs !== undefined ? { newInputs } : {}) });
  }
  // 長く確かめていない順。
  items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.knowledgeId.localeCompare(b.knowledgeId));
  return { items, problems: reviews.problems };
}

export type PolicyKeepRefusal = 'missing' | 'changed' | 'inactive';
export class PolicyReviewError extends Error {
  constructor(readonly reason: { code: 'policy-review-refused'; cause: PolicyKeepRefusal }) { super(policyReviewMessage(reason)); }
}
export function policyReviewMessage(reason: { cause: PolicyKeepRefusal }): string {
  return reason.cause === 'changed' ? '確かめた後に方針の内容が変わっています。同期してから、採用履歴で確かめ直してください。'
    : reason.cause === 'inactive' ? 'この方針はもう有効ではありません（適用停止・置き換え・手での変更）。同期してから、採用履歴を確かめてください。'
      : '確かめた方針が見つかりません。同期してから、採用履歴を確かめてください。';
}
export interface PolicyKeepRequest { knowledgeId: string; expectedHash: string; source: string; sourceEventId?: string; reviewedAt?: string }
/** 本人が「まだ有効」と確かめた記録を作る。同じ出典・イベントIDの再送では既存の記録を返す。 */
export async function keepPolicy(config: HubConfig, request: PolicyKeepRequest): Promise<{ knowledgeId: string; reviewId: string; deduped: boolean }> {
  const r = z.object({ knowledgeId: knowledgeIdSchema, expectedHash: digest, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), reviewedAt: z.string().datetime({ offset: true }).optional() }).strict().parse(request);
  const vault = new Vault(config);
  return vault.withLock(async () => {
    const reviews = await readPolicyReviews(vault);
    if (r.sourceEventId !== undefined) {
      const same = reviews.records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (same) {
        if (same.knowledge_id !== r.knowledgeId || same.knowledge_hash !== r.expectedHash) throw new Error('同じイベントで別の方針を確かめた記録があります');
        return { knowledgeId: same.knowledge_id, reviewId: same.id, deduped: true };
      }
    }
    const state = await collectPolicyState(vault);
    const entry = [...state.global, ...Object.values(state.projects).flat()].find(e => e.id === r.knowledgeId);
    if (!entry) {
      const exists = state.inactiveIds.includes(r.knowledgeId);
      throw new PolicyReviewError({ code: 'policy-review-refused', cause: exists ? 'inactive' : 'missing' });
    }
    if (state.dependencies[entry.path] !== r.expectedHash) throw new PolicyReviewError({ code: 'policy-review-refused', cause: 'changed' });
    const record: PolicyReview = { schema_version: 1, id: `PREV-${ulid()}`, knowledge_id: r.knowledgeId, knowledge_hash: r.expectedHash, source: r.source, ...(r.sourceEventId !== undefined ? { source_event_id: r.sourceEventId } : {}), reviewed_at: r.reviewedAt ?? new Date().toISOString() };
    if (!await vault.create(reviewPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('見直しの記録が競合しました');
    return { knowledgeId: record.knowledge_id, reviewId: record.id, deduped: false };
  });
}
