import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { capture, readInputs } from '../src/capture.js';
import { Vault, hash, markdown, parseMarkdown } from '../src/storage.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { rebuildNow } from '../src/views.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { rebuildDigest } from '../src/digest.js';
import { listConflicts, readConflictResolutions, resolveConflict } from '../src/conflicts.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { doctor } from '../src/doctor.js';
import { resume } from '../src/retrieve.js';
import type { HubConfig, OrganizeResult } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const nowPath = '10_projects/context-hub/NOW.md';
async function setup(): Promise<HubConfig> {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-conflicts-')); roots.push(root);
  const config = defaultConfig(path.join(root, 'vault'), path.join(root, 'state')); const vault = new Vault(config); await vault.init();
  await vault.write('10_projects/context-hub/project.md', markdown({ id: 'context-hub', title: 'コンテキスト集約', aliases: [], keywords: ['集約'], status: 'active' }, '# プロジェクト\n'));
  return config;
}
function summary(current: string): OrganizeResult { return { category: 'project-update', summary: current, project_candidates: [], next_action_suggestions: [], extracted: { current: [{ text: current, status: 'confirmed' }], next: [{ text: 'ローカルでテストする', status: 'confirmed' }], open: [] }, knowledge_candidate: null, new_project_hint: null }; }
async function report(config: HubConfig, at: string, current: string) {
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'context-hub', occurredAt: at, text: `## 現在地\n- [確認済み] ${current}` });
  await organize(config, new MockLlm([summary(current)]));
}
/** NOWの自動領域を手で書き換え、手動領域にも書き足す。 */
async function editNow(vault: Vault): Promise<string> {
  const edited = (await vault.read(nowPath))!.replace('<!-- ctx:auto:start -->', '手動メモ: 消さない\n\n<!-- ctx:auto:start -->').replace('- 実装済み', '- 人が直した現在地');
  await vault.write(nowPath, edited); return edited;
}
async function packet(config: HubConfig, fields: Record<string, unknown>) {
  const request_id = `REQ-${randomBytes(16).toString('hex')}`, rel = `Input/${request_id}.md`;
  await new Vault(config).create(rel, markdown({ schema_version: 1, request_id, source: 'android-app', occurred_at: '2026-10-03T10:00:00Z', ...fields }, ''));
  await utimes(path.join(config.vaultPath, rel), new Date(0), new Date(0)); return { requestId: request_id, path: rel };
}

test('手で書き換えたNOWは退避を1件にまとめ、差分と止まった時点を示す', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const stoppedAt = parseMarkdown((await vault.read(nowPath))!).meta.generated_at;
  const edited = await editNow(vault);
  await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  await report(config, '2026-09-16T12:00:00+09:00', 'レビュー中');
  expect(await vault.read(nowPath)).toBe(edited);
  const groups = await listConflicts(config);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ kind: 'now', target: nowPath, projectId: 'context-hub', title: 'コンテキスト集約', targetHash: hash(edited), stoppedAt, resolvable: true });
  // 再生成のたびに増えず、最新の生成版だけを持つ。
  expect(groups[0]!.files).toHaveLength(1);
  expect(await vault.read(groups[0]!.latest)).toContain('レビュー中');
  expect(groups[0]!.baseline).toBe('generated');
  expect(groups[0]!.manualLines).toHaveLength(1);
  expect(groups[0]!.manualLines[0]).toMatch(/^- 人が直した現在地 /);
  await rebuildDashboard(config);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('NOWの更新が止まっています'); expect(home).toContain('コンテキスト集約'); expect(home).toContain('ctx conflict resolve');
  expect(await resume(config, 'context-hub')).toContain('更新が止まっています');
});

test('生成版に戻すと手で変えた行をメモに残し、手動領域を保ってNOWを最新にする', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const edited = await editNow(vault);
  await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  await expect(resolveConflict(config, { target: nowPath, expectedHash: '0'.repeat(64), source: 'cli' })).rejects.toThrow('変更されています');
  const result = await resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'cli', sourceEventId: 'cli:1' });
  expect(result).toMatchObject({ target: nowPath, archived: 1, deduped: false });
  const now = (await vault.read(nowPath))!;
  expect(now).toContain('手動メモ: 消さない'); expect(now).toContain('公開準備中'); expect(now).not.toContain('人が直した現在地');
  expect(await listConflicts(config)).toEqual([]);
  expect((await doctor(config)).issues.join('\n')).not.toContain('生成物の競合');
  const memo = (await readInputs(config)).find(i => i.id === result.memoInputId)!;
  expect(memo).toMatchObject({ kind: 'memo', project: 'context-hub', source: 'cli' });
  expect(memo.text).toContain('人が直した現在地'); expect(memo.text).toContain('コンテキスト集約'); expect(memo.text).not.toContain('公開準備中');
  const [record] = await readConflictResolutions(vault);
  expect(record).toMatchObject({ id: result.conflictResolutionId, target: nowPath, before_hash: hash(edited), replaced_text: edited, memo_input_id: result.memoInputId });
  expect(await vault.files(`90_system/conflict-archive/${record!.id}`)).toHaveLength(1);
  // 戻した後は通常どおり更新される。
  await report(config, '2026-09-16T12:00:00+09:00', 'レビュー中');
  expect(await vault.read(nowPath)).toContain('レビュー中');
  // 同じ確認での再実行は同じ結果を返し、メモを増やさない。
  const again = await resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'cli', sourceEventId: 'cli:1' });
  expect(again).toMatchObject({ conflictResolutionId: result.conflictResolutionId, memoInputId: result.memoInputId, deduped: true, archived: 0 });
  expect((await readInputs(config)).filter(i => i.kind === 'memo')).toHaveLength(1);
});

test('--no-memo相当ではメモを作らず、置き換えた全文は記録に残す', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const edited = await editNow(vault); await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  const result = await resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'cli', saveManualAsMemo: false });
  expect(result.memoInputId).toBeUndefined();
  expect((await readInputs(config)).filter(i => i.kind === 'memo')).toHaveLength(0);
  expect((await readConflictResolutions(vault))[0]!.replaced_text).toBe(edited);
});

test('マーカーを壊したNOWも作り直せる', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const broken = (await vault.read(nowPath))!.replace('<!-- ctx:auto:end -->', '');
  await vault.write(nowPath, broken); await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  await resolveConflict(config, { target: nowPath, expectedHash: hash(broken), source: 'cli' });
  const now = (await vault.read(nowPath))!;
  expect(now).toContain('<!-- ctx:auto:end -->'); expect(now).toContain('公開準備中');
  expect(await listConflicts(config)).toEqual([]);
});

test('HOMEとふりかえりの競合も作り直し、メモは作らない', async () => {
  const config = await setup(), vault = new Vault(config);
  await rebuildDashboard(config); await rebuildDigest(config, { days: 3 });
  const home = (await vault.read('HOME.md'))! + '\n手で追記', review = (await vault.read('REVIEW.md'))! + '\n手で追記';
  await vault.write('HOME.md', home); await vault.write('REVIEW.md', review);
  await rebuildDashboard(config); await rebuildDashboard(config); await rebuildDigest(config, { days: 3 });
  const groups = await listConflicts(config);
  expect(groups.map(g => [g.kind, g.files.length])).toEqual([['home', 1], ['review', 1]]);
  expect(groups[0]!.manualLines).toEqual([]);
  const r1 = await resolveConflict(config, { target: 'HOME.md', expectedHash: hash(home), source: 'cli' });
  const r2 = await resolveConflict(config, { target: 'REVIEW.md', expectedHash: hash(review), source: 'cli' });
  expect(r1.memoInputId).toBeUndefined(); expect(r2.memoInputId).toBeUndefined();
  expect(await vault.read('HOME.md')).not.toContain('手で追記');
  // 片付けたHOMEの競合を、作り直したHOMEに載せない。
  expect(await vault.read('HOME.md')).not.toContain('conflicts/HOME.md.');
  expect(parseMarkdown((await vault.read('REVIEW.md'))!).meta.period_days).toBe(3);
  expect(await listConflicts(config)).toEqual([]);
});

test('Inputからの依頼を受け付け、確認後の変更や競合のない依頼は理由付きで止める', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const edited = await editNow(vault); await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  // 不正な対象・本文は受付形式で拒否する。
  await packet(config, { operation: 'conflict-resolve', target: '00_inbox/x.md', target_hash: hash(edited), confirmed: true });
  expect((await ingest(config)).rejected).toBe(1);
  const stale = await packet(config, { operation: 'conflict-resolve', target: nowPath, target_hash: '1'.repeat(64), confirmed: true });
  expect((await ingest(config)).rejected).toBe(1);
  const errors = await vault.files('90_system/intake-errors');
  const reasons = await Promise.all(errors.map(async p => JSON.parse((await vault.read(p))!)));
  expect(reasons.find(r => r.path === stale.path)?.reason).toEqual({ code: 'conflict-target-changed' });
  // 確認後に変わっていた依頼では、手で変えた行のメモも作らない。
  expect((await readInputs(config)).filter(i => i.kind === 'memo')).toHaveLength(0);
  const ok = await packet(config, { operation: 'conflict-resolve', target: nowPath, target_hash: hash(edited), confirmed: true });
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === ok.requestId)!;
  expect(receipt).toMatchObject({ operation: 'conflict-resolve', result: { target: nowPath, archived: 1, deduped: false } });
  expect((await readInputs(config)).find(i => i.kind === 'memo')).toMatchObject({ source: 'android-app', project: 'context-hub' });
  expect(await vault.read(nowPath)).toContain('公開準備中');
});

test('作り直しの前に止まっても、同じ受付IDの再送で続きから片付ける', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const edited = await editNow(vault); await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  const remove = Vault.prototype.remove;
  vi.spyOn(Vault.prototype, 'remove').mockImplementation(async function (this: Vault, rel) { if (rel.startsWith('90_system/conflicts/')) throw new Error('停止'); return remove.call(this, rel); });
  await expect(resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'app', sourceEventId: 'REQ-x' })).rejects.toThrow('停止');
  vi.restoreAllMocks();
  // 退避を片付けてから作り直すので、途中で止まったNOWは手で書き換えたままになる。
  expect(await vault.read(nowPath)).toBe(edited);
  const again = await resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'app', sourceEventId: 'REQ-x' });
  expect(again).toMatchObject({ deduped: true, archived: 1 });
  expect(await vault.read(nowPath)).toContain('公開準備中');
  expect(await listConflicts(config)).toEqual([]);
  expect(await readConflictResolutions(vault)).toHaveLength(1);
  expect((await readInputs(config)).filter(i => i.kind === 'memo')).toHaveLength(1);
});

test('基準が残っていない旧版のNOWは、最新の退避と比べて手で変えた行を示す', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  await vault.remove('90_system/now-generated/context-hub.json');
  await editNow(vault);
  await vault.write(nowPath, (await vault.read(nowPath))!.replace('<!-- ctx:auto:end -->', '- 手で足した行\n<!-- ctx:auto:end -->'));
  await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  const [group] = await listConflicts(config);
  expect(group!.baseline).toBe('latest');
  // 出典付きの行は、生成側の更新と手で直した行を区別できないため含めない。
  expect(group!.manualLines).toEqual(['- 手で足した行']);
});

test('同じ受付IDの再送では、記録後に新しく退避された競合を片付けず、手で書き換えたNOWも上書きしない', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const edited = await editNow(vault); await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  await resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'app', sourceEventId: 'REQ-y' });
  const again = (await vault.read(nowPath))!.replace('- 公開準備中', '- また手で直した');
  await vault.write(nowPath, again); await report(config, '2026-09-16T12:00:00+09:00', 'レビュー中');
  expect(await listConflicts(config)).toHaveLength(1);
  const resend = await resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'app', sourceEventId: 'REQ-y' });
  expect(resend).toMatchObject({ deduped: true, archived: 0 });
  expect(await vault.read(nowPath)).toBe(again);
  expect(await listConflicts(config)).toHaveLength(1);
});

test('記録の退避一覧が対象と合わない場合は、ファイルを消さずに止める', async () => {
  const config = await setup(), vault = new Vault(config);
  await report(config, '2026-09-14T12:00:00+09:00', '実装済み');
  const edited = await editNow(vault); await report(config, '2026-09-15T12:00:00+09:00', '公開準備中');
  vi.spyOn(Vault.prototype, 'remove').mockImplementationOnce(async () => { throw new Error('停止'); });
  await expect(resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'app', sourceEventId: 'REQ-z' })).rejects.toThrow('停止');
  vi.restoreAllMocks();
  const [record] = await readConflictResolutions(vault);
  const other = '90_system/conflicts/HOME.md.01JZ0000000000000000000000.md';
  await vault.write(other, '# 別の競合\n');
  await vault.write(`90_system/conflict-resolutions/${record!.id}.json`, JSON.stringify({ ...record, conflict_files: [other] }));
  await expect(resolveConflict(config, { target: nowPath, expectedHash: hash(edited), source: 'app', sourceEventId: 'REQ-z' })).rejects.toThrow('不正');
  expect(await vault.read(other)).toBe('# 別の競合\n');
  await vault.write(`90_system/conflict-resolutions/${record!.id}.json`, JSON.stringify({ ...record, conflict_files: ['00_inbox/x.md'] }));
  await expect(readConflictResolutions(vault)).rejects.toThrow();
});
