import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { activeSchedules, addDays, readItemSchedules, scheduleBucket, scheduleDateSchema, setItemSchedule, todayIn } from '../src/item-schedules.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n- [確認済み] 説明を書く\n## 未解決\n- 配布方法が決まっていない';

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', text: summary });
  await organize(config, new MockLlm());
  const items = (await readNowItems(vault, 'hub'))!.items;
  return { config, vault, items };
}
const home = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('HOME.md'))!;
const now = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('10_projects/hub/NOW.md'))!;

test('日付は実在する暦日だけを受け付け、今日と週の区切りをタイムゾーンで決める', () => {
  expect(scheduleDateSchema.safeParse('2026-11-20').success).toBe(true);
  for (const bad of ['2026-02-30', '2026-13-01', '26-11-20', '1999-12-31', '2100-01-01', '2026-11-20T00:00:00Z']) expect(scheduleDateSchema.safeParse(bad).success).toBe(false);
  // UTCでは前日でも、東京では翌日になる時刻。
  expect(todayIn('Asia/Tokyo', new Date('2026-11-14T16:00:00Z'))).toBe('2026-11-15');
  expect(todayIn('UTC', new Date('2026-11-14T16:00:00Z'))).toBe('2026-11-14');
  expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  const today = '2026-11-15';
  expect(scheduleBucket({ due: '2026-11-14', review_after: null }, today)).toEqual({ bucket: 'overdue', hidden: false });
  expect(scheduleBucket({ due: today, review_after: null }, today)).toEqual({ bucket: 'today', hidden: false });
  expect(scheduleBucket({ due: '2026-11-21', review_after: null }, today)).toEqual({ bucket: 'week', hidden: false });
  expect(scheduleBucket({ due: '2026-11-22', review_after: null }, today)).toEqual({ bucket: 'later', hidden: false });
  expect(scheduleBucket({ due: null, review_after: '2026-11-16' }, today)).toEqual({ bucket: 'none', hidden: true });
  expect(scheduleBucket({ due: null, review_after: today }, today)).toEqual({ bucket: 'none', hidden: false });
  // 期日が近ければ、見直す日が先でも隠さない。
  expect(scheduleBucket({ due: '2026-11-17', review_after: '2026-11-20' }, today)).toEqual({ bucket: 'week', hidden: false });
  expect(scheduleBucket({ due: '2026-12-01', review_after: '2026-11-20' }, today)).toEqual({ bucket: 'later', hidden: true });
});

test('期日と見直す日を付け、NOWの行末とHOMEの区分に出し、外すと元に戻る', async () => {
  const { config, vault, items } = await fixture();
  const [show, name, write, open] = items as [typeof items[0], typeof items[0], typeof items[0], typeof items[0]];
  const clock = new Date('2026-11-15T03:00:00Z'), today = todayIn(config.timezone, clock);
  await rebuildDashboard(config, { now: clock });
  const before = await home(vault);
  expect(before).not.toContain('### プロジェクトごと');

  const first = await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: addDays(today, -1), reviewAfter: null, source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: name.key, due: addDays(today, 3), reviewAfter: null, source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: write.key, due: null, reviewAfter: addDays(today, 10), source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: open.key, due: today, reviewAfter: null, source: 'cli' });
  expect(first.scheduleId).toMatch(/^SCH-/);
  const text = await now(vault);
  // 行頭（表示文と出典）は変えず、末尾に日付を付ける。
  expect(text).toMatch(new RegExp(`- 利用者に見せる \\[IN-[^\\n]+ — 期日 ${addDays(today, -1)}\\n`));
  expect(text).toContain(`— 見直す日 ${addDays(today, 10)}`);
  const listed = (await readNowItems(vault, 'hub'))!.items;
  expect(listed.find(i => i.key === show.key)!.schedule).toMatchObject({ due: addDays(today, -1), review_after: null });

  await rebuildDashboard(config, { now: clock });
  const dated = await home(vault);
  const section = dated.slice(dated.indexOf('## 次の一手（進行中のプロジェクト）'), dated.indexOf('## 確認待ち'));
  expect(section).toMatch(new RegExp(`### 期限切れ（1件）\\n- 期日 ${addDays(today, -1)} — \\[集約ツール\\]\\(10_projects/hub/NOW.md\\) 次の一手: 利用者に見せる`));
  expect(section).toMatch(new RegExp(`### 今日（1件）\\n- 期日 ${today} — \\[集約ツール\\][^\\n]+未解決: 配布方法が決まっていない`));
  expect(section).toMatch(/### 7日以内（1件）\n[^\n]+名前を決める/);
  // 前に出した項目と、見直す日まで休ませる項目は、プロジェクトごとの一覧に重ねて載せない。
  const perProject = section.slice(section.indexOf('### プロジェクトごと'));
  expect(perProject).not.toContain('利用者に見せる');
  expect(perProject).not.toContain('説明を書く');
  expect(perProject).toContain('見直す日まで休ませている項目: 1件');
  expect(perProject).toContain('ほかに期日のない次の一手はありません。');

  // 見直す日が来れば元の一覧に戻る。
  await rebuildDashboard(config, { now: new Date(clock.getTime() + 11 * 86_400_000) });
  expect(await home(vault)).toMatch(/\n {2}- 説明を書く（見直す日 [0-9-]+）/);

  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: addDays(today, -1), reviewAfter: null, source: 'cli' })).rejects.toThrow('同じ日付');
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: '0'.repeat(64), due: today, reviewAfter: null, source: 'cli' })).rejects.toThrow('該当する項目がありません');
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: '2026-02-30', reviewAfter: null, source: 'cli' })).rejects.toThrow();
  for (const item of [show, name, write, open]) await setItemSchedule(config, { projectId: 'hub', itemKey: item.key, due: null, reviewAfter: null, source: 'cli' });
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: null, reviewAfter: null, source: 'cli' })).rejects.toThrow('外す日付はありません');
  expect(await now(vault)).not.toContain('期日');
  await rebuildDashboard(config, { now: clock });
  // 日付を使わなくなれば、HOMEはこれまでと同じ形に戻る。
  expect((await home(vault)).replace(/\n(生成時点|generated_at|generated_hash)[^\n]*/g, '')).toBe(before.replace(/\n(生成時点|generated_at|generated_hash)[^\n]*/g, ''));
  expect(activeSchedules((await readItemSchedules(vault)).records).size).toBe(0);
});

test('解決済みの項目には付けず、同じ本文の新しい項目へは引き継ぎ、外れた項目の日付は付け直しを促して外せる', async () => {
  const { config, vault, items } = await fixture();
  const [show, name, write] = items as [typeof items[0], typeof items[0], typeof items[0]];
  await setItemResolution(config, { projectId: 'hub', itemKey: name.key, action: 'resolve', source: 'cli' });
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: name.key, due: '2026-11-20', reviewAfter: null, source: 'cli' })).rejects.toThrow('解決済み');
  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: '2026-12-20', reviewAfter: null, source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: write.key, due: '2026-12-21', reviewAfter: null, source: 'cli' });
  // 新しい作業要約で次の一手が置き換わる。「利用者に見せる」は同じ本文で再び報告され、「説明を書く」は消える。
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決め直す' });
  await organize(config, new MockLlm());
  const current = (await readNowItems(vault, 'hub'))!.items, again = current.find(i => i.section === 'next' && i.text === '利用者に見せる')!;
  expect(again.key).not.toBe(show.key);
  expect(again.schedule).toMatchObject({ due: '2026-12-20' });
  expect(await now(vault)).toContain('利用者に見せる [IN-');
  expect(await now(vault)).toMatch(/利用者に見せる \[IN-[^\n]+ — 期日 2026-12-20/);
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  let text = await home(vault);
  // 解決済みの項目と引き継いだ項目は付け直しに出さない。
  expect(text).toMatch(/日付を付け直す項目（[^\n]*1件。[^\n]*）:\n- \[集約ツール\]\(10_projects\/hub\/NOW.md\): 説明を書く（期日 2026-12-21） \/ key [a-f0-9]{64}/);
  expect(text).toContain('  - 利用者に見せる（期日 2026-12-20）');
  // 付け直しを促す日付は外せる。引き継いだ日付を外すと、新しい項目からも外れる。
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: write.key, due: '2026-12-22', reviewAfter: null, source: 'cli' })).rejects.toThrow('該当する項目がありません');
  await setItemSchedule(config, { projectId: 'hub', itemKey: write.key, due: null, reviewAfter: null, source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: again.key, due: null, reviewAfter: null, source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === again.key)!.schedule).toBeNull();
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  text = await home(vault);
  expect(text).not.toContain('日付を付け直す項目');
  expect(text).not.toContain('期日');
  expect(activeSchedules((await readItemSchedules(vault)).records).size).toBe(0);
});

test('受付ファイルの日付指定を反映し、同じ受付IDは重複させず、不正な記録はHOMEとdoctorで示す', async () => {
  const { config, vault, items } = await fixture();
  const key = items[0]!.key, fields = { operation: 'item-schedule', source: 'flutter', project_id: 'hub', item_key: key, due: '2026-11-20', review_after: '2026-11-18', confirmed: true };
  await packet(config, { ...fields, due: '2026-11-31' }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, due: undefined }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-schedule', result: { projectId: 'hub', itemKey: key, deduped: false } });
  const { records } = await readItemSchedules(vault);
  expect(records).toMatchObject([{ id: (receipt.result as { scheduleId: string }).scheduleId, source: 'flutter', source_event_id: p.requestId, due: '2026-11-20', review_after: '2026-11-18', section: 'next', text: '利用者に見せる' }]);
  expect(await setItemSchedule(config, { projectId: 'hub', itemKey: key, due: '2026-11-20', reviewAfter: '2026-11-18', source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, scheduleId: records[0]!.id });
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: key, due: '2026-11-21', reviewAfter: null, source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の日付');
  // 両方nullの依頼で外せる。
  await packet(config, { ...fields, due: null, review_after: null }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect(activeSchedules((await readItemSchedules(vault)).records).size).toBe(0);

  await vault.write('90_system/item-schedules/SCH-01JZ0000000000000000000000.json', '{"broken":true}\n');
  await rebuildDashboard(config);
  expect(await home(vault)).toContain('[期日・見直す日の記録が不正です](90_system/item-schedules/SCH-01JZ0000000000000000000000.json)');
  expect((await doctor(config)).issues).toContain('期日・見直す日の記録が不正です: 90_system/item-schedules/SCH-01JZ0000000000000000000000.json');
});

test('引き継いだ日付の項目に自分の日付を付けてから外すと、引き継ぎ元の古い日付を復活させない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'alpha', title: 'アルファ' });
  const ws = async (t: string, text: string) => { await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'alpha', occurredAt: t, receivedAt: t, text }); await organize(config, new MockLlm()); };
  await ws('2026-10-01T00:00:00Z', '## 現在地\n- [確認済み] A\n## 次の一手\n- [確認済み] Xをする');
  const k1 = (await readNowItems(vault, 'alpha'))!.items.find(i => i.section === 'next')!;
  await setItemSchedule(config, { projectId: 'alpha', itemKey: k1.key, due: '2026-11-20', reviewAfter: null, source: 'cli' });
  await ws('2026-10-05T00:00:00Z', '## 現在地\n- [確認済み] B\n## 次の一手\n- [確認済み] Xをする');
  const k2 = (await readNowItems(vault, 'alpha'))!.items.find(i => i.section === 'next')!;
  expect(k2.key).not.toBe(k1.key); expect(k2.schedule).toMatchObject({ due: '2026-11-20' });
  await setItemSchedule(config, { projectId: 'alpha', itemKey: k2.key, due: '2026-12-01', reviewAfter: null, source: 'cli' });
  expect((await readNowItems(vault, 'alpha'))!.items.find(i => i.key === k2.key)!.schedule).toMatchObject({ due: '2026-12-01' });
  await setItemSchedule(config, { projectId: 'alpha', itemKey: k2.key, due: null, reviewAfter: null, source: 'cli' });
  expect((await readNowItems(vault, 'alpha'))!.items.find(i => i.key === k2.key)!.schedule).toBeNull();
  expect(await vault.read('10_projects/alpha/NOW.md')).not.toContain('2026-11-20');
});
test('日付を外した項目が次の作業要約で別の項目に移っても、外す前の古い日付を引き継がない（K1→K2→K3）', async () => {
  const { effectiveSchedules } = await import('../src/item-schedules.js');
  const rec = (n: number, key: string, due: string | null) => ({ schema_version: 1 as const, id: `SCH-0000000000000000000000000${n}`, project_id: 'p', item_key: key, section: 'next' as const, text: '見積もりを送る', input_id: `IN-0000000000000000000000000${n}`, due, review_after: null, source: 'cli', created_at: `2026-10-0${n}T00:00:00Z` });
  const item = (key: string) => ({ key, section: 'next', text: '見積もりを送る', resolution: null });
  // K1で期日を付け、次の作業要約で移ったK2で期日を外した。
  const cleared = [rec(1, 'K1', '2026-10-10'), rec(2, 'K2', null)];
  expect(effectiveSchedules(cleared as never, 'p', [item('K2')], new Set()).byKey.size).toBe(0);
  // さらに次の作業要約でK3へ移っても、K1の期日は戻らない。
  const moved = effectiveSchedules(cleared as never, 'p', [item('K3')], new Set());
  expect(moved.byKey.size).toBe(0); expect(moved.orphaned).toEqual([]);
  // 外した後に付け直した期日は、引き継ぐ。
  const again = effectiveSchedules([...cleared, rec(3, 'K2', '2026-10-20')] as never, 'p', [item('K4')], new Set());
  expect(again.byKey.get('K4')?.due).toBe('2026-10-20');
});
