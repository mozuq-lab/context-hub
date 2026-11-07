import { afterEach, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { Vault, parseMarkdown } from '../src/storage.js';
import { addProject, readProjects } from '../src/projects.js';
import { createProject, readProjectCreations } from '../src/project-creations.js';
import { ingest, readIntakeReceipts, intakeErrorSchema, intakeErrorMessage } from '../src/intake.js';
import { readInputs } from '../src/capture.js';
import { rebuildDashboard } from '../src/dashboard.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const id = 'project-01jc3b7q8k9m0n1p2q3r4s5t6v';
const fields = { operation: 'project-create', project_id: id, title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培', '野菜'], confirmed: true };

test('Inputからプロジェクトを作り、最初のメモをそのプロジェクトの入力にする', async () => {
  const { config, vault } = await workflowSetup(roots);
  const p = await packet(config, fields, 'トマトの苗を植えた');
  expect((await ingest(config)).accepted).toBe(1);
  const project = (await readProjects(config)).find(x => x.id === id);
  expect(project).toEqual({ id, title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培', '野菜'], status: 'active' });
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'project-create', result: { projectId: id, deduped: false } });
  const inputId = (receipt.result as { firstMemoInputId?: string }).firstMemoInputId;
  expect((await readInputs(config)).find(i => i.id === inputId)).toMatchObject({ kind: 'memo', project: id, text: 'トマトの苗を植えた', source: 'quickadd', occurred_at: '2026-10-03T10:00:00Z' });
  const [record] = await readProjectCreations(vault);
  expect(record).toMatchObject({ project_id: id, title: '家庭菜園', source: 'quickadd', source_event_id: p.requestId });
  // 同じ受付の再処理は重複して作らない。
  expect((await ingest(config)).deduped).toBeGreaterThanOrEqual(1);
  expect(await readProjectCreations(vault)).toHaveLength(1);
  expect((await readInputs(config)).filter(i => i.project === id)).toHaveLength(1);
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('家庭菜園');
});

test('本文が空なら作成だけを行う', async () => {
  const { config } = await workflowSetup(roots);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt.result).not.toHaveProperty('firstMemoInputId');
  expect(await readInputs(config)).toHaveLength(0);
});

test('名前・別名の重なりと同じIDは理由付きで受け付けない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '畑仕事', aliases: ['家庭菜園'] });
  const overlap = await packet(config, fields, '');
  expect((await ingest(config)).rejected).toBe(1);
  const errors = await Promise.all((await vault.files('90_system/intake-errors')).map(async p => intakeErrorSchema.parse(JSON.parse((await vault.read(p))!))));
  const error = errors.find(e => e.path === overlap.path)!;
  expect(error.reason).toEqual({ code: 'project-overlap', project_id: 'garden' });
  expect(intakeErrorMessage(error)).toContain('garden');
  expect((await readProjects(config)).map(p => p.id)).toEqual(['garden']);
  await rm(await vault.path(overlap.path));
  await createProject(config, { projectId: id, title: '別の名前', aliases: [], keywords: [], occurredAt: '2026-10-03T10:00:00Z', source: 'cli' });
  await expect(createProject(config, { projectId: id, title: 'さらに別', aliases: [], keywords: [], occurredAt: '2026-10-03T10:00:00Z', source: 'cli' })).rejects.toThrow('既にあります');
});

test('不正なIDや名前、上限を超える依頼は受付形式で拒否する', async () => {
  const { config } = await workflowSetup(roots);
  await packet(config, { ...fields, project_id: 'garden' }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, title: ' 前後に空白 ' }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, aliases: Array.from({ length: 51 }, (_, i) => `a${i}`) }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, confirmed: false }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, 'あ'.repeat(config.capture.maxInputChars + 1)); expect((await ingest(config)).rejected).toBe(1);
  expect(await readProjects(config)).toEqual([]);
});

test('定義の書き込み前に止まっても、同じ受付IDの再送で同じ内容を作る', async () => {
  const { config, vault } = await workflowSetup(roots);
  const p = await packet(config, fields, '最初のメモ');
  const create = Vault.prototype.create;
  vi.spyOn(Vault.prototype, 'create').mockImplementation(async function (this: Vault, rel, text) { if (rel === `10_projects/${id}/project.md`) throw new Error('停止'); return create.call(this, rel, text); });
  expect((await ingest(config)).rejected).toBe(1);
  vi.restoreAllMocks();
  expect(await readProjects(config)).toEqual([]);
  await rm(await vault.path(`90_system/intake-errors`), { recursive: true, force: true });
  expect((await ingest(config)).accepted).toBe(1);
  expect(await readProjectCreations(vault)).toHaveLength(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt.result).toMatchObject({ projectId: id, deduped: true });
  expect(parseMarkdown((await vault.read(`10_projects/${id}/project.md`))!).meta).toMatchObject({ id, title: '家庭菜園' });
  expect((await readInputs(config)).filter(i => i.project === id)).toHaveLength(1);
});

test('定義の書き込み前に止まった間に重なる名前のプロジェクトが作られたら、再送でも作らない', async () => {
  const { config, vault } = await workflowSetup(roots);
  const request = { projectId: id, title: '家庭菜園', aliases: ['菜園'], keywords: [], occurredAt: '2026-10-03T10:00:00Z', source: 'android-app', sourceEventId: 'REQ-1' };
  const create = Vault.prototype.create;
  vi.spyOn(Vault.prototype, 'create').mockImplementation(async function (this: Vault, rel, text) { if (rel === `10_projects/${id}/project.md`) throw new Error('停止'); return create.call(this, rel, text); });
  await expect(createProject(config, request)).rejects.toThrow('停止');
  vi.restoreAllMocks();
  await createProject(config, { ...request, projectId: 'project-01jc3b7q8k9m0n1p2q3r4s5t6w', aliases: [], sourceEventId: 'REQ-2' });
  await expect(createProject(config, request)).rejects.toMatchObject({ reason: { code: 'project-overlap', project_id: 'project-01jc3b7q8k9m0n1p2q3r4s5t6w' } });
  expect(await vault.read(`10_projects/${id}/project.md`)).toBeUndefined();
});
