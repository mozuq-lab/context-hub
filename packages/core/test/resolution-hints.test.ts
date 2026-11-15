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
  const raw = JSON.stringify({ ...base, resolution_hints: [{ item: 'i1', quote: 'Aは済んだ' }, { item: 'i9', quote: 'x' }, { item: 'i2' }, 'bad', { item: 'i1', quote: '重複' }, { item: 'i2', quote: '  ' }, { item: 'i2', quote: '。' }, { item: 'i2', quote: '完了' }, { item: key(2), quote: 'キーの直接指定' }] });
  expect(validateOrganizeResult(raw, [], 4000, items).resolution_hints).toEqual([{ item_key: key(1), quote: 'Aは済んだ' }]);
  // 項目を見せていないときは、モデルが返しても候補にしない。
  expect(validateOrganizeResult(raw, [], 4000).resolution_hints).toBeUndefined();
  expect(validateOrganizeResult(JSON.stringify({ ...base, resolution_hints: null }), [], 4000, items).resolution_hints).toBeUndefined();
  // 形の崩れた候補の欄は、整理全体を失敗にしない。
  expect(validateOrganizeResult(JSON.stringify({ ...base, resolution_hints: { item: 'i1' } }), [], 4000, items).category).toBe('unclassified');
  expect(validateOrganizeResult(JSON.stringify({ ...base, resolution_hints: Array(80).fill('x') }), [], 4000, items).resolution_hints).toBeUndefined();
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
  expect(await nowText(vault)).toContain('- 未解決: 配布方法が決まっていない ← ');
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
  // 依頼の後に候補が消えていても（先に完了された等）、見送りは受け付けて記録する。
  const other = (await readNowItems(vault, 'hub'))!.items.find(i => i.text === '利用者に見せる')!;
  await setItemResolution(config, { projectId: 'hub', itemKey: other.key, action: 'resolve', source: 'cli' });
  const late = await packet(config, { ...fields, item_key: other.key }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readIntakeReceipts(config)).find(r => r.request_id === late.requestId)).toMatchObject({ result: { itemKey: other.key, deduped: false } });
  expect(await readHintDismissals(vault)).toHaveLength(2);
  // 別のメモが同じ項目に触れたら、改めて示す。
  const second = await memo(config, '完了: 名前を決める', 5);
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === target.key)!.hints).toEqual([expect.objectContaining({ input_id: second })]);
});

test('次の一手を先に、未解決は根拠が新しい順に30件までモデルへ見せ、メモより後の根拠の項目は見せない', async () => {
  const { config } = await fixture();
  for (const day of [2, 3]) await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: at(day), receivedAt: at(day), text: `## 次の一手\n- [確認済み] 利用者に見せる\n## 未解決\n${Array.from({ length: 20 }, (_, i) => `- 課題${day}-${i}`).join('\n')}` });
  await organize(config, new MockLlm());
  const prompts: string[] = [];
  const llm = { complete: async (prompt: string, opts: Parameters<MockLlm['complete']>[1]) => { prompts.push(prompt); return new MockLlm().complete(prompt, opts); } };
  await capture(config, { source: 'cli', kind: 'memo', project: 'hub', occurredAt: at(10), receivedAt: at(10), text: '完了: 利用者に見せる' });
  await organize(config, llm);
  const offered = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf('入力データ(JSON):\n') + '入力データ(JSON):\n'.length)).open_items as { section: string; text: string }[];
  expect(offered).toHaveLength(30);
  expect(offered[0]).toMatchObject({ section: 'next', text: '利用者に見せる' });
  expect(offered[1]!.text).toContain('課題3-');
  expect(offered.some(i => i.text.includes('課題2-'))).toBe(true);
  // メモより後の作業要約で挙がった項目は見せない。
  prompts.length = 0;
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: at(20), receivedAt: at(20), text: '## 次の一手\n- [確認済み] 新しい作業' });
  await organize(config, new MockLlm());
  await capture(config, { source: 'cli', kind: 'memo', project: 'hub', occurredAt: at(15), receivedAt: at(15), text: '完了: 新しい作業' });
  await organize(config, llm);
  const later = JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf('入力データ(JSON):\n') + '入力データ(JSON):\n'.length)).open_items as { text: string }[] | undefined;
  expect((later ?? []).some(i => i.text === '新しい作業')).toBe(false);
});

test('項目を足してプロンプトが上限を超えたら、項目なしで整理し直す', async () => {
  const { config, vault } = await fixture();
  const { PromptTooLargeError } = await import('../src/infer.js');
  const llm = { complete: async (prompt: string, opts: Parameters<MockLlm['complete']>[1]) => { if (prompt.includes('"open_items"')) throw new PromptTooLargeError(); return new MockLlm().complete(prompt, opts); } };
  const r = await capture(config, { source: 'cli', kind: 'memo', project: 'hub', occurredAt: at(3), receivedAt: at(3), text: '完了: 利用者に見せる' });
  expect((await organize(config, llm)).processed).toBe(1);
  const receipt = JSON.parse((await vault.read(`90_system/receipts/${r.inputId}.json`))!);
  expect(receipt).toMatchObject({ status: 'organized', error: null });
  expect(receipt.result.resolution_hints).toBeUndefined();
});

test('未解決に戻した後に整理したメモからは、改めて示す', async () => {
  const { config, vault } = await fixture();
  await memo(config, '完了: 利用者に見せる', 3);
  const target = (await readNowItems(vault, 'hub'))!.items.find(i => i.text === '利用者に見せる')!;
  await setItemResolution(config, { projectId: 'hub', itemKey: target.key, action: 'resolve', source: 'cli' });
  await setItemResolution(config, { projectId: 'hub', itemKey: target.key, action: 'reopen', source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === target.key)!.hints).toBeUndefined();
  const again = await memo(config, '今度こそ\n完了: 利用者に見せる', 4);
  expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === target.key)!.hints).toEqual([expect.objectContaining({ input_id: again })]);
});
