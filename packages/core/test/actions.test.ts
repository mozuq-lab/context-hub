import { afterEach, expect, test } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture, readInputs } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { runCycle } from '../src/cycle.js';
import { MockLlm } from '../src/llm.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { buildDigest } from '../src/digest.js';
import { buildHistory } from '../src/history.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { find, pending, context } from '../src/retrieve.js';
import { mergeProjects } from '../src/project-merges.js';
import { itemKey, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemSchedule } from '../src/item-schedules.js';
import { hash } from '../src/storage.js';
import type { LlmClient, OrganizeResult } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

/** 呼び出し回数を数えるモデル。 */
function counting(fixtures: OrganizeResult[] = []): LlmClient & { calls: number } {
  const inner = new MockLlm(fixtures), llm = { calls: 0, complete: async (prompt: string, opts: Parameters<LlmClient['complete']>[1]) => { llm.calls++; return inner.complete(prompt, opts); } };
  return llm;
}
const summary = (next: string[], at = '2026-10-30T00:00:00Z') => ({ source: 'file', kind: 'work-summary' as const, tool: 'codex', project: 'hub', occurredAt: at, receivedAt: at, text: `## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n${next.map(t => `- [確認済み] ${t}`).join('\n')}` });
const section = (text: string, title: string) => { const i = text.indexOf(`# ${title}`), j = text.indexOf('\n# ', i + 1); return text.slice(i, j < 0 ? undefined : j); };
async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  return { config, vault, now: async () => (await vault.read('10_projects/hub/NOW.md'))! };
}

test('受付ファイルで追加した行動は、モデルを呼ばずに本人の言葉のままNOWの次の一手と項目一覧に載り、新しい作業要約の後も残る', async () => {
  const { config, vault, now } = await fixture();
  await packet(config, { kind: 'action', project: 'hub', source: 'flutter-mac' }, '見積もりを依頼する');
  const llm = counting();
  const run = await runCycle(config, llm);
  expect(run.intake.accepted).toBe(1);
  expect(llm.calls).toBe(0);
  const [input] = await readInputs(config);
  expect(input).toMatchObject({ kind: 'action', project: 'hub', origin: 'user-note', text: '見積もりを依頼する' });
  expect((await readIntakeReceipts(config))[0]!.result).toMatchObject({ inputId: input!.id, deduped: false });
  expect(await vault.read(`90_system/receipts/${input!.id}.json`)).toBeUndefined();
  expect(section(await now(), '次の一手')).toContain(`- 本人が追加: 見積もりを依頼する [${input!.id}]`);
  expect(section(await now(), '次の一手')).toContain('本人が追加した行動]');
  const key = itemKey('hub', 'next', input!.id, '見積もりを依頼する');
  expect((await readNowItems(vault, 'hub'))!.items).toEqual([{ key, section: 'next', label: '本人が追加: ', text: '見積もりを依頼する', input_id: input!.id, resolution: null, schedule: null, action: {} }]);
  // HOMEの次の一手にも載り、整理待ちには数えない。
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('  - 本人が追加: 見積もりを依頼する');
  expect(home).toContain('整理待ち 0件');
  expect(home).toContain(`[${input!.id}](${input!.path}): 本人が追加した行動（整理しません）`);

  // 新しい作業要約が届いても、本人が追加した行動は外さず、作業要約の次の一手より前に並べる。
  await capture(config, summary(['利用者に見せる']));
  await organize(config, llm);
  expect(llm.calls).toBe(1);
  const next = section(await now(), '次の一手');
  expect(next.indexOf('本人が追加: 見積もりを依頼する')).toBeGreaterThan(0);
  expect(next.indexOf('本人が追加: 見積もりを依頼する')).toBeLessThan(next.indexOf('- 利用者に見せる'));
  await capture(config, summary(['名前を決める'], '2026-11-01T00:00:00Z'));
  await organize(config, llm);
  expect(section(await now(), '次の一手')).toContain('本人が追加: 見積もりを依頼する');
  expect(section(await now(), '次の一手')).not.toContain('利用者に見せる');
  // 次のcycleでも整理の対象にしない。
  await runCycle(config, llm);
  expect(llm.calls).toBe(2);
});

test('追加した行動に、完了報告・未解決へ戻す・誤りとして外す・期日と見直す日が既存の操作のまま使える', async () => {
  const { config, vault, now } = await fixture();
  const added = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', text: '請求書を送る' });
  const key = itemKey('hub', 'next', added.inputId, '請求書を送る');
  await setItemSchedule(config, { projectId: 'hub', itemKey: key, due: '2026-12-01', reviewAfter: null, source: 'cli' });
  expect(section(await now(), '次の一手')).toContain('請求書を送る');
  expect(section(await now(), '次の一手')).toContain('— 期日 2026-12-01');
  const done = await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'resolve', source: 'cli' });
  expect(section(await now(), '次の一手')).toContain('残っている次の一手はありません（完了報告済み）');
  expect(await now()).toContain(`- 完了: 本人が追加: 請求書を送る [${added.inputId}]`);
  expect(await now()).toContain(done.resolutionId);
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'reopen', source: 'cli' });
  expect(section(await now(), '次の一手')).toContain('本人が追加: 請求書を送る');
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'outdated', note: '別の方法にした', source: 'cli' });
  expect(section(await now(), '次の一手')).not.toContain('請求書を送る');
  expect(await now()).toContain('# 誤りとして外した項目（本人報告）\n');
  expect(await now()).toContain('- 本人が追加: 請求書を送る');
  expect((await readNowItems(vault, 'hub'))!.items[0]!.resolution).toMatchObject({ action: 'exclude', reason: 'outdated', note: '別の方法にした' });
});

test('AIの提案と作業要約の次の一手を行動にすると、元の行へのリンクを残して元の欄に二重に並べない', async () => {
  const { config, vault, now } = await fixture();
  const memoResult: OrganizeResult = { category: 'task', summary: '見積もりを取る', project_candidates: [], next_action_suggestions: ['業者を3社選ぶ', '予算を決める'], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null };
  const memo = await capture(config, { source: 'cli', project: 'hub', occurredAt: '2026-11-02T00:00:00Z', text: '引っ越しの見積もりを取る' });
  await organize(config, new MockLlm([memoResult]));
  const work = await capture(config, summary(['利用者に見せる', '名前を決める']));
  await organize(config, new MockLlm());
  expect(section(await now(), '提案')).toContain('AI提案: 業者を3社選ぶ');
  const aiKey = itemKey('hub', 'next', work.inputId, '名前を決める');
  // 提案は文面を直してから行動にできる。元の行は入力IDと直す前の本文で指す。
  const fromProposal = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-03T00:00:00Z', text: '業者を3社選んで連絡する', meta: { action_from_input: memo.inputId, action_from_text: '業者を3社選ぶ' } });
  const fromNext = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-03T01:00:00Z', text: '名前を決める', meta: { action_from_input: work.inputId, action_from_text: '名前を決める', action_from_key: aiKey } });
  const text = await now();
  expect(section(text, '提案')).not.toContain('業者を3社選ぶ');
  expect(section(text, '提案')).toContain('AI提案: 予算を決める');
  expect(section(text, '次の一手')).toContain('本人が追加: 業者を3社選んで連絡する');
  expect(section(text, '次の一手')).toContain('本人が追加: 名前を決める');
  expect(section(text, '次の一手').match(/名前を決める/g)).toHaveLength(1);
  expect(section(text, '次の一手')).toContain('- 利用者に見せる');
  const items = (await readNowItems(vault, 'hub'))!.items;
  expect(items.map(i => i.key)).not.toContain(aiKey);
  expect(items.find(i => i.input_id === fromProposal.inputId)!.action).toEqual({ from: { input_id: memo.inputId, text: '業者を3社選ぶ' } });
  expect(items.find(i => i.input_id === fromNext.inputId)!.action).toEqual({ from: { input_id: work.inputId, text: '名前を決める', key: aiKey } });
  // 元のメモ・作業要約と処理記録は書き換えない。
  expect((await readInputs(config)).find(i => i.id === memo.inputId)!.text).toBe('引っ越しの見積もりを取る');
});

test('行動の文面を直すと元の文面は残り、NOWは直した文面になり、付けた日付を引き継ぐ', async () => {
  const { config, vault, now } = await fixture();
  const added = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', text: '請求書を送る' });
  const before = (await vault.read(added.path))!;
  await setItemSchedule(config, { projectId: 'hub', itemKey: itemKey('hub', 'next', added.inputId, '請求書を送る'), due: '2026-12-01', reviewAfter: null, source: 'cli' });
  await expect(correctInput(config, added.inputId, { source: 'cli', occurredAt: '2026-11-02T00:00:00Z', text: '請求書を送る\n控えも取る' })).rejects.toThrow('1行');
  const fixed = await correctInput(config, added.inputId, { source: 'cli', occurredAt: '2026-11-02T00:00:00Z', text: '請求書と見積書を送る' });
  expect(await vault.read(added.path)).toBe(before);
  const next = section(await now(), '次の一手');
  expect(next).toContain('本人が追加: 請求書と見積書を送る');
  expect(next).not.toContain('本人が追加: 請求書を送る');
  expect(next).toContain(`訂正反映済み: [${added.inputId}]`);
  expect(next).toContain(fixed.inputId);
  expect(next).toContain('— 期日 2026-12-01');
  const item = (await readNowItems(vault, 'hub'))!.items[0]!;
  expect(item).toMatchObject({ key: itemKey('hub', 'next', added.inputId, '請求書と見積書を送る'), text: '請求書と見積書を送る', input_id: added.inputId, schedule: { due: '2026-12-01' } });
  // 日付は引き継いだので、HOMEの付け直しには出さない。直した行動もモデルで整理しない。
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).not.toContain('日付を付け直す項目');
  const llm = counting();
  expect((await organize(config, llm)).processed).toBe(0);
  expect(llm.calls).toBe(0);
});

test('行動の文面・プロジェクト・元の行の参照を検証し、統合済みのプロジェクトには追加しない', async () => {
  const { config } = await fixture();
  const base = { source: 'cli', kind: 'action' as const, occurredAt: '2026-11-01T00:00:00Z' };
  await expect(capture(config, { ...base, text: '請求書を送る' })).rejects.toThrow('プロジェクトの指定');
  await expect(capture(config, { ...base, project: 'hub', text: 'あ'.repeat(201) })).rejects.toThrow('200文字以内');
  await expect(capture(config, { ...base, project: 'hub', text: '一行目\n二行目' })).rejects.toThrow('1行');
  await expect(capture(config, { ...base, project: 'hub', text: ' 前に空白' })).rejects.toThrow('空白');
  await expect(capture(config, { ...base, project: 'hub', text: '送る', tool: 'codex' })).rejects.toThrow('作業ツール');
  await expect(capture(config, { ...base, project: 'hub', text: '送る', meta: { action_from_input: 'IN-x', action_from_text: '送る' } })).rejects.toThrow('元の行の参照');
  await expect(capture(config, { ...base, project: 'hub', text: '送る', meta: { session: 'x' } })).rejects.toThrow('元の行の参照');
  await expect(capture(config, { ...base, project: 'missing', text: '送る' })).rejects.toThrow('指定プロジェクトがありません');
  expect(await readInputs(config)).toHaveLength(0);
  await addProject(config, { id: 'old', title: '旧ツール' });
  const projectHash = async (id: string) => hash(await readFile(join(config.vaultPath, `10_projects/${id}/project.md`), 'utf8'));
  await mergeProjects(config, { fromId: 'old', intoId: 'hub', fromHash: await projectHash('old'), intoHash: await projectHash('hub'), source: 'cli' });
  await expect(capture(config, { ...base, project: 'old', text: '送る' })).rejects.toThrow('統合');
  // 受付ファイルの不正な行動は、受け付けずに理由を記録する。
  await packet(config, { kind: 'action' }, '請求書を送る');
  expect((await ingest(config)).accepted).toBe(0);
});

test('統合元へ先に追加した行動は統合先のNOWに載る', async () => {
  const { config, vault } = await fixture();
  await addProject(config, { id: 'old', title: '旧ツール' });
  const added = await capture(config, { source: 'cli', kind: 'action', project: 'old', occurredAt: '2026-11-01T00:00:00Z', text: '移行の手順を書く' });
  const projectHash = async (id: string) => hash(await readFile(join(config.vaultPath, `10_projects/${id}/project.md`), 'utf8'));
  await mergeProjects(config, { fromId: 'old', intoId: 'hub', fromHash: await projectHash('old'), intoHash: await projectHash('hub'), source: 'cli' });
  const items = (await readNowItems(vault, 'hub'))!.items;
  expect(items).toEqual([expect.objectContaining({ key: itemKey('hub', 'next', added.inputId, '移行の手順を書く'), label: '本人が追加: ', action: {} })]);
});

test('ふりかえり・経緯・検索・未整理の一覧・contextに、行動を整理待ちのメモと分けて反映する', async () => {
  const { config } = await fixture();
  const at = new Date().toISOString();
  const added = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: at, text: '請求書を送る' });
  const other = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: at, text: '見積書を送る' });
  await setItemResolution(config, { projectId: 'hub', itemKey: itemKey('hub', 'next', other.inputId, '見積書を送る'), action: 'resolve', source: 'cli' });
  const digest = await buildDigest(config);
  expect(digest).toContain('整理待ち 0 / 整理失敗 0 / 本人が追加した行動 2）');
  expect(digest).toContain('- 新しい入力: 2件（作業要約 0 / メモ 0 / 行動 2）');
  expect(digest).toContain('- 期間内に本人が追加した行動: 2件（うち完了 1件）');
  expect(digest).toContain('  - 完了: 見積書を送る');
  expect(digest).toContain('  - 未完了: 請求書を送る');
  expect(digest).toContain('本人が追加した行動: 請求書を送る');
  expect(digest).not.toContain('（整理待ち）');
  const history = await buildHistory(config, 'hub');
  expect(history).toContain(`本人が追加した行動 [${added.inputId}]`);
  expect(history).toContain('（作業要約 0 / メモ 0 / 本人が追加した行動 2）');
  expect(history).not.toContain('（整理待ち）');
  const found = await find(config, '請求書', { kinds: ['action'] });
  expect(found).toContain(added.inputId);
  expect(await find(config, '請求書', { kinds: ['memo'] })).not.toContain(added.inputId);
  expect(await pending(config)).not.toContain(added.inputId);
  const ctx = await context(config, 'hub');
  expect(ctx).toContain('本人が追加: 請求書を送る');
  expect(ctx).toContain('## 未整理・失敗\nなし');
});
