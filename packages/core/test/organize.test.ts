import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { capture } from '../src/capture.js';
import { addProject } from '../src/projects.js';
import { Vault, parseMarkdown } from '../src/storage.js';
import { organize } from '../src/organize.js';
import { MockLlm, validateOrganizeResult } from '../src/llm.js';
import { listCandidates, approve } from '../src/approvals.js';
import type { HubConfig, OrganizeResult } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(): Promise<HubConfig> {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-organize-')); roots.push(root);
  const config = defaultConfig(path.join(root, 'vault'), path.join(root, 'state')); await new Vault(config).init(); return config;
}
const valid = (): OrganizeResult => ({ category: 'idea', summary: '試すと面白そう', project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null });
async function add(config: HubConfig, text = 'いつか試すと面白そう') { return capture(config, { source: 'cli', text, occurredAt: '2026-09-14T09:00:00+09:00' }); }

describe('整理の契約と安全な再処理', () => {
  test('不正な追加キー・上限超過・未知プロジェクトを拒否する', () => {
    for (const result of [{ ...valid(), approved: true }, { ...valid(), summary: 'あ'.repeat(201) }, { ...valid(), project_candidates: [{ id: 'invented', confidence: 0.9 }] }, { ...valid(), extracted: { current: [{ text: '完了', status: 'confirmed', approved: true }], next: [], open: [] } }]) {
      expect(() => validateOrganizeResult(JSON.stringify(result), ['context-hub'], 4000)).toThrow();
    }
    expect(() => validateOrganizeResult(' '.repeat(4001), [], 4000)).toThrow();
    expect(validateOrganizeResult(JSON.stringify(valid()), [], 4000).category).toBe('idea');
  });
  test('0件とdry-runではLLMを呼ばず原文と処理状態を変更しない', async () => {
    const config = await setup(); const complete = vi.fn(() => { throw new Error('呼出禁止'); });
    expect((await organize(config, { complete })).processed).toBe(0);
    const saved = await add(config); const original = await readFile(path.join(config.vaultPath, saved.path), 'utf8');
    const dry = await organize(config, { complete }, { dryRun: true });
    expect(dry.inputIds).toEqual([saved.inputId]); expect(dry.dryRun).toBe(true); expect(complete).not.toHaveBeenCalled();
    expect(await new Vault(config).files('90_system/receipts')).toEqual(expect.not.arrayContaining([`90_system/receipts/${saved.inputId}.json`]));
    expect(await readFile(path.join(config.vaultPath, saved.path), 'utf8')).toBe(original);
  });
  test('面白そうは未検証ideaになり承認済み知識や確定タスクを作らない', async () => {
    const config = await setup(); const saved = await add(config); const vault = new Vault(config);
    expect((await organize(config, new MockLlm())).processed).toBe(1);
    const receipt = JSON.parse((await vault.read(`90_system/receipts/${saved.inputId}.json`))!);
    expect(receipt.result.category).toBe('idea'); expect(receipt.result.extracted.next).toEqual([]);
    const files = await vault.files('20_ideas'); expect(files).toHaveLength(1);
    const idea = parseMarkdown((await vault.read(files[0]!))!); expect(idea.meta.verified).toBe(false); expect(idea.meta.input_ids).toEqual([saved.inputId]); expect(idea.text).toContain('未検証'); expect(idea.text).toContain(`](../${saved.path})`); expect(idea.text).toContain('Asia/Tokyo');
    expect(await vault.files('30_knowledge')).toEqual([]);
    expect((await organize(config, new MockLlm())).processed).toBe(0);
  });
  test('不正JSONは1回再依頼し失敗receiptを残し、最大試行回数を超えない', async () => {
    const config = await setup(); const saved = await add(config); const vault = new Vault(config);
    const complete = vi.fn(async () => ({ text: '{不正JSON' }));
    for (let n = 1; n <= config.organize.maxAttempts; n++) {
      expect((await organize(config, { complete }, { retryFailed: true })).failed).toBe(1);
      expect(JSON.parse((await vault.read(`90_system/receipts/${saved.inputId}.json`))!).attempts).toBe(n);
    }
    expect((await organize(config, { complete }, { retryFailed: true })).failed).toBe(0);
    expect(complete).toHaveBeenCalledTimes(6); expect(await vault.read(saved.path)).toContain('いつか試す');
  });
  test('不正なモデル出力に続く正しい再依頼結果だけを保存する', async () => {
    const config = await setup(); await add(config);
    const llm = new MockLlm(['{"approved":true}', valid()]);
    expect((await organize(config, llm)).processed).toBe(1); expect(await new Vault(config).files('30_knowledge')).toEqual([]);
  });
  test('上限と指定IDを守り古い入力から処理する', async () => {
    const config = await setup(); config.organize.maxItemsPerRun = 1; const newest = await capture(config, { source: 'cli', text: '新しい', occurredAt: '2026-09-14T09:00:00+09:00' });
    const oldest = await capture(config, { source: 'cli', text: '古い', occurredAt: '2026-09-10T09:00:00+09:00' });
    expect((await organize(config, new MockLlm(), { limit: 99 })).inputIds).toEqual([oldest.inputId]);
    expect((await organize(config, new MockLlm(), { id: newest.inputId })).inputIds).toEqual([newest.inputId]);
    await expect(organize(config, new MockLlm(), { limit: 0 })).rejects.toThrow();
  });
  test('タイムアウトで終了し本文を残してfailedにする', async () => {
    const config = await setup(); config.organize.timeoutSec = 0.01; const saved = await add(config);
    const result = await organize(config, { complete: async () => new Promise<never>(() => {}) }); expect(result.failed).toBe(1);
    const receipt = JSON.parse((await new Vault(config).read(`90_system/receipts/${saved.inputId}.json`))!); expect(receipt.error).toBe('timeout');
  });
  test('AIの知識候補は人のハッシュ承認までknowledgeに入れない', async () => {
    const config = await setup(); const saved = await add(config, 'これは候補として検討する'); const vault = new Vault(config);
    await organize(config, new MockLlm([{ ...valid(), category: 'decision-candidate', knowledge_candidate: { kind: 'decision', claim: 'Markdownを正本にする', rationale: '移植しやすい' } }]));
    expect(await vault.files('30_knowledge')).toEqual([]); expect(await vault.files('90_system/approvals')).toEqual([]);
    const candidateId = `CAN-${saved.inputId.slice(3)}`; const listing = await listCandidates(config); expect(listing).toContain(saved.inputId);
    const candidateHash = listing.match(/ハッシュ: ([0-9a-f]{64})/)![1]!; await approve(config, candidateId, candidateHash); expect(await vault.files('30_knowledge')).toHaveLength(1);
    const candidatePath = `90_system/candidates/${candidateId}.md`; const approvedContent = await vault.read(candidatePath); await rm(path.join(config.vaultPath, `90_system/receipts/${saved.inputId}.json`));
    const rerun = await organize(config, new MockLlm([{ ...valid(), knowledge_candidate: { kind: 'decision', claim: '内容を勝手に変更', rationale: '再処理' } }]));
    expect(await vault.read(candidatePath)).toBe(approvedContent); expect(rerun.conflicts).toHaveLength(1);
  });
  test('運用ログに件数を残し本文は複製しない', async () => {
    const config = await setup(); await add(config, 'ログへ複製しない原文'); await organize(config, new MockLlm());
    const files = await readdir(config.logging.dir); const content = await readFile(path.join(config.logging.dir, files[0]!), 'utf8');
    const entry = content.trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.op === 'organize');
    expect(entry?.counts.processed).toBe(1); expect(content).not.toContain('ログへ複製しない原文');
  });
  test('ログ障害でも耐久化済み整理を成功として返す', async () => {
    const config = await setup(); const saved = await add(config); const occupied = path.join(config.statePath, 'occupied'); await writeFile(occupied, ''); config.logging.dir = occupied;
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect((await organize(config, new MockLlm())).processed).toBe(1); expect(warning).toHaveBeenCalled();
    expect(await new Vault(config).read(`90_system/receipts/${saved.inputId}.json`)).toContain('organized');
  });
  test('モデル障害のエラー本文はreceiptへ複製しない', async () => {
    const config = await setup(); const saved = await add(config);
    expect((await organize(config, new MockLlm([new Error('秘密の本文 sk-secret')]))).failed).toBe(1);
    const receipt = (await new Vault(config).read(`90_system/receipts/${saved.inputId}.json`))!;
    expect(receipt).not.toContain('秘密の本文'); expect(receipt).not.toContain('sk-secret');
  });
  test('receipt保存前の停止後は安定IDで回復し二重生成しない', async () => {
    const config = await setup(); const saved = await add(config); const vault = new Vault(config);
    const write = Vault.prototype.write; let stopped = false;
    vi.spyOn(Vault.prototype, 'write').mockImplementation(async function (this: Vault, relative, text) {
      if (!stopped && relative === `90_system/receipts/${saved.inputId}.json`) { stopped = true; throw new Error('停止'); }
      return write.call(this, relative, text);
    });
    await expect(organize(config, new MockLlm())).rejects.toThrow('停止');
    expect(await vault.read(`90_system/receipts/${saved.inputId}.json`)).toBeUndefined(); expect(await vault.files('20_ideas')).toHaveLength(1);
    vi.restoreAllMocks(); expect((await organize(config, new MockLlm())).processed).toBe(1); expect(await vault.files('20_ideas')).toHaveLength(1);
  });
  test('派生生成後に停止してもjournalの同じ結果と日時で再開しモデルの別回答を混ぜない', async () => {
    const config = await setup(); const vault = new Vault(config);
    await addProject(config, { id: 'project-alpha', title: '最初のプロジェクト' }); await addProject(config, { id: 'project-beta', title: '後のプロジェクト' });
    const saved = await capture(config, { source: 'file', kind: 'work-summary', text: '## 現在地\n- [確認済み] 作業中', occurredAt: '2026-09-14T09:00:00+09:00' });
    const first: OrganizeResult = { ...valid(), summary: '最初の整理結果', project_candidates: [{ id: 'project-alpha', confidence: 0.9 }], knowledge_candidate: { kind: 'decision', claim: '最初の知識候補', rationale: '要検討' }, extracted: { current: [{ text: '作業中', status: 'confirmed' }], next: [], open: [] } };
    const changed: OrganizeResult = { ...valid(), category: 'reference', summary: '変化した整理結果', project_candidates: [{ id: 'project-beta', confidence: 0.9 }] };
    const complete = vi.fn(async () => ({ text: JSON.stringify(complete.mock.calls.length === 1 ? first : changed) }));
    const receiptPath = `90_system/receipts/${saved.inputId}.json`; const journalPath = `90_system/receipts/pending/${saved.inputId}.json`; const write = Vault.prototype.write;
    vi.spyOn(Vault.prototype, 'write').mockImplementation(async function (this: Vault, relative, text) { if (relative === receiptPath) throw new Error('receipt直前停止'); return write.call(this, relative, text); });
    await expect(organize(config, { complete })).rejects.toThrow('receipt直前停止');
    const journalRaw = await vault.read(journalPath); expect(journalRaw).toBeDefined(); const journal = JSON.parse(journalRaw!);
    const derivedPaths = [`20_ideas/IDEA-${saved.inputId.slice(3)}.md`, `90_system/candidates/CAN-${saved.inputId.slice(3)}.md`, '10_projects/project-alpha/NOW.md'];
    const before = await Promise.all(derivedPaths.map((file) => vault.read(file)));
    for (const content of before) expect(parseMarkdown(content!).meta.generated_at).toBe(journal.organized_at);
    expect(await vault.read(receiptPath)).toBeUndefined(); vi.restoreAllMocks();
    expect((await organize(config, { complete })).processed).toBe(1); expect(complete).toHaveBeenCalledTimes(1);
    expect(await Promise.all(derivedPaths.map((file) => vault.read(file)))).toEqual(before); expect(await vault.read('10_projects/project-beta/NOW.md')).toBeUndefined();
    const receipt = JSON.parse((await vault.read(receiptPath))!); expect(receipt.result).toEqual(first); expect(receipt.attempts).toBe(1); expect(receipt.organized_at).toBe(journal.organized_at);
    expect(await vault.read(journalPath)).toBe(journalRaw); expect((await organize(config, { complete })).processed).toBe(0); expect(complete).toHaveBeenCalledTimes(1);
  });
  test('failedの再試行で生成途中に止まったjournalは追加モデル呼出や試行加算なしで自動回復する', async () => {
    const config = await setup(); config.organize.maxAttempts = 2; const saved = await add(config); const vault = new Vault(config);
    await organize(config, new MockLlm([new Error('モデル障害')]));
    const receiptPath = `90_system/receipts/${saved.inputId}.json`; const write = Vault.prototype.write;
    vi.spyOn(Vault.prototype, 'write').mockImplementation(async function (this: Vault, relative, text) { if (relative === receiptPath) throw new Error('停止'); return write.call(this, relative, text); });
    await expect(organize(config, new MockLlm(), { retryFailed: true })).rejects.toThrow('停止'); vi.restoreAllMocks();
    const complete = vi.fn(async () => { throw new Error('再呼出禁止'); });
    expect((await organize(config, { complete })).processed).toBe(1); expect(complete).not.toHaveBeenCalled();
    expect(JSON.parse((await vault.read(receiptPath))!).attempts).toBe(2);
  });
  test('journalが不正なら停止して再分類による上書きを行わない', async () => {
    const config = await setup(); const saved = await add(config); const vault = new Vault(config);
    await vault.write(`90_system/receipts/pending/${saved.inputId}.json`, JSON.stringify({ input_id: saved.inputId, status: 'organized' }));
    const complete = vi.fn(async () => ({ text: JSON.stringify(valid()) }));
    await expect(organize(config, { complete })).rejects.toThrow(/journal/); expect(complete).not.toHaveBeenCalled(); expect(await vault.files('20_ideas')).toEqual([]);
  });
  test.each(['本文', 'メタデータ'])('journal保存後に原文の%sが変わると旧結果を新出典へ結合せず停止する', async (kind) => {
    const config = await setup(); const saved = await add(config, '変更前の原文'); const vault = new Vault(config); const original = (await vault.read(saved.path))!;
    const result: OrganizeResult = { ...valid(), knowledge_candidate: { kind: 'knowledge', claim: '変更前からの候補', rationale: '未確認' } };
    const receiptPath = `90_system/receipts/${saved.inputId}.json`; const journalPath = `90_system/receipts/pending/${saved.inputId}.json`; const write = Vault.prototype.write;
    vi.spyOn(Vault.prototype, 'write').mockImplementation(async function (this: Vault, relative, text) { if (relative === receiptPath) throw new Error('停止'); return write.call(this, relative, text); });
    await expect(organize(config, new MockLlm([result]))).rejects.toThrow('停止'); vi.restoreAllMocks();
    const journal = (await vault.read(journalPath))!; expect(JSON.parse(journal).input_hash).toBe(createHash('sha256').update(original).digest('hex'));
    const paths = [...await vault.files('20_ideas'), ...await vault.files('90_system/candidates')]; const before = await Promise.all(paths.map((file) => vault.read(file)));
    await vault.write(saved.path, kind === '本文' ? original.replace('変更前の原文', '別の原文') : original.replace('source: cli', 'source: file'));
    const complete = vi.fn(async () => ({ text: JSON.stringify(valid()) }));
    await expect(organize(config, { complete })).rejects.toThrow(/ハッシュ/); expect(complete).not.toHaveBeenCalled();
    expect(await vault.read(receiptPath)).toBeUndefined(); expect(await vault.read(journalPath)).toBe(journal); expect(await Promise.all(paths.map((file) => vault.read(file)))).toEqual(before);
  });
  test('入力の解析と生ファイル取得の間に変更があればモデルを呼ぶ前に停止する', async () => {
    const config = await setup(); const saved = await add(config, '変更前の原文'); const vault = new Vault(config); const read = Vault.prototype.read; let changed = false;
    vi.spyOn(Vault.prototype, 'read').mockImplementation(async function (this: Vault, relative) {
      const content = await read.call(this, relative);
      if (relative === saved.path && !changed) { changed = true; await vault.write(saved.path, content!.replace('変更前の原文', '変更後の原文')); }
      return content;
    });
    const complete = vi.fn(async () => ({ text: JSON.stringify(valid()) }));
    await expect(organize(config, { complete })).rejects.toThrow(/入力.*変更/); expect(complete).not.toHaveBeenCalled();
    expect(await vault.read(`90_system/receipts/pending/${saved.inputId}.json`)).toBeUndefined(); expect(await vault.files('20_ideas')).toEqual([]);
  });
  test.each(['成功', '失敗'])('モデル%s応答中に原文が変わるとjournalやreceiptを作成しない', async (kind) => {
    const config = await setup(); const saved = await add(config, '変更前の原文'); const vault = new Vault(config); const original = (await vault.read(saved.path))!;
    const complete = async () => { await vault.write(saved.path, original.replace('変更前の原文', '変更後の原文')); if (kind === '失敗') throw new Error('モデル障害'); return { text: JSON.stringify(valid()) }; };
    await expect(organize(config, { complete })).rejects.toThrow(/ハッシュ/);
    expect(await vault.read(`90_system/receipts/pending/${saved.inputId}.json`)).toBeUndefined(); expect(await vault.read(`90_system/receipts/${saved.inputId}.json`)).toBeUndefined(); expect(await vault.files('20_ideas')).toEqual([]);
  });
  test('停止後の生成物に手動変更があれば保護して新版をconflictsへ残す', async () => {
    const config = await setup(); const saved = await add(config); const vault = new Vault(config);
    await organize(config, new MockLlm()); const [idea] = await vault.files('20_ideas');
    const edited = `${await vault.read(idea!)}\n人の編集\n`; await vault.write(idea!, edited);
    await rm(path.join(config.vaultPath, `90_system/receipts/${saved.inputId}.json`));
    const result = await organize(config, new MockLlm());
    expect(result.conflicts).toHaveLength(1); expect(await vault.read(idea!)).toBe(edited); expect(await vault.files('90_system/conflicts')).toHaveLength(1);
  });
});

describe('実行モデルの記録', () => {
  const client = (model?: string) => ({ complete: async () => ({ text: JSON.stringify(valid()), ...(model ? { model } : {}) }) });
  test('応答で報告されたprovider/modelをreceiptと生成物に記録する', async () => {
    const config = await setup(); config.organize.llm = { ...config.organize.llm, provider: 'openclaw-infer', model: null };
    const saved = await add(config); expect((await organize(config, client('openai/gpt-6-astra'))).processed).toBe(1);
    const receipt = JSON.parse(await readFile(path.join(config.vaultPath, `90_system/receipts/${saved.inputId}.json`), 'utf8'));
    expect(receipt.llm).toEqual({ provider: 'openclaw-infer', model: 'openai/gpt-6-astra', prompt_version: 1 });
    const idea = await readFile(path.join(config.vaultPath, `20_ideas/IDEA-${saved.inputId.slice(3)}.md`), 'utf8');
    expect(idea).toContain('model: openai/gpt-6-astra');
  });
  test('報告がなければ設定モデル、それもなければinherited-unverifiedを記録する', async () => {
    const config = await setup(); config.organize.llm = { ...config.organize.llm, provider: 'openclaw-infer', model: null };
    const first = await add(config, '一件目'); expect((await organize(config, client())).processed).toBe(1);
    const firstReceipt = JSON.parse(await readFile(path.join(config.vaultPath, `90_system/receipts/${first.inputId}.json`), 'utf8'));
    expect(firstReceipt.status).toBe('organized'); expect(firstReceipt.llm.model).toBe('inherited-unverified');
    config.organize.llm.model = 'openai/configured';
    const second = await add(config, '二件目'); expect((await organize(config, client())).processed).toBe(1);
    const secondReceipt = JSON.parse(await readFile(path.join(config.vaultPath, `90_system/receipts/${second.inputId}.json`), 'utf8'));
    expect(secondReceipt.status).toBe('organized'); expect(secondReceipt.llm.model).toBe('openai/configured');
  });
});
