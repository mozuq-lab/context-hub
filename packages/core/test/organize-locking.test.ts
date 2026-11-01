import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { doctor } from '../src/doctor.js';
import { addProject, readProjects } from '../src/projects.js';
import { decideProject, listProjectCandidates } from '../src/project-proposals.js';
import { Vault } from '../src/storage.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { PromptTooLargeError } from '../src/infer.js';
import type { HubConfig, LlmCompletion, OrganizeResult } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(): Promise<HubConfig> {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-organize-lock-')); roots.push(root);
  const config = defaultConfig(path.join(root, 'vault'), path.join(root, 'state')); await new Vault(config).init(); return config;
}
const valid = (): OrganizeResult => ({ category: 'idea', summary: '試すと面白そう', project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null });
const add = (config: HubConfig, text = 'いつか試すと面白そう') => capture(config, { source: 'cli', text, occurredAt: '2026-09-14T09:00:00+09:00' });

/** モデル呼び出しの途中で止め、その間に別の操作を差し込むためのLLM。 */
function pausedLlm() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const complete = vi.fn(async (): Promise<LlmCompletion> => { entered(); await gate; return { text: JSON.stringify(valid()) }; });
  return { llm: { complete }, complete, started, release };
}

describe('モデル呼び出し中はVaultのwriterロックを保持しない', () => {
  test('整理のモデル待機中もcaptureが成功し、整理結果も確定する', async () => {
    const config = await setup(); const saved = await add(config); const { llm, started, release } = pausedLlm();
    const running = organize(config, llm); await started;
    // 以前は整理がロックを保持し続けるため、ここで10秒待って失敗していた。
    const during = await Promise.race([add(config, '整理中に届いたメモ'), new Promise<'timeout'>(done => setTimeout(() => done('timeout'), 3000))]);
    release();
    const result = await running;
    expect(during).not.toBe('timeout');
    expect(result.processed).toBe(1);
    const vault = new Vault(config);
    expect(await vault.read(`90_system/receipts/${saved.inputId}.json`)).toBeDefined();
    expect(await vault.read(`90_system/receipts/${(during as { inputId: string }).inputId}.json`)).toBeUndefined();
  }, 10_000);

  test('モデル待機中に訂正が届いた対象は書き込まず、次回は訂正後を整理する', async () => {
    const config = await setup(); const saved = await add(config); const { llm, started, release } = pausedLlm();
    const running = organize(config, llm); await started;
    const corrected = await correctInput(config, saved.inputId, { source: 'cli-correction', occurredAt: '2026-09-15T09:00:00+09:00', text: '訂正: 試す予定はない' });
    release();
    const result = await running, vault = new Vault(config);
    expect(result).toMatchObject({ processed: 0, failed: 0 });
    expect(await vault.read(`90_system/receipts/${saved.inputId}.json`)).toBeUndefined();
    expect(await vault.read(`90_system/receipts/pending/${saved.inputId}.json`)).toBeUndefined();
    expect(await vault.files('20_ideas')).toEqual([]);
    const next = await organize(config, new MockLlm());
    expect(next.inputIds).toEqual([corrected.inputId]); expect(next.processed).toBe(1);
  }, 10_000);

  test('モデル待機中にプロジェクト定義が変わった対象は古い候補で確定しない', async () => {
    const config = await setup(); const saved = await add(config); const { llm, started, release } = pausedLlm();
    const running = organize(config, llm); await started;
    await addProject(config, { id: 'garden', title: '家庭菜園' });
    release();
    const result = await running;
    expect(result).toMatchObject({ processed: 0, failed: 0 });
    expect(await new Vault(config).read(`90_system/receipts/${saved.inputId}.json`)).toBeUndefined();
    expect((await organize(config, new MockLlm())).processed).toBe(1);
  }, 10_000);

  test('モデル待機中にプロジェクト候補が承認されても整理は中断しない', async () => {
    const config = await setup();
    const proposal = { title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培'], rationale: '継続した活動の記録' };
    await capture(config, { source: 'cli', occurredAt: '2026-10-03T10:00:00Z', text: '家庭菜園を始めたい' });
    await organize(config, new MockLlm([{ ...valid(), project_proposal: proposal }]));
    const [candidate] = await listProjectCandidates(config);
    await add(config, '一件目'); await add(config, '二件目');
    const { llm, started, release } = pausedLlm();
    const running = organize(config, llm); await started;
    await decideProject(config, { candidateId: candidate.candidateId, expectedHash: candidate.candidateHash, confirmationToken: candidate.confirmationToken, action: 'approve', source: 'quickadd', sourceEventId: 'REQ-' + 'a'.repeat(32), confirmed: true });
    release();
    // 以前は承認後の方針manifest不一致で整理全体が例外になっていた。
    await expect(running).resolves.toBeDefined();
    expect((await readProjects(config)).map(p => p.title)).toEqual(['家庭菜園']);
  }, 20_000);

  test('処理対象がない整理は入力数に比例した回数しかVaultを走査しない', async () => {
    const config = await setup();
    config.organize.maxItemsPerRun = 100;
    for (let i = 0; i < 30; i++) await add(config, `メモ${i}`);
    await organize(config, new MockLlm());
    const files = vi.spyOn(Vault.prototype, 'files');
    const result = await organize(config, new MockLlm());
    expect(result.processed).toBe(0);
    // 入力ごとに全体を再走査すると30件で数百回になる。対象がなければ定数回で終わる。
    expect(files.mock.calls.filter(([dir]) => dir === '00_inbox').length).toBeLessThan(15);
  }, 30_000);

  test('整理同士は排他し、後続はモデルを呼ばずに停止する。doctorは整理中と報告する', async () => {
    const config = await setup(); await add(config); const { llm, started, release } = pausedLlm();
    const running = organize(config, llm); await started;
    const second = vi.fn(async (): Promise<LlmCompletion> => ({ text: JSON.stringify(valid()) }));
    const report = await doctor(config);
    expect(report.issues.some(issue => issue.startsWith('整理実行中'))).toBe(true);
    await expect(organize(config, { complete: second })).rejects.toThrow(/別の整理処理/);
    release(); await running;
    expect(second).not.toHaveBeenCalled();
  }, 20_000);
});

describe('プロンプトの引数長上限', () => {
  test('上限超過は送信前の失敗としてreceiptへprompt-too-largeを記録する', async () => {
    const config = await setup(); const saved = await add(config);
    const result = await organize(config, { complete: async () => { throw new PromptTooLargeError(); } });
    expect(result).toMatchObject({ processed: 0, failed: 1 });
    const receipt = JSON.parse((await new Vault(config).read(`90_system/receipts/${saved.inputId}.json`))!);
    expect(receipt).toMatchObject({ status: 'failed', error: 'prompt-too-large' });
  });
});
