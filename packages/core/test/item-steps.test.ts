import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { hash } from '../src/storage.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, intakeErrorMessage, intakeErrorSchema, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { UNASSIGNED_SCOPE, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { completeOccurrence, setItemSchedule } from '../src/item-schedules.js';
import { readItemSteps, setItemSteps, stepsLabel } from '../src/item-steps.js';
import { setItemEffort } from '../src/item-efforts.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 確定申告を進める\n- [確認済み] 名前を決める\n## 未解決\n- 配布方法が決まっていない';
const plan = ['医療費の領収書を集める', 'ふるさと納税の受領証を探す', 'e-Taxで下書きする', '提出する'];

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', text: summary });
  await organize(config, new MockLlm());
  const items = (await readNowItems(vault, 'hub'))!.items;
  return { config, vault, items, tax: items.find(i => i.text === '確定申告を進める')!, open: items.find(i => i.section === 'open')! };
}
const now = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('10_projects/hub/NOW.md'))!;
const steps = async (vault: Awaited<ReturnType<typeof fixture>>['vault'], key: string) => (await readNowItems(vault, 'hub'))!.items.find(i => i.key === key)!.steps;

test('手順を付けると今の1歩だけがNOW・HOME・項目一覧に出て、進める・戻す・すべて終える・外すができる', async () => {
  const { config, vault, tax } = await fixture();
  const before = await now(vault);
  const first = await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 0 }, source: 'cli' });
  expect(first.stepsId).toMatch(/^STP-/);
  expect(await now(vault)).toMatch(/- 確定申告を進める \[IN-[^\n]+ — 手順 1\/4: 医療費の領収書を集める\n/);
  expect(await steps(vault, tax.key)).toMatchObject({ items: plan, done: 0 });
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  expect(await vault.read('HOME.md')).toContain('  - 確定申告を進める（手順 1/4: 医療費の領収書を集める）');
  // 進める（全体を送る）。
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 1 }, source: 'cli' });
  expect(await now(vault)).toContain('— 手順 2/4: ふるさと納税の受領証を探す\n');
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 4 }, source: 'cli' });
  expect(await now(vault)).toContain('— 手順 4/4 済み・項目の完了を確かめる\n');
  // 戻す。
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 3 }, source: 'cli' });
  expect(stepsLabel((await steps(vault, tax.key))!)).toBe('手順 4/4: 提出する');
  // 不正な全体は受け付けない。
  for (const bad of [{ items: ['1つだけ'], done: 0 }, { items: plan, done: 5 }, { items: Array.from({ length: 11 }, (_, i) => `手順${i}`), done: 0 }, { items: ['改行\nあり', '二つ目'], done: 0 }, { items: [' 前に空白', '二つ目'], done: 0 }, { items: plan, done: -1 }])
    await expect(setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: bad, source: 'cli' })).rejects.toThrow();
  await expect(setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 3 }, source: 'cli' })).rejects.toThrow('同じ手順');
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: null, source: 'cli' });
  await expect(setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: null, source: 'cli' })).rejects.toThrow('外す手順はありません');
  const strip = (t: string) => t.replace(/\n(generated_at|generated_hash)[^\n]*/g, '');
  expect(strip(await now(vault))).toBe(strip(before));
});

test('未解決・片付いた項目には付けず、手順の文面はNOWの1行に収める', async () => {
  const { config, vault, tax, open, items } = await fixture();
  await expect(setItemSteps(config, { projectId: 'hub', itemKey: open.key, steps: { items: plan, done: 0 }, source: 'cli' })).rejects.toMatchObject({ reason: { code: 'steps-refused', cause: 'not-next' } });
  const name = items.find(i => i.text === '名前を決める')!;
  await setItemResolution(config, { projectId: 'hub', itemKey: name.key, action: 'resolve', source: 'cli' });
  await expect(setItemSteps(config, { projectId: 'hub', itemKey: name.key, steps: { items: plan, done: 0 }, source: 'cli' })).rejects.toThrow('解決済み');
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: ['[リンク](http://example.com) を *強調*', '次'], done: 0 }, source: 'cli' });
  const line = (await now(vault)).split('\n').find(l => l.startsWith('- 確定申告を進める'))!;
  expect(line).toMatch(/ — 手順 1\/2: .*強調/);
  expect((await steps(vault, tax.key))!.items[0]).toBe('[リンク](http://example.com) を *強調*');
});

test('同じ本文の新しい項目へ引き継ぎ、定例の今回を終えると手順が最初に戻る', async () => {
  const { config, vault, tax } = await fixture();
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 2 }, source: 'cli' });
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '## 次の一手\n- [確認済み] 確定申告を進める' });
  await organize(config, new MockLlm());
  const again = (await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'next' && i.text === '確定申告を進める')!;
  expect(again.key).not.toBe(tax.key);
  expect(again.steps).toMatchObject({ items: plan, done: 2 });
  await setItemSchedule(config, { projectId: 'hub', itemKey: again.key, due: '2026-11-16', reviewAfter: null, repeat: { unit: 'month', every: 1 }, source: 'cli' });
  const done = await completeOccurrence(config, { projectId: 'hub', itemKey: again.key, action: 'done', due: '2026-11-16', source: 'app', sourceEventId: 'REQ-occurrence', now: new Date('2026-11-17T00:00:00Z') });
  expect((await steps(vault, again.key))).toMatchObject({ items: plan, done: 0 });
  const records = (await readItemSteps(vault)).records;
  // 同じ回の再送で、二重に戻さない。
  await completeOccurrence(config, { projectId: 'hub', itemKey: again.key, action: 'done', due: '2026-11-16', source: 'app', sourceEventId: 'REQ-occurrence', now: new Date('2026-11-17T00:00:00Z') });
  expect((await readItemSteps(vault)).records).toHaveLength(records.length);
  expect(done.nextDue).toBe('2026-12-16');
  // 進めていない手順の定例は、記録を増やさない。
  await completeOccurrence(config, { projectId: 'hub', itemKey: again.key, action: 'skip', due: '2026-12-16', source: 'cli', now: new Date('2026-11-17T00:00:00Z') });
  expect((await readItemSteps(vault)).records).toHaveLength(records.length);
});

test('受付の依頼で付けられ、別の端末からの同じ全体は記録を増やさず、プロジェクト未定の行動にも付けられる', async () => {
  const { config, vault, tax, open } = await fixture();
  expect(intakeFeatures(config).operations).toContain('item-steps');
  expect(intakeFeatures(config).item_steps).toEqual({ min: 2, max: 10, max_chars: 200 });
  await packet(config, { operation: 'item-steps', project_id: 'hub', item_key: tax.key, steps: { items: plan, done: 1 }, expected: null, confirmed: true }, '');
  await packet(config, { operation: 'item-steps', project_id: 'hub', item_key: tax.key, steps: { items: plan, done: 1 }, expected: null, confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(2);
  expect((await readItemSteps(vault)).records).toHaveLength(1);
  expect((await readIntakeReceipts(config)).filter(r => r.operation === 'item-steps').map(r => 'stepsId' in r.result)).toEqual([true, true]);
  // 未解決への依頼は理由を付けて断り、再試行しない。
  const refused = await packet(config, { operation: 'item-steps', project_id: 'hub', item_key: open.key, steps: { items: plan, done: 0 }, expected: null, confirmed: true }, '');
  expect((await ingest(config)).rejected).toBe(1);
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(refused.path)}.json`))!));
  expect(error.reason).toEqual({ code: 'steps-refused', cause: 'not-next' });
  expect(intakeErrorMessage(error)).toContain('「次の一手」の項目だけ');
  expect((await ingest(config)).rejected).toBe(0);
  // プロジェクト未定の行動。
  await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-01T00:00:00Z', text: '引っ越しの準備をする' });
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  const action = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.text === '引っ越しの準備をする')!;
  await setItemSteps(config, { projectId: UNASSIGNED_SCOPE, itemKey: action.key, steps: { items: ['業者を比べる', '見積もりを取る'], done: 0 }, source: 'cli' });
  expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.key === action.key)!.steps).toMatchObject({ done: 0 });
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  expect(await vault.read('HOME.md')).toContain('引っ越しの準備をする（手順 1/2: 業者を比べる）');
  expect((await doctor(config)).issues.filter(i => i.includes('手順'))).toEqual([]);
});

test('古い表示から送った手順は断り（進み具合を巻き戻さない）、自分の行動にした元の行が出直しても手順を重ねて付けない', async () => {
  const { config, vault, tax } = await fixture();
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 1 }, expected: null, source: 'cli' });
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 2 }, expected: { items: plan, done: 1 }, source: 'cli' });
  // 別の端末は1つ済みのまま見ていて「進める」を押した。
  await expect(setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 2 }, expected: { items: plan, done: 1 }, source: 'app', sourceEventId: 'REQ-stale' })).resolves.toMatchObject({ deduped: true });
  await expect(setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 3 }, expected: { items: plan, done: 1 }, source: 'cli' })).rejects.toMatchObject({ reason: { code: 'steps-refused', cause: 'changed' } });
  expect((await steps(vault, tax.key))!.done).toBe(2);
  // 自分の行動にする。元の行の手順は行動へ写り、元の行が作業要約で出直しても付かない。
  await setItemEffort(config, { projectId: 'hub', itemKey: tax.key, effort: 'quick', source: 'cli' });
  await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-02T00:00:00Z', text: '確定申告を進める', meta: { action_from_input: tax.input_id, action_from_text: tax.text, action_from_key: tax.key } });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-11-03T00:00:00Z', receivedAt: '2026-11-03T00:00:00Z', text: '## 次の一手\n- [確認済み] 確定申告を進める' });
  await organize(config, new MockLlm());
  const list = (await readNowItems(vault, 'hub'))!.items.filter(i => i.text === '確定申告を進める' && !i.resolution);
  expect(list.find(i => i.action)!.steps).toMatchObject({ items: plan, done: 2 });
  expect(list.filter(i => !i.action).every(i => i.steps === undefined)).toBe(true);
});

test('定例の回の依頼の再送が、手順を進めた後に届いても、手順を最初に戻さない', async () => {
  const { config, vault, tax } = await fixture();
  await setItemSchedule(config, { projectId: 'hub', itemKey: tax.key, due: '2026-11-16', reviewAfter: null, repeat: { unit: 'month', every: 1 }, source: 'cli' });
  await completeOccurrence(config, { projectId: 'hub', itemKey: tax.key, action: 'done', due: '2026-11-16', source: 'app', sourceEventId: 'REQ-round', now: new Date('2026-11-17T00:00:00Z') });
  await new Promise(resolve => setTimeout(resolve, 5));
  await setItemSteps(config, { projectId: 'hub', itemKey: tax.key, steps: { items: plan, done: 2 }, source: 'cli' });
  await completeOccurrence(config, { projectId: 'hub', itemKey: tax.key, action: 'done', due: '2026-11-16', source: 'app', sourceEventId: 'REQ-round', now: new Date('2026-11-17T00:00:00Z') });
  expect((await steps(vault, tax.key))!.done).toBe(2);
});
