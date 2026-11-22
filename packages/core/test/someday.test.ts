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
import { context } from '../src/retrieve.js';
import { UNASSIGNED_SCOPE, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemSchedule } from '../src/item-schedules.js';
import { setItemWait } from '../src/item-waits.js';
import { effectiveSomedays, readItemSomedays, setItemSomeday } from '../src/item-somedays.js';
import { SOMEDAY_REVIEW_DAYS, buildSomedayList, readSomedayReviews, setSomedayReview, somedayListPath, somedayListSchema } from '../src/someday.js';
import { setProjectStatus } from '../src/project-status.js';
import { readProjectCatalog } from '../src/knowledge-scope.js';
import { unassignedItemsPath } from '../src/unassigned-actions.js';
import { CALENDAR_PATH } from '../src/calendar.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n- [確認済み] 説明を書く\n## 未解決\n- 配布方法が決まっていない';
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
const list = async (vault: Fixture['vault']) => somedayListSchema.parse(JSON.parse((await vault.read(somedayListPath))!));

test('項目を「いつかやる」へ移すと、HOMEの次の一手・期日の欄・カレンダーから外れて「いつかやる」に並び、戻すと元に戻る', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる'), open = items.find(i => i.section === 'open')!;
  const before = await now(vault);
  await rebuildDashboard(config, { now: clock });
  const homeBefore = await home(vault);
  expect(homeBefore).not.toContain('## いつかやる');

  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: '2026-11-21', reviewAfter: null, source: 'cli' });
  const moved = await setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: { since: '2026-11-10' }, source: 'cli', now: clock });
  expect(moved.somedayId).toMatch(/^SMD-/);
  await setItemSomeday(config, { projectId: 'hub', itemKey: open.key, someday: { since: '2026-11-18' }, source: 'cli', now: clock });
  // NOWでは欄に置いたまま行末に示す（別AIにも今は取り組まないことを伝える）。
  const text = await now(vault);
  expect(text).toMatch(/- 利用者に見せる \[IN-[^\n]+ — いつかやる・期日 2026-11-21\n/);
  expect(text).toMatch(/配布方法が決まっていない \[IN-[^\n]+ — いつかやる\n/);
  expect(await context(config, 'hub')).toContain('いつかやる');
  const listed = (await readNowItems(vault, 'hub'))!.items;
  expect(find(listed, '利用者に見せる').someday).toEqual({ id: moved.somedayId, since: '2026-11-10', reviewed: '2026-11-10' });

  await rebuildDashboard(config, { now: clock });
  const shown = await home(vault);
  expect(shown).not.toContain('  - 利用者に見せる');
  expect(shown).not.toContain('### 7日以内');
  expect(shown).toContain('  - 名前を決める');
  expect(shown).toContain('## いつかやる（2件）');
  expect(shown).toContain(`${SOMEDAY_REVIEW_DAYS}日以上見直していないもの: 0件。`);
  // カレンダーにも出さない（期日の記録は残し、戻すと出る）。
  expect(await vault.read(CALENDAR_PATH)).toBeUndefined();
  // アプリが読む一覧には、最後に見直した日の古い順に並ぶ。
  expect((await list(vault)).entries).toMatchObject([
    { kind: 'item', scope: 'hub', title: '集約ツール', item_key: show.key, section: 'next', text: '利用者に見せる', since: '2026-11-10', reviewed: '2026-11-10' },
    { kind: 'item', scope: 'hub', item_key: open.key, section: 'open', since: '2026-11-18', reviewed: '2026-11-18' },
  ]);

  // 連絡待ちとは同時に付けない。
  await expect(setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow('先に元の欄へ戻して');
  const name = find(items, '名前を決める');
  await setItemWait(config, { projectId: 'hub', itemKey: name.key, waiting: { since: '2026-11-10' }, source: 'cli', now: clock });
  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: name.key, someday: { since: '2026-11-19' }, source: 'cli', now: clock })).rejects.toThrow('先に連絡待ちの印を外して');
  await setItemWait(config, { projectId: 'hub', itemKey: name.key, waiting: null, source: 'cli' });

  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: { since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow('既に同じ日付');
  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: { since: '2026-11-25' }, source: 'cli', now: clock })).rejects.toThrow('先の日付');
  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: { since: '2026-11-10', reviewed: '2026-11-09' }, source: 'cli', now: clock })).rejects.toThrow();
  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: { since: '2026-11-12' }, source: 'cli', now: clock })).rejects.toThrow('移した日は変えられません');
  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: name.key, someday: null, source: 'cli' })).rejects.toThrow('「いつかやる」にありません');

  // そのまま（見直した）: 移した日を変えずに見直した日だけが進み、並びも変わる。
  await setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: { since: '2026-11-10', reviewed: '2026-11-20' }, source: 'cli', now: clock });
  expect(find((await readNowItems(vault, 'hub'))!.items, '利用者に見せる').someday).toMatchObject({ since: '2026-11-10', reviewed: '2026-11-20' });
  expect((await buildSomedayList(config, vault, clock)).entries.map(e => e.kind === 'item' && e.text)).toEqual(['配布方法が決まっていない', '利用者に見せる']);

  // 戻す（始める）と元の欄へ戻り、NOW・HOMEは移す前と同じになる。
  await setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: null, source: 'cli' });
  await setItemSomeday(config, { projectId: 'hub', itemKey: open.key, someday: null, source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: null, reviewAfter: null, source: 'cli' });
  const strip = (t: string) => t.replace(/\n(generated_at|generated_hash)[^\n]*/g, '');
  expect(strip(await now(vault))).toBe(strip(before));
  await rebuildDashboard(config, { now: clock });
  const stripHome = (t: string) => t.replace(/(生成時点: |generated_at: |generated_hash: )[^\n]+/g, '');
  expect(stripHome(await home(vault))).toBe(stripHome(homeBefore));
  expect((await list(vault)).entries).toEqual([]);
});

test('やめるは「もう古い」として外し、作業要約が届いても同じ本文の項目へ引き継ぐ', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる'), name = find(items, '名前を決める');
  await setItemSomeday(config, { projectId: 'hub', itemKey: show.key, someday: { since: '2026-11-10' }, source: 'cli', now: clock });
  await setItemSomeday(config, { projectId: 'hub', itemKey: name.key, someday: { since: '2026-11-10' }, source: 'cli', now: clock });
  await setItemResolution(config, { projectId: 'hub', itemKey: name.key, action: 'exclude', reason: 'outdated', source: 'cli' });
  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: name.key, someday: null, source: 'cli' })).rejects.toThrow('解決済み');
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 案内を作る' });
  await organize(config, new MockLlm());
  const again = (await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'next' && i.text === '利用者に見せる')!;
  expect(again.key).not.toBe(show.key);
  expect(again.someday).toMatchObject({ since: '2026-11-10' });
  await rebuildDashboard(config, { now: clock });
  expect((await list(vault)).entries.map(e => e.kind === 'item' && e.text)).toEqual(['利用者に見せる']);
  // 引き継いだものを戻すと、新しい項目からも外れる。
  await setItemSomeday(config, { projectId: 'hub', itemKey: again.key, someday: null, source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === again.key)!.someday).toBeUndefined();
});

test('引き継ぎの規則は日付と同じで、戻した記録より前の古い記録を引き継がない', () => {
  const rec = (n: number, key: string, someday: { since: string; reviewed?: string } | null) => ({ schema_version: 1 as const, id: `SMD-0000000000000000000000000${n}`, project_id: 'p', item_key: key, section: 'next' as const, text: '見積もりを送る', input_id: `IN-0000000000000000000000000${n}`, someday, source: 'cli', created_at: '2026-11-01T00:00:00Z' });
  const item = (key: string) => ({ key, section: 'next', text: '見積もりを送る', resolution: null });
  expect(effectiveSomedays([rec(1, 'K1', { since: '2026-11-01' })], 'p', [item('K2')], new Set()).get('K2')).toEqual({ id: 'SMD-00000000000000000000000001', since: '2026-11-01', reviewed: '2026-11-01' });
  expect(effectiveSomedays([rec(1, 'K1', { since: '2026-11-01' }), rec(2, 'K2', null)], 'p', [item('K3')], new Set()).size).toBe(0);
});

test('休止中のプロジェクトと、置いたアイデアが並び、そのまま・始める・やめるを記録できる', async () => {
  const { config, vault } = await fixture();
  await addProject(config, { id: 'old', title: '昔の企画' });
  const ideaInput = (await capture(config, { source: 'cli', text: '開発再開を助ける仕組みがあると面白そう', occurredAt: '2026-11-01T00:00:00Z' })).inputId;
  const other = (await capture(config, { source: 'cli', text: 'いつか週末にキャンプへ行く計画を立てたい', occurredAt: '2026-11-02T00:00:00Z' })).inputId;
  await organize(config, new MockLlm());
  const idea = `IDEA-${ideaInput.slice(3)}`, otherIdea = `IDEA-${other.slice(3)}`;
  expect(await vault.read(`20_ideas/${idea}.md`)).toBeDefined();
  // アイデアは本人が置いたものだけを並べる。
  expect((await buildSomedayList(config, vault, clock)).entries).toEqual([]);

  const hash = (await readProjectCatalog(vault)).find(p => p.id === 'old')!.hash;
  await setProjectStatus(config, { projectId: 'old', status: 'paused', expectedHash: hash, source: 'cli' });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone }).format(new Date());
  await setSomedayReview(config, { target: 'idea', targetId: idea, action: 'add', on: '2026-11-05', source: 'cli', now: clock });
  let entries = (await list(vault)).entries;
  // 置いた日の古い順。休止した日は状態の記録から読む。
  expect(entries).toMatchObject([{ kind: 'idea', idea_id: idea, path: `20_ideas/${idea}.md`, since: '2026-11-05', reviewed: '2026-11-05' }, { kind: 'project', project_id: 'old', title: '昔の企画', since: today, reviewed: today }]);
  expect(entries[0]!.kind === 'idea' && entries[0]!.summary).toContain('開発再開');

  await expect(setSomedayReview(config, { target: 'idea', targetId: idea, action: 'add', on: '2026-11-06', source: 'cli', now: clock })).rejects.toThrow('既に「いつかやる」');
  await expect(setSomedayReview(config, { target: 'idea', targetId: otherIdea, action: 'keep', on: '2026-11-06', source: 'cli', now: clock })).rejects.toThrow('置いていません');
  await expect(setSomedayReview(config, { target: 'idea', targetId: 'IDEA-00000000000000000000000000', action: 'add', on: '2026-11-06', source: 'cli', now: clock })).rejects.toThrow('見つかりません');
  await expect(setSomedayReview(config, { target: 'project', targetId: 'hub', action: 'keep', on: '2026-11-06', source: 'cli', now: clock })).rejects.toThrow('休止中ではありません');
  await expect(setSomedayReview(config, { target: 'project', targetId: 'old', action: 'drop', on: '2026-11-06', source: 'cli', now: clock })).rejects.toThrow('状態を切り替えて');
  await expect(setSomedayReview(config, { target: 'idea', targetId: idea, action: 'keep', on: '2026-11-25', source: 'cli', now: clock })).rejects.toThrow('先の日付');

  // そのまま: 見直した日だけが進む。
  await setSomedayReview(config, { target: 'idea', targetId: idea, action: 'keep', on: '2026-11-20', source: 'cli', now: clock });
  expect((await list(vault)).entries.find(e => e.kind === 'idea')).toMatchObject({ since: '2026-11-05', reviewed: '2026-11-20' });

  // HOMEとふりかえりに件数と見直していないものが出る（休止した日から30日後）。
  const later = new Date(Date.parse(`${today}T03:00:00Z`) + 31 * 86_400_000);
  await rebuildDashboard(config, { now: later });
  const shown = await home(vault);
  expect(shown).toContain('## いつかやる（2件）');
  expect(shown).toContain('（休止中のプロジェクト1件・アイデア1件）');
  expect(shown).toMatch(/- 休止中のプロジェクト: \[昔の企画\]\(10_projects\/old\/project\.md\)（置いてから3\d日）/);
  await rebuildDigest(config, { now: later });
  const review = (await vault.read('REVIEW.md'))!;
  expect(review).toMatch(/## いつかやる\n- いつかやる: 2件（項目 0件・休止中のプロジェクト 1件・アイデア 1件。うち30日以上見直していない \d件）/);

  // プロジェクトのそのまま。休止した日と同じ日の見直しで一覧が変わらなくても、一覧は書き直す（アプリが反映を確かめられるように）。
  const before = (await list(vault)).generated_at;
  await new Promise(resolve => setTimeout(resolve, 5));
  await setSomedayReview(config, { target: 'project', targetId: 'old', action: 'keep', on: today, source: 'cli' });
  expect((await list(vault)).generated_at > before).toBe(true);
  // やめる・始めると一覧から外れ、もう一度置ける。
  await setSomedayReview(config, { target: 'idea', targetId: idea, action: 'drop', on: '2026-11-20', source: 'cli', now: clock });
  entries = (await list(vault)).entries;
  expect(entries.map(e => e.kind)).toEqual(['project']);
  await expect(setSomedayReview(config, { target: 'idea', targetId: idea, action: 'start', on: '2026-11-20', source: 'cli', now: clock })).rejects.toThrow('置いていません');
  await setSomedayReview(config, { target: 'idea', targetId: idea, action: 'add', on: '2026-11-20', source: 'cli', now: clock });
  await setSomedayReview(config, { target: 'idea', targetId: idea, action: 'start', on: '2026-11-20', source: 'cli', now: clock });
  // 再開すると一覧から外れる。
  const paused = (await readProjectCatalog(vault)).find(p => p.id === 'old')!.hash;
  await setProjectStatus(config, { projectId: 'old', status: 'active', expectedHash: paused, source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  expect((await list(vault)).entries).toEqual([]);
  expect(await home(vault)).not.toContain('## いつかやる');
  // アイデアのファイルは書き換えない。
  expect((await vault.read(`20_ideas/${idea}.md`))).not.toContain('いつかやる');
  expect((await readSomedayReviews(vault)).records.map(r => r.action)).toEqual(['add', 'keep', 'keep', 'drop', 'add', 'start']);
});

test('受付ファイルの依頼を反映し、同じ受付IDと同じ状態の依頼は重複させず、理由付きで断る', async () => {
  const { config, vault, items } = await fixture();
  const key = items[0]!.key, fields = { operation: 'item-someday', source: 'flutter', project_id: 'hub', item_key: key, someday: { since: '2026-11-10' }, confirmed: true };
  expect(intakeFeatures(config)).toMatchObject({ someday_review_days: SOMEDAY_REVIEW_DAYS });
  expect(intakeFeatures(config).operations).toEqual(expect.arrayContaining(['item-someday', 'someday-review']));
  await packet(config, { ...fields, someday: { reviewed: '2026-11-10' } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, someday: { since: '2026-11-10', extra: 1 } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-someday', result: { projectId: 'hub', itemKey: key, deduped: false } });
  const { records } = await readItemSomedays(vault);
  expect(records).toMatchObject([{ id: (receipt.result as { somedayId: string }).somedayId, source: 'flutter', source_event_id: p.requestId, someday: { since: '2026-11-10' } }]);
  // 受け付けた時点で「いつかやる」の一覧も作り直す。
  expect((await list(vault)).entries).toHaveLength(1);
  expect(await setItemSomeday(config, { projectId: 'hub', itemKey: key, someday: { since: '2026-11-10' }, source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true });
  await expect(setItemSomeday(config, { projectId: 'hub', itemKey: key, someday: null, source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の「いつかやる」');
  // 同じ状態を重ねて依頼しても、再試行させずに受け付ける。
  await packet(config, fields, '');
  expect(await ingest(config)).toMatchObject({ accepted: 1, rejected: 0 });
  expect((await readItemSomedays(vault)).records).toHaveLength(1);
  // 連絡待ちの依頼は理由付きで断る。
  await packet(config, { operation: 'item-wait', source: 'flutter', project_id: 'hub', item_key: key, waiting: { since: '2026-11-10' }, confirmed: true }, '');
  expect((await ingest(config)).rejected).toBe(1);
  const errors = await vault.files('90_system/intake-errors');
  const refusals = await Promise.all(errors.map(async path => JSON.parse((await vault.read(path))!)));
  expect(refusals.find(e => e.reason?.code === 'someday-refused')).toMatchObject({ reason: { code: 'someday-refused', cause: 'someday' }, code: '「いつかやる」の項目には連絡待ちの印を付けられません。先に元の欄へ戻してください。' });
  // そのまま、戻す。
  await packet(config, { ...fields, someday: { since: '2026-11-10', reviewed: '2026-11-19' } }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readNowItems(vault, 'hub'))!.items[0]!.someday).toMatchObject({ reviewed: '2026-11-19' });
  await packet(config, { ...fields, someday: null }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readNowItems(vault, 'hub'))!.items[0]!.someday).toBeUndefined();

  // アイデア・プロジェクトの依頼。
  const reviewFields = { operation: 'someday-review', source: 'flutter', target: 'project', target_id: 'hub', action: 'keep', on: '2026-11-19', confirmed: true };
  await packet(config, { ...reviewFields, action: 'drop' }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...reviewFields, target: 'idea' }, ''); expect((await ingest(config)).rejected).toBe(1);
  // 進行中のプロジェクトは理由付きで断る。
  await packet(config, reviewFields, ''); expect((await ingest(config)).rejected).toBe(1);
  const refused = await Promise.all((await vault.files('90_system/intake-errors')).map(async path => JSON.parse((await vault.read(path))!)));
  expect(refused.some(e => e.reason?.cause === 'not-paused')).toBe(true);
  const hash = (await readProjectCatalog(vault)).find(p => p.id === 'hub')!.hash;
  await setProjectStatus(config, { projectId: 'hub', status: 'paused', expectedHash: hash, source: 'cli' });
  const ok = await packet(config, reviewFields, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readIntakeReceipts(config)).find(r => r.request_id === ok.requestId)).toMatchObject({ operation: 'someday-review', result: { target: 'project', targetId: 'hub', action: 'keep', deduped: false } });
  await packet(config, reviewFields, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readSomedayReviews(vault)).records).toHaveLength(1);

  await vault.write('90_system/item-somedays/SMD-01JZ0000000000000000000000.json', '{"broken":true}\n');
  expect((await doctor(config)).issues).toContain('「いつかやる」の記録が不正です: 90_system/item-somedays/SMD-01JZ0000000000000000000000.json');
  await rebuildDashboard(config, { now: clock });
  expect(await home(vault)).toContain('[「いつかやる」の記録が不正です](90_system/item-somedays/SMD-01JZ0000000000000000000000.json)');
});

test('プロジェクト未定の行動も移せて、HOMEでは件数だけを示し、ふりかえりの残っている行動に数えない', async () => {
  const { config, vault } = await fixture();
  await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '楽器を習う' });
  await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', receivedAt: '2026-11-02T00:00:00Z', text: '牛乳を買う' });
  await rebuildDashboard(config, { now: clock });
  const own = JSON.parse((await vault.read(unassignedItemsPath))!).items.find((i: { text: string }) => i.text === '楽器を習う');
  await setItemSomeday(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, someday: { since: '2026-10-01' }, source: 'cli', now: clock });
  await rebuildDashboard(config, { now: clock });
  const shown = await home(vault);
  const unassigned = shown.slice(shown.indexOf('## プロジェクト未定の次の一手'), shown.indexOf('## いつかやる'));
  expect(unassigned).toContain('本人が追加した行動1件');
  expect(unassigned).toContain('- 「いつかやる」へ移した行動1件は、「いつかやる」の欄で示します');
  expect(unassigned).not.toContain('楽器を習う');
  expect(shown).toContain('- プロジェクト未定 次の一手: 本人が追加: 楽器を習う（置いてから50日）');
  expect(shown).toContain('30日以上見直していないもの: 1件。古い1件を並べます。');
  await rebuildDigest(config, { now: clock });
  const review = (await vault.read('REVIEW.md'))!;
  expect(review).toContain('- 残っている行動: 1件（ほかにいつかやる 1件）');
  expect(review).toContain('- いつかやる: 1件（項目 1件・休止中のプロジェクト 0件・アイデア 0件。うち30日以上見直していない 1件）');
  // AIの行は移せない（先に行動にしてもらう）。
  await capture(config, { source: 'cli', text: 'ベランダの掃除をする', occurredAt: '2026-11-03T00:00:00Z' });
  await organize(config, new MockLlm());
  const ai = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => !i.action);
  if (ai) await expect(setItemSomeday(config, { projectId: UNASSIGNED_SCOPE, itemKey: ai.key, someday: { since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow('本人が追加した行動だけ');
});
