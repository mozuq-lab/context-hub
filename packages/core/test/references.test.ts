import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { runCycle } from '../src/cycle.js';
import { find } from '../src/retrieve.js';
import { doctor } from '../src/doctor.js';
import { buildReferences, extractUrls, rebuildReferences, referencesPath, type ReferencesWrite } from '../src/references.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

const at = (iso: string) => ({ occurredAt: iso, receivedAt: iso });
async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール', keywords: ['集約'] });
  const spec = await capture(config, { source: 'cli', project: 'hub', ...at('2026-09-10T01:00:00Z'), text: '同期の仕様はここ https://example.com/spec?v=2 と (https://example.com/guide)。' });
  // プロジェクトの指定はなく、キーワードからAIが結び付ける。
  const article = await capture(config, { source: 'cli', ...at('2026-10-05T01:00:00Z'), text: '集約の参考記事 [解説](https://example.org/a_(b)) と https://example.com/spec?v=2' });
  const loose = await capture(config, { source: 'cli', ...at('2026-10-06T01:00:00Z'), text: 'あとで読む https://example.net/reading' });
  const plain = await capture(config, { source: 'cli', project: 'hub', ...at('2026-10-07T01:00:00Z'), text: '名前の候補を考えた' });
  await organize(config, new MockLlm());
  return { config, vault, spec, article, loose, plain };
}

test('本文のURLを文末の句読点や閉じ括弧を除いて取り出し、http・https以外と長すぎるものは載せない', () => {
  expect(extractUrls('見た: https://example.com/a。次は「https://example.com/b」と(https://example.com/c).').urls).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
  expect(extractUrls('[題](https://example.org/a_(b)) https://example.org/a_(b)').urls).toEqual(['https://example.org/a_(b)']);
  expect(extractUrls('ftp://example.com/x と javascript:alert(1) と http://').urls).toEqual([]);
  expect(extractUrls(`https://example.com/${'a'.repeat(600)}`)).toEqual({ urls: [], skipped: 1 });
  // 伏せ字を含むURLは開けないので載せない。
  expect(extractUrls('https://example.com/cb?token=[伏せ字:パスワード等]')).toEqual({ urls: [], skipped: 1 });
  // 和文が空白なしで続いても、URLに取り込まない。
  expect(extractUrls('仕様はhttps://example.com/specを読んだ。https://example.com/a・https://example.com/b').urls).toEqual(['https://example.com/spec', 'https://example.com/a', 'https://example.com/b']);
  expect(extractUrls('https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC を見た').urls).toEqual(['https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC']);
});

test('上限を超えて載せなかったURLは古い資料に載せ、要約の山括弧はHTMLとして残さない', async () => {
  const { config } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約<b>ツール' });
  const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/p${i}`);
  await capture(config, { source: 'cli', project: 'hub', ...at('2026-09-10T01:00:00Z'), text: `古い資料 ${urls[11]}` });
  await capture(config, { source: 'cli', project: 'hub', ...at('2026-09-11T01:00:00Z'), text: `<img src=x> まとめ ${urls.join(' ')}` });
  await organize(config, new MockLlm());
  const text = await buildReferences(config, 'hub');
  expect(text).toContain('ほかURL 2件');
  expect(text).toMatch(/古い資料[^\n]*\n {2}- <https:\/\/example\.com\/p11>/);
  expect(text).not.toContain('新しい資料と同じURL');
  expect(text).toContain('# 集約&lt;b>ツールの資料');
  expect(text).toContain('&lt;img src=x>');
  expect(text).not.toContain('<img');
});

test('参考資料に分類されたメモを新しい順に月ごとへ並べ、同じURLは新しい資料にだけ載せる', async () => {
  const { config, spec, article, loose, plain } = await fixture();
  const text = await buildReferences(config, 'hub');
  expect(text).toContain('# 集約ツールの資料');
  expect(text).toContain('資料 2件 / URL 3件');
  const oct = text.slice(text.indexOf('## 2026年10月'), text.indexOf('## 2026年9月'));
  expect(oct).toMatch(new RegExp(`- 2026-10-05 集約の参考記事[^\\n]* — \\[${article.inputId}\\]\\(\\.\\./\\.\\./00_inbox/[^)]+\\) / 関連候補（AI推定）\\n {2}- <https://example\\.org/a_\\(b\\)>\\n {2}- <https://example\\.com/spec\\?v=2>`));
  const sep = text.slice(text.indexOf('## 2026年9月'));
  // 本人が指定したメモには推定の印を付けず、新しい資料に載せたURLは繰り返さない。
  expect(sep).toMatch(new RegExp(`- 2026-09-10 同期の仕様はここ[^\\n]* — \\[${spec.inputId}\\]\\([^)]+\\)\\n {2}- <https://example\\.com/guide>\\n {2}- 新しい資料と同じURL 1件（原文で確認）`));
  expect(text).not.toContain(loose.inputId);
  expect(text).not.toContain(plain.inputId);
  expect(text).not.toMatch(/日前/);
  expect(await buildReferences(config, 'hub')).toBe(text);
});

test('URLに埋めたパスワードやトークンは載せず、件数だけ示す', async () => {
  const { config } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'cli', project: 'hub', ...at('2026-09-10T01:00:00Z'), text: '接続先 https://admin:hunter2secret@example.com/db と https://example.com/hook?token=abcdef123456 と https://example.com/docs' });
  await organize(config, new MockLlm());
  const text = await buildReferences(config, 'hub');
  expect(text).toContain('<https://example.com/docs>');
  expect(text).not.toContain('hunter2secret');
  expect(text).not.toContain('abcdef123456');
  expect(text).toContain('載せていないURL 2件（長すぎる、または秘密情報らしい文字列を含む）');
});

test('訂正で参考資料でなくなったメモは外し、訂正後のURLを載せる', async () => {
  const { config, spec } = await fixture();
  await correctInput(config, spec.inputId, { source: 'cli', text: '仕様は移転した https://example.com/spec-v3', ...at('2026-10-08T01:00:00Z') });
  await organize(config, new MockLlm());
  const text = await buildReferences(config, 'hub');
  expect(text).toMatch(new RegExp(`\\[${spec.inputId}\\]\\([^)]+\\) / 訂正あり\\n {2}- <https://example\\.com/spec-v3>`));
  expect(text).not.toContain('example.com/guide');
  const { config: other, vault } = await workflowSetup(roots);
  await addProject(other, { id: 'hub', title: '集約ツール' });
  const memo = await capture(other, { source: 'cli', project: 'hub', ...at('2026-09-10T01:00:00Z'), text: '参考 https://example.com/x' });
  await organize(other, new MockLlm());
  await correctInput(other, memo.inputId, { source: 'cli', text: 'URLは不要だった。面白そうなので試したい', ...at('2026-09-11T01:00:00Z') });
  await organize(other, new MockLlm());
  expect(await buildReferences(other, 'hub')).toContain('まだ資料はありません。');
  expect(await vault.read(referencesPath('hub'))).toBeUndefined();
});

test('cycleで資料のあるプロジェクトにだけ書き、変化がなければ書き直さず、手で変えたものは止めてHOMEとdoctorに示す', async () => {
  const { config, vault, loose } = await fixture();
  await addProject(config, { id: 'empty', title: '空のプロジェクト' });
  const result = await runCycle(config, new MockLlm());
  expect(result.references).toEqual([{ projectId: 'hub', path: referencesPath('hub'), written: true }]);
  expect(await vault.read(referencesPath('empty'))).toBeUndefined();
  const written = (await vault.read(referencesPath('hub')))!;
  expect(written).toMatch(/^---\n[\s\S]*source_hash: sha256:[a-f0-9]{64}[\s\S]*verified: false/);
  // どのプロジェクトにも結び付いていない資料はHOMEに載せる。
  const home = (await vault.read('HOME.md'))!;
  expect(home).toMatch(new RegExp(`## プロジェクト未定の資料（1件）\\n[^\\n]+\\n- 2026-10-06 あとで読む[^\\n]* — \\[${loose.inputId}\\]\\(00_inbox/[^)]+\\)\\n {2}- <https://example\\.net/reading>`));
  expect((await runCycle(config, new MockLlm())).references).toEqual([]);
  expect(await rebuildReferences(config, { projectId: 'hub' })).toEqual([{ projectId: 'hub', path: referencesPath('hub'), written: false }]);
  await expect(rebuildReferences(config, { projectId: 'missing' })).rejects.toThrow('見つかりません');

  await vault.write(referencesPath('hub'), written.replace('# 集約ツールの資料', '# 手で直した資料'));
  await capture(config, { source: 'cli', project: 'hub', ...at('2026-10-09T01:00:00Z'), text: '追加の資料 https://example.com/new' });
  const next = await runCycle(config, new MockLlm());
  expect(next.references).toEqual([{ projectId: 'hub', path: referencesPath('hub'), written: false, stopped: true }]);
  expect(await vault.read('HOME.md')).toContain('[資料の更新が止まっています](10_projects/hub/REFERENCES.md): 集約ツール — REFERENCES.mdが手で変更されています');
  expect((await doctor(config)).issues).toContain('資料の更新が止まっています（手で変更されています）: 10_projects/hub/REFERENCES.md');
  // 消せば次のcycleで作り直す。資料がなくなっても、既にあるファイルは「まだ資料はありません」に書き直す。
  await vault.remove(referencesPath('hub'));
  expect(((await runCycle(config, new MockLlm())).references as ReferencesWrite[])[0]).toMatchObject({ projectId: 'hub', written: true });
  expect(await vault.read(referencesPath('hub'))).toContain('<https://example.com/new>');
  expect(await vault.read('HOME.md')).not.toContain('資料の更新が止まっています');
});

test('検索は種類referenceで、参考資料に分類されたメモだけに絞り込める', async () => {
  const { config, spec, article, loose, plain } = await fixture();
  const all = await find(config, '', { kinds: ['reference'] });
  for (const id of [spec.inputId, article.inputId, loose.inputId]) expect(all).toContain(id);
  expect(all).not.toContain(plain.inputId);
  const mine = await find(config, '', { kinds: ['reference'], project: 'hub' });
  expect(mine).toContain(spec.inputId);
  expect(mine).toContain(article.inputId);
  expect(mine).not.toContain(loose.inputId);
  // メモと資料の両方を指定すれば、どちらかに当たるものを返す。
  expect(await find(config, '名前', { kinds: ['reference', 'memo'] })).toContain(plain.inputId);
});
