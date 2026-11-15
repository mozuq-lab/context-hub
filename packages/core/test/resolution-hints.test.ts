import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { MockLlm, validateOrganizeResult, groundResolutionHints, buildOrganizePrompt } from '../src/llm.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { dismissResolutionHint, readHintDismissals } from '../src/resolution-hints.js';
import type { OrganizeResult } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n## 未解決\n- 配布方法が決まっていない';
const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`;

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: at(1), receivedAt: at(1), text: summary });
  await organize(config, new MockLlm());
  return { config, vault };
}
async function memo(config: Awaited<ReturnType<typeof fixture>>['config'], text: string, day: number, project: string | null = 'hub') {
  const r = await capture(config, { source: 'cli', kind: 'memo', ...(project ? { project } : {}), occurredAt: at(day), receivedAt: at(day), text });
  await organize(config, new MockLlm());
  return r.inputId;
}
const nowText = async (vault: Awaited<ReturnType<typeof fixture>>['vault']) => (await vault.read('10_projects/hub/NOW.md'))!;
const base: OrganizeResult = { category: 'unclassified', summary: 'x', project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null };
const key = (n: number) => String(n).repeat(64);

test('モデルの候補は提示した参照名だけをキーへ対応付け、崩れた要素は整理全体を失敗にせず捨てる', () => {
  const items = [{ ref: 'i1', key: key(1), section: 'next' as const, text: 'A' }, { ref: 'i2', key: key(2), section: 'open' as const, text: 'B' }];
  const raw = JSON.stringify({ ...base, resolution_hints: [{ item: 'i1', quote: 'Aは済んだ' }, { item: 'i9', quote: 'x' }, { item: 'i2' }, 'bad', { item: 'i1', quote: '重複' }, { item: 'i2', quote: '  ' }, { item: key(2), quote: 'キーの直接指定' }] });
  expect(validateOrganizeResult(raw, [], 4000, items).resolution_hints).toEqual([{ item_key: key(1), quote: 'Aは済んだ' }]);
  // 項目を見せていないときは、モデルが返しても候補にしない。
  expect(validateOrganizeResult(raw, [], 4000).resolution_hints).toBeUndefined();
  expect(validateOrganizeResult(JSON.stringify({ ...base, resolution_hints: null }), [], 4000, items).resolution_hints).toBeUndefined();
  // 原文にそのまま含まれない引用は捨てる。
  const grounded = groundResolutionHints('昨日、Aは済んだ。', { ...base, resolution_hints: [{ item_key: key(1), quote: 'Aは済んだ' }, { item_key: key(2), quote: 'Bも終わった' }] });
  expect(grounded.resolution_hints).toEqual([{ item_key: key(1), quote: 'Aは済んだ' }]);
  expect(groundResolutionHints('無関係', grounded).resolution_hints).toBeUndefined();
  // 項目は引用データとして渡し、指示ではないことを明記する。
  const prompt = buildOrganizePrompt({ schema_version: 1, id: 'IN-01JZ0000000000000000000000', kind: 'memo', source: 'cli', source_event_id: 'e', occurred_at: at(1), received_at: at(1), origin: 'user-note', text: 't', path: 'p' }, [], false, undefined, items);
  expect(prompt).toContain('open_itemsは');
  expect(prompt).toContain('"open_items":[{"ref":"i1","section":"next","text":"A"}');
  expect(buildOrganizePrompt({ schema_version: 1, id: 'IN-01JZ0000000000000000000000', kind: 'memo', source: 'cli', source_event_id: 'e', occurred_at: at(1), received_at: at(1), origin: 'user-note', text: 't', path: 'p' }, [])).not.toContain('open_items');
});

test('本人がプロジェクトを指定したメモから「片付いたかも」を示し、完了にはしない', async () => {
  const { config, vault } = await fixture();
  const before = (await readNowItems(vault, 'hub'))!.items;
  const target = before.find(i => i.text === '利用者に見せる')!;
  const inputId = await memo(config, '今日のこと\n完了: 利用者に見せる\n感想は良かった', 3);
  const items = (await readNowItems(vault, 'hub'))!.items;
  const hinted = items.find(i => i.key === target.key)!;
  expect(hinted.resolution).toBeNull();
  expect(hinted.hints).toEqual([{ input_id: inputId, quote: '完了: 利用者に見せる', at: expect.any(String) }]);
  expect(items.filter(i => i.hints)).toHaveLength(1);
  const text = await nowText(vault);
  expect(text).toMatch(new RegExp(`# 片付いたかも（AI推定・本人の確認待ち）\\n[^\\n]+\\n- 次の一手: 利用者に見せる ← 「完了: 利用者に見せる」 \\[${inputId}\\]`));
  // 次の一手の欄には残る。
  expect(text.slice(text.indexOf('# 次の一手'), text.indexOf('## 提案'))).toContain('利用者に見せる');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('  - 利用者に見せる（片付いたかも・要確認）');
  // 本人が完了にすると候補は消え、解決済みへ移る。
  await setItemResolution(config, { projectId: 'hub', itemKey: target.key, action: 'resolve', source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === target.key)!.hints).toBeUndefined();
  expect(await nowText(vault)).not.toContain('# 片付いたかも');
  // 未解決に戻したら、戻す前の整理からの候補は再び出さない。
  await setItemResolution(config, { projectId: 'hub', itemKey: target.key, action: 'reopen', source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === target.key)!.hints).toBeUndefined();
  expect(await nowText(vault)).not.toContain('# 片付いたかも');
});

test('プロジェクトを指定していないメモや、項目と合わない記述からは示さない', async () => {
  const { config, vault } = await fixture();
  await memo(config, '集約ツール\n完了: 利用者に見せる', 3, null);
  await memo(config, '完了: 利用者に見せるかもしれない', 4);
  expect((await readNowItems(vault, 'hub'))!.items.some(i => i.hints)).toBe(false);
  expect(await nowText(vault)).not.toContain('# 片付いたかも');
});

test('訂正で記述を取り消すと候補も消える', async () => {
  const { config, vault } = await fixture();
  const inputId = await memo(config, '解決: 未解決: 配布方法が決まっていない', 3);
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'open')!.hints).toHaveLength(1);
  await correctInput(config, inputId, { source: 'cli-correction', text: '配布方法はまだ決めていない', occurredAt: at(4) });
  // 訂正が未反映の間も、取り消された記述を候補として示さない。
  const { rebuildNow } = await import('../src/views.js');
  await rebuildNow(config, 'hub');
  expect((await readNowItems(vault, 'hub'))!.items.some(i => i.hints)).toBe(false);
  await organize(config, new MockLlm());
  expect((await readNowItems(vault, 'hub'))!.items.some(i => i.hints)).toBe(false);
});

test('「違う」は受付ファイルで見送り、同じメモから同じ項目へは示さない', async () => {
  const { config, vault } = await fixture();
  const inputId = await memo(config, '完了: 名前を決める', 3);
  const target = (await readNowItems(vault, 'hub'))!.items.find(i => i.text === '名前を決める')!;
  expect(target.hints).toHaveLength(1);
  const fields = { operation: 'item-hint-dismiss', source: 'flutter', project_id: 'hub', item_key: target.key, input_id: inputId, confirmed: true };
  await packet(config, fields, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-hint-dismiss', result: { projectId: 'hub', itemKey: target.key, hintInputId: inputId, deduped: false } });
  const after = (await readNowItems(vault, 'hub'))!.items.find(i => i.key === target.key)!;
  expect(after.hints).toBeUndefined();
  expect(after.resolution).toBeNull();
  expect(await nowText(vault)).not.toContain('# 片付いたかも');
  // 同じ受付IDの再送と、別経路からの同じ見送りは記録を増やさない。
  const records = await readHintDismissals(vault);
  expect(await dismissResolutionHint(config, { projectId: 'hub', itemKey: target.key, inputId, source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, dismissalId: records[0]!.id });
  expect(await dismissResolutionHint(config, { projectId: 'hub', itemKey: target.key, inputId, source: 'cli' })).toMatchObject({ deduped: true });
  await expect(dismissResolutionHint(config, { projectId: 'hub', itemKey: target.key, inputId: 'IN-01JZ0000000000000000000000', source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の見送り');
  expect(await readHintDismissals(vault)).toHaveLength(1);
  // 示されていない組は見送れない。
  const other = (await readNowItems(vault, 'hub'))!.items.find(i => i.text === '利用者に見せる')!;
  await expect(dismissResolutionHint(config, { projectId: 'hub', itemKey: other.key, inputId, source: 'cli' })).rejects.toThrow('片付いたかも');
  // 別のメモが同じ項目に触れたら、改めて示す。
  const second = await memo(config, '完了: 名前を決める', 5);
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === target.key)!.hints).toEqual([expect.objectContaining({ input_id: second })]);
});
