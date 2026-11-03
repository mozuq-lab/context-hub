import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { setProjectStatus } from '../src/project-status.js';
import { capture, readInputs } from '../src/capture.js';
import { hash } from '../src/storage.js';
import { ingest } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { runCycle } from '../src/cycle.js';
import { MockLlm } from '../src/llm.js';
import { collectGitDrafts, dismissGitDraft, gitLog, readGitDrafts, useGitDraft } from '../src/git-drafts.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

async function repo(commits: [string, string][]) {
  const dir = await mkdtemp(join(tmpdir(), 'ctx-git-')); roots.push(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  execFileSync('git', ['init', '-q', dir]);
  for (const [i, [message, at]] of commits.entries()) {
    await writeFile(join(dir, 'f.txt'), String(i));
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message], { env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  }
  return { dir, commit: async (message: string, at: string) => { await writeFile(join(dir, 'f.txt'), message); execFileSync('git', ['-C', dir, 'add', '.']); execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message], { env: { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }); } };
}
const now = new Date('2026-11-03T00:00:00Z');

test('無効のとき、またはリポジトリ未設定のときはgitを実行しない', async () => {
  const { config } = await workflowSetup(roots);
  const log = () => { throw new Error('呼ばれない'); };
  expect(await collectGitDrafts(config, { now, log })).toEqual({ created: [], skipped: [], errors: [] });
  expect(await collectGitDrafts({ ...config, git: { ...config.git, enabled: true } }, { now, log })).toEqual({ created: [], skipped: [], errors: [] });
});

test('最後の根拠以降のコミットから下書きを作り、未確認の間は重ねて作らない', async () => {
  const { config: base, vault } = await workflowSetup(roots);
  const r = await repo([['古い変更', '2026-10-01T00:00:00Z'], ['画面を追加', '2026-11-01T01:00:00Z'], ['テスト\x1bを直す', '2026-11-02T01:00:00Z']]);
  const config = { ...base, git: { enabled: true, repos: [{ projectId: 'hub', path: r.dir, name: 'hub-app' }, { projectId: 'missing', path: join(r.dir, 'other') }], maxCommits: 30, lookbackDays: 14 } };
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'memo', project: 'hub', occurredAt: '2026-10-31T00:00:00Z', receivedAt: '2026-10-31T00:00:00Z', text: '最後の根拠' });
  const first = await collectGitDrafts(config, { now });
  expect(first.created).toHaveLength(1);
  expect(first.errors).toEqual([expect.objectContaining({ projectId: 'missing', error: '設定したプロジェクトが見つかりません' })]);
  const [draft] = await readGitDrafts(config);
  expect(draft).toMatchObject({ project_id: 'hub', repo: 'hub-app', status: 'pending' });
  expect(draft!.commits.map(c => c.subject)).toEqual(['画面を追加', 'テスト を直す']);
  expect(draft).toMatchObject({ repo_path: r.dir, omitted: 0 });
  expect(draft!.text).toContain('hub-appのコミット履歴（2026-11-01〜2026-11-02、2件）');
  expect(draft!.text).toMatch(/- 2026-11-01 画面を追加 \([a-f0-9]{7}\)\n- 2026-11-02 テスト を直す/);
  expect((await collectGitDrafts(config, { now })).skipped[0]).toMatchObject({ projectId: 'hub', reason: '未確認の下書きがあります' });
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain(`## 作業記録の下書き（1件）`);
  expect(await vault.read('HOME.md')).toContain('作業記録の下書き（missing / other）: 設定したプロジェクトが見つかりません');
  expect(await vault.read('HOME.md')).toContain(`集約ツール / hub-app: コミット2件 — [${draft!.id}](${draft!.path}) / hash ${draft!.hash}`);
  // 見送った後は、下書きにしたコミットを再び拾わない。
  await expect(dismissGitDraft(config, { draftId: draft!.id, expectedHash: '0'.repeat(64), source: 'cli' })).rejects.toThrow('変更されています');
  expect(await dismissGitDraft(config, { draftId: draft!.id, expectedHash: draft!.hash, source: 'cli' })).toMatchObject({ deduped: false });
  expect(await dismissGitDraft(config, { draftId: draft!.id, expectedHash: draft!.hash, source: 'cli' })).toMatchObject({ deduped: true });
  expect((await collectGitDrafts(config, { now })).created).toEqual([]);
  await r.commit('同期を直す', '2026-11-02T12:00:00Z');
  const second = await collectGitDrafts(config, { now });
  expect(second.created).toHaveLength(1);
  expect((await readGitDrafts(config)).find(d => d.id === second.created[0])!.commits.map(c => c.subject)).toEqual(['同期を直す']);
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('## 作業記録の下書き（1件）');
});

test('下書きを入力にすると使用済みになり、休止中のプロジェクトは対象外にする', async () => {
  const { config: base, vault } = await workflowSetup(roots);
  const r = await repo([['画面を追加', '2026-11-01T01:00:00Z']]);
  const config = { ...base, git: { enabled: true, repos: [{ projectId: 'hub', path: r.dir }], maxCommits: 30, lookbackDays: 14 } };
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await collectGitDrafts(config, { now });
  const [draft] = await readGitDrafts(config);
  const used = await useGitDraft(config, { draftId: draft!.id, expectedHash: draft!.hash, kind: 'memo', source: 'cli' });
  expect(used).toMatchObject({ deduped: false });
  expect(await useGitDraft(config, { draftId: draft!.id, expectedHash: draft!.hash, kind: 'memo', source: 'cli' })).toMatchObject({ deduped: true, inputId: used.inputId });
  const input = (await readInputs(config)).find(i => i.id === used.inputId)!;
  expect(input).toMatchObject({ kind: 'memo', project: 'hub', tool: 'git', occurred_at: '2026-11-01T01:00:00.000Z', meta: { git_draft: draft!.id } });
  expect((await readGitDrafts(config))[0]).toMatchObject({ status: 'used', inputId: used.inputId });
  await expect(dismissGitDraft(config, { draftId: draft!.id, expectedHash: draft!.hash, source: 'cli' })).rejects.toThrow('見送れません');
  await setProjectStatus(config, { projectId: 'hub', status: 'paused', expectedHash: hash((await vault.read('10_projects/hub/project.md'))!), source: 'cli' });
  await r.commit('次の変更', '2026-11-02T01:00:00Z');
  expect((await collectGitDrafts(config, { now })).skipped[0]).toMatchObject({ reason: '休止・完了のプロジェクトです' });
});

test('アプリの見送り依頼を受け付け、cycleは読めないリポジトリでも止まらない', async () => {
  const { config: base } = await workflowSetup(roots);
  const r = await repo([['画面を追加', '2026-11-01T01:00:00Z']]);
  const config = { ...base, git: { enabled: true, repos: [{ projectId: 'hub', path: r.dir }], maxCommits: 30, lookbackDays: 3650 } };
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const result = await runCycle(config, new MockLlm());
  expect(result.git?.created).toHaveLength(1);
  const [draft] = await readGitDrafts(config);
  await packet(config, { operation: 'git-draft-dismiss', source: 'flutter', draft_id: draft!.id, draft_hash: draft!.hash, confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readGitDrafts(config))[0]!.status).toBe('dismissed');
  const broken = { ...config, git: { ...config.git, repos: [{ projectId: 'hub', path: join(r.dir, 'missing') }] } };
  const cycle = await runCycle(broken, new MockLlm());
  expect(cycle.git?.errors).toEqual([expect.objectContaining({ error: 'コミット履歴を読み取れません' })]);
  expect(cycle.dashboard).toBeDefined();
});

test('git logは固定引数で件名の制御文字を除き、件数の上限を守る', async () => {
  const r = await repo([['一', '2026-11-01T00:00:00Z'], ['二', '2026-11-01T01:00:00Z'], ['三\tタブ', '2026-11-01T02:00:00Z']]);
  const rows = await gitLog(r.dir, { since: '2026-10-01T00:00:00Z', max: 2 });
  expect(rows.map(x => x.subject)).toEqual(['二', '三 タブ']);
  expect(rows[1]!.committed_at).toBe('2026-11-01T02:00:00.000Z');
  // 前回のコミットからの範囲で読み、履歴にないコミットなら日時で読み直す。
  const all = await gitLog(r.dir, { since: '2026-10-01T00:00:00Z', max: 10 });
  expect((await gitLog(r.dir, { since: '2030-01-01T00:00:00Z', after: all[0]!.sha, max: 10 })).map(x => x.subject)).toEqual(['二', '三 タブ']);
  expect(await gitLog(r.dir, { since: '2030-01-01T00:00:00Z', after: 'f'.repeat(40), max: 10 })).toEqual([]);
  // 継承したGIT_DIRは無視する。
  process.env.GIT_DIR = '/nonexistent';
  try { expect(await gitLog(r.dir, { since: '2026-10-01T00:00:00Z', max: 10 })).toHaveLength(3); } finally { delete process.env.GIT_DIR; }
});

test('上限を超えるコミットは古い順に入れて残りを次の下書きに回し、壊れた下書きでもHOMEを作る', async () => {
  const { config: base, vault } = await workflowSetup(roots);
  const r = await repo(Array.from({ length: 6 }, (_, i) => [`変更${i}${'あ'.repeat(150)}`, `2026-11-01T0${i}:00:00Z`] as [string, string]));
  const config = { ...base, capture: { ...base.capture, maxInputChars: 600 }, git: { enabled: true, repos: [{ projectId: 'hub', path: r.dir }], maxCommits: 4, lookbackDays: 14 } };
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await collectGitDrafts(config, { now });
  const [first] = await readGitDrafts(config);
  expect(first!.text.length).toBeLessThanOrEqual(600);
  expect(first!.commits[0]!.subject.startsWith('変更0')).toBe(true);
  expect(first!.omitted).toBe(6 - first!.commits.length);
  expect(first!.text).toContain(`ほか${first!.omitted}件は次の下書きに回します`);
  await dismissGitDraft(config, { draftId: first!.id, expectedHash: first!.hash, source: 'cli' });
  await collectGitDrafts(config, { now });
  const second = (await readGitDrafts(config)).find(d => d.status === 'pending')!;
  expect(second.commits[0]!.subject.startsWith(`変更${first!.commits.length}`)).toBe(true);
  await vault.write(second.path, '{"broken":true}');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain(`[作業記録の下書きの記録が不正です](${second.path})`);
});

test('同じプロジェクト・同じhashの下書きから作った入力だけを使用済みにする', async () => {
  const { config: base } = await workflowSetup(roots);
  const r = await repo([['画面を追加', '2026-11-01T01:00:00Z']]);
  const config = { ...base, git: { enabled: true, repos: [{ projectId: 'hub', path: r.dir }], maxCommits: 30, lookbackDays: 14 } };
  await addProject(config, { id: 'hub', title: '集約ツール' }); await addProject(config, { id: 'other', title: '別' });
  await collectGitDrafts(config, { now });
  const [draft] = await readGitDrafts(config);
  await capture(config, { source: 'x', kind: 'memo', project: 'other', occurredAt: '2026-11-01T02:00:00Z', text: '別', meta: { git_draft: draft!.id, git_draft_hash: draft!.hash } });
  await capture(config, { source: 'x', kind: 'memo', project: 'hub', occurredAt: '2026-11-01T02:00:00Z', text: '古い', meta: { git_draft: draft!.id, git_draft_hash: '0'.repeat(64) } });
  expect((await readGitDrafts(config))[0]!.status).toBe('pending');
  await capture(config, { source: 'x', kind: 'memo', project: 'hub', occurredAt: '2026-11-01T02:00:00Z', text: '編集した本文', meta: { git_draft: draft!.id, git_draft_hash: draft!.hash } });
  expect((await readGitDrafts(config))[0]!.status).toBe('used');
});
