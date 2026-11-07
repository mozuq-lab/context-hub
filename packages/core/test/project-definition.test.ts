import { afterEach, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { Vault, hash, parseMarkdown } from '../src/storage.js';
import { addProject, readProjects, inspectProjects } from '../src/projects.js';
import { setProjectDefinition, readProjectDefinitionChanges, normalizeDefinition, editDefinition, withDefinition } from '../src/project-definition.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { runCycle } from '../src/cycle.js';
import { MockLlm } from '../src/llm.js';
import { doctor } from '../src/doctor.js';
import { parseIntake } from '../src/intake-format.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const path = '10_projects/garden/project.md';
const read = async (vault: Vault) => (await vault.read(path))!;

test('確認したハッシュに一致するときだけ名前・別名・キーワードを書き換え、ほかのキー・コメント・本文を保つ', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培'] });
  const edited = (await read(vault)).replace('status: active', 'status: active # 手で書いたコメント\nowner: 本人').replace('人が保守するプロジェクト定義です。', '手で書いたメモ');
  await vault.write(path, edited);
  const request = { projectId: 'garden', title: ' ベランダ菜園 ', aliases: ['菜園', ' ベランダ ', 'ﾍﾞﾗﾝﾀﾞ', '', 'べランダ'], keywords: ['苗', 'R&D', 'r&d'], source: 'cli' };
  await expect(setProjectDefinition(config, { ...request, expectedHash: '0'.repeat(64) })).rejects.toThrow('変更されています');
  expect(await read(vault)).toBe(edited);
  const result = await setProjectDefinition(config, { ...request, expectedHash: hash(edited) });
  expect(result).toMatchObject({ projectId: 'garden', deduped: false, changed: ['title', 'aliases', 'keywords'] });
  const saved = await read(vault), parsed = parseMarkdown(saved);
  expect(parsed.meta).toMatchObject({ id: 'garden', title: 'ベランダ菜園', aliases: ['菜園', 'ベランダ', 'べランダ'], keywords: ['苗', 'R&D'], status: 'active', owner: '本人' });
  expect(saved).toContain('# 手で書いたコメント');
  expect(parsed.text).toContain('手で書いたメモ');
  expect(await readProjectDefinitionChanges(vault)).toMatchObject([{ id: result.changeId, project_id: 'garden', before: { title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培'] }, after: { title: 'ベランダ菜園' }, before_hash: hash(edited), after_hash: hash(saved) }]);
  // 古いハッシュ・変更なし・上限超過は受け付けない。
  await expect(setProjectDefinition(config, { ...request, expectedHash: hash(edited) })).rejects.toThrow('変更されています');
  await expect(setProjectDefinition(config, { ...request, title: 'ベランダ菜園', expectedHash: hash(saved) })).rejects.toThrow('変更がありません');
  await expect(setProjectDefinition(config, { ...request, aliases: Array.from({ length: 51 }, (_, i) => `別名${i}`), expectedHash: hash(saved) })).rejects.toThrow('50件まで');
  await expect(setProjectDefinition(config, { ...request, title: '  ', expectedHash: hash(saved) })).rejects.toThrow('名前は1〜200文字');
  await expect(setProjectDefinition(config, { ...request, projectId: 'missing', expectedHash: hash(saved) })).rejects.toThrow('見つかりません');
  expect(await read(vault)).toBe(saved);
});

test('CLIの追加・削除の指定を今の定義へ当てはめ、ない語の削除は止める', () => {
  const current = { title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培', '苗'] };
  expect(normalizeDefinition(editDefinition(current, { addAliases: ['ベランダ', '菜園'], removeKeywords: ['栽培'], addKeywords: ['肥料'] }))).toEqual({ title: '家庭菜園', aliases: ['菜園', 'ベランダ'], keywords: ['苗', '肥料'] });
  expect(() => editDefinition(current, { removeAliases: ['存在しない'] })).toThrow('定義にありません');
  expect(() => withDefinition('本文だけ', current)).toThrow('frontmatter');
});

test('書き換えるのは名前・別名・キーワードの値だけで、コメント・一覧の書き方・ほかのキーの書式を保つ', () => {
  const raw = '---\nid: garden\ntitle: 家庭菜園 # 名前のコメント\naliases: [菜園, 畑] # 別名のコメント\nkeywords:\n    - 苗 # 苗のコメント\n    - 肥料\nstatus: active # 状態\nowner: { name: 本人 }\n---\n本文\n';
  const next = withDefinition(raw, { title: 'ベランダ: 菜園', aliases: ['菜園', '#タグ'], keywords: ['肥料', '苗', '水やり'] });
  expect(next).toBe('---\nid: garden\ntitle: "ベランダ: 菜園" # 名前のコメント\naliases: [菜園, "#タグ"] # 別名のコメント\nkeywords:\n    - 肥料\n    - 苗 # 苗のコメント\n    - 水やり\nstatus: active # 状態\nowner: { name: 本人 }\n---\n本文\n');
  expect(parseMarkdown(withDefinition(raw, { title: '家庭菜園', aliases: [], keywords: [] })).meta).toMatchObject({ aliases: [], keywords: [], status: 'active', owner: { name: '本人' } });
  // 項目がなければ末尾に足し、改行コードを保つ。
  expect(withDefinition('---\r\nid: gg\r\ntitle: g\r\nstatus: active\r\n---\r\n', { title: 'g', aliases: ['b'], keywords: [] })).toBe('---\r\nid: gg\r\ntitle: g\r\nstatus: active\r\naliases: [b]\r\nkeywords: []\r\n---\r\n');
});

test('手で書いた空の語を含む定義も変更前として記録し、ほかの定義が壊れているときは書き換えない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  await vault.write(path, (await read(vault)).replace('aliases: []', 'aliases: ["", " 菜園 "]'));
  const before = await read(vault);
  const result = await setProjectDefinition(config, { projectId: 'garden', expectedHash: hash(before), title: '家庭菜園', aliases: ['菜園'], keywords: [], source: 'cli' });
  expect(await readProjectDefinitionChanges(vault)).toMatchObject([{ id: result.changeId, before: { aliases: ['', ' 菜園 '] }, after: { aliases: ['菜園'] } }]);
  await addProject(config, { id: 'work', title: '仕事' });
  await vault.write('10_projects/work/project.md', '---\nid: work\ntitle: 仕事\naliases: 3\nkeywords: []\nstatus: active\n---\n');
  const saved = await read(vault);
  await expect(setProjectDefinition(config, { projectId: 'garden', expectedHash: hash(saved), title: '畑', aliases: ['菜園'], keywords: [], source: 'cli' })).rejects.toThrow('10_projects/work/project.md');
  expect(await read(vault)).toBe(saved);
  const issues = (await doctor(config)).issues;
  expect(issues).toContain('プロジェクト定義が不正です: 10_projects/work/project.md（別名（aliases））');
  expect(issues.filter(i => !i.startsWith('プロジェクト定義が不正です')).every(i => i.endsWith('（プロジェクト定義を直してから再確認してください）'))).toBe(true);
});

test('Inputからの定義変更を受け付け、書き込み前の停止を同じ受付IDで回復する', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園', aliases: ['菜園'] });
  const before = await read(vault);
  const fields = { operation: 'project-definition', project_id: 'garden', project_hash: hash(before), title: '家庭菜園', aliases: ['菜園', 'ベランダ'], keywords: ['苗'], confirmed: true };
  await packet(config, { ...fields, confirmed: false }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect(parseIntake(p.path, (await vault.read(p.path))!, 8000)).toMatchObject({ operation: 'project-definition', aliases: ['菜園', 'ベランダ'] });
  const write = Vault.prototype.write;
  vi.spyOn(Vault.prototype, 'write').mockImplementation(async function (this: Vault, target, text) { if (target === path) throw new Error('停止'); return write.call(this, target, text); });
  expect((await ingest(config)).rejected).toBe(1);
  expect(await read(vault)).toBe(before);
  expect(await readProjectDefinitionChanges(vault)).toHaveLength(1);
  vi.restoreAllMocks();
  await rm(await vault.path(p.path));
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readProjects(config))[0]).toMatchObject({ aliases: ['菜園', 'ベランダ'], keywords: ['苗'] });
  expect(await readProjectDefinitionChanges(vault)).toHaveLength(1);
  expect(await readIntakeReceipts(config)).toMatchObject([{ operation: 'project-definition', result: { projectId: 'garden', deduped: true, changed: ['aliases', 'keywords'] } }]);
  expect((await doctor(config)).issues.join(' ')).not.toMatch(/受付記録が不正|プロジェクト定義/);
  expect((await ingest(config)).accepted).toBe(0);
});

test('別名を足すと、帰属未確定のメモが次の整理で新しい定義に関連付けられる', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '庭仕事' });
  await capture(config, { source: 'cli', kind: 'work-summary', occurredAt: '2026-10-01T10:00:00Z', text: '## 現在地\n- [確認済み] 菜園で苗を育てている' });
  await organize(config, new MockLlm());
  expect(await vault.read('10_projects/garden/NOW.md') ?? '').not.toContain('苗を育てている');
  await setProjectDefinition(config, { projectId: 'garden', expectedHash: hash(await read(vault)), title: '庭仕事', aliases: ['菜園'], keywords: [], source: 'cli' });
  await organize(config, new MockLlm());
  expect(await vault.read('10_projects/garden/NOW.md')).toContain('苗を育てている');
});

test('壊れた定義はファイルと項目を示して止め、モデルを呼ばずにHOMEへ示す', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  await addProject(config, { id: 'work', title: '仕事' });
  await vault.write('10_projects/work/project.md', (await vault.read('10_projects/work/project.md'))!.replace('aliases: []', 'aliases: 3').replace('title: 仕事', `title: ${'長'.repeat(201)}`));
  await vault.write('10_projects/garden/project.md', '---\nid: [壊れた\n---\n本文');
  const { projects, issues } = await inspectProjects(config);
  expect(projects).toEqual([]);
  expect(issues).toEqual(expect.arrayContaining([{ path: '10_projects/garden/project.md', fields: ['frontmatter'] }, { path: '10_projects/work/project.md', fields: ['title', 'aliases'] }]));
  await expect(readProjects(config)).rejects.toThrow('10_projects/work/project.md（名前（title）・別名（aliases））');
  expect((await doctor(config)).issues).toEqual(expect.arrayContaining(['プロジェクト定義が不正です: 10_projects/work/project.md（名前（title）・別名（aliases））']));
  await capture(config, { source: 'cli', occurredAt: '2026-10-01T10:00:00Z', text: '未整理のメモ' });
  const llm = { complete: vi.fn(async () => { throw new Error('呼ばない'); }) };
  await expect(runCycle(config, llm)).rejects.toThrow('プロジェクト定義が不正です');
  expect(llm.complete).not.toHaveBeenCalled();
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('## プロジェクト定義の不正（2件）');
  expect(home).toContain('[10_projects/work/project.md](<10_projects/work/project.md>): 名前（title）・別名（aliases）');
  // 直すと通常のHOMEに戻る。
  await vault.write('10_projects/work/project.md', (await vault.read('10_projects/work/project.md'))!.replace('aliases: 3', 'aliases: []').replace(/title: 長+/, 'title: 仕事'));
  await vault.write('10_projects/garden/project.md', '---\nid: garden\ntitle: 家庭菜園\naliases: []\nkeywords: []\nstatus: active\n---\n本文');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('## プロジェクト一覧');
});
