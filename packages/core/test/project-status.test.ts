import { afterEach, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { Vault, hash, markdown, parseMarkdown } from '../src/storage.js';
import { addProject, readProjects } from '../src/projects.js';
import { setProjectStatus, readProjectStatusChanges, candidateProjects, lifecycleOf } from '../src/project-status.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { doctor } from '../src/doctor.js';
import type { LlmClient } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const definition = (vault: Vault, id: string) => vault.read(`10_projects/${id}/project.md`);

test('確認したハッシュに一致するときだけ状態を変え、本文と他の定義を保持する', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培'] });
  const path = '10_projects/garden/project.md', edited = (await vault.read(path))!.replace('人が保守するプロジェクト定義です。', '手で書いたメモ');
  await vault.write(path, edited);
  await expect(setProjectStatus(config, { projectId: 'garden', status: 'paused', expectedHash: '0'.repeat(64), source: 'cli' })).rejects.toThrow('変更されています');
  expect(await vault.read(path)).toBe(edited);
  const result = await setProjectStatus(config, { projectId: 'garden', status: 'paused', expectedHash: hash(edited), source: 'cli' });
  expect(result).toMatchObject({ projectId: 'garden', status: 'paused', deduped: false });
  const saved = parseMarkdown((await vault.read(path))!);
  expect(saved.meta).toMatchObject({ id: 'garden', title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培'], status: 'paused' });
  expect(saved.text).toContain('手で書いたメモ');
  const changes = await readProjectStatusChanges(vault);
  expect(changes).toMatchObject([{ id: result.changeId, project_id: 'garden', from: 'active', to: 'paused', before_hash: hash(edited), after_hash: hash((await vault.read(path))!) }]);
  // 変更後は古いハッシュでの再変更を受け付けない。
  await expect(setProjectStatus(config, { projectId: 'garden', status: 'done', expectedHash: hash(edited), source: 'cli' })).rejects.toThrow();
  await expect(setProjectStatus(config, { projectId: 'missing', status: 'done', expectedHash: hash(edited), source: 'cli' })).rejects.toThrow('見つかりません');
});

test('旧版の自由記述の状態は進行中として扱い、休止・完了は帰属候補から外す', () => {
  const base = { aliases: [], keywords: [] };
  const projects = [{ ...base, id: 'a1', title: 'A', status: 'active' }, { ...base, id: 'b1', title: 'B', status: '検討中' }, { ...base, id: 'c1', title: 'C', status: 'paused' }, { ...base, id: 'd1', title: 'D', status: 'done' }];
  expect(projects.map(lifecycleOf)).toEqual(['active', 'active', 'paused', 'done']);
  expect(candidateProjects(projects).map(p => p.id)).toEqual(['a1', 'b1']);
  expect(candidateProjects(projects, 'd1').map(p => p.id)).toEqual(['a1', 'b1', 'd1']);
});

test('Inputからの状態変更を受け付け、書き込み前の停止を同じ受付IDで回復する', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  const before = (await definition(vault, 'garden'))!;
  const fields = { operation: 'project-status', project_id: 'garden', project_hash: hash(before), status: 'done', confirmed: true };
  await packet(config, { ...fields, project_hash: 'x' }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  const write = Vault.prototype.write;
  vi.spyOn(Vault.prototype, 'write').mockImplementation(async function (this: Vault, path, text) { if (path === '10_projects/garden/project.md') throw new Error('停止'); return write.call(this, path, text); });
  expect((await ingest(config)).rejected).toBe(1);
  expect(await definition(vault, 'garden')).toBe(before);
  expect(await readProjectStatusChanges(vault)).toHaveLength(1);
  vi.restoreAllMocks();
  await rm(await vault.path(p.path));
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readProjects(config))[0].status).toBe('done');
  expect(await readProjectStatusChanges(vault)).toHaveLength(1);
  const acks = await readIntakeReceipts(config);
  expect(acks).toMatchObject([{ operation: 'project-status', result: { projectId: 'garden', status: 'done', deduped: true } }]);
  expect((await doctor(config)).issues.join(' ')).not.toContain('受付記録が不正');
  // 同じ受付IDの再送は何も変えない。
  expect((await ingest(config)).accepted).toBe(0);
});

test('HOMEに最終根拠からの日数を出し、停滞・休止・完了を分けて並べる', async () => {
  const { config, vault } = await workflowSetup(roots);
  for (const [id, title] of [['fresh', '最近の作業'], ['old', '止まった作業'], ['rest', '休んでいる作業'], ['empty', '根拠なし']]) await addProject(config, { id, title });
  const now = (id: string, at: string) => vault.write(`10_projects/${id}/NOW.md`, markdown({ project: id, last_evidence_at: at }, '<!-- ctx:auto:start -->\n<!-- ctx:auto:end -->\n'));
  await now('fresh', '2026-10-30T00:00:00Z'); await now('old', '2026-10-01T00:00:00Z'); await now('rest', '2026-09-01T00:00:00Z');
  await setProjectStatus(config, { projectId: 'rest', status: 'paused', expectedHash: hash((await definition(vault, 'rest'))!), source: 'cli' });
  await rebuildDashboard(config, { now: new Date('2026-11-02T00:00:00Z') });
  const home = (await vault.read('HOME.md'))!;
  const section = (title: string) => home.slice(home.indexOf(title)).split('\n## ')[0];
  expect(section('## プロジェクト一覧')).toContain('最近の作業](10_projects/fresh/NOW.md) — fresh / 進行中 / 最終根拠: 2026-10-30 09:00（3日前）');
  expect(section('## プロジェクト一覧')).toContain('根拠なし');
  expect(section('## プロジェクト一覧')).not.toContain('止まった作業');
  expect(section('## 停滞しているプロジェクト（1件）')).toContain('止まった作業](10_projects/old/NOW.md) — old / 進行中 / 最終根拠: 2026-10-01 09:00（32日前）');
  expect(section('## 休止・完了（1件）')).toContain('休んでいる作業](10_projects/rest/NOW.md) — rest / 休止');
  expect(home).not.toContain('REVIEW.md');
});

test('休止したプロジェクトは整理の候補に出さず、人が指定した入力では残す', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園', keywords: ['栽培'] }); await addProject(config, { id: 'study', title: '勉強会', keywords: ['輪読'] });
  await setProjectStatus(config, { projectId: 'garden', status: 'paused', expectedHash: hash((await definition(vault, 'garden'))!), source: 'cli' });
  const prompts: string[] = [], mock = new MockLlm();
  const llm: LlmClient = { complete: async (prompt, opts) => { prompts.push(prompt); return mock.complete(prompt, opts); } };
  await capture(config, { source: 'cli', occurredAt: '2026-11-01T00:00:00Z', text: '栽培と輪読のメモ' });
  await organize(config, llm);
  expect(prompts.at(-1)).toContain('"id":"study"'); expect(prompts.at(-1)).not.toContain('"id":"garden"');
  await capture(config, { source: 'cli', occurredAt: '2026-11-01T01:00:00Z', text: '菜園の片付け', project: 'garden' });
  await organize(config, llm);
  expect(prompts.at(-1)).toContain('"id":"garden"');
});
