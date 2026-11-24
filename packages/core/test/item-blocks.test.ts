import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, intakeErrorMessage, intakeErrorSchema, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { context } from '../src/retrieve.js';
import { hash } from '../src/storage.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemWait } from '../src/item-waits.js';
import { ItemBlocksError, readItemBlocks, setItemBlocks } from '../src/item-blocks.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const clock = new Date('2026-11-24T03:00:00Z');

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await addProject(config, { id: 'shop', title: '発注' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-11-20T00:00:00Z', receivedAt: '2026-11-20T00:00:00Z', text: '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 発注する\n- [確認済み] 説明を書く\n## 未解決\n- 配布方法が決まっていない' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'shop', occurredAt: '2026-11-21T00:00:00Z', receivedAt: '2026-11-21T00:00:00Z', text: '## 現在地\n- [確認済み] 相見積もり中\n## 次の一手\n- [確認済み] 見積もりを受け取る\n- [確認済み] 予算を確かめる' });
  await organize(config, new MockLlm());
  const hub = (await readNowItems(vault, 'hub'))!.items, shop = (await readNowItems(vault, 'shop'))!.items;
  const find = (items: typeof hub, text: string) => items.find(i => i.text === text)!;
  return { config, vault, order: find(hub, '発注する'), doc: find(hub, '説明を書く'), open: hub.find(i => i.section === 'open')!, quote: find(shop, '見積もりを受け取る'), budget: find(shop, '予算を確かめる') };
}
const home = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('HOME.md'))!;

test('先に済ませることを付けると先待ちにまとまり、先の項目が片付くと動けるようになった項目に出て、外すと元に戻る', async () => {
  const { config, vault, order, quote, budget } = await fixture();
  await rebuildDashboard(config, { now: clock });
  const before = await home(vault);
  expect(before).toContain('  - 発注する');
  expect(before).not.toContain('## 先待ち');

  const first = await setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: [{ projectId: 'shop', itemKey: quote.key }, { projectId: 'shop', itemKey: budget.key }], source: 'cli' });
  expect(first.blocksId).toMatch(/^BLK-/);
  const listed = (await readNowItems(vault, 'hub'))!.items.find(i => i.key === order.key)!;
  expect(listed.after).toEqual({ id: first.blocksId, items: [{ project_id: 'shop', item_key: quote.key, section: 'next', text: '見積もりを受け取る' }, { project_id: 'shop', item_key: budget.key, section: 'next', text: '予算を確かめる' }] });
  // NOWは件数だけを示し、別のプロジェクトの項目の本文は載せない（別AI向けの資料の元になるため）。
  const now = (await vault.read('10_projects/hub/NOW.md'))!;
  expect(now).toMatch(/- 発注する \[IN-[^\n]+ — 先に済ませること 2件\n/);
  expect(await context(config, 'hub')).not.toContain('見積もりを受け取る');

  await rebuildDashboard(config, { now: clock });
  let shown = await home(vault);
  expect(shown).not.toContain('  - 発注する');
  expect(shown).toContain('  - 説明を書く');
  expect(shown).toContain('## 先待ち（1件）');
  expect(shown).toContain('- [集約ツール](10_projects/hub/NOW.md) 次の一手: 発注する（先に: 「見積もりを受け取る」（発注）、「予算を確かめる」（発注））');
  expect(shown).not.toContain('### 動けるようになった項目');

  // 1件だけ済んでも、残りがあれば先待ちのまま。
  await setItemResolution(config, { projectId: 'shop', itemKey: quote.key, action: 'resolve', source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  shown = await home(vault);
  expect(shown).toContain('次の一手: 発注する（先に: 「予算を確かめる」（発注））');
  // 誤りとして外した先の項目も、待たない。
  await setItemResolution(config, { projectId: 'shop', itemKey: budget.key, action: 'exclude', reason: 'outdated', source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  shown = await home(vault);
  expect(shown).not.toContain('## 先待ち');
  expect(shown).toContain('### 動けるようになった項目（1件）');
  const next = shown.slice(shown.indexOf('## 次の一手'), shown.indexOf('### プロジェクトごと'));
  expect(next).toContain('- [集約ツール](10_projects/hub/NOW.md) 次の一手: 発注する（先の「見積もりを受け取る」（発注）、「予算を確かめる」（発注）が片付きました）');
  expect(shown).not.toContain('  - 発注する');

  // 外すと、ふつうの次の一手に戻る。
  await setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: null, source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  shown = await home(vault);
  expect(shown).toContain('  - 発注する');
  expect(shown).not.toContain('動けるようになった項目');
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === order.key)!.after).toBeUndefined();
  await expect(setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: null, source: 'cli' })).rejects.toThrow('付いていません');
});

test('自分自身・片付いた項目・見当たらない項目・互いに待つ組・上限を超える指定は受け付けない', async () => {
  const { config, order, doc, open, quote, budget } = await fixture();
  const refuse = async (after: { projectId: string; itemKey: string }[], cause: string) => {
    const error = await setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after, source: 'cli' }).catch(e => e);
    expect(error).toBeInstanceOf(ItemBlocksError);
    expect((error as ItemBlocksError).reason.cause).toBe(cause);
  };
  await refuse([{ projectId: 'hub', itemKey: order.key }], 'self');
  await refuse([{ projectId: 'shop', itemKey: '0'.repeat(64) }], 'missing');
  await refuse([{ projectId: 'nothing', itemKey: quote.key }], 'missing');
  await setItemResolution(config, { projectId: 'shop', itemKey: budget.key, action: 'resolve', source: 'cli' });
  await refuse([{ projectId: 'shop', itemKey: budget.key }], 'closed');
  await expect(setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: [{ projectId: 'shop', itemKey: quote.key }, { projectId: 'shop', itemKey: quote.key }], source: 'cli' })).rejects.toThrow('同じ項目');
  await expect(setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: [1, 2, 3, 4].map(() => ({ projectId: 'shop', itemKey: quote.key })), source: 'cli' })).rejects.toThrow();
  // プロジェクト未定の行には付けられない。
  await expect(setItemBlocks(config, { projectId: '_unassigned', itemKey: order.key, after: [{ projectId: 'shop', itemKey: quote.key }], source: 'cli' })).rejects.toThrow();
  // 発注する→説明を書く→未解決→発注する は互いに待つ組になる。
  await setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: [{ projectId: 'hub', itemKey: doc.key }], source: 'cli' });
  await setItemBlocks(config, { projectId: 'hub', itemKey: doc.key, after: [{ projectId: 'hub', itemKey: open.key }], source: 'cli' });
  const error = await setItemBlocks(config, { projectId: 'hub', itemKey: open.key, after: [{ projectId: 'hub', itemKey: order.key }], source: 'cli' }).catch(e => e);
  expect((error as ItemBlocksError).reason.cause).toBe('cycle');
  await expect(setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: [{ projectId: 'hub', itemKey: doc.key }], source: 'cli' })).rejects.toThrow('既に同じ');
  // 片付いた項目の印は付けも外しもしない。
  await setItemResolution(config, { projectId: 'hub', itemKey: order.key, action: 'resolve', source: 'cli' });
  await expect(setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: null, source: 'cli' })).rejects.toThrow('解決済み');
});

test('先の項目には本人が追加したプロジェクト未定の行動も選べ、連絡待ちの項目は連絡待ちとして扱う', async () => {
  const { config, vault, order, doc } = await fixture();
  const added = await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-22T00:00:00Z', text: '銀行に電話する' });
  await rebuildDashboard(config, { now: clock });
  const action = (await readNowItems(vault, '_unassigned'))!.items.find(i => i.input_id === added.inputId)!;
  await setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: [{ projectId: '_unassigned', itemKey: action.key }], source: 'cli' });
  await setItemBlocks(config, { projectId: 'hub', itemKey: doc.key, after: [{ projectId: '_unassigned', itemKey: action.key }], source: 'cli' });
  await setItemWait(config, { projectId: 'hub', itemKey: doc.key, waiting: { since: '2026-11-20' }, source: 'cli', now: clock });
  await rebuildDashboard(config, { now: clock });
  const shown = await home(vault);
  expect(shown).toContain('## 先待ち（1件）');
  expect(shown).toContain('次の一手: 発注する（先に: 「銀行に電話する」（プロジェクト未定））');
  const waiting = shown.slice(shown.indexOf('## 連絡待ち'));
  expect(waiting).toContain('説明を書く');
});

test('受付から先に済ませることを付け外しでき、断った理由を本人向けの文で残す', async () => {
  const { config, vault, order, quote } = await fixture();
  expect(intakeFeatures(config).operations).toContain('item-blocks');
  expect(intakeFeatures(config).item_blocks).toEqual({ max: 3 });
  const fields = { operation: 'item-blocks', project_id: 'hub', item_key: order.key, after: [{ project_id: 'shop', item_key: quote.key }], confirmed: true };
  await packet(config, { ...fields, after: [] }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(2);
  const receipts = (await readIntakeReceipts(config)).filter(r => r.operation === 'item-blocks');
  expect(receipts.map(r => 'blocksId' in r.result && r.result.deduped)).toEqual(expect.arrayContaining([false, true]));
  expect(receipts.find(r => r.request_id === p.requestId)).toBeDefined();
  expect((await readItemBlocks(vault)).records).toHaveLength(1);
  const refused = await packet(config, { ...fields, item_key: quote.key, project_id: 'shop', after: [{ project_id: 'hub', item_key: order.key }] }, '');
  expect((await ingest(config)).rejected).toBe(1);
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(refused.path)}.json`))!));
  expect(error.reason).toEqual({ code: 'blocks-refused', cause: 'cycle' });
  expect(intakeErrorMessage(error)).toContain('互いに待つ');
  await packet(config, { ...fields, after: null }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === order.key)!.after).toBeUndefined();
  // 壊れた記録はHOMEとdoctorで示す。
  await vault.write('90_system/item-blocks/BLK-01JZZZZZZZZZZZZZZZZZZZZZZZ.json', '{');
  await rebuildDashboard(config, { now: clock });
  expect(await home(vault)).toContain('先に済ませることの記録が不正です');
  expect((await doctor(config)).issues.join('\n')).toContain('先に済ませることの記録が不正です');
});

test('同じ本文の新しい項目へ引き継ぎ、先の項目の本文が変わって見当たらなくなると待たずに付け直しを促す', async () => {
  const { config, vault, order, quote } = await fixture();
  await setItemBlocks(config, { projectId: 'hub', itemKey: order.key, after: [{ projectId: 'shop', itemKey: quote.key }], source: 'cli' });
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-11-22T00:00:00Z', receivedAt: '2026-11-22T00:00:00Z', text: '## 次の一手\n- [確認済み] 発注する\n- [確認済み] 説明を書き直す' });
  await capture(config, { source: 'file', kind: 'work-summary', project: 'shop', occurredAt: '2026-11-22T00:00:00Z', receivedAt: '2026-11-22T00:00:00Z', text: '## 次の一手\n- [確認済み] 見積もりを比べる' });
  await organize(config, new MockLlm());
  const again = (await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'next' && i.text === '発注する')!;
  expect(again.key).not.toBe(order.key);
  expect(again.after?.items.map(i => i.text)).toEqual(['見積もりを受け取る']);
  await rebuildDashboard(config, { now: clock });
  const shown = await home(vault);
  expect(shown).not.toContain('## 先待ち');
  expect(shown).toContain('次の一手: 発注する（先の項目が片付きました（「見積もりを受け取る」（発注）は見当たりません。付け直すか、印を外してください））');
});
