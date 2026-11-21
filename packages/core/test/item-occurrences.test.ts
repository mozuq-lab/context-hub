import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, readIntakeReceipts, intakeErrorSchema, intakeErrorMessage } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { buildHistory } from '../src/history.js';
import { doctor } from '../src/doctor.js';
import { hash } from '../src/storage.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { advanceDue, completeOccurrence, nextOccurrenceDue, readItemOccurrences, readItemSchedules, repeatLabel, scheduleLabel, setItemSchedule } from '../src/item-schedules.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] バックアップを確かめる\n- [確認済み] 請求書を出す\n## 未解決\n- 配布方法が決まっていない';

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', text: summary });
  await organize(config, new MockLlm());
  const items = (await readNowItems(vault, 'hub'))!.items;
  return { config, vault, items };
}
const item = async (vault: Awaited<ReturnType<typeof fixture>>['vault'], key: string) => (await readNowItems(vault, 'hub'))!.items.find(i => i.key === key)!;

test('繰り返しの間隔を進め、毎月は付けた日を短い月で月末に丸めて次の月で戻す', () => {
  expect(advanceDue('2026-11-16', { unit: 'week', every: 1 })).toBe('2026-11-23');
  expect(advanceDue('2026-12-28', { unit: 'day', every: 14 })).toBe('2027-01-11');
  expect(advanceDue('2026-01-31', { unit: 'month', every: 1, day: 31 })).toBe('2026-02-28');
  expect(advanceDue('2026-02-28', { unit: 'month', every: 1, day: 31 })).toBe('2026-03-31');
  expect(advanceDue('2028-01-31', { unit: 'month', every: 1, day: 31 })).toBe('2028-02-29');
  expect(advanceDue('2026-11-30', { unit: 'month', every: 3, day: 30 })).toBe('2027-02-28');
  // 遅れて片付けても過ぎた回をためず、今日より後の最初の回へ進む。早めに片付けたときは次の回へ。
  expect(nextOccurrenceDue('2026-11-02', { unit: 'week', every: 1 }, '2026-11-21')).toBe('2026-11-23');
  expect(nextOccurrenceDue('2026-11-30', { unit: 'week', every: 1 }, '2026-11-21')).toBe('2026-12-07');
  expect(nextOccurrenceDue('2026-11-21', { unit: 'day', every: 1 }, '2026-11-21')).toBe('2026-11-22');
  expect(repeatLabel({ unit: 'week', every: 1 })).toBe('毎週');
  expect(repeatLabel({ unit: 'month', every: 3 })).toBe('3か月ごと');
  expect(scheduleLabel({ due: '2026-11-23', review_after: null, repeat: { unit: 'week', every: 1 } })).toBe('期日 2026-11-23（毎週）');
});

test('繰り返しを付けた項目は、今回を完了しても欄に残り、期日が次の回へ進む', async () => {
  const { config, vault, items } = await fixture();
  const backup = items.find(i => i.text === 'バックアップを確かめる')!;
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: backup.key, due: null, reviewAfter: '2026-11-20', repeat: { unit: 'week', every: 1 }, source: 'cli' })).rejects.toThrow();
  await setItemSchedule(config, { projectId: 'hub', itemKey: backup.key, due: '2026-11-16', reviewAfter: null, repeat: { unit: 'week', every: 1 }, source: 'cli' });
  expect((await item(vault, backup.key)).schedule).toMatchObject({ due: '2026-11-16', repeat: { unit: 'week', every: 1 } });
  expect(await vault.read('10_projects/hub/NOW.md')).toContain('期日 2026-11-16（毎週）');
  await rebuildDashboard(config, { now: new Date('2026-11-21T03:00:00Z') });
  expect(await vault.read('HOME.md')).toContain('- 期日 2026-11-16（毎週） — ');

  // 確認した回の期日が違う依頼は受け付けない（別の端末で先に片付けた場合）。
  await expect(completeOccurrence(config, { projectId: 'hub', itemKey: backup.key, action: 'done', due: '2026-11-09', source: 'cli', now: new Date('2026-11-21T03:00:00Z') })).rejects.toMatchObject({ reason: { code: 'occurrence-changed', due: '2026-11-16' } });
  const done = await completeOccurrence(config, { projectId: 'hub', itemKey: backup.key, action: 'done', due: '2026-11-16', source: 'cli', now: new Date('2026-11-21T03:00:00Z') });
  expect(done).toMatchObject({ action: 'done', nextDue: '2026-11-23', deduped: false });
  const after = await item(vault, backup.key);
  expect(after.resolution).toBeNull();
  expect(after.schedule).toMatchObject({ due: '2026-11-23', review_after: null, repeat: { unit: 'week', every: 1 } });
  // 同じ回をもう一度片付けようとしても、2回分は進めない。
  await expect(completeOccurrence(config, { projectId: 'hub', itemKey: backup.key, action: 'done', due: '2026-11-16', source: 'cli', now: new Date('2026-11-21T03:00:00Z') })).rejects.toMatchObject({ reason: { code: 'occurrence-changed' } });
  await completeOccurrence(config, { projectId: 'hub', itemKey: backup.key, action: 'skip', due: '2026-11-23', source: 'cli', now: new Date('2026-11-21T03:00:00Z') });
  expect((await item(vault, backup.key)).schedule?.due).toBe('2026-11-30');
  const history = await buildHistory(config, 'hub');
  expect(history).toContain('定例（毎週）の2026-11-16の回を完了: バックアップを確かめる（次は 2026-11-23');
  expect(history).toContain('定例（毎週）の2026-11-23の回を見送り');

  // 期日だけを送る依頼（繰り返しを知らない版のアプリ）では繰り返しを保ち、nullで外す。
  await setItemSchedule(config, { projectId: 'hub', itemKey: backup.key, due: '2026-12-01', reviewAfter: null, source: 'flutter' });
  expect((await item(vault, backup.key)).schedule?.repeat).toEqual({ unit: 'week', every: 1 });
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: backup.key, due: '2026-12-01', reviewAfter: null, repeat: { unit: 'week', every: 1 }, source: 'cli' })).rejects.toThrow('同じ日付');
  await setItemSchedule(config, { projectId: 'hub', itemKey: backup.key, due: '2026-12-01', reviewAfter: null, repeat: null, source: 'cli' });
  expect((await item(vault, backup.key)).schedule?.repeat).toBeUndefined();
  await expect(completeOccurrence(config, { projectId: 'hub', itemKey: backup.key, action: 'done', due: '2026-12-01', source: 'cli' })).rejects.toMatchObject({ reason: { code: 'not-repeating' } });

  // 完了・解決の報告は定例でも項目を片付ける（繰り返しを終える）。
  await setItemSchedule(config, { projectId: 'hub', itemKey: backup.key, due: '2026-12-01', reviewAfter: null, repeat: { unit: 'month', every: 1 }, source: 'cli' });
  expect((await item(vault, backup.key)).schedule?.repeat).toEqual({ unit: 'month', every: 1, day: 1 });
  await setItemResolution(config, { projectId: 'hub', itemKey: backup.key, action: 'resolve', source: 'cli' });
  await expect(completeOccurrence(config, { projectId: 'hub', itemKey: backup.key, action: 'done', due: '2026-12-01', source: 'cli' })).rejects.toMatchObject({ reason: { code: 'item-closed' } });
});

test('受付ファイルで繰り返しと今回の完了を依頼し、同じ受付IDの再送と停止の後の続きを扱う', async () => {
  const { config, vault, items } = await fixture();
  const bill = items.find(i => i.text === '請求書を出す')!;
  const fields = { operation: 'item-schedule', source: 'flutter', project_id: 'hub', item_key: bill.key, due: '2026-11-30', review_after: null, confirmed: true };
  await packet(config, { ...fields, due: null, repeat: { unit: 'month', every: 1 } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, repeat: { unit: 'year', every: 1 } }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, repeat: { unit: 'month', every: 1 } }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await item(vault, bill.key)).schedule?.repeat).toEqual({ unit: 'month', every: 1, day: 30 });

  const round = { operation: 'item-occurrence', source: 'flutter', project_id: 'hub', item_key: bill.key, action: 'done', due: '2026-11-30', confirmed: true };
  await packet(config, { ...round, action: 'finish' }, ''); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, round, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-occurrence', result: { projectId: 'hub', itemKey: bill.key, action: 'done', deduped: false } });
  const nextDue = (receipt.result as { nextDue: string }).nextDue;
  expect(nextDue > '2026-11-30').toBe(true);
  expect((await item(vault, bill.key)).schedule?.due).toBe(nextDue);

  // 回の記録の後、次の回の日付を作る前に停止した場合は、同じ受付IDの再送で続きを作る。
  const occurrence = (await readItemOccurrences(vault)).records.at(-1)!;
  await vault.remove(`90_system/item-schedules/${occurrence.schedule_id}.json`);
  expect((await item(vault, bill.key)).schedule?.due).toBe(nextDue);
  expect(await completeOccurrence(config, { projectId: 'hub', itemKey: bill.key, action: 'done', due: '2026-11-30', source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, occurrenceId: occurrence.id, nextDue });
  expect((await readItemSchedules(vault)).records.some(r => r.id === occurrence.schedule_id)).toBe(true);
  await expect(completeOccurrence(config, { projectId: 'hub', itemKey: bill.key, action: 'skip', due: '2026-11-30', source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の定例の報告');

  // 確認した回が古い依頼は、理由付きで拒否して再試行しない。
  const stale = await packet(config, round, '');
  expect((await ingest(config)).rejected).toBe(1);
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(stale.path)}.json`))!));
  expect(error.reason).toEqual({ code: 'occurrence-changed', due: nextDue });
  expect(intakeErrorMessage(error)).toContain(`今の期日は ${nextDue}`);
  expect(error.code).toContain('既に片付いている');

  await vault.write('90_system/item-occurrences/OCC-01JZ0000000000000000000000.json', '{"broken":true}\n');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('[定例の回の記録が不正です](90_system/item-occurrences/OCC-01JZ0000000000000000000000.json)');
  expect((await doctor(config)).issues).toContain('定例の回の記録が不正です: 90_system/item-occurrences/OCC-01JZ0000000000000000000000.json');
});

test('毎月の日は、期日を変えずに見直す日だけを変えても覚え直さず、2099年を超える回へは進めない', async () => {
  const { config, vault, items } = await fixture();
  const invoice = items.find(i => i.text === '請求書を出す')!;
  await setItemSchedule(config, { projectId: 'hub', itemKey: invoice.key, due: '2026-10-31', reviewAfter: null, repeat: { unit: 'month', every: 1 }, source: 'cli' });
  await completeOccurrence(config, { projectId: 'hub', itemKey: invoice.key, action: 'done', due: '2026-10-31', source: 'cli', now: new Date('2026-11-01T03:00:00Z') });
  expect((await item(vault, invoice.key)).schedule).toMatchObject({ due: '2026-11-30', repeat: { unit: 'month', every: 1, day: 31 } });
  // 繰り返しを省いた依頼（古い版のアプリ・CLIの--review）も、繰り返しを添えた依頼も、月末に丸めた期日のままなら日を保つ。
  await setItemSchedule(config, { projectId: 'hub', itemKey: invoice.key, due: '2026-11-30', reviewAfter: '2026-11-20', source: 'flutter' });
  expect((await item(vault, invoice.key)).schedule?.repeat).toEqual({ unit: 'month', every: 1, day: 31 });
  await expect(setItemSchedule(config, { projectId: 'hub', itemKey: invoice.key, due: '2026-11-30', reviewAfter: '2026-11-20', repeat: { unit: 'month', every: 1 }, source: 'cli' })).rejects.toThrow('同じ日付');
  await setItemSchedule(config, { projectId: 'hub', itemKey: invoice.key, due: '2026-11-30', reviewAfter: null, repeat: { unit: 'month', every: 1 }, source: 'flutter', sourceEventId: 'REQ-M' });
  expect((await item(vault, invoice.key)).schedule?.repeat).toEqual({ unit: 'month', every: 1, day: 31 });
  // 同じ受付IDの再送も、覚えた日の違いを別の依頼とみなさない。
  expect((await setItemSchedule(config, { projectId: 'hub', itemKey: invoice.key, due: '2026-11-30', reviewAfter: null, repeat: { unit: 'month', every: 1 }, source: 'flutter', sourceEventId: 'REQ-M' })).deduped).toBe(true);
  expect((await completeOccurrence(config, { projectId: 'hub', itemKey: invoice.key, action: 'done', due: '2026-11-30', source: 'cli', now: new Date('2026-12-01T03:00:00Z') })).nextDue).toBe('2026-12-31');
  // 期日を変えたときは、新しい期日の日を覚える。
  await setItemSchedule(config, { projectId: 'hub', itemKey: invoice.key, due: '2027-01-15', reviewAfter: null, source: 'cli' });
  expect((await item(vault, invoice.key)).schedule?.repeat).toEqual({ unit: 'month', every: 1, day: 15 });

  await setItemSchedule(config, { projectId: 'hub', itemKey: invoice.key, due: '2099-12-31', reviewAfter: null, repeat: { unit: 'day', every: 1 }, source: 'cli' });
  await expect(completeOccurrence(config, { projectId: 'hub', itemKey: invoice.key, action: 'done', due: '2099-12-31', source: 'cli', now: new Date('2099-12-31T03:00:00Z') })).rejects.toMatchObject({ reason: { code: 'occurrence-out-of-range' } });
  expect((await readItemOccurrences(vault)).problems).toEqual([]);
  expect((await readItemSchedules(vault)).problems).toEqual([]);
  expect((await item(vault, invoice.key)).schedule?.due).toBe('2099-12-31');
});
