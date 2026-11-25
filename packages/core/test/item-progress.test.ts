import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, intakeErrorSchema, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { hash } from '../src/storage.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { rebuildDigest } from '../src/digest.js';
import { doctor } from '../src/doctor.js';
import { context } from '../src/retrieve.js';
import { UNASSIGNED_SCOPE, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemSchedule } from '../src/item-schedules.js';
import { setItemWait } from '../src/item-waits.js';
import { setItemSomeday } from '../src/item-somedays.js';
import { PROGRESS_LIMIT, progressDetail, readItemProgress, setItemProgress } from '../src/item-progress.js';
import { buildWeeklyReview, weeklyReviewDigestLines } from '../src/weekly-review.js';
import { unassignedItemsPath } from '../src/unassigned-actions.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n- [確認済み] 説明を書く\n- [確認済み] 価格を決める\n- [確認済み] 配布先を探す\n## 未解決\n- 配布方法が決まっていない';
const clock = new Date('2026-11-20T03:00:00Z');

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', text: summary });
  await organize(config, new MockLlm());
  const items = (await readNowItems(vault, 'hub'))!.items;
  return { config, vault, items };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const now = async (vault: Fixture['vault']) => (await vault.read('10_projects/hub/NOW.md'))!;
const home = async (vault: Fixture['vault']) => (await vault.read('HOME.md'))!;
const find = (items: Fixture['items'], text: string) => items.find(i => i.text === text)!;
/** 書いた日を過去にした記録を置く（更新のない日数を確かめるため）。 */
async function writeOld(vault: Fixture['vault'], item: Fixture['items'][number], id: string, progress: { since: string; note?: string }, createdAt: string) {
  await vault.write(`90_system/item-progress/${id}.json`, JSON.stringify({ schema_version: 1, id, project_id: 'hub', item_key: item.key, section: item.section, text: item.text, input_id: item.input_id, progress, source: 'cli', created_at: createdAt }, null, 2) + '\n');
}

test('取りかかり中の印を付けると、HOMEの次の一手の先頭にひとこと付きでまとまり、NOWには印と始めた日だけが載り、外すと元に戻る', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる');
  await rebuildDashboard(config, { now: clock });
  const before = await home(vault);
  expect(before).toContain('  - 利用者に見せる');
  expect(before).not.toContain('### 取りかかり中');

  const first = await setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: { since: '2026-11-17', note: '画面の録画まで済んだ' }, source: 'cli', now: clock });
  expect(first.progressId).toMatch(/^PROG-/);
  const text = await now(vault);
  // NOWは行末に印と始めた日だけを示す。ひとことは載せない（別AI向けの資料の元になるため）。
  expect(text).toMatch(/- 利用者に見せる \[IN-[^\n]+ — 取りかかり中 2026-11-17から\n/);
  expect(text).not.toContain('録画');
  expect(await context(config, 'hub')).not.toContain('録画');
  const listed = find((await readNowItems(vault, 'hub'))!.items, '利用者に見せる');
  expect(listed.progress).toMatchObject({ id: first.progressId, since: '2026-11-17', note: '画面の録画まで済んだ' });
  expect(listed.progress!.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await rebuildDashboard(config, { now: clock });
  const shown = await home(vault);
  expect(shown).toContain('### 取りかかり中（1件）');
  expect(shown).toMatch(/- \[集約ツール\]\(10_projects\/hub\/NOW\.md\) 次の一手: 利用者に見せる（2026-11-17から3日・どこまで: 画面の録画まで済んだ）/);
  // 取りかかり中の項目は、プロジェクトごとの次の一手の一覧から外れる。
  expect(shown).not.toContain('  - 利用者に見せる');
  expect(shown).toContain('  - 名前を決める');

  // ひとことだけを書き直すと、始めた日はそのままで最後の記録が効く。
  await setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: { since: '2026-11-17', note: '説明の文を書いている' }, source: 'cli', now: clock });
  expect(find((await readNowItems(vault, 'hub'))!.items, '利用者に見せる').progress).toMatchObject({ since: '2026-11-17', note: '説明の文を書いている' });
  await expect(setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: { since: '2026-11-17', note: '説明の文を書いている' }, source: 'cli', now: clock })).rejects.toThrow('同じ取りかかり中');
  await expect(setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: { since: '2026-11-25' }, source: 'cli', now: clock })).rejects.toThrow('先の日付');
  for (const note of [' 前に空白', '改行\nあり', 'あ'.repeat(81), ''])
    await expect(setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: { since: '2026-11-17', note }, source: 'cli', now: clock })).rejects.toThrow();

  // 外すと元の欄へ戻り、NOWは印を付ける前と同じになる。
  await setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: null, source: 'cli' });
  expect(await now(vault)).not.toContain('取りかかり中');
  await rebuildDashboard(config, { now: clock });
  expect(await home(vault)).toContain('  - 利用者に見せる');
  await expect(setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: null, source: 'cli' })).rejects.toThrow('取りかかり中ではありません');
});

test('未解決・連絡待ち・「いつかやる」・先待ちの項目と、片付いた項目には付けず、付いた印は残す', async () => {
  const { config, vault, items } = await fixture();
  const open = items.find(i => i.section === 'open')!, name = find(items, '名前を決める'), docs = find(items, '説明を書く'), show = find(items, '利用者に見せる');
  const refused = (key: string) => setItemProgress(config, { projectId: 'hub', itemKey: key, progress: { since: '2026-11-18' }, source: 'cli', now: clock });
  await expect(refused(open.key)).rejects.toMatchObject({ reason: { code: 'progress-refused', cause: 'not-next' } });
  await setItemWait(config, { projectId: 'hub', itemKey: name.key, waiting: { since: '2026-11-10' }, source: 'cli', now: clock });
  await expect(refused(name.key)).rejects.toMatchObject({ reason: { code: 'progress-refused', cause: 'waiting' } });
  await setItemSomeday(config, { projectId: 'hub', itemKey: docs.key, someday: { since: '2026-11-10' }, source: 'cli', now: clock });
  await expect(refused(docs.key)).rejects.toMatchObject({ reason: { code: 'progress-refused', cause: 'someday' } });
  // 先に済ませることが残っている項目（先待ち）にも付けない。
  const { setItemBlocks } = await import('../src/item-blocks.js');
  const price = find(items, '価格を決める');
  await setItemBlocks(config, { projectId: 'hub', itemKey: price.key, after: [{ projectId: 'hub', itemKey: show.key }], source: 'cli' });
  await expect(refused(price.key)).rejects.toMatchObject({ reason: { code: 'progress-refused', cause: 'blocked' } });
  // 先の項目が片付けば付けられる。
  await setItemResolution(config, { projectId: 'hub', itemKey: show.key, action: 'resolve', source: 'cli' });
  await expect(refused(price.key)).resolves.toMatchObject({ deduped: false });
  // 片付いた項目には付けも外しもしない。
  await setItemResolution(config, { projectId: 'hub', itemKey: price.key, action: 'resolve', source: 'cli' });
  await expect(setItemProgress(config, { projectId: 'hub', itemKey: price.key, progress: null, source: 'cli' })).rejects.toMatchObject({ reason: { code: 'item-closed' } });
  expect((await readItemProgress(vault)).records).toHaveLength(1);
});

test('受付ファイルの取りかかり中の依頼を反映し、本人が見た印と違えば断り、同じ受付IDは重複させない', async () => {
  const { config, vault, items } = await fixture();
  const key = find(items, '利用者に見せる').key, fields = { operation: 'item-progress', source: 'flutter', project_id: 'hub', item_key: key, progress: { since: '2026-11-18', note: '下書きまで' }, expected: null, confirmed: true };
  expect(intakeFeatures(config).operations).toContain('item-progress');
  expect(intakeFeatures(config).item_progress).toEqual({ note_max_chars: 80, limit: PROGRESS_LIMIT, stale_days: 14 });
  await packet(config, { ...fields, progress: { note: '日付なし' } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, progress: { since: '2026-11-18', note: 'あ'.repeat(81) } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, expected: undefined }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-progress', result: { projectId: 'hub', itemKey: key, deduped: false } });
  const { records } = await readItemProgress(vault);
  expect(records).toMatchObject([{ id: (receipt.result as { progressId: string }).progressId, source: 'flutter', source_event_id: p.requestId, progress: { since: '2026-11-18', note: '下書きまで' } }]);
  // 同じ印を重ねて依頼しても、再試行させずに受け付ける。
  await packet(config, fields, '');
  expect(await ingest(config)).toMatchObject({ accepted: 1, rejected: 0 });
  expect((await readItemProgress(vault)).records).toHaveLength(1);
  // 古い表示（印がない）から送ったひとことの書き直しは、新しいひとことを上書きしないよう理由付きで断る。
  const stale = await packet(config, { ...fields, progress: { since: '2026-11-18', note: '古い端末から' } }, '');
  expect((await ingest(config)).rejected).toBe(1);
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(stale.path)}.json`))!));
  expect(error.reason).toEqual({ code: 'progress-refused', cause: 'changed' });
  // 今の印を見て送れば受け付ける。nullで外せる。
  await packet(config, { ...fields, progress: { since: '2026-11-18', note: '清書まで' }, expected: { since: '2026-11-18', note: '下書きまで' } }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect(find((await readNowItems(vault, 'hub'))!.items, '利用者に見せる').progress!.note).toBe('清書まで');
  await packet(config, { ...fields, progress: null, expected: { since: '2026-11-18', note: '清書まで' } }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect(find((await readNowItems(vault, 'hub'))!.items, '利用者に見せる').progress).toBeUndefined();

  await vault.write('90_system/item-progress/PROG-01JZ0000000000000000000000.json', '{"broken":true}\n');
  expect((await doctor(config)).issues).toContain('取りかかり中の記録が不正です: 90_system/item-progress/PROG-01JZ0000000000000000000000.json');
});

test('プロジェクト未定の行動にも付けられ、多すぎれば添え、期日は取りかかり中の行に添える', async () => {
  const { config, vault, items } = await fixture();
  await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '見積もりを作る' });
  await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', receivedAt: '2026-11-02T00:00:00Z', text: '牛乳を買う' });
  await rebuildDashboard(config, { now: clock });
  const own = JSON.parse((await vault.read(unassignedItemsPath))!).items.find((i: { text: string }) => i.text === '見積もりを作る');
  await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, due: '2026-11-21', reviewAfter: null, source: 'cli' });
  await setItemProgress(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, progress: { since: '2026-11-19' }, source: 'cli', now: clock });
  expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.key === own.key)!.progress).toMatchObject({ since: '2026-11-19' });
  await rebuildDashboard(config, { now: clock });
  let shown = await home(vault);
  expect(shown).toContain('- プロジェクト未定 次の一手: 本人が追加: 見積もりを作る（2026-11-19から1日・期日 2026-11-21）');
  // 期日の欄とプロジェクト未定の一覧には重ねて載せない。
  expect(shown).not.toMatch(/期日 2026-11-21 — プロジェクト未定/);
  expect(shown).toContain('- 取りかかり中の行動1件は、「次の一手」の「取りかかり中」の欄で示します');
  expect(shown).not.toContain('取りかかり中が3件を超えています');
  for (const text of ['名前を決める', '説明を書く', '価格を決める']) await setItemProgress(config, { projectId: 'hub', itemKey: find(items, text).key, progress: { since: '2026-11-19' }, source: 'cli', now: clock });
  await rebuildDashboard(config, { now: clock });
  shown = await home(vault);
  expect(shown).toContain('### 取りかかり中（4件）');
  expect(shown).toContain(`取りかかり中が${PROGRESS_LIMIT}件を超えています`);
});

test('印もひとことも14日更新がないと週次レビューとふりかえりに出て、完了したら始めてから何日で済んだかをふりかえりに示す', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる'), name = find(items, '名前を決める');
  await writeOld(vault, show, 'PROG-01JZ0000000000000000000001', { since: '2026-10-31', note: '録画まで' }, '2026-11-01T00:00:00Z');
  await writeOld(vault, name, 'PROG-01JZ0000000000000000000002', { since: '2026-11-15' }, '2026-11-15T00:00:00Z');
  await setItemSchedule(config, { projectId: 'hub', itemKey: find(items, '説明を書く').key, due: null, reviewAfter: '2026-12-01', source: 'cli' });
  const list = await buildWeeklyReview(config, vault, clock);
  expect(list.progress_stale).toMatchObject([{ scope: 'hub', item_key: show.key, since: '2026-10-31', updated: '2026-11-01', note: '録画まで' }]);
  expect(list.progress_stale_total).toBe(1);
  expect(list.progress_stale_days).toBe(14);
  // 取りかかり中の項目は「長く残っている項目」には数えない。
  expect(list.lingering.map(r => r.item_key)).not.toContain(show.key);
  const lines = weeklyReviewDigestLines(list, clock, config.timezone).join('\n');
  expect(lines).toContain('止まった取りかかり中（14日以上更新なし 1件');
  expect(lines).toContain('利用者に見せる（2026-10-31から・19日更新なし・どこまで: 録画まで）');
  expect(progressDetail({ since: '2026-10-31', updated: '2026-11-01', note: '録画まで' }, '2026-11-20')).toBe('2026-10-31から20日・19日更新なし・どこまで: 録画まで');

  // 止まった取りかかり中がなければ、一覧に欄を作らない（旧版と同じ形）。
  await setItemProgress(config, { projectId: 'hub', itemKey: show.key, progress: null, source: 'cli' });
  expect('progress_stale' in await buildWeeklyReview(config, vault, clock)).toBe(false);

  await setItemResolution(config, { projectId: 'hub', itemKey: name.key, action: 'resolve', source: 'cli' });
  await rebuildDigest(config, { now: new Date() });
  const review = (await vault.read('REVIEW.md'))!;
  expect(review).toContain('## 取りかかり中');
  expect(review).toMatch(/- 完了: \[集約ツール\]\(10_projects\/hub\/NOW\.md\) 名前を決める（始めてから\d+日で完了）/);
});
