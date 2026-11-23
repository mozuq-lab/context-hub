import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { inputIdSchema } from './capture.js';
import { readCorrectionChains } from './corrections.js';
import { readReceipts } from './views.js';
import type { HubConfig, Receipt } from './types.js';

/**
 * 本人が頼んだ「整理のやり直し」。AIの読み取り（整理）に失敗したメモ1件だけを、次の整理でもう一度モデルへ渡す。
 * - 全体の`organize --retry-failed`（失敗した全件を、設定の`organize.maxAttempts`回まで）とは別に、本人が選んだ1件だけを対象にする。
 * - 依頼1件につき1回だけ試す。依頼した時点の試行回数（attempts）を記録し、receiptの試行回数がそれを超えたら使い終えたとする。
 *   本人の依頼なので`organize.maxAttempts`には縛られないが、同じ失敗に重ねて依頼しても試すのは1回だけ。
 * - 原文・receipt・整理結果は書き換えない。依頼の記録を作るだけで、試すのは次の整理（cycle）。
 */
export const organizeRetryIdSchema = z.string().regex(/^ORT-[0-9A-HJKMNP-TV-Z]{26}$/);
export const organizeRetryRecordSchema = z.object({
  schema_version: z.literal(1), id: organizeRetryIdSchema, input_id: inputIdSchema,
  // 依頼した時点の、失敗したreceiptの試行回数。
  attempts: z.number().int().min(1),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type OrganizeRetryRecord = z.infer<typeof organizeRetryRecordSchema>;
const retryDir = '90_system/organize-retries';
const retryPath = (id: string) => `${retryDir}/${id}.json`;

/** 記録と、読めなかった記録のパス。不正な記録があっても整理は止めず、doctorで示す。 */
export async function readOrganizeRetries(vault: Vault): Promise<{ records: OrganizeRetryRecord[]; problems: string[] }> {
  const records: OrganizeRetryRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(retryDir)) {
    if (!/^90_system\/organize-retries\/ORT-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = organizeRetryRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== retryPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  return { records: records.sort((a, b) => a.id.localeCompare(b.id)), problems };
}

/** まだ使っていないやり直しの依頼がある入力ID（今のreceiptが失敗のままで、試行回数が依頼した時点と同じもの）。 */
export function pendingOrganizeRetries(records: readonly OrganizeRetryRecord[], receipts: ReadonlyMap<string, Pick<Receipt, 'status' | 'attempts'>>): Set<string> {
  const pending = new Set<string>();
  for (const r of records) { const receipt = receipts.get(r.input_id); if (receipt?.status === 'failed' && receipt.attempts === r.attempts) pending.add(r.input_id); }
  return pending;
}

/**
 * 受け付けられない理由。同じ内容の依頼は何度送っても同じ結果になるため、受付は再試行しない。
 * missing: メモが見つからない / action: 本人が追加した行動（整理しない） / superseded: 訂正が届いていて、このメモの整理は使われない /
 * not-failed: 整理に失敗していない（整理済み・まだ整理していない） / changed: 確かめた後に整理が試され、試行回数が変わった。
 */
export const organizeRetryRefusalCauses = ['missing', 'action', 'superseded', 'not-failed', 'changed'] as const;
export type OrganizeRetryReason = { code: 'organize-retry-refused'; cause: typeof organizeRetryRefusalCauses[number] };
export class OrganizeRetryError extends Error {
  constructor(readonly reason: OrganizeRetryReason) { super(organizeRetryMessage(reason)); this.name = 'OrganizeRetryError'; }
}
export function organizeRetryMessage(reason: OrganizeRetryReason): string {
  switch (reason.cause) {
    case 'missing': return 'やり直すメモが見つかりません。同期してから、もう一度確かめてください。';
    case 'action': return '本人が追加した行動はAIで整理しないため、やり直しはありません。';
    case 'superseded': return 'このメモには訂正が届いています。訂正した後のメモが整理されるので、やり直しは要りません。';
    case 'not-failed': return 'このメモは整理に失敗していません（整理済みか、まだ整理を待っています）。同期してから確かめてください。';
    case 'changed': return '確かめた後に、このメモの整理がもう一度試されています。同期して結果を確かめ、まだ失敗していれば、もう一度頼んでください。';
  }
}

export interface OrganizeRetryRequest { inputId: string; attempts: number; source: string; sourceEventId?: string }
export interface OrganizeRetryResult { inputId: string; retryId: string; deduped: boolean }
const requestSchema = z.object({ inputId: inputIdSchema, attempts: z.number().int().min(1), source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional() }).strict();

/**
 * 整理に失敗したメモ1件のやり直しを頼む。attemptsは本人が確かめた時点の試行回数で、今のreceiptと違えば受け付けない。
 * 同じ失敗に使っていない依頼が既にあれば（別の端末や二度押し）、記録を増やさずに受け付ける。
 */
export async function requestOrganizeRetry(config: HubConfig, request: OrganizeRetryRequest): Promise<OrganizeRetryResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    const { records } = await readOrganizeRetries(vault);
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.input_id !== r.inputId || previous.attempts !== r.attempts) throw new Error('同じ受付IDで別のやり直しが記録されています');
        return { inputId: r.inputId, retryId: previous.id, deduped: true };
      }
    }
    // 同じ失敗（試行回数）へのやり直しが既に記録されていれば、使い終えていても受け付ける（受付の再送が、やり直した後に届いた場合）。
    const same = records.find(x => x.input_id === r.inputId && x.attempts === r.attempts);
    if (same) return { inputId: r.inputId, retryId: same.id, deduped: true };
    const chains = await readCorrectionChains(config), refuse = (cause: OrganizeRetryReason['cause']) => new OrganizeRetryError({ code: 'organize-retry-refused', cause });
    const chain = chains.find(c => c.root.id === r.inputId || c.revisions.some(i => i.id === r.inputId));
    if (!chain) throw refuse('missing');
    if (chain.root.kind === 'action') throw refuse('action');
    if (chain.latest.id !== r.inputId) throw refuse('superseded');
    const receipt = (await readReceipts(config)).find(x => x.input_id === r.inputId);
    if (receipt?.status !== 'failed') throw refuse('not-failed');
    if (receipt.attempts !== r.attempts) throw refuse('changed');
    const record: OrganizeRetryRecord = { schema_version: 1, id: `ORT-${ulid()}`, input_id: r.inputId, attempts: r.attempts, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString() };
    if (!await vault.create(retryPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('やり直しの記録が競合しました');
    return { inputId: r.inputId, retryId: record.id, deduped: false };
  });
}
