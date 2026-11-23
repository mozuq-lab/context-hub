import { afterEach, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, intakeErrorSchema, intakeErrorMessage, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { hash } from '../src/storage.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { readOrganizeRetries, requestOrganizeRetry } from '../src/organize-retries.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const broken = () => ({ complete: vi.fn(async () => ({ text: '{不正JSON' })) });

async function failed(maxAttempts = 3) {
  const { config, vault } = await workflowSetup(roots);
  config.organize.maxAttempts = maxAttempts;
  const saved = await capture(config, { source: 'cli', text: 'いつか試す', occurredAt: '2026-11-20T00:00:00Z', receivedAt: '2026-11-20T00:00:00Z' });
  const llm = broken();
  expect((await organize(config, llm)).failed).toBe(1);
  const receipt = async () => JSON.parse((await vault.read(`90_system/receipts/${saved.inputId}.json`))!);
  return { config, vault, saved, receipt };
}

test('頼んだ1件だけを次の整理で1回試し、上限の回数を使い切っていても試す。成功すれば整理済みになる', async () => {
  const { config, vault, saved, receipt } = await failed(1);
  const other = await capture(config, { source: 'cli', text: 'ほかの失敗', occurredAt: '2026-11-21T00:00:00Z', receivedAt: '2026-11-21T00:00:00Z' });
  const llm = broken();
  await organize(config, llm);
  expect((await vault.read(`90_system/receipts/${other.inputId}.json`))).toContain('"failed"');
  // 頼まなければ、上限に達した失敗は試さない（--retry-failedでも）。
  llm.complete.mockClear();
  expect((await organize(config, llm, { retryFailed: true })).inputIds).toEqual([]);
  const result = await requestOrganizeRetry(config, { inputId: saved.inputId, attempts: 1, source: 'cli' });
  expect(result).toMatchObject({ inputId: saved.inputId, deduped: false });
  expect(result.retryId).toMatch(/^ORT-/);
  // もう一度頼んでも、使っていない依頼があれば記録を増やさない。
  expect((await requestOrganizeRetry(config, { inputId: saved.inputId, attempts: 1, source: 'cli' })).deduped).toBe(true);
  expect((await readOrganizeRetries(vault)).records).toHaveLength(1);
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain(`[${saved.inputId}](${saved.path}): 整理失敗（やり直しを頼まれています。次の整理で試します）`);
  // 頼んだ1件だけを試す（ほかの失敗は試さない）。失敗すれば依頼は使い終わり、続けては試さない。
  const tried = await organize(config, llm);
  expect(tried.inputIds).toEqual([saved.inputId]);
  expect(tried.failed).toBe(1);
  expect((await receipt()).attempts).toBe(2);
  expect((await organize(config, llm)).inputIds).toEqual([]);
  // 頼み直せば、もう1回だけ試す。今度は成功する。
  await requestOrganizeRetry(config, { inputId: saved.inputId, attempts: 2, source: 'cli' });
  expect((await organize(config, new MockLlm())).processed).toBe(1);
  expect((await receipt())).toMatchObject({ status: 'organized', attempts: 3 });
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).not.toContain('やり直しを頼まれています');
  expect((await doctor(config)).issues.filter(i => i.includes('やり直し'))).toEqual([]);
});

test('失敗していないメモ・訂正の届いたメモ・行動・試行回数の変わったメモは、理由を付けて断る', async () => {
  const { config, saved } = await failed();
  const refused = (inputId: string, attempts: number) => requestOrganizeRetry(config, { inputId, attempts, source: 'cli' }).then(() => undefined, (e: { reason?: unknown }) => e.reason);
  expect(await refused(saved.inputId, 2)).toEqual({ code: 'organize-retry-refused', cause: 'changed' });
  expect(await refused('IN-00000000000000000000000000', 1)).toEqual({ code: 'organize-retry-refused', cause: 'missing' });
  const action = await capture(config, { source: 'cli', kind: 'action', text: '請求書を送る', occurredAt: '2026-11-21T00:00:00Z' });
  expect(await refused(action.inputId, 1)).toEqual({ code: 'organize-retry-refused', cause: 'action' });
  const waiting = await capture(config, { source: 'cli', text: 'まだ整理していない', occurredAt: '2026-11-21T00:00:00Z' });
  expect(await refused(waiting.inputId, 1)).toEqual({ code: 'organize-retry-refused', cause: 'not-failed' });
  const corrected = await correctInput(config, saved.inputId, { source: 'cli', text: 'いつか試す（訂正）', occurredAt: '2026-11-22T00:00:00Z' });
  expect(await refused(saved.inputId, 1)).toEqual({ code: 'organize-retry-refused', cause: 'superseded' });
  expect(await refused(corrected.inputId, 1)).toEqual({ code: 'organize-retry-refused', cause: 'not-failed' });
});

test('受付の依頼で頼め、同じ受付IDの再送は記録を増やさず、断った依頼は理由を残して再試行しない', async () => {
  const { config, vault, saved, receipt } = await failed();
  expect(intakeFeatures(config).operations).toContain('organize-retry');
  const p = await packet(config, { operation: 'organize-retry', input_id: saved.inputId, attempts: 1, confirmed: true }, '');
  const run = await ingest(config);
  expect(run.accepted).toBe(1);
  const ack = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(ack.operation).toBe('organize-retry');
  expect(ack.result).toMatchObject({ inputId: saved.inputId, deduped: false });
  expect((await ingest(config)).accepted).toBe(0);
  // 受領記録のHOMEの行に、入力へのリンクを付けない（やり直しの依頼の結果は入力を作らない）。
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).not.toContain('(undefined)');
  expect((await organize(config, new MockLlm())).processed).toBe(1);
  expect((await receipt()).status).toBe('organized');
  // 整理済みのメモへのやり直しは、理由を付けて断る。
  const late = await packet(config, { operation: 'organize-retry', input_id: saved.inputId, attempts: 1, confirmed: true }, '');
  expect((await ingest(config)).rejected).toBe(1);
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(late.path)}.json`))!));
  expect(error.reason).toEqual({ code: 'organize-retry-refused', cause: 'not-failed' });
  expect(intakeErrorMessage(error)).toContain('整理に失敗していません');
  expect((await ingest(config)).rejected).toBe(0);
  // 本文や確認のない依頼は受け付けない。
  await packet(config, { operation: 'organize-retry', input_id: saved.inputId, attempts: 1 }, '');
  expect((await ingest(config)).rejected).toBe(1);
});
