import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { buildDigest } from '../src/digest.js';
import { itemKey, readItemResolutions, readNowItems, setItemResolution } from '../src/item-resolutions.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n## 未解決\n- 配布方法が決まっていない';

async function fixture(text = summary, occurredAt = '2026-10-30T00:00:00Z') {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const r = await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt, receivedAt: occurredAt, text });
  await organize(config, new MockLlm());
  return { config, vault, inputId: r.inputId };
}
const nowText = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('10_projects/hub/NOW.md'))!;
const section = (text: string, title: string) => { const i = text.indexOf(`# ${title}`), j = text.indexOf('\n# ', i + 1); return text.slice(i, j < 0 ? undefined : j); };

test('NOWの項目一覧を書き、完了・解決の報告で該当欄から外して再開で戻す', async () => {
  const { config, vault, inputId } = await fixture();
  const items = (await readNowItems(vault, 'hub'))!;
  expect(items.items.map(i => [i.section, i.label, i.text])).toEqual([
    ['next', '', '利用者に見せる'], ['next', '', '名前を決める'], ['open', '未解決: ', '配布方法が決まっていない'],
  ]);
  const next = items.items[0]!, open = items.items[2]!;
  expect(next.key).toBe(itemKey('hub', 'next', inputId, '利用者に見せる'));
  const done = await setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'resolve', source: 'cli' });
  expect(done).toMatchObject({ action: 'resolve', deduped: false });
  let text = await nowText(vault);
  expect(section(text, '次の一手')).not.toContain('利用者に見せる');
  expect(section(text, '次の一手')).toContain('名前を決める');
  expect(text).toMatch(new RegExp(`# 解決済み・完了（本人報告）\\n- 完了: 利用者に見せる \\[${inputId}\\][^\\n]+ ${done.resolutionId}`));
  expect((await readNowItems(vault, 'hub'))!.items[0]!.resolution).toMatchObject({ id: done.resolutionId, source: 'cli' });
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'resolve', source: 'cli' })).rejects.toThrow('既に解決済み');
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: open.key, action: 'reopen', source: 'cli' })).rejects.toThrow('解決済みではありません');
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: '0'.repeat(64), action: 'resolve', source: 'cli' })).rejects.toThrow('該当する項目がありません');
  await expect(setItemResolution(config, { projectId: 'missing', itemKey: next.key, action: 'resolve', source: 'cli' })).rejects.toThrow('見つかりません');
  // すべて解決すると欄は空と表示し、不明扱いにしない。
  await setItemResolution(config, { projectId: 'hub', itemKey: open.key, action: 'resolve', source: 'cli' });
  text = await nowText(vault);
  expect(section(text, '未解決')).toContain('残っている未解決はありません');
  expect(text).toContain('- 解決: 未解決: 配布方法が決まっていない');
  await setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'reopen', source: 'cli' });
  text = await nowText(vault);
  expect(section(text, '次の一手')).toContain('利用者に見せる');
  expect(text).not.toContain('- 完了: 利用者に見せる');
  expect((await readItemResolutions(vault)).map(r => r.action)).toEqual(['resolve', 'resolve', 'reopen']);
});

test('新しい作業要約で同じ本文が報告されたときは、別の項目として再び表示する', async () => {
  const { config, vault } = await fixture();
  const key = (await readNowItems(vault, 'hub'))!.items[0]!.key;
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'resolve', source: 'cli' });
  expect(section(await nowText(vault), '次の一手')).not.toContain('利用者に見せる');
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-10-31T00:00:00Z', receivedAt: '2026-10-31T00:00:00Z', text: '## 次の一手\n- [確認済み] 利用者に見せる' });
  await organize(config, new MockLlm());
  expect(section(await nowText(vault), '次の一手')).toContain('利用者に見せる');
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'next')!.key).not.toBe(key);
});

test('受付ファイルの解決報告を本人操作として反映し、同じ受付IDは重複させない', async () => {
  const { config, vault } = await fixture();
  const key = (await readNowItems(vault, 'hub'))!.items[2]!.key;
  const fields = { operation: 'item-resolution', source: 'flutter', project_id: 'hub', item_key: key, action: 'resolve', confirmed: true };
  await packet(config, { ...fields, confirmed: false }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-resolution', result: { projectId: 'hub', itemKey: key, action: 'resolve', deduped: false } });
  const records = await readItemResolutions(vault);
  expect(records).toMatchObject([{ id: (receipt.result as { resolutionId: string }).resolutionId, source: 'flutter', source_event_id: p.requestId, section: 'open' }]);
  expect(await nowText(vault)).toContain('- 解決: 未解決: 配布方法が決まっていない');
  // 記録後に受付記録を書く前に止まっても、同じ受付IDの再送は重複記録を作らない。
  expect(await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'resolve', source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, resolutionId: records[0]!.id });
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'reopen', source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の解決報告');
  expect(await readItemResolutions(vault)).toHaveLength(1);
});

test('ふりかえりは期間内の完了・解決を数え、解決済みを持ち越しの未解決から外す', async () => {
  const { config, vault } = await fixture(`${summary}\n- サーバーの置き場所`, '2026-10-01T00:00:00Z');
  const quiet = await buildDigest(config, { now: new Date(Date.now() + 60_000) });
  expect(quiet.slice(quiet.indexOf('## 動きのなかった進行中のプロジェクト'))).toContain('[集約ツール]');
  const items = (await readNowItems(vault, 'hub'))!.items;
  await setItemResolution(config, { projectId: 'hub', itemKey: items[2]!.key, action: 'resolve', source: 'cli' });
  await setItemResolution(config, { projectId: 'hub', itemKey: items[0]!.key, action: 'resolve', source: 'cli' });
  const text = await buildDigest(config, { now: new Date(Date.now() + 60_000) });
  const hub = text.slice(text.indexOf('### [集約ツール]'), text.indexOf('## 確認待ちの候補'));
  expect(hub).toContain('- 新しい入力: 0件');
  expect(hub).toMatch(/- 期間内に完了・解決と報告した項目: 2件\n {2}- 完了: 利用者に見せる（[^)]+RES-[^)]+）\n {2}- 解決: 配布方法が決まっていない/);
  expect(hub).toMatch(/期間より前からの未解決[^\n]*全1件）:\n {2}- サーバーの置き場所/);
  expect(hub).not.toContain('主な入力');
});
