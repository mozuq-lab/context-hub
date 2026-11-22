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
import { effectiveWaits, readItemWaits, setItemWait, waitingDays } from '../src/item-waits.js';
import { setPerson, rebuildPeople, personPagePath } from '../src/people.js';
import { unassignedItemsPath } from '../src/unassigned-actions.js';
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

test('連絡待ちの印を付けると、HOMEの次の一手から外れて「連絡待ち」にまとまり、NOWには相手を載せず、外すと元に戻る', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる'), open = items.find(i => i.section === 'open')!;
  const before = await now(vault);
  await rebuildDashboard(config, { now: clock });
  const homeBefore = await home(vault);
  expect(homeBefore).toContain('  - 利用者に見せる');
  expect(homeBefore).not.toContain('## 連絡待ち');

  const first = await setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: '山田さん', since: '2026-11-10' }, source: 'cli', now: clock });
  expect(first.waitId).toMatch(/^WAIT-/);
  await setItemWait(config, { projectId: 'hub', itemKey: open.key, waiting: { since: '2026-11-18' }, source: 'cli', now: clock });
  const text = await now(vault);
  // NOWは行末に印と頼んだ日だけを示す。相手の名前は載せない（別AI向けの資料の元になるため）。
  expect(text).toMatch(/- 利用者に見せる \[IN-[^\n]+ — 連絡待ち 2026-11-10から\n/);
  expect(text).toMatch(/配布方法が決まっていない \[IN-[^\n]+ — 連絡待ち 2026-11-18から\n/);
  expect(text).not.toContain('山田');
  expect(await context(config, 'hub')).not.toContain('山田');
  const listed = (await readNowItems(vault, 'hub'))!.items;
  expect(find(listed, '利用者に見せる').waiting).toEqual({ id: first.waitId, since: '2026-11-10', who: '山田さん' });
  expect(listed.find(i => i.key === open.key)!.waiting).toMatchObject({ since: '2026-11-18' });
  expect(listed.find(i => i.key === open.key)!.waiting!.who).toBeUndefined();

  await rebuildDashboard(config, { now: clock });
  const shown = await home(vault);
  // 次の一手の一覧から外れ、連絡待ちの欄に頼んだ日の古い順で並ぶ。
  expect(shown).not.toContain('  - 利用者に見せる');
  expect(shown).toContain('  - 名前を決める');
  expect(shown).toContain('## 連絡待ち（2件）');
  const section = shown.slice(shown.indexOf('## 連絡待ち（2件）'));
  expect(section).toMatch(/- \[集約ツール\]\(10_projects\/hub\/NOW\.md\) 次の一手: 利用者に見せる（相手: 山田さん・2026-11-10から10日）\n- \[集約ツール\]\(10_projects\/hub\/NOW\.md\) 未解決: 配布方法が決まっていない（2026-11-18から2日）/);

  await expect(setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: '山田さん', since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow('同じ連絡待ち');
  await expect(setItemWait(config, { projectId: 'hub', itemKey: '0'.repeat(64), waiting: { since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow('該当する項目がありません');
  await expect(setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { since: '2026-11-25' }, source: 'cli', now: clock })).rejects.toThrow('先の日付');
  await expect(setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: ' 山田', since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow();
  await expect(setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: '山田\nさん', since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow();
  await expect(setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: 'あ'.repeat(41), since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow();
  // 相手を変えると最後の記録が効く。
  await setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: '佐藤さん', since: '2026-11-10' }, source: 'cli', now: clock });
  expect(find((await readNowItems(vault, 'hub'))!.items, '利用者に見せる').waiting!.who).toBe('佐藤さん');

  // 外すと元の欄へ戻り、NOW・HOMEは印を付ける前と同じになる。
  await setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: null, source: 'cli' });
  await setItemWait(config, { projectId: 'hub', itemKey: open.key, waiting: null, source: 'cli' });
  await expect(setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: null, source: 'cli' })).rejects.toThrow('連絡待ちではありません');
  const strip = (t: string) => t.replace(/\n(generated_at|generated_hash)[^\n]*/g, '');
  expect(strip(await now(vault))).toBe(strip(before));
  await rebuildDashboard(config, { now: clock });
  const stripHome = (t: string) => t.replace(/(生成時点: |generated_at: |generated_hash: )[^\n]+/g, '');
  expect(stripHome(await home(vault))).toBe(stripHome(homeBefore));
});

test('見直す日が来た連絡待ちは、次の一手の先頭に確認として出て、期日の欄と休ませている件数には入らない', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる'), name = find(items, '名前を決める');
  await setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: '山田さん', since: '2026-11-10' }, source: 'cli', now: clock });
  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: '2026-11-21', reviewAfter: '2026-11-25', source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  let shown = await home(vault);
  // 見直す日の前は、期日が近くても期日の欄に入れず、連絡待ちの欄に日付と一緒に示す。
  expect(shown).not.toContain('### 連絡待ちの確認');
  expect(shown).not.toContain('### 7日以内');
  expect(shown).not.toContain('見直す日まで休ませている項目');
  expect(shown).toContain('次の一手: 利用者に見せる（相手: 山田さん・2026-11-10から10日・期日 2026-11-21・見直す日 2026-11-25）');
  await rebuildDashboard(config, { now: new Date('2026-11-25T03:00:00Z') });
  shown = await home(vault);
  expect(shown).toContain('### 連絡待ちの確認（1件）');
  const next = shown.slice(shown.indexOf('## 次の一手'), shown.indexOf('### プロジェクトごと'));
  expect(next).toContain('- [集約ツール](10_projects/hub/NOW.md) 連絡待ちの確認: 次の一手: 利用者に見せる（相手: 山田さん・2026-11-10から15日・期日 2026-11-21・見直す日 2026-11-25）');
  expect(shown).toContain('・見直す日が来ました）');
  // 期日のない連絡待ちでも、見直す日が来れば確認として出る（日付を使っていない間の見出しも付く）。
  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: null, reviewAfter: null, source: 'cli' });
  await setItemWait(config, { projectId: 'hub', itemKey: name.key, waiting: { since: '2026-11-19' }, source: 'cli', now: clock });
  await setItemSchedule(config, { projectId: 'hub', itemKey: name.key, due: null, reviewAfter: '2026-11-20', source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  shown = await home(vault);
  expect(shown).toContain('### 連絡待ちの確認（1件）');
  expect(shown).toContain('連絡待ちの確認: 次の一手: 名前を決める（2026-11-19から1日・見直す日 2026-11-20）');
  expect(shown).toContain('### プロジェクトごと\n');
  expect(shown).toContain('  - 説明を書く');
});

test('印は記録として残り、同じ本文の新しい項目へ引き継ぎ、解決済みの項目には付けず、戻すと印も戻る', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる'), name = find(items, '名前を決める');
  await setItemResolution(config, { projectId: 'hub', itemKey: name.key, action: 'resolve', source: 'cli' });
  await expect(setItemWait(config, { projectId: 'hub', itemKey: name.key, waiting: { since: '2026-11-10' }, source: 'cli', now: clock })).rejects.toThrow('解決済み');
  await setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: '山田さん', since: '2026-11-10' }, source: 'cli', now: clock });
  const raw = await vault.read('00_inbox/' + (await vault.files('00_inbox'))[0]!.split('/').pop());
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決め直す' });
  await organize(config, new MockLlm());
  const again = (await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'next' && i.text === '利用者に見せる')!;
  expect(again.key).not.toBe(show.key);
  expect(again.waiting).toMatchObject({ since: '2026-11-10', who: '山田さん' });
  // 原文は書き換えない。
  expect(await vault.read('00_inbox/' + (await vault.files('00_inbox'))[0]!.split('/').pop())).toBe(raw);
  // 返事が来て完了にすると連絡待ちから外れ、戻すと連絡待ちのまま戻る。
  await setItemResolution(config, { projectId: 'hub', itemKey: again.key, action: 'resolve', source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  expect(await home(vault)).not.toContain('## 連絡待ち');
  await setItemResolution(config, { projectId: 'hub', itemKey: again.key, action: 'reopen', source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === again.key)!.waiting).toMatchObject({ who: '山田さん' });
  // 引き継いだ印を外すと、新しい項目からも外れる。
  await setItemWait(config, { projectId: 'hub', itemKey: again.key, waiting: null, source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === again.key)!.waiting).toBeUndefined();
  expect((await readItemWaits(vault)).records).toHaveLength(2);
});

test('引き継ぎの規則は日付と同じで、外した記録より前の古い印を引き継がない', () => {
  const rec = (n: number, key: string, waiting: { since: string; who?: string } | null) => ({ schema_version: 1 as const, id: `WAIT-0000000000000000000000000${n}`, project_id: 'p', item_key: key, section: 'next' as const, text: '見積もりを送る', input_id: `IN-0000000000000000000000000${n}`, waiting, source: 'cli', created_at: '2026-11-01T00:00:00Z' });
  const item = (key: string) => ({ key, section: 'next', text: '見積もりを送る', resolution: null });
  expect(effectiveWaits([rec(1, 'K1', { since: '2026-11-01', who: 'A' })], 'p', [item('K2')], new Set()).get('K2')).toEqual({ id: 'WAIT-00000000000000000000000001', since: '2026-11-01', who: 'A' });
  expect(effectiveWaits([rec(1, 'K1', { since: '2026-11-01' }), rec(2, 'K2', null)], 'p', [item('K3')], new Set()).size).toBe(0);
  expect(waitingDays('2026-11-10', '2026-11-20')).toBe(10);
  expect(waitingDays('2026-11-21', '2026-11-20')).toBe(0);
});

test('受付ファイルの連絡待ちの依頼を反映し、同じ受付IDは重複させず、不正な依頼と記録を断る', async () => {
  const { config, vault, items } = await fixture();
  const key = items[0]!.key, fields = { operation: 'item-wait', source: 'flutter', project_id: 'hub', item_key: key, waiting: { who: '山田さん', since: '2026-11-10' }, confirmed: true };
  expect(intakeFeatures(config).operations).toContain('item-wait');
  await packet(config, { ...fields, waiting: { who: '山田さん' } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, waiting: { since: '2026-11-10', extra: 1 } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, waiting: undefined }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-wait', result: { projectId: 'hub', itemKey: key, deduped: false } });
  const { records } = await readItemWaits(vault);
  expect(records).toMatchObject([{ id: (receipt.result as { waitId: string }).waitId, source: 'flutter', source_event_id: p.requestId, waiting: { who: '山田さん', since: '2026-11-10' } }]);
  expect(await setItemWait(config, { projectId: 'hub', itemKey: key, waiting: { who: '山田さん', since: '2026-11-10' }, source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, waitId: records[0]!.id });
  await expect(setItemWait(config, { projectId: 'hub', itemKey: key, waiting: { since: '2026-11-10' }, source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の連絡待ち');
  // 同じ印を重ねて依頼しても、再試行させずに受け付ける。
  await packet(config, fields, '');
  expect(await ingest(config)).toMatchObject({ accepted: 1, rejected: 0 });
  expect((await readItemWaits(vault)).records).toHaveLength(1);
  // NOWにない項目への依頼は、理由付きで断る。
  await packet(config, { ...fields, item_key: '0'.repeat(64) }, '');
  expect((await ingest(config)).rejected).toBe(1);
  // nullで外せる。
  await packet(config, { ...fields, waiting: null }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readNowItems(vault, 'hub'))!.items[0]!.waiting).toBeUndefined();

  await vault.write('90_system/item-waits/WAIT-01JZ0000000000000000000000.json', '{"broken":true}\n');
  expect((await doctor(config)).issues).toContain('連絡待ちの記録が不正です: 90_system/item-waits/WAIT-01JZ0000000000000000000000.json');
  await rebuildDashboard(config, { now: clock });
  expect(await home(vault)).toContain('[連絡待ちの記録が不正です](90_system/item-waits/WAIT-01JZ0000000000000000000000.json)');
});

test('プロジェクト未定の行動にも付けられ、HOMEでは連絡待ちの欄へ移り、AIの行には付けない', async () => {
  const { config, vault } = await fixture();
  await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '見積もりの返事を待つ' });
  await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', receivedAt: '2026-11-02T00:00:00Z', text: '牛乳を買う' });
  await rebuildDashboard(config, { now: clock });
  const own = JSON.parse((await vault.read(unassignedItemsPath))!).items.find((i: { text: string }) => i.text === '見積もりの返事を待つ');
  await setItemWait(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, waiting: { who: '工務店', since: '2026-11-15' }, source: 'cli', now: clock });
  expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.key === own.key)!.waiting).toMatchObject({ who: '工務店', since: '2026-11-15' });
  await rebuildDashboard(config, { now: clock });
  const shown = await home(vault);
  expect(shown).toContain('- プロジェクト未定 次の一手: 本人が追加: 見積もりの返事を待つ（相手: 工務店・2026-11-15から5日）');
  const unassigned = shown.slice(shown.indexOf('## プロジェクト未定の次の一手'), shown.indexOf('## 連絡待ち'));
  expect(unassigned).toContain('本人が追加した行動1件');
  expect(unassigned).toContain('- 連絡待ちの行動1件は、「連絡待ち」の欄で示します');
  expect(unassigned).not.toContain('見積もりの返事を待つ');
  expect(intakeFeatures(config).item_record_scopes).toEqual([UNASSIGNED_SCOPE]);
});

test('ふりかえりに件数と長く待っている項目が出て、人ごとの見返しには相手にした人の項目が載る', async () => {
  const { config, vault, items } = await fixture();
  const show = find(items, '利用者に見せる'), name = find(items, '名前を決める');
  await setItemWait(config, { projectId: 'hub', itemKey: show.key, waiting: { who: '山田さん', since: '2026-11-01' }, source: 'cli', now: clock });
  await setItemWait(config, { projectId: 'hub', itemKey: name.key, waiting: { since: '2026-11-18' }, source: 'cli', now: clock });
  await rebuildDigest(config, { now: clock });
  const review = (await vault.read('REVIEW.md'))!;
  expect(review).toContain('## 連絡待ち\n- 連絡待ちの項目: 2件（うち14日以上 1件）');
  expect(review).toContain('  - [集約ツール](10_projects/hub/NOW.md) 次の一手: 利用者に見せる（相手: 山田さん・頼んでから19日）\n  - [集約ツール](10_projects/hub/NOW.md) 次の一手: 名前を決める（頼んでから2日）');
  await setPerson(config, { personId: 'yamada', action: 'add', name: '山田', aliases: [], source: 'cli' });
  await rebuildPeople(config);
  const person = (await vault.read(personPagePath('yamada')))!;
  expect(person).toContain('利用者に見せる（連絡待ち 2026-11-01から）');
});
