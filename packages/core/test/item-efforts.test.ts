import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemSchedule } from '../src/item-schedules.js';
import { effectiveEfforts, readItemEfforts, setItemEffort } from '../src/item-efforts.js';
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
const now = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('10_projects/hub/NOW.md'))!;
const home = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('HOME.md'))!;

test('手間の目安を付けるとNOWの行末・項目一覧・HOMEに出て、日付と並び、外すと元に戻る', async () => {
  const { config, vault, items } = await fixture();
  const [show, name] = items as [typeof items[0], typeof items[0]];
  const before = await now(vault);
  const first = await setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: 'quick', source: 'cli' });
  expect(first.effortId).toMatch(/^EFF-/);
  await setItemEffort(config, { projectId: 'hub', itemKey: name.key, effort: 'half-day', source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: name.key, due: '2026-12-01', reviewAfter: null, source: 'cli' });
  const text = await now(vault);
  expect(text).toMatch(/- 利用者に見せる \[IN-[^\n]+ — 手間 15分ほど\n/);
  expect(text).toMatch(/- 名前を決める \[IN-[^\n]+ — 期日 2026-12-01・手間 半日以上\n/);
  const listed = (await readNowItems(vault, 'hub'))!.items;
  expect(listed.find(i => i.key === show.key)!.effort).toBe('quick');
  expect(listed.find(i => i.key === name.key)!.effort).toBe('half-day');
  expect(listed.find(i => i.text === '説明を書く')!.effort).toBeUndefined();
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  expect(await home(vault)).toContain('  - 利用者に見せる（手間 15分ほど）');

  await expect(setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: 'quick', source: 'cli' })).rejects.toThrow('同じ手間の目安');
  await expect(setItemEffort(config, { projectId: 'hub', itemKey: '0'.repeat(64), effort: 'quick', source: 'cli' })).rejects.toThrow('該当する項目がありません');
  await expect(setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: 'week' as never, source: 'cli' })).rejects.toThrow();
  // 変えると最後の記録が効く。
  await setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: 'hour', source: 'cli' });
  expect(await now(vault)).toMatch(/- 利用者に見せる \[IN-[^\n]+ — 手間 1時間ほど\n/);
  await setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: null, source: 'cli' });
  await setItemEffort(config, { projectId: 'hub', itemKey: name.key, effort: null, source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: name.key, due: null, reviewAfter: null, source: 'cli' });
  await expect(setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: null, source: 'cli' })).rejects.toThrow('外す手間の目安はありません');
  const strip = (t: string) => t.replace(/\n(generated_at|generated_hash)[^\n]*/g, '');
  expect(strip(await now(vault))).toBe(strip(before));
});

test('解決済みの項目には付けず、同じ本文の新しい項目へは引き継ぎ、引き継いだ目安を外すと新しい項目からも外れる', async () => {
  const { config, vault, items } = await fixture();
  const [show, name] = items as [typeof items[0], typeof items[0]];
  await setItemResolution(config, { projectId: 'hub', itemKey: name.key, action: 'resolve', source: 'cli' });
  await expect(setItemEffort(config, { projectId: 'hub', itemKey: name.key, effort: 'quick', source: 'cli' })).rejects.toThrow('解決済み');
  await setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: 'quick', source: 'cli' });
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決め直す' });
  await organize(config, new MockLlm());
  const again = (await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'next' && i.text === '利用者に見せる')!;
  expect(again.key).not.toBe(show.key);
  expect(again.effort).toBe('quick');
  await setItemEffort(config, { projectId: 'hub', itemKey: again.key, effort: null, source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === again.key)!.effort).toBeUndefined();
  expect(await now(vault)).not.toContain('手間');
});

test('引き継ぎの規則は日付と同じで、外した記録より前の古い目安を引き継がない', () => {
  const rec = (n: number, key: string, effort: 'quick' | 'hour' | null) => ({ schema_version: 1 as const, id: `EFF-0000000000000000000000000${n}`, project_id: 'p', item_key: key, section: 'next' as const, text: '見積もりを送る', input_id: `IN-0000000000000000000000000${n}`, effort, source: 'cli', created_at: '2026-11-01T00:00:00Z' });
  const item = (key: string) => ({ key, section: 'next', text: '見積もりを送る', resolution: null });
  expect(effectiveEfforts([rec(1, 'K1', 'quick')], 'p', [item('K2')], new Set()).get('K2')).toBe('quick');
  expect(effectiveEfforts([rec(1, 'K1', 'quick'), rec(2, 'K2', null)], 'p', [item('K3')], new Set()).size).toBe(0);
  expect(effectiveEfforts([rec(1, 'K1', 'quick'), rec(2, 'K2', 'hour')], 'p', [item('K2')], new Set()).get('K2')).toBe('hour');
});

test('受付ファイルの目安の依頼を反映し、同じ受付IDは重複させず、不正な記録はdoctorで示す', async () => {
  const { config, vault, items } = await fixture();
  const key = items[0]!.key, fields = { operation: 'item-effort', source: 'flutter', project_id: 'hub', item_key: key, effort: 'quick', confirmed: true };
  expect(intakeFeatures(config)).toMatchObject({ item_efforts: ['quick', 'hour', 'half-day'] });
  expect(intakeFeatures(config).operations).toContain('item-effort');
  await packet(config, { ...fields, effort: 'week' }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, effort: undefined }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-effort', result: { projectId: 'hub', itemKey: key, deduped: false } });
  const { records } = await readItemEfforts(vault);
  expect(records).toMatchObject([{ id: (receipt.result as { effortId: string }).effortId, source: 'flutter', source_event_id: p.requestId, effort: 'quick', section: 'next', text: '利用者に見せる' }]);
  expect(await setItemEffort(config, { projectId: 'hub', itemKey: key, effort: 'quick', source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, effortId: records[0]!.id });
  await expect(setItemEffort(config, { projectId: 'hub', itemKey: key, effort: 'hour', source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の手間の目安');
  // NOWにない項目への依頼は、理由付きで断る（再試行しない）。
  await packet(config, { ...fields, item_key: '0'.repeat(64) }, '');
  expect((await ingest(config)).rejected).toBe(1);
  // nullで外せる。
  await packet(config, { ...fields, effort: null }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readNowItems(vault, 'hub'))!.items[0]!.effort).toBeUndefined();

  await vault.write('90_system/item-efforts/EFF-01JZ0000000000000000000000.json', '{"broken":true}\n');
  expect((await doctor(config)).issues).toContain('手間の目安の記録が不正です: 90_system/item-efforts/EFF-01JZ0000000000000000000000.json');
});
