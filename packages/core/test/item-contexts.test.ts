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
import { UNASSIGNED_SCOPE, itemKey, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemEffort, readItemEfforts } from '../src/item-efforts.js';
import { contextTagsSchema, effectiveContexts, readItemContexts, setItemContexts } from '../src/item-contexts.js';
import { readClientPreferences, setClientPreferences } from '../src/client-preferences.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n## 未解決\n- 配布方法が決まっていない';

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', text: summary });
  await organize(config, new MockLlm());
  const items = (await readNowItems(vault, 'hub'))!.items;
  return { config, vault, items };
}
type Vault = Awaited<ReturnType<typeof fixture>>['vault'];
const now = async (vault: Vault) => (await vault.read('10_projects/hub/NOW.md'))!;

test('札を付けるとNOWの行末と項目一覧に出て、HOMEは変えず、置き換え・外すと元に戻る', async () => {
  const { config, vault, items } = await fixture();
  const show = items.find(i => i.text === '利用者に見せる')!, open = items.find(i => i.section === 'open')!;
  const before = await now(vault);
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  const homeBefore = (await vault.read('HOME.md'))!;
  const first = await setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: ['PC', '家'], source: 'cli' });
  expect(first.contextId).toMatch(/^CTX-/);
  await setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: 'quick', source: 'cli' });
  // 未解決の項目にも付けられる。
  await setItemContexts(config, { projectId: 'hub', itemKey: open.key, contexts: ['電話'], source: 'cli' });
  const text = await now(vault);
  expect(text).toMatch(/- 利用者に見せる \[IN-[^\n]+ — 手間 15分ほど・@PC @家\n/);
  expect(text).toMatch(/- 未解決: 配布方法が決まっていない \[IN-[^\n]+ — @電話\n/);
  const listed = (await readNowItems(vault, 'hub'))!.items;
  expect(listed.find(i => i.key === show.key)!.contexts).toEqual(['PC', '家']);
  expect(listed.find(i => i.text === '名前を決める')!.contexts).toBeUndefined();
  // HOMEは絞り込めないので表示を変えない（札は出さない）。
  await rebuildDashboard(config, { now: new Date('2026-11-15T03:00:00Z') });
  const home = (await vault.read('HOME.md'))!;
  expect(home).not.toContain('@PC');
  const plain = (t: string) => t.replace(/\n(generated_at|generated_hash)[^\n]*/g, '').replace(/（手間 15分ほど）/, '');
  expect(plain(home)).toBe(plain(homeBefore));

  await expect(setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: ['PC', '家'], source: 'cli' })).rejects.toThrow('同じ札');
  await expect(setItemContexts(config, { projectId: 'hub', itemKey: '0'.repeat(64), contexts: ['PC'], source: 'cli' })).rejects.toThrow('該当する項目がありません');
  for (const bad of [[], ['外 出'], ['@家'], ['家', '家'], ['a・b'], ['x'.repeat(21)], Array.from({ length: 9 }, (_, i) => `t${i}`), ['<b>'], ['`x`'], ['P\u200bC'], ['\u30ab\u3099']]) {
    await expect(setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: bad, source: 'cli' })).rejects.toThrow();
  }
  // 置き換えると最後の記録が効く（順番の違いも別の札として記録する）。
  await setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: ['外出先'], source: 'cli' });
  expect(await now(vault)).toMatch(/- 利用者に見せる \[IN-[^\n]+ — 手間 15分ほど・@外出先\n/);
  await setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: null, source: 'cli' });
  await setItemContexts(config, { projectId: 'hub', itemKey: open.key, contexts: null, source: 'cli' });
  await setItemEffort(config, { projectId: 'hub', itemKey: show.key, effort: null, source: 'cli' });
  await expect(setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: null, source: 'cli' })).rejects.toThrow('外す札はありません');
  const strip = (t: string) => t.replace(/\n(generated_at|generated_hash)[^\n]*/g, '');
  expect(strip(await now(vault))).toBe(strip(before));
  // 記録は消さずに残る。
  expect((await readItemContexts(vault)).records).toHaveLength(5);
});

test('解決済みの項目には付けず、同じ本文の新しい項目へは引き継ぐ', async () => {
  const { config, vault, items } = await fixture();
  const show = items.find(i => i.text === '利用者に見せる')!, name = items.find(i => i.text === '名前を決める')!;
  await setItemResolution(config, { projectId: 'hub', itemKey: name.key, action: 'resolve', source: 'cli' });
  await expect(setItemContexts(config, { projectId: 'hub', itemKey: name.key, contexts: ['PC'], source: 'cli' })).rejects.toThrow('解決済み');
  await setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: ['PC'], source: 'cli' });
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', receivedAt: '2026-11-01T00:00:00Z', text: '## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決め直す' });
  await organize(config, new MockLlm());
  const again = (await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'next' && i.text === '利用者に見せる')!;
  expect(again.key).not.toBe(show.key);
  expect(again.contexts).toEqual(['PC']);
  await setItemContexts(config, { projectId: 'hub', itemKey: again.key, contexts: null, source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === again.key)!.contexts).toBeUndefined();
  expect(await now(vault)).not.toContain('@PC');
});

test('引き継ぎの規則は日付と同じで、外した記録より前の古い札を引き継がない', () => {
  const rec = (n: number, key: string, contexts: string[] | null) => ({ schema_version: 1 as const, id: `CTX-0000000000000000000000000${n}`, project_id: 'p', item_key: key, section: 'next' as const, text: '見積もりを送る', input_id: `IN-0000000000000000000000000${n}`, contexts, source: 'cli', created_at: '2026-11-01T00:00:00Z' });
  const item = (key: string) => ({ key, section: 'next', text: '見積もりを送る', resolution: null });
  expect(effectiveContexts([rec(1, 'K1', ['PC'])], 'p', [item('K2')], new Set()).get('K2')).toEqual(['PC']);
  expect(effectiveContexts([rec(1, 'K1', ['PC']), rec(2, 'K2', null)], 'p', [item('K3')], new Set()).size).toBe(0);
  expect(contextTagsSchema.safeParse(['家', '外出先', 'PC', '電話', '元気なとき']).success).toBe(true);
});

test('受付ファイルの札の依頼を反映し、同じ受付IDは重複させず、不正な記録はdoctorで示す', async () => {
  const { config, vault, items } = await fixture();
  const key = items[0]!.key, fields = { operation: 'item-contexts', source: 'flutter', project_id: 'hub', item_key: key, contexts: ['家', 'PC'], confirmed: true };
  expect(intakeFeatures(config)).toMatchObject({ action_fields: ['effort', 'contexts'], item_contexts: { max_tags: 8, max_chars: 20, vocabulary_max: 30 } });
  expect(intakeFeatures(config).operations).toContain('item-contexts');
  await packet(config, { ...fields, contexts: ['家 PC'] }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, contexts: [] }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, contexts: undefined }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-contexts', result: { projectId: 'hub', itemKey: key, deduped: false } });
  const { records } = await readItemContexts(vault);
  expect(records).toMatchObject([{ id: (receipt.result as { contextId: string }).contextId, source: 'flutter', source_event_id: p.requestId, contexts: ['家', 'PC'], section: 'next' }]);
  expect(await setItemContexts(config, { projectId: 'hub', itemKey: key, contexts: ['家', 'PC'], source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, contextId: records[0]!.id });
  await expect(setItemContexts(config, { projectId: 'hub', itemKey: key, contexts: ['家'], source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の札');
  // 別の端末から同じ札の依頼が重なっても、受け付けて何も記録しない。
  expect(await setItemContexts(config, { projectId: 'hub', itemKey: key, contexts: ['家', 'PC'], source: 'flutter', sourceEventId: 'REQ-other' })).toMatchObject({ deduped: true });
  await packet(config, { ...fields, item_key: '0'.repeat(64) }, '');
  expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, contexts: null }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readNowItems(vault, 'hub'))!.items[0]!.contexts).toBeUndefined();

  await vault.write('90_system/item-contexts/CTX-01JZ0000000000000000000000.json', '{"broken":true}\n');
  expect((await doctor(config)).issues).toContain('場所・道具の札の記録が不正です: 90_system/item-contexts/CTX-01JZ0000000000000000000000.json');
});

test('行動の追加と一緒に手間の目安と札を付けられ、再送で重ねず、メモには付けられない', async () => {
  const { config, vault } = await fixture();
  const p = await packet(config, { kind: 'action', project: 'hub', source: 'flutter-mac', effort: 'quick', contexts: ['電話'] }, '見積もりを頼む');
  expect(await ingest(config)).toMatchObject({ accepted: 1 });
  const added = (await readNowItems(vault, 'hub'))!.items.find(i => i.text === '見積もりを頼む')!;
  expect(added).toMatchObject({ effort: 'quick', contexts: ['電話'] });
  expect(await now(vault)).toMatch(/本人が追加: 見積もりを頼む [^\n]* — 手間 15分ほど・@電話\n/);
  // 同じ受付の再送（受領記録の前に止まった）では、記録を重ねない。
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  await capture(config, { source: 'flutter-mac', sourceEventId: p.requestId, kind: 'action', project: 'hub', occurredAt: new Date().toISOString(), text: '見積もりを頼む', effort: 'quick', contexts: ['電話'] });
  expect((await readItemContexts(vault)).records).toHaveLength(1);
  expect((await readItemEfforts(vault)).records).toHaveLength(1);
  expect((await readItemContexts(vault)).records[0]).toMatchObject({ item_key: itemKey('hub', 'next', (receipt.result as { inputId: string }).inputId, '見積もりを頼む'), source_event_id: `action-add:${(receipt.result as { inputId: string }).inputId}` });

  // プロジェクト未定の行動にも付けられる。
  const own = await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', text: '本を返す', contexts: ['外出先'] });
  expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === own.inputId)!.contexts).toEqual(['外出先']);
  // メモと作業要約には付けられない。不正な札の行動は保存しない。
  await packet(config, { kind: 'memo', project: 'hub', contexts: ['家'] }, 'メモ'); expect((await ingest(config)).rejected).toBe(1);
  await expect(capture(config, { source: 'cli', kind: 'memo', occurredAt: '2026-11-02T00:00:00Z', text: 'メモ', contexts: ['家'] })).rejects.toThrow('行動にだけ');
  await expect(capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', text: '鍵を返す', contexts: ['家 外'] })).rejects.toThrow();
  expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.some(i => i.text === '鍵を返す')).toBe(false);
  // 追加した後に本人が付け直した札は、同じ受付の再送で戻さない。
  const later = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === own.inputId)!;
  await setItemContexts(config, { projectId: UNASSIGNED_SCOPE, itemKey: later.key, contexts: ['家'], source: 'cli' });
  const resent = await capture(config, { source: 'flutter-mac', sourceEventId: 'again-1', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', text: '傘を返す', contexts: ['外出先'] });
  await setItemContexts(config, { projectId: UNASSIGNED_SCOPE, itemKey: (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === resent.inputId)!.key, contexts: ['PC'], source: 'cli' });
  await capture(config, { source: 'flutter-mac', sourceEventId: 'again-1', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', text: '傘を返す', contexts: ['外出先'] });
  expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === resent.inputId)!.contexts).toEqual(['PC']);
  // 同じ受付IDで別の入力（メモ）が保存済みなら、その入力に札を付けない。
  const memo = await capture(config, { source: 'flutter-mac', sourceEventId: 'reused-1', kind: 'memo', occurredAt: '2026-11-02T00:00:00Z', text: '覚え書き' });
  const reused = await capture(config, { source: 'flutter-mac', sourceEventId: 'reused-1', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', text: '別の行動', contexts: ['家'] }).catch(() => undefined);
  expect(reused?.inputId).toBe(memo.inputId);
  expect((await readItemContexts(vault, { raw: true })).records.some(r => r.input_id === memo.inputId)).toBe(false);
});

test('AIの行を行動にしたとき・行動を移したとき、札を行動へ写し、追加で選んだ札が優先する', async () => {
  const { config, vault, items } = await fixture();
  const show = items.find(i => i.text === '利用者に見せる')!, name = items.find(i => i.text === '名前を決める')!;
  await setItemContexts(config, { projectId: 'hub', itemKey: show.key, contexts: ['PC'], source: 'cli' });
  await setItemContexts(config, { projectId: 'hub', itemKey: name.key, contexts: ['家'], source: 'cli' });
  const from = (i: typeof show) => ({ action_from_input: i.input_id, action_from_text: i.text, action_from_key: i.key });
  const taken = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-02T00:00:00Z', text: '利用者に見せる', meta: from(show) });
  const picked = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-02T00:00:00Z', text: '名前を決める', meta: from(name), contexts: ['電話'] });
  let list = (await readNowItems(vault, 'hub'))!.items;
  expect(list.find(i => i.input_id === taken.inputId)!.contexts).toEqual(['PC']);
  expect(list.find(i => i.input_id === picked.inputId)!.contexts).toEqual(['電話']);
  // 元の行の札は引き取られたので、元の行が出直しても重ねて付かない。
  expect(list.filter(i => i.contexts).length).toBe(2);
  // 追加で選んだ札は、元の行から写した記録（引き取った印）より後に書く。
  const raw = (await readItemContexts(vault, { raw: true })).records.filter(r => r.input_id === picked.inputId);
  expect(raw.map(r => r.contexts)).toEqual([['家'], ['電話']]);
  expect(raw[0]!.source_event_id).toMatch(/^take-over:/);
  // プロジェクト未定へ移すと、札も移した先の行動に写る。
  const { moveAction } = await import('../src/action-moves.js');
  const moved = list.find(i => i.input_id === taken.inputId)!;
  await moveAction(config, { from: 'hub', itemKey: moved.key, to: UNASSIGNED_SCOPE, source: 'cli', occurredAt: new Date().toISOString() });
  expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.text === '利用者に見せる')!.contexts).toEqual(['PC']);
  list = (await readNowItems(vault, 'hub'))!.items;
  expect(list.some(i => i.input_id === taken.inputId)).toBe(false);
});

test('札の語彙をアプリの好みとして端末の間にそろえ、不正な語彙は断る', async () => {
  const { config, vault } = await workflowSetup(roots);
  const contexts = (items: string[], at: string) => ({ updated_at: at, value: { items } });
  expect(await setClientPreferences(config, { payload: { schema_version: 1, device: 'mac', groups: { contexts: contexts(['家', '外出先', 'PC', '電話', '元気なとき'], '2026-11-22T01:00:00Z') } }, source: 'flutter', sourceEventId: 'REQ-1' })).toEqual({ applied: ['contexts'], deduped: false });
  expect((await readClientPreferences(vault))!.groups.contexts?.value.items).toEqual(['家', '外出先', 'PC', '電話', '元気なとき']);
  for (const items of [['家', '家'], ['家 外'], Array.from({ length: 31 }, (_, i) => `t${i}`)]) {
    await expect(setClientPreferences(config, { payload: { schema_version: 1, device: 'mac', groups: { contexts: contexts(items, '2026-11-22T02:00:00Z') } }, source: 'flutter', sourceEventId: 'REQ-2' })).rejects.toThrow();
  }
  // 空の語彙（すべて消した）も記録できる。
  expect((await setClientPreferences(config, { payload: { schema_version: 1, device: 'android', groups: { contexts: contexts([], '2026-11-22T03:00:00Z') } }, source: 'flutter', sourceEventId: 'REQ-3' })).applied).toEqual(['contexts']);
});
