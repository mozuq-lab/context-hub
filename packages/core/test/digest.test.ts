import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup } from './workflow-fixtures.js';
import { hash } from '../src/storage.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { propose } from '../src/approvals.js';
import { buildDigest, rebuildDigest } from '../src/digest.js';
import { setProjectStatus } from '../src/project-status.js';
import { runCycle } from '../src/cycle.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const now = new Date('2026-11-02T00:00:00Z');
async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' }); await addProject(config, { id: 'calm', title: '静かな計画' }); await addProject(config, { id: 'rest', title: '休止中の計画' });
  const add = async (text: string, occurredAt: string, kind: 'memo' | 'work-summary' = 'work-summary', project: string | null = 'hub') => { const r = await capture(config, { source: 'file', kind, tool: 'codex', project: project ?? undefined, occurredAt, receivedAt: occurredAt, text }); await organize(config, new MockLlm()); return r; };
  const old = await add('## 現在地\n- [確認済み] 設計を終えた\n## 次の一手\n- [確認済み] 試作する\n## 未解決\n- 名前が決まっていない', '2026-10-20T00:00:00Z');
  await add('## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 試作する\n- [確認済み] 利用者に見せる', '2026-10-30T00:00:00Z');
  await add('思いつきのメモ', '2026-10-31T00:00:00Z', 'memo');
  await add('どこにも属さないメモ', '2026-11-01T00:00:00Z', 'memo', null);
  await add('## 現在地\n- [確認済み] 計画だけある', '2026-10-01T00:00:00Z', 'work-summary', 'calm');
  await setProjectStatus(config, { projectId: 'rest', status: 'paused', expectedHash: hash((await vault.read('10_projects/rest/project.md'))!), source: 'cli' });
  return { config, vault, old };
}

test('期間内の入力・NOWの変化・持ち越しの未解決をまとめる', async () => {
  const { config, old } = await fixture();
  const text = await buildDigest(config, { now });
  expect(text).toContain('# 直近7日のふりかえり');
  expect(text).toContain('期間: 2026-10-26 09:00 〜 2026-11-02 09:00 Asia/Tokyo');
  expect(text).toContain('- この期間に届いた入力: 3件（整理済み 3 / 整理待ち 0 / 整理失敗 0）');
  expect(text).toContain('- プロジェクト未帰属: 1件');
  const hub = text.slice(text.indexOf('### [集約ツール]'), text.indexOf('## 動きのなかった'));
  expect(hub).toContain('- 新しい入力: 2件（作業要約 1 / メモ 1）');
  expect(hub).toMatch(/- 現在地の変化（\[IN-[^\]]+\]\([^)]+\)）:\n {2}- 追加: 試作が動いた\n {2}- 外れた: 設計を終えた/);
  expect(hub).toMatch(/- 次の一手の変化（[^\n]+）:\n {2}- 追加: 利用者に見せる\n/);
  expect(hub).not.toContain('外れた: 試作する');
  expect(hub).toContain(`名前が決まっていない [${old.inputId}](${old.path})（13日前）`);
  expect(text.slice(text.indexOf('## 動きのなかった進行中のプロジェクト'))).toContain('[静かな計画](10_projects/calm/NOW.md) — 進行中 / 最終根拠: 2026-10-01 09:00（32日前）');
  expect(text.slice(text.indexOf('## 休止・完了'))).toContain('[休止中の計画](10_projects/rest/NOW.md) — 休止');
  expect(text).toContain('確認待ちの候補はありません。');
});

test('期間より前の候補を滞留として数え、日数の指定で集計範囲を変える', async () => {
  const { config } = await fixture();
  await propose(config, { claim: '週の始めにふりかえる' });
  const text = await buildDigest(config, { now: new Date(Date.now() + 10 * 86_400_000) });
  expect(text).toMatch(/確認待ちの候補: 1件（うち期間より前から残っているもの 1件）/);
  expect(text).toMatch(/- \[週の始めにふりかえる\]\([^)]+\) — 1[01]日前から/);
  const wide = await buildDigest(config, { now, days: 30 });
  expect(wide).toContain('# 直近30日のふりかえり');
  expect(wide).toContain('- この期間に届いた入力: 4件');
  await expect(buildDigest(config, { now, days: 0 })).rejects.toThrow();
});

test('REVIEW.mdを生成物として書き、手で編集された場合は競合へ退避する', async () => {
  const { config, vault } = await fixture();
  expect(await rebuildDigest(config, { now })).toEqual({ path: 'REVIEW.md' });
  const saved = (await vault.read('REVIEW.md'))!;
  expect(saved).toContain('verified: false'); expect(saved).toContain('period_days: 7');
  await vault.write('REVIEW.md', saved + '\n手で追記\n');
  const result = await rebuildDigest(config, { now });
  expect(result.conflict).toMatch(/^90_system\/conflicts\/REVIEW\.md\./);
  expect(await vault.read('REVIEW.md')).toContain('手で追記');
});

test('cycleがふりかえりを生成し、HOMEからリンクする', async () => {
  const { config, vault } = await workflowSetup(roots);
  const result = await runCycle(config, new MockLlm());
  expect(result.digest).toEqual({ path: 'REVIEW.md' });
  expect(await vault.read('REVIEW.md')).toContain('この期間に新しい入力のあったプロジェクトはありません。');
  expect(await vault.read('HOME.md')).toContain('直近7日のふりかえり: [REVIEW.md](REVIEW.md)');
  expect((await runCycle(config, new MockLlm(), { dryRun: true })).digest).toBeUndefined();
});
