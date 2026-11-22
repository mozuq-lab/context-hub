import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { rebuildDigest } from '../src/digest.js';
import { doctor } from '../src/doctor.js';
import { UNASSIGNED_SCOPE, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemSchedule } from '../src/item-schedules.js';
import { setItemWait } from '../src/item-waits.js';
import { setItemSomeday } from '../src/item-somedays.js';
import { WEEKLY_NEXT_STALE_DAYS, WEEKLY_OPEN_STALE_DAYS, WEEKLY_REVIEW_INTERVAL_DAYS, buildWeeklyReview, readWeeklyReviews, setWeeklyReview, weeklyReviewListSchema, weeklyReviewPath } from '../src/weekly-review.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n- [確認済み] 説明を書く\n- [確認済み] 料金を決める\n## 未解決\n- 配布方法が決まっていない';
const clock = new Date('2026-11-20T03:00:00Z');

/**
 * hub: 21日前の作業要約（次の一手4件・未解決1件）。fresh: 2日前の作業要約（次の一手1件）。empty: 根拠のないプロジェクト。
 * プロジェクト未定の本人の行動を1件。
 */
async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await addProject(config, { id: 'fresh', title: '新しい企画' });
  await addProject(config, { id: 'empty', title: '空の企画' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', text: summary });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'fresh', occurredAt: '2026-11-18T00:00:00Z', receivedAt: '2026-11-18T00:00:00Z', text: '## 次の一手\n- [確認済み] 案をまとめる' });
  await capture(config, { source: 'file', kind: 'action', text: '請求書を送る', occurredAt: '2026-11-19T00:00:00Z', receivedAt: '2026-11-19T00:00:00Z' });
  await organize(config, new MockLlm());
  await rebuildDashboard(config, { now: clock });
  const items = (await readNowItems(vault, 'hub'))!.items, own = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.action)!;
  return { config, vault, items, own };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const find = (items: Fixture['items'], text: string) => items.find(i => i.text === text)!;
const list = async (vault: Fixture['vault']) => weeklyReviewListSchema.parse(JSON.parse((await vault.read(weeklyReviewPath))!));

test('点検の一覧に、次の一手がないプロジェクト・長く残っている項目・停滞・連絡待ち・期日・いつかやるを、モデルを使わずに並べる', async () => {
  const { config, vault, items, own } = await fixture();
  const show = find(items, '利用者に見せる'), name = find(items, '名前を決める'), write = find(items, '説明を書く'), open = items.find(i => i.section === 'open')!;
  // 期日を付けた項目は「長く残っている」から外し、期日の段に出す。連絡待ち・いつかやるは次の一手の数からも外す。
  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: '2026-11-18', reviewAfter: null, source: 'cli' });
  await setItemWait(config, { projectId: 'hub', itemKey: name.key, waiting: { since: '2026-11-01' }, source: 'cli', now: clock });
  await setItemSchedule(config, { projectId: 'hub', itemKey: name.key, due: null, reviewAfter: '2026-11-19', source: 'cli' });
  await setItemSomeday(config, { projectId: 'hub', itemKey: write.key, someday: { since: '2026-11-10' }, source: 'cli', now: clock });
  await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, due: '2026-11-24', reviewAfter: null, source: 'cli' });
  await rebuildDashboard(config, { now: clock });

  const built = await list(vault);
  expect(built).toMatchObject({ interval_days: WEEKLY_REVIEW_INTERVAL_DAYS, next_stale_days: WEEKLY_NEXT_STALE_DAYS, open_stale_days: WEEKLY_OPEN_STALE_DAYS, project_stale_days: 14, last_review: null, unassigned: { actions: 1, suggestions: 0 }, someday: { total: 1, stale: 0 } });
  // 最近動いた順。根拠のないプロジェクトは次の一手が0件（停滞ではない）。
  expect(built.projects).toEqual([
    { project_id: 'fresh', title: '新しい企画', next: 1, open: 0, waiting: 0, hints: 0, last_evidence: '2026-11-18T00:00:00Z', stale: false },
    { project_id: 'hub', title: '集約ツール', next: 2, open: 1, waiting: 1, hints: 0, last_evidence: '2026-10-30T00:00:00Z', stale: true },
    { project_id: 'empty', title: '空の企画', next: 0, open: 0, waiting: 0, hints: 0, last_evidence: null, stale: false },
  ]);
  // 21日前の次の一手（期日・連絡待ち・いつかやるのないもの）だけが長く残っている。未解決は30日未満なので出さない。
  expect(built.lingering).toEqual([{ scope: 'hub', item_key: find(items, '料金を決める').key, section: 'next', label: '', text: '料金を決める', since: '2026-10-30' }]);
  expect(built.lingering_total).toBe(1);
  expect(built.waiting).toEqual([{ scope: 'hub', item_key: name.key, section: 'next', label: '', text: '名前を決める', since: '2026-11-01', check: true }]);
  expect(built.dated).toEqual([
    { scope: 'hub', item_key: show.key, section: 'next', label: '', text: '利用者に見せる', due: '2026-11-18', bucket: 'overdue', review_after: null },
    { scope: UNASSIGNED_SCOPE, item_key: own.key, section: 'next', label: own.label, text: '請求書を送る', due: '2026-11-24', bucket: 'week', review_after: null },
  ]);

  // 30日を過ぎると未解決も長く残っている項目になる。
  const later = await buildWeeklyReview(config, vault, new Date('2026-12-01T03:00:00Z'));
  expect(later.lingering.map(r => r.text)).toEqual(['料金を決める', '配布方法が決まっていない']);
  expect(later.lingering.find(r => r.section === 'open')).toMatchObject({ item_key: open.key, since: '2026-10-30' });

  // 片付けた項目は数えない。
  await setItemResolution(config, { projectId: 'fresh', itemKey: (await readNowItems(vault, 'fresh'))!.items[0]!.key, action: 'resolve', source: 'cli' });
  expect((await buildWeeklyReview(config, vault, clock)).projects.find(p => p.project_id === 'fresh')).toMatchObject({ next: 0 });

  // ふりかえりに同じ順で載せる（今週の気づきの後、概要の前）。
  await rebuildDigest(config, { now: clock });
  const review = (await vault.read('REVIEW.md'))!;
  const section = review.slice(review.indexOf('## 週次レビューの点検'), review.indexOf('## 概要'));
  expect(review.indexOf('## 週次レビューの点検')).toBeGreaterThan(0);
  expect(section).toContain('週次レビューの記録はまだありません');
  const steps = ['1. 確認待ち', '2. プロジェクト未定の行動: 残っている行動 1件', '3. 進行中のプロジェクト: 3件。次の一手がないもの 2件', '4. 停滞しているプロジェクト: 1件', '5. 連絡待ち: 1件（見直す日が来た 1件', '6. 期日: 期限切れ 1件・今日 0件・7日以内 1件', '7. いつかやる: 1件'];
  const at = steps.map(s => section.indexOf(s));
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(section).toContain('次の一手がないプロジェクト（次の一手を足すか、休止・完了にする）: [新しい企画](10_projects/fresh/project.md)、[空の企画](10_projects/empty/project.md)');
  expect(section).toContain('[集約ツール](10_projects/hub/NOW.md) 次の一手: 料金を決める（根拠から21日）');
  expect(section).toContain('[集約ツール](10_projects/hub/project.md)（最終根拠から21日）');
  expect(section).toContain('見直す日が来た: [集約ツール](10_projects/hub/NOW.md) 次の一手: 名前を決める（頼んでから19日）');
  expect(section).toContain('期限切れ 2026-11-18 — [集約ツール](10_projects/hub/NOW.md) 次の一手: 利用者に見せる');
  expect(section).toContain('7日以内 2026-11-24 — プロジェクト未定 次の一手: ');
}, 20000);

test('見直した記録は本人の報告だけで作り、HOMEとふりかえりに最後の見直しからの日数を示す。一覧は内容が変わったときだけ書き直す', async () => {
  const { config, vault } = await fixture();
  const home = async () => (await vault.read('HOME.md'))!;
  // ふりかえりがまだ無いうちは、無いファイルへのリンクを出さない。
  expect(await home()).toContain('週次レビュー: まだ見直した記録がありません。アプリの「ふりかえり」の「週次レビューを始める」から順に確かめてください。');
  expect(await home()).not.toContain('REVIEW.md');
  // 内容が変わらなければ書き直さない（同期を起こさない）。
  const first = (await vault.read(weeklyReviewPath))!;
  await rebuildDashboard(config, { now: new Date(clock.getTime() + 3_600_000) });
  expect(await vault.read(weeklyReviewPath)).toBe(first);

  await expect(setWeeklyReview(config, { on: '2026-11-22', source: 'cli', now: clock })).rejects.toThrow('先の日付');
  const done = await setWeeklyReview(config, { on: '2026-11-20', source: 'flutter', sourceEventId: 'REQ-a', now: clock });
  expect(done).toMatchObject({ on: '2026-11-20', deduped: false, weeklyReviewId: expect.stringMatching(/^WRV-/) });
  // 記録の後は、中身が変わらなくても書き直す（アプリは書いた日時で反映を確かめる）。
  const after = await list(vault), record = (await readWeeklyReviews(vault)).records[0]!;
  expect(after.last_review).toEqual({ id: done.weeklyReviewId, on: '2026-11-20', created_at: record.created_at });
  expect(Date.parse(after.generated_at)).toBeGreaterThanOrEqual(Date.parse(record.created_at));
  // 同じ受付IDの再送・同じ日の見直し（別の端末や二度押し）は記録を増やさない。同じ受付IDで別の日は断る。
  expect(await setWeeklyReview(config, { on: '2026-11-20', source: 'flutter', sourceEventId: 'REQ-a', now: clock })).toMatchObject({ weeklyReviewId: done.weeklyReviewId, deduped: true });
  expect(await setWeeklyReview(config, { on: '2026-11-20', source: 'flutter', sourceEventId: 'REQ-b', now: clock })).toMatchObject({ weeklyReviewId: done.weeklyReviewId, deduped: true });
  await expect(setWeeklyReview(config, { on: '2026-11-19', source: 'flutter', sourceEventId: 'REQ-a', now: clock })).rejects.toThrow('別の日');
  expect((await readWeeklyReviews(vault)).records).toHaveLength(1);

  await rebuildDashboard(config, { now: clock });
  expect(await home()).toContain('週次レビュー: 最後に見直したのは2026-11-20（今日）。\n');
  await rebuildDigest(config, { now: clock });
  expect(await vault.read('REVIEW.md')).toContain('最後に見直した日: 2026-11-20（今日）。');
  // 間隔の日数を過ぎると促す。
  const week = new Date('2026-11-27T03:00:00Z');
  await rebuildDashboard(config, { now: new Date('2026-11-26T03:00:00Z') });
  expect(await home()).toContain('最後に見直したのは2026-11-20（6日前）。\n');
  await rebuildDashboard(config, { now: week });
  expect(await home()).toContain('最後に見直したのは2026-11-20（7日前）。アプリの「ふりかえり」の「週次レビューを始める」か、[REVIEW.md](REVIEW.md)の「週次レビューの点検」を順に確かめてください。');
  // 後の日の見直しが最後の見直しになる。
  await setWeeklyReview(config, { on: '2026-11-21', source: 'cli', now: week });
  expect((await list(vault)).last_review?.on).toBe('2026-11-21');

  // 壊れた記録はHOMEとdoctorで示し、一覧とHOMEの生成は止めない。
  await vault.write('90_system/weekly-reviews/WRV-01ARZ3NDEKTSV4RRFFQ69G5FAV.json', '{"broken":true}\n');
  await rebuildDashboard(config, { now: week });
  expect(await home()).toContain('[週次レビューの記録が不正です](90_system/weekly-reviews/WRV-01ARZ3NDEKTSV4RRFFQ69G5FAV.json)');
  expect((await doctor(config)).issues).toContain('週次レビューの記録が不正です: 90_system/weekly-reviews/WRV-01ARZ3NDEKTSV4RRFFQ69G5FAV.json');
  // ほかの機能の記録が壊れていても、見直しの記録と一覧の書き直しは止めない（その段だけ数えない）。
  await vault.write('90_system/item-resolutions/RES-01ARZ3NDEKTSV4RRFFQ69G5FAV.json', '{"broken":true}\n');
  const later = new Date('2026-11-28T03:00:00Z');
  const again = await setWeeklyReview(config, { on: '2026-11-28', source: 'cli', now: later });
  expect(again.deduped).toBe(false);
  expect((await list(vault)).last_review?.id).toBe(again.weeklyReviewId);
}, 20000);

test('受付ファイルで見直しを報告でき、本文付き・日付なしの依頼は受け付けない', async () => {
  const { config, vault } = await fixture();
  expect(intakeFeatures(config).operations).toContain('weekly-review');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone }).format(new Date());
  const fields = { operation: 'weekly-review', source: 'flutter', on: today, confirmed: true };
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { operation: 'weekly-review', source: 'flutter', confirmed: true }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, confirmed: false }, ''); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'weekly-review', result: { on: today, deduped: false } });
  expect((await readWeeklyReviews(vault)).records).toMatchObject([{ id: (receipt.result as { weeklyReviewId: string }).weeklyReviewId, on: today, source: 'flutter', source_event_id: p.requestId }]);
  expect((await list(vault)).last_review?.on).toBe(today);
  // 同じ日の見直しをもう一度送っても（別の端末）、記録を増やさずに受け付ける。
  await packet(config, fields, '');
  expect(await ingest(config)).toMatchObject({ accepted: 1, rejected: 0 });
  expect((await readWeeklyReviews(vault)).records).toHaveLength(1);
}, 20000);
