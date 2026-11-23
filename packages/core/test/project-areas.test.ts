import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { hash, parseMarkdown } from '../src/storage.js';
import { addProject, readProjects } from '../src/projects.js';
import { setProjectStatus } from '../src/project-status.js';
import { projectRegistryHash } from '../src/associations.js';
import { orderAreas, readArea } from '../src/areas.js';
import { readProjectAreaChanges, setProjectArea, withArea } from '../src/project-areas.js';
import { setClientPreferences } from '../src/client-preferences.js';
import { createProject } from '../src/project-creations.js';
import { ingest, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { buildWeeklyReview, weeklyReviewDigestLines, weeklyReviewListSchema } from '../src/weekly-review.js';
import { doctor } from '../src/doctor.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const raw = async (vault: { read(p: string): Promise<string | undefined> }, id: string) => (await vault.read(`10_projects/${id}/project.md`))!;

test('確認したハッシュに一致するときだけ領域を書き、ほかの行・コメント・本文を保ち、外せる。登録簿のハッシュは変わらない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園', aliases: ['菜園'] });
  const path = '10_projects/garden/project.md', edited = (await raw(vault, 'garden')).replace('status: active', 'status: active # 手で書いたコメント');
  await vault.write(path, edited);
  const registry = projectRegistryHash(await readProjects(config));
  await expect(setProjectArea(config, { projectId: 'garden', area: '家', expectedHash: '0'.repeat(64), source: 'cli' })).rejects.toThrow('変更されています');
  const result = await setProjectArea(config, { projectId: 'garden', area: '家', expectedHash: hash(edited), source: 'cli' });
  expect(result).toMatchObject({ projectId: 'garden', area: '家', deduped: false });
  const saved = await raw(vault, 'garden');
  expect(saved).toContain('status: active # 手で書いたコメント');
  expect(saved).toContain('\narea: 家\n');
  expect((await readProjects(config))[0]).toMatchObject({ id: 'garden', area: '家' });
  expect(projectRegistryHash(await readProjects(config))).toBe(registry);
  expect((await readProjectAreaChanges(vault)).records).toMatchObject([{ id: result.changeId, from: null, to: '家', before_hash: hash(edited), after_hash: hash(saved) }]);
  await expect(setProjectArea(config, { projectId: 'garden', area: '家', expectedHash: hash(saved), source: 'cli' })).rejects.toThrow('既に領域');
  // 変える・外す。外すと行ごとなくなる。
  await setProjectArea(config, { projectId: 'garden', area: '暮らし', expectedHash: hash(saved), source: 'cli' });
  expect(await raw(vault, 'garden')).toContain('\narea: 暮らし\n');
  await setProjectArea(config, { projectId: 'garden', area: null, expectedHash: hash(await raw(vault, 'garden')), source: 'cli' });
  expect(await raw(vault, 'garden')).not.toContain('area');
  expect((await readProjects(config))[0]!.area).toBeUndefined();
  await expect(setProjectArea(config, { projectId: 'garden', area: null, expectedHash: hash(await raw(vault, 'garden')), source: 'cli' })).rejects.toThrow('外す領域はありません');
  // 規則に合わない名前は受け付けない。
  for (const bad of ['', ' 家', 'a'.repeat(21), '家\n庭', '領域なし']) await expect(setProjectArea(config, { projectId: 'garden', area: bad, expectedHash: hash(await raw(vault, 'garden')), source: 'cli' })).rejects.toThrow();
  // YAMLとして別の値に読める名前は引用符で書く。
  expect(withArea(await raw(vault, 'garden'), 'true')).toContain('area: "true"');
  expect(readArea(parseMarkdown(withArea(await raw(vault, 'garden'), '123')).meta.area)).toBe('123');
});

test('手で書いた不正な領域は領域なしとして読み、doctorで示す', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  await vault.write('10_projects/garden/project.md', (await raw(vault, 'garden')).replace('status: active', 'status: active\narea: [仕事, 家]'));
  expect((await readProjects(config))[0]!.area).toBeUndefined();
  expect((await doctor(config)).issues.some(i => i.startsWith('領域（area）が読めません') && i.includes('10_projects/garden/project.md'))).toBe(true);
  // 不正な値は、正しい領域で書き直せる。
  const fixed = await setProjectArea(config, { projectId: 'garden', area: '家', expectedHash: hash(await raw(vault, 'garden')), source: 'cli' });
  expect(fixed.deduped).toBe(false);
  expect((await readProjects(config))[0]!.area).toBe('家');
  expect((await doctor(config)).issues.some(i => i.startsWith('領域（area）'))).toBe(false);
});

test('受付の依頼で付けられ、別の端末からの同じ領域の依頼は記録を増やさずに受け付け、作成の依頼でも付けられる', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  expect(intakeFeatures(config).operations).toContain('project-area');
  expect(intakeFeatures(config).project_areas).toEqual({ max_chars: 20, vocabulary_max: 12 });
  const seen = hash(await raw(vault, 'garden'));
  await packet(config, { operation: 'project-area', project_id: 'garden', project_hash: seen, area: '家', confirmed: true }, '');
  await packet(config, { operation: 'project-area', project_id: 'garden', project_hash: seen, area: '家', confirmed: true }, '');
  const run = await ingest(config);
  expect(run.accepted).toBe(2);
  const results = (await readIntakeReceipts(config)).filter(r => r.operation === 'project-area').map(r => r.result);
  expect(results).toHaveLength(2);
  expect(new Set(results.map(r => 'areaChangeId' in r ? r.areaChangeId : ''))).toHaveProperty('size', 1);
  expect((await readProjectAreaChanges(vault)).records).toHaveLength(1);
  // 外す依頼。
  await packet(config, { operation: 'project-area', project_id: 'garden', project_hash: hash(await raw(vault, 'garden')), area: null, confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readProjects(config))[0]!.area).toBeUndefined();
  // 不正な名前の依頼は受け付けない。
  await packet(config, { operation: 'project-area', project_id: 'garden', project_hash: hash(await raw(vault, 'garden')), area: ' 家', confirmed: true }, '');
  expect((await ingest(config)).rejected).toBe(1);
  // 作成の依頼に領域を添えられる。
  const created = await createProject(config, { projectId: 'project-01kaxqz0000000000000000000', title: '引っ越し', aliases: [], keywords: [], area: '家', occurredAt: '2026-11-20T00:00:00Z', source: 'cli' });
  expect((await readProjects(config)).find(p => p.id === created.projectId)!.area).toBe('家');
  await expect(createProject(config, { projectId: 'project-01kaxqz0000000000000000001', title: '別の作成', aliases: [], keywords: [], area: '', occurredAt: '2026-11-20T00:00:00Z', source: 'cli' })).rejects.toThrow();
});

test('HOMEと週次レビューは、領域を付けたときだけ領域ごとにまとめ、本人の語彙の順に並べる', async () => {
  const { config, vault } = await workflowSetup(roots);
  const clock = new Date('2026-11-23T03:00:00Z');
  for (const [id, title] of [['garden', '家庭菜園'], ['report', '月次報告'], ['hiring', '採用'], ['misc', '雑務'], ['old', '昔の仕事']] as const) await addProject(config, { id, title });
  await capture(config, { source: 'cli', project: 'garden', text: '種をまいた', occurredAt: '2026-11-20T00:00:00Z' });
  await capture(config, { source: 'cli', project: 'report', text: '報告を書いた', occurredAt: '2026-09-01T00:00:00Z' });
  await organize(config, new MockLlm());
  await rebuildDashboard(config, { now: clock });
  expect(await vault.read('HOME.md')).not.toContain('### 領域なし');
  expect((await buildWeeklyReview(config, vault, clock)).areas).toBeUndefined();
  const set = async (id: string, area: string) => setProjectArea(config, { projectId: id, area, expectedHash: hash(await raw(vault, id)), source: 'cli' });
  await set('garden', '家'); await set('report', '仕事'); await set('hiring', '仕事'); await set('old', '趣味');
  await setProjectStatus(config, { projectId: 'old', status: 'paused', expectedHash: hash(await raw(vault, 'old')), source: 'cli' });
  await setClientPreferences(config, { payload: { schema_version: 1, device: 'mac', groups: { areas: { updated_at: '2026-11-22T00:00:00Z', value: { items: ['仕事', '家', '健康'] } } } }, source: 'app', sourceEventId: 'REQ-1', now: clock });
  await rebuildDashboard(config, { now: clock });
  const home = (await vault.read('HOME.md'))!;
  const list = home.slice(home.indexOf('## プロジェクト一覧'));
  // 語彙の順（仕事→家）、語彙にない領域は後ろ、領域なしは最後。休止のプロジェクトは休止の欄に残る。
  expect(list.indexOf('### 仕事')).toBeLessThan(list.indexOf('### 家'));
  expect(list.indexOf('### 家')).toBeLessThan(list.indexOf('### 領域なし'));
  expect(list).not.toContain('### 健康');
  expect(list).not.toContain('### 趣味');
  expect(list).toContain('/ 領域: 仕事');
  const review = weeklyReviewListSchema.parse(await buildWeeklyReview(config, vault, clock));
  expect(review.areas).toEqual([
    { area: '仕事', active: 2, paused: 0, done: 0, last_evidence: '2026-09-01T00:00:00Z', no_active: false, quiet: true },
    { area: '家', active: 1, paused: 0, done: 0, last_evidence: '2026-11-20T00:00:00Z', no_active: false, quiet: false },
    { area: '趣味', active: 0, paused: 1, done: 0, last_evidence: null, no_active: true, quiet: false },
    { area: null, active: 1, paused: 0, done: 0, last_evidence: null, no_active: false, quiet: true },
  ]);
  expect(review.projects.find(p => p.project_id === 'report')!.area).toBe('仕事');
  const lines = weeklyReviewDigestLines(review, clock, config.timezone).join('\n');
  expect(lines).toContain('8. 領域を見渡す: 4件（進行中のプロジェクトがない領域 1件・30日以上動いていない領域 2件');
  expect(lines).toContain('   - 趣味: 進行中 0件・休止 1件・完了 0件（進行中なし）');
  expect(orderAreas(['b', undefined, 'a', 'c'], ['c'])).toEqual(['c', 'a', 'b', undefined]);
});
