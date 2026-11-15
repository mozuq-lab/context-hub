import { afterEach, expect, test } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { workflowSetup } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { bundle, context } from '../src/retrieve.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { validateConfig } from '../src/config.js';
import { readNowItems } from '../src/item-resolutions.js';
import { findSecrets, redactCompletion, redactPrompt, redactText, secretSettings } from '../src/secrets.js';
import type { LlmCompletion, LlmOptions } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';

/** 渡されたプロンプトを記録するモデル。応答は既定のMockLlmに任せる。 */
class RecordingLlm extends MockLlm {
  prompts: string[] = [];
  override async complete(prompt: string, opts: LlmOptions): Promise<LlmCompletion> { this.prompts.push(prompt); return super.complete(prompt, opts); }
}

test('共有の試験データどおりに検出して伏せる（Flutterクライアントと同じ結果）', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/secret-cases.json', import.meta.url), 'utf8')) as { cases: { name: string; text: string; redacted: string; labels: string[] }[] };
  const settings = secretSettings({ privacy: { redactSecrets: true, patterns: [] } });
  expect(fixture.cases.length).toBeGreaterThan(15);
  for (const c of fixture.cases) {
    const r = redactText(c.text, settings);
    expect(r.text, c.name).toBe(c.redacted);
    expect(r.findings.map(f => f.label), c.name).toEqual(c.labels);
    // 伏せた結果をもう一度伏せても変わらない。
    expect(redactText(r.text, settings).text, c.name).toBe(r.text);
  }
});

test('プロンプトのJSONは値ごとに伏せ、引用符を含む本文でもJSONとして読める', () => {
  const settings = secretSettings({ privacy: { redactSecrets: true, patterns: [] } });
  const prompt = `方針 password=hunter2pass\n入力データ(JSON):\n${JSON.stringify({ source_text: `設定は "password": "hunter2pass" と ${KEY}`, metadata: { id: 'IN-01M2DSFVQMH65989604KSVE1PV' } })}`;
  const r = redactPrompt(prompt, settings);
  expect(r.text).not.toContain('hunter2pass');
  expect(r.text).not.toContain(KEY);
  const data = JSON.parse(r.text.slice(r.text.indexOf('入力データ(JSON):\n') + '入力データ(JSON):\n'.length));
  expect(data.source_text).toBe('設定は "password": "[伏せ字:パスワード等]" と [伏せ字:APIキー]');
  expect(data.metadata.id).toBe('IN-01M2DSFVQMH65989604KSVE1PV');
  expect(r.text.startsWith('方針 password=[伏せ字:パスワード等]')).toBe(true);
  // 出力に残った値も伏せる。JSONでなければそのまま返す。
  expect(JSON.parse(redactCompletion(JSON.stringify({ summary: `鍵は${KEY}` }), settings)).summary).toBe('鍵は[伏せ字:APIキー]');
  expect(redactCompletion(`not json ${KEY}`, settings)).toBe(`not json ${KEY}`);
  // 無効にすると何もしない。
  expect(redactPrompt(prompt, secretSettings({ privacy: { redactSecrets: false, patterns: [] } })).text).toBe(prompt);
});

test('整理用のモデルには伏せ字だけを渡し、原文は変えず、作業要約のラベルは伏せ字の本文で照合する', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const memo = await capture(config, { source: 'cli', text: `いつか試したい。キーは ${KEY} で、password=hunter2pass`, occurredAt: '2026-11-10T00:00:00Z' });
  const summary = await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', text: `## 現在地\n- [確認済み] 本番キー ${KEY} を設定した\n## 次の一手\n- [確認済み] 動作を確かめる`, occurredAt: '2026-11-10T01:00:00Z' });
  const llm = new RecordingLlm();
  await organize(config, llm);
  expect(llm.prompts).toHaveLength(2);
  for (const prompt of llm.prompts) { expect(prompt).not.toContain(KEY); expect(prompt).not.toContain('hunter2pass'); expect(prompt).toContain('[伏せ字:'); }
  // 原文は変えない。
  expect(await vault.read(memo.path)).toContain(KEY);
  // 生成物と処理記録には値が残らない。
  for (const dir of ['20_ideas', '10_projects', '90_system/receipts']) for (const path of await vault.files(dir)) expect(await vault.read(path), path).not.toContain(KEY);
  const items = (await readNowItems(vault, 'hub'))!;
  expect(items.items.find(i => i.section === 'next')?.text).toBe('動作を確かめる');
  const now = (await vault.read('10_projects/hub/NOW.md'))!;
  expect(now).toContain('本番キー [伏せ字:APIキー] を設定した');
  // 伏せ字の本文で照合するため、明示の[確認済み]は降格しない。
  const receipt = JSON.parse((await vault.read(`90_system/receipts/${summary.inputId}.json`))!);
  expect(receipt.result.extracted.current).toEqual([{ text: '本番キー [伏せ字:APIキー] を設定した', status: 'confirmed' }]);
  expect(summary.inputId).toMatch(/^IN-/);
});

test('無効にした設定ではモデルへそのまま渡し、HOMEにも載せない', async () => {
  const { config } = await workflowSetup(roots);
  const off = { ...config, privacy: { redactSecrets: false, patterns: [] } };
  await capture(off, { source: 'cli', text: `いつか試したい ${KEY}`, occurredAt: '2026-11-10T00:00:00Z' });
  const llm = new RecordingLlm();
  await organize(off, llm);
  expect(llm.prompts[0]).toContain(KEY);
  await rebuildDashboard(off);
  expect(await new (await import('../src/storage.js')).Vault(off).read('HOME.md')).not.toContain('秘密情報らしい文字列を含むメモ');
});

test('関連付けを判断するモデルにも伏せ字だけを渡す', async () => {
  const { config } = await workflowSetup(roots);
  await capture(config, { source: 'cli', kind: 'work-summary', text: `## 現在地\n- [確認済み] 菜園の通知に ${KEY} を使う`, occurredAt: '2026-11-10T00:00:00Z' });
  await organize(config, new MockLlm());
  await addProject(config, { id: 'garden', title: '家庭菜園', keywords: ['菜園'] });
  const llm = new RecordingLlm();
  await organize(config, llm);
  expect(llm.prompts.length).toBeGreaterThan(0);
  for (const prompt of llm.prompts) expect(prompt).not.toContain(KEY);
});

test('contextの抜粋で切れる位置にある値も、切る前に伏せる', async () => {
  const { config } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'cli', project: 'hub', text: `${'あ'.repeat(285)} ${KEY}`, occurredAt: '2026-11-10T00:00:00Z' });
  await organize(config, new MockLlm());
  const text = await context(config, 'hub');
  expect(text).not.toContain('sk-ant-api03');
  expect(text).toContain('[伏せ字:APIキー]');
});

test('URLの資格情報と鍵名の検出は長い入力でも時間がかからない', () => {
  const settings = secretSettings({ privacy: { redactSecrets: true, patterns: [] } });
  const started = performance.now();
  findSecrets('a'.repeat(50000) + '://', settings);
  findSecrets('a+'.repeat(25000), settings);
  // 区切りでつないだ長い名前（a_a_a_…）でも、位置ごとに先まで読み直さない。
  findSecrets('a_'.repeat(25000), settings);
  expect(redactText(`${'a_'.repeat(2000)}password=hunter2pass`, settings).text.endsWith('password=[伏せ字:パスワード等]')).toBe(true);
  expect(performance.now() - started).toBeLessThan(2000);
});

test('別AI向けのcontext、HOME、doctorでは値を出さない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const memo = await capture(config, { source: 'cli', project: 'hub', text: `接続先 postgres://admin:s3cr3tPass@db.example.com/app と ${KEY}`, occurredAt: '2026-11-10T00:00:00Z' });
  await organize(config, new MockLlm());
  const text = await context(config, 'hub');
  expect(text).not.toContain(KEY);
  expect(text).not.toContain('s3cr3tPass');
  expect(text).toContain('[伏せ字:パスワード]');
  expect(text).toContain('秘密情報らしい文字列は[伏せ字:種類]に置き換えています');
  // 選んだ記録を束ねた資料（bundle）でも同じ。
  const picked = await bundle(config, [memo.inputId, 'hub'], 20000);
  expect(picked).not.toContain(KEY);
  expect(picked).not.toContain('s3cr3tPass');
  expect(picked).toContain('[伏せ字:APIキー]');
  expect(picked).toContain('秘密情報らしい文字列は[伏せ字:種類]に置き換えています');
  await rebuildDashboard(config);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('## 秘密情報らしい文字列を含むメモ（1件）');
  expect(home).toContain(`[${memo.inputId}](${memo.path}): パスワード、APIキー`);
  expect(home).not.toContain(KEY);
  const result = await doctor(config);
  expect(result.issues).toEqual([]);
  expect(result.secrets).toEqual([{ input_id: memo.inputId, path: memo.path, found: 'パスワード、APIキー' }]);
});

test('設定で検出規則を追加でき、不正な正規表現は設定の読込で止める', () => {
  const settings = secretSettings({ privacy: { redactSecrets: true, patterns: [{ label: '社員番号', pattern: 'EMP-\\d{6}' }] } });
  expect(redactText('担当 EMP-123456', settings).text).toBe('担当 [伏せ字:社員番号]');
  expect(findSecrets('担当 EMP-123456', settings)[0]?.rule).toBe('custom-1');
  const base = { schema_version: 1, vaultPath: '/tmp/ctx-v', statePath: '/tmp/ctx-s', timezone: 'Asia/Tokyo', policy: { projectRoots: [] }, capture: { maxInputChars: 8000, allowedSenderIds: [] }, organize: { maxItemsPerRun: 20, maxAttempts: 3, timeoutSec: 60, projectThreshold: 0.7, llm: { provider: 'mock', model: null, maxOutputChars: 4000, executable: 'openclaw' } }, retrieve: { contextMaxChars: 6000, discordMaxChars: 1900 }, logging: { dir: '/tmp/ctx-s/logs', retentionDays: 14 } };
  // 旧版の設定（privacyなし）は既定で有効になる。
  expect(validateConfig(base).privacy).toEqual({ redactSecrets: true, patterns: [] });
  expect(() => validateConfig({ ...base, privacy: { redactSecrets: true, patterns: [{ label: 'x', pattern: '(' }] } })).toThrow();
});

test('鍵の名前の後に長い空白が続いても、検出は文字数に比例する時間で終わる', () => {
  const settings = secretSettings({ privacy: { redactSecrets: true, patterns: [] } });
  // 以前は鍵と区切りの間の空白で二乗の後戻りが起き、5万字で数秒かかった。
  const started = performance.now();
  for (const text of ['password' + ' '.repeat(50_000) + 'x', 'token' + '\t'.repeat(50_000) + '"x', 'パスワードは' + ' '.repeat(50_000)]) findSecrets(text, settings);
  expect(performance.now() - started).toBeLessThan(1000);
});
