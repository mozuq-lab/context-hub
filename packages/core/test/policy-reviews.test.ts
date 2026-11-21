import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { propose, approve } from '../src/approvals.js';
import { readProjectCatalog } from '../src/knowledge-scope.js';
import { retireKnowledge } from '../src/knowledge-retirement.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { ingest } from '../src/intake.js';
import { buildReviewIndex } from '../src/candidate-review.js';
import { buildHistory } from '../src/history.js';
import { doctor } from '../src/doctor.js';
import { PolicyReviewError, keepPolicy, policyReviewItems } from '../src/policy-reviews.js';
import { Vault, hash } from '../src/storage.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const global = await propose(config, { claim: '正本はMarkdownとする', kind: 'decision', rationale: '復旧しやすい' });
  const g = await approve(config, global.candidateId, global.hash, { scope: 'global' });
  const projectHash = (await readProjectCatalog(vault)).find(p => p.id === 'hub')!.hash;
  const local = await propose(config, { claim: '説明は短く書く', kind: 'preference', rationale: '読み返しやすい' });
  const p = await approve(config, local.candidateId, local.hash, { scope: 'project', projectId: 'hub', projectHash });
  const knowledge = await propose(config, { claim: 'Syncthingは双方向', kind: 'knowledge', rationale: '仕様' });
  await approve(config, knowledge.candidateId, knowledge.hash, { scope: 'global' });
  await capture(config, { source: 'cli', project: 'hub', occurredAt: new Date().toISOString(), text: '説明が長すぎると言われた' });
  const fileHash = async (id: string) => hash((await vault.read((await vault.files('30_knowledge')).concat(await vault.files('10_projects/hub/knowledge')).find(x => x.endsWith(`/${id}.md`))!))!);
  return { config, vault, globalId: g.knowledgeId!, projectId: p.knowledgeId!, fileHash };
}

test('採用から日数が過ぎた方針だけを見直しに出し、参考知識は対象にしない', async () => {
  const { config, vault, globalId, projectId } = await fixture();
  expect((await policyReviewItems(config, vault)).items.map(i => [i.knowledgeId, i.due])).toEqual(expect.arrayContaining([[globalId, false], [projectId, false]]));
  const { items } = await policyReviewItems(config, vault, { now: later(91), inputs: (await (await import('../src/capture.js')).readInputs(config)) });
  expect(items).toHaveLength(2);
  expect(items.every(i => i.due)).toBe(true);
  expect(items.find(i => i.knowledgeId === projectId)).toMatchObject({ projectId: 'hub', kind: 'preference', newInputs: 1 });
  expect(items.find(i => i.knowledgeId === globalId)).toMatchObject({ projectId: null, kind: 'decision' });
  expect(items.find(i => i.knowledgeId === globalId)!.newInputs).toBeUndefined();

  await rebuildDashboard(config, { now: later(91) });
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('## 見直す方針（2件）');
  expect(home).toContain('正本はMarkdownとする');
  expect(home).toContain(`${projectId} / hash `);
  const section = home.slice(home.indexOf('## 見直す方針'), home.indexOf('## 要確認'));
  expect(section).toContain('その後このプロジェクトを指定したメモ 1件');
  expect(section).not.toContain('Syncthingは双方向');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).not.toContain('## 見直す方針');
  // 0日にすると見直しを出さない。
  await rebuildDashboard({ ...config, policy: { ...config.policy, reviewDays: 0 } }, { now: later(400) });
  expect(await vault.read('HOME.md')).not.toContain('## 見直す方針');
});

test('「まだ有効」と確かめた日から数え直し、内容の変わった・止めた方針は確かめられない', async () => {
  const { config, vault, globalId, projectId, fileHash } = await fixture();
  const h = await fileHash(projectId);
  await expect(keepPolicy(config, { knowledgeId: projectId, expectedHash: '0'.repeat(64), source: 'cli' })).rejects.toMatchObject({ reason: { cause: 'changed' } });
  const kept = await keepPolicy(config, { knowledgeId: projectId, expectedHash: h, source: 'app', sourceEventId: 'REQ-1', reviewedAt: later(60).toISOString() });
  expect(kept.reviewId).toMatch(/^PREV-/);
  expect((await keepPolicy(config, { knowledgeId: projectId, expectedHash: h, source: 'app', sourceEventId: 'REQ-1' })).deduped).toBe(true);
  const items = (await policyReviewItems(config, vault, { now: later(91) })).items;
  expect(items.find(i => i.knowledgeId === projectId)).toMatchObject({ due: false, days: 31 });
  expect(items.find(i => i.knowledgeId === projectId)!.confirmedAt).toBeDefined();
  expect(items.find(i => i.knowledgeId === globalId)!.due).toBe(true);
  // 見直しの記録は経緯にも残る。
  expect(await buildHistory(config, 'hub')).toContain('好みがまだ有効と確かめた: 説明は短く書く');

  const g = await fileHash(globalId);
  await retireKnowledge(config, globalId, g);
  await expect(keepPolicy(config, { knowledgeId: globalId, expectedHash: g, source: 'cli' })).rejects.toBeInstanceOf(PolicyReviewError);
  await expect(keepPolicy(config, { knowledgeId: globalId, expectedHash: g, source: 'cli' })).rejects.toMatchObject({ reason: { cause: 'inactive' } });
  await expect(keepPolicy(config, { knowledgeId: 'KNW-' + '0'.repeat(26), expectedHash: g, source: 'cli' })).rejects.toMatchObject({ reason: { cause: 'missing' } });
  expect((await doctor(config)).issues).toEqual([]);
});

test('端末からの「まだ有効」を受け付け、候補一覧に見直しの状態を添える', async () => {
  const { config, vault, globalId, projectId, fileHash } = await fixture();
  const good = await packet(config, { operation: 'policy-keep', knowledge_id: projectId, knowledge_hash: await fileHash(projectId), confirmed: true }, '');
  const bad = await packet(config, { operation: 'policy-keep', knowledge_id: globalId, knowledge_hash: 'f'.repeat(64), confirmed: true }, '');
  const result = await ingest(config);
  expect(result.accepted).toBe(1);
  expect(result.rejected).toBe(1);
  const receipt = JSON.parse((await vault.read(`90_system/intake/${good.requestId}.json`))!);
  expect(receipt.result).toMatchObject({ knowledgeId: projectId, deduped: false });
  expect(receipt.result.reviewId).toMatch(/^PREV-/);
  const [errorPath] = await vault.files('90_system/intake-errors'), record = JSON.parse((await vault.read(errorPath!))!);
  expect(record.reason).toEqual({ code: 'policy-review-refused', cause: 'changed' });
  expect(record.code).toContain('方針の内容が変わっています');
  expect(await vault.read(`90_system/intake/${bad.requestId}.json`)).toBeUndefined();
  expect((await ingest(config)).rejected).toBe(0);

  const index = await buildReviewIndex(config);
  const item = index.items.find(i => i.id === `CAN-${projectId.slice(4)}`)!;
  expect(item.policyReview).toMatchObject({ due: false, reviewDays: 90 });
  expect(item.policyReview!.confirmedAt).toBeDefined();
  expect(index.items.find(i => i.claim === 'Syncthingは双方向')!.policyReview).toBeUndefined();
  void new Vault(config);
});
