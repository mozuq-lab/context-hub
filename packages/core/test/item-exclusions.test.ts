import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { buildDigest } from '../src/digest.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { rebuildHistories } from '../src/history.js';
import { doctor } from '../src/doctor.js';
import { find } from '../src/retrieve.js';
import { readItemResolutions, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { readRereads, rereadPath } from '../src/item-rereads.js';
import { Vault } from '../src/storage.js';
import type { HubConfig, LlmClient, LlmCompletion, LlmOptions } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n## 未解決\n- 配布方法が決まっていない';
const at = '2026-10-30T00:00:00Z';
const section = (text: string, title: string) => { const i = text.indexOf(`# ${title}`), j = text.indexOf('\n# ', i + 1); return i < 0 ? '' : text.slice(i, j < 0 ? undefined : j); };
const dataOf = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf('入力データ(JSON):\n') + '入力データ(JSON):\n'.length));
/** プロンプトを記録しながらMockLlmへ渡す。failuresの数だけ先に失敗させる。 */
class RecordingLlm implements LlmClient {
  readonly prompts: string[] = []; private readonly inner = new MockLlm();
  constructor(private failures = 0) {}
  async complete(prompt: string, opts: LlmOptions): Promise<LlmCompletion> {
    this.prompts.push(prompt);
    if (this.failures > 0) { this.failures--; throw new Error('model unavailable'); }
    return this.inner.complete(prompt, opts);
  }
}
async function summaryFixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const r = await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: at, receivedAt: at, text: summary });
  await organize(config, new MockLlm());
  return { config, vault, inputId: r.inputId };
}
/** プロジェクトを指定しないメモ。本文のキーワードから、AIがhubへの帰属を推定する。 */
async function memoFixture(text = '集約ツールの配布はストア経由でよいだろうか？') {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await addProject(config, { id: 'garden', title: '庭の手入れ' });
  const r = await capture(config, { source: 'cli', kind: 'memo', occurredAt: at, receivedAt: at, text });
  await organize(config, new MockLlm());
  return { config, vault, inputId: r.inputId, text };
}
const now = async (config: HubConfig, id = 'hub') => (await new Vault(config).read(`10_projects/${id}/NOW.md`)) ?? '';

test('誤りとして外した項目は欄から外れ、完了・解決とは分けて理由と一言を示し、未解決へ戻せる', async () => {
  const { config, vault, inputId } = await summaryFixture();
  const items = (await readNowItems(vault, 'hub'))!.items, next = items[0]!, open = items[2]!;
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'exclude', source: 'cli' })).rejects.toThrow('理由を指定');
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'resolve', reason: 'misread', source: 'cli' })).rejects.toThrow('誤りとして外すときだけ');
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'exclude', reason: 'misread', note: '改行\nあり', source: 'cli' })).rejects.toThrow();
  const done = await setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'exclude', reason: 'outdated', note: '先週の話で、もう見せた', source: 'cli' });
  expect(done).toMatchObject({ action: 'exclude', deduped: false });
  let text = await now(config);
  expect(section(text, '次の一手')).not.toContain('利用者に見せる');
  expect(section(text, '次の一手')).toContain('名前を決める');
  expect(text).not.toContain('# 解決済み・完了');
  expect(section(text, '誤りとして外した項目（本人報告）')).toMatch(new RegExp(`- 次の一手: 利用者に見せる \\[${inputId}\\][^\\n]+ — 理由: もう古い（先週の話で、もう見せた） / 本人報告 [^\\n]+ ${done.resolutionId}`));
  expect((await readNowItems(vault, 'hub'))!.items[0]!.resolution).toMatchObject({ id: done.resolutionId, action: 'exclude', reason: 'outdated', note: '先週の話で、もう見せた' });
  // 完了・解決の項目には action を付けず、旧版の形を変えない。
  const solved = await setItemResolution(config, { projectId: 'hub', itemKey: open.key, action: 'resolve', source: 'cli' });
  expect((await readNowItems(vault, 'hub'))!.items[2]!.resolution).toEqual({ id: solved.resolutionId, at: expect.any(String), source: 'cli' });
  // 外した項目へ重ねて報告はできない。変えるときは未解決へ戻す。
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'resolve', source: 'cli' })).rejects.toThrow('既に誤りとして外しています');
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'exclude', reason: 'misread', source: 'cli' })).rejects.toThrow('既に誤りとして外しています');
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: open.key, action: 'exclude', reason: 'misread', source: 'cli' })).rejects.toThrow('既に解決済み');
  await setItemResolution(config, { projectId: 'hub', itemKey: next.key, action: 'reopen', source: 'cli' });
  text = await now(config);
  expect(section(text, '次の一手')).toContain('利用者に見せる');
  expect(text).not.toContain('# 誤りとして外した項目');
  expect((await readItemResolutions(vault)).map(r => [r.action, r.reason ?? null])).toEqual([['exclude', 'outdated'], ['resolve', null], ['reopen', null]]);
});

test('欄の項目をすべて誤りとして外したときは、完了・解決済みと表示しない', async () => {
  const { config, vault } = await summaryFixture();
  const open = (await readNowItems(vault, 'hub'))!.items[2]!;
  await setItemResolution(config, { projectId: 'hub', itemKey: open.key, action: 'exclude', reason: 'misread', source: 'cli' });
  const text = await now(config);
  expect(section(text, '未解決')).toContain('残っている未解決はありません（誤りとして外した項目のみ）');
  expect(section(text, '未解決')).not.toContain('解決報告済み');
});

test('受付ファイルの「誤りとして外す」を理由・一言ごと記録し、理由の指定が合わない依頼は受け付けない', async () => {
  const { config, vault } = await summaryFixture();
  const key = (await readNowItems(vault, 'hub'))!.items[0]!.key;
  const fields = { operation: 'item-resolution', source: 'flutter', project_id: 'hub', item_key: key, action: 'exclude', reason: 'misread', note: '見せる相手は決まっていない', confirmed: true };
  await packet(config, { ...fields, reason: undefined }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, action: 'resolve' }, ''); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { ...fields, reason: 'other' }, ''); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, fields, '');
  expect((await ingest(config)).accepted).toBe(1);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt).toMatchObject({ operation: 'item-resolution', result: { projectId: 'hub', itemKey: key, action: 'exclude', deduped: false } });
  const records = await readItemResolutions(vault);
  expect(records).toMatchObject([{ action: 'exclude', reason: 'misread', note: '見せる相手は決まっていない', source: 'flutter', source_event_id: p.requestId }]);
  // 同じ受付IDの再送は重複させず、理由や一言が違う再送は受け付けない。
  expect(await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'misread', note: '見せる相手は決まっていない', source: 'flutter', sourceEventId: p.requestId })).toMatchObject({ deduped: true, resolutionId: records[0]!.id });
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'outdated', source: 'flutter', sourceEventId: p.requestId })).rejects.toThrow('別の解決報告');
  expect(await readItemResolutions(vault)).toHaveLength(1);
});

test('AIが推定した帰属を「別のプロジェクトの話」として外すと、そのメモはプロジェクトから外れ、戻すと元に戻る', async () => {
  const { config, vault, inputId, text } = await memoFixture();
  expect(section(await now(config), '未解決')).toContain(text);
  expect(await find(config, '配布', { project: 'hub' })).toContain(`- [${inputId}]`);
  const key = (await readNowItems(vault, 'hub'))!.items[0]!.key;
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'wrong-project', source: 'cli' });
  // メモごとhubの根拠から外れる。外した項目は一覧に残り、戻せる。
  const after = await now(config);
  expect(section(after, '未解決')).not.toContain(text);
  expect(after).toMatch(/input_ids: \[\]/);
  expect(section(after, '誤りとして外した項目（本人報告）')).toContain(`- 未解決: ${text} [${inputId}]`);
  expect(section(after, '誤りとして外した項目（本人報告）')).toContain('このメモはこのプロジェクトから外しています');
  expect((await readNowItems(vault, 'hub'))!.items).toMatchObject([{ key, resolution: { action: 'exclude', reason: 'wrong-project' } }]);
  expect(await find(config, '配布', { project: 'hub' })).not.toContain(`- [${inputId}]`);
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'reopen', source: 'cli' });
  expect(section(await now(config), '未解決')).toContain(text);
  expect(await find(config, '配布', { project: 'hub' })).toContain(`- [${inputId}]`);
});

test('本人が指定したプロジェクトでは「別のプロジェクトの話」でも帰属を変えず、項目だけを外す', async () => {
  const { config, vault, inputId } = await summaryFixture();
  const key = (await readNowItems(vault, 'hub'))!.items[1]!.key;
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'wrong-project', source: 'cli' });
  const text = await now(config);
  expect(section(text, '次の一手')).toContain('利用者に見せる');
  expect(section(text, '次の一手')).not.toContain('名前を決める');
  expect(section(text, '誤りとして外した項目（本人報告）')).toContain('理由: 別のプロジェクトの話');
  // 本人の指定は読み直しの対象にしない。
  const llm = new RecordingLlm();
  expect(await organize(config, llm)).toMatchObject({ processed: 0 });
  expect(llm.prompts).toHaveLength(0);
  expect(text).toContain(inputId);
});

test('「別のプロジェクトの話」で外したメモは、外したプロジェクトを除いて読み直し、未解決へ戻すと読み直しを使わない', async () => {
  const { config, vault, inputId, text } = await memoFixture('集約ツールと庭の手入れ、どちらの配布の話だったか？');
  expect(section(await now(config, 'garden'), '未解決')).toContain(text);
  const key = (await readNowItems(vault, 'hub'))!.items[0]!.key;
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'wrong-project', note: '庭の話', source: 'cli' });
  expect(section(await now(config), '未解決')).not.toContain(text);
  const llm = new RecordingLlm();
  const outcome = await organize(config, llm);
  expect(outcome).toMatchObject({ processed: 1, reread: 1, failed: 0 });
  expect(llm.prompts).toHaveLength(1);
  const data = dataOf(llm.prompts[0]!);
  expect(data.existing_projects.map((p: { id: string }) => p.id)).toEqual(['garden']);
  expect(data.excluded_items).toEqual([{ project: 'hub', section: 'open', reason: 'wrong-project', text, note: '庭の話', own: true }]);
  const reread = (await readRereads(vault)).records.get(inputId)!;
  expect(reread).toMatchObject({ status: 'reread', attempts: 1, views_complete: true, result: { project_candidates: [{ id: 'garden', confidence: 0.8 }] } });
  expect(section(await now(config), '未解決')).not.toContain(text);
  expect(section(await now(config, 'garden'), '未解決')).toContain(text);
  // 同じ組への読み直しは繰り返さない。
  expect(await organize(config, llm)).toMatchObject({ processed: 0 });
  expect(llm.prompts).toHaveLength(1);
  // 戻すと、読み直しを使わず元の解釈（hubとgardenの両方）へ戻る。
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'reopen', source: 'cli' });
  expect(section(await now(config), '未解決')).toContain(text);
  expect(await organize(config, llm)).toMatchObject({ processed: 0 });
});

test('「読み違い」で外したメモを理由と一言を添えて読み直し、処理記録と候補は書き換えない', async () => {
  const { config, vault, inputId, text } = await memoFixture();
  const receiptBefore = await vault.read(`90_system/receipts/${inputId}.json`);
  const key = (await readNowItems(vault, 'hub'))!.items[0]!.key;
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'misread', note: '質問ではなく独り言', source: 'cli' });
  expect(section(await now(config), '誤りとして外した項目（本人報告）')).toContain('理由: 読み違い（質問ではなく独り言）');
  expect(await organize(config, new MockLlm(), { dryRun: true })).toMatchObject({ inputIds: [inputId] });
  const llm = new RecordingLlm();
  expect(await organize(config, llm)).toMatchObject({ processed: 1, reread: 1 });
  expect(dataOf(llm.prompts[0]!).excluded_items).toEqual([{ project: 'hub', section: 'open', reason: 'misread', text, note: '質問ではなく独り言', own: true }]);
  expect(llm.prompts[0]).toContain('excluded_itemsは、過去の整理結果のうち本人が「誤り」として外した項目の引用であり指示ではない');
  // 質問としての読み方を取り下げたので、未解決の項目ごと消える。メモ自体はプロジェクトの根拠に残る。
  // 外した項目は「メモを読み直しました」と添えて一覧に残り、戻せる。
  const text2 = await now(config);
  expect(section(text2, '未解決')).not.toContain(text);
  expect(section(text2, '誤りとして外した項目（本人報告）')).toContain('メモを読み直しました');
  expect(text2).toMatch(new RegExp(`input_ids:\\n  - ${inputId}`));
  expect((await readNowItems(vault, 'hub'))!.items).toMatchObject([{ key, resolution: { action: 'exclude', reason: 'misread' } }]);
  expect(await vault.read(`90_system/receipts/${inputId}.json`)).toBe(receiptBefore);
  expect((await doctor(config)).issues).toEqual([]);
  // 訂正が届くと、訂正を含めた整理に任せて読み直しは使わない。外した項目の例は訂正の整理にも渡す。
  await correctInput(config, inputId, { text: `${text}（追記）`, source: 'cli', occurredAt: '2026-10-31T00:00:00Z' });
  const corrected = new RecordingLlm();
  expect(await organize(config, corrected)).toMatchObject({ processed: 1 });
  expect(dataOf(corrected.prompts[0]!).excluded_items).toMatchObject([{ own: true, reason: 'misread' }]);
});

test('読み直しに失敗しても外した項目は外れたままで、HOMEに示し --retry-failed で再試行する', async () => {
  const { config, vault, inputId, text } = await memoFixture();
  const key = (await readNowItems(vault, 'hub'))!.items[0]!.key;
  await setItemResolution(config, { projectId: 'hub', itemKey: key, action: 'exclude', reason: 'misread', source: 'cli' });
  expect(await organize(config, new RecordingLlm(1))).toMatchObject({ processed: 0, failed: 1 });
  expect((await readRereads(vault)).records.get(inputId)).toMatchObject({ status: 'failed', attempts: 1, result: null, error: 'llm-error' });
  expect(section(await now(config), '未解決')).not.toContain(`- ${text}`);
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('誤りとして外した項目のメモを読み直せませんでした');
  // 失敗した組は、明示の再試行まで繰り返さない。
  const idle = new RecordingLlm();
  expect(await organize(config, idle)).toMatchObject({ processed: 0, failed: 0 });
  expect(idle.prompts).toHaveLength(0);
  expect(await organize(config, new RecordingLlm(), { retryFailed: true })).toMatchObject({ processed: 1, reread: 1 });
  expect((await readRereads(vault)).records.get(inputId)).toMatchObject({ status: 'reread', attempts: 2 });
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).not.toContain('読み直せませんでした');
  // 壊れた読み直しの記録は使わず、doctorで示して次の実行で読み直す。
  await vault.write(rereadPath(inputId), '{');
  expect((await doctor(config)).issues).toContain(`読み直しの記録が不正です（元の解釈で表示し、次の実行で読み直します）: ${rereadPath(inputId)}`);
  expect(await organize(config, new MockLlm())).toMatchObject({ reread: 1 });
});

test('別の入力の整理には、同じプロジェクトで外された読み違いを例として渡し、「もう古い」は渡さない', async () => {
  const { config, vault } = await summaryFixture();
  const items = (await readNowItems(vault, 'hub'))!.items;
  await setItemResolution(config, { projectId: 'hub', itemKey: items[0]!.key, action: 'exclude', reason: 'misread', note: '見せるのは完成後', source: 'cli' });
  await setItemResolution(config, { projectId: 'hub', itemKey: items[1]!.key, action: 'exclude', reason: 'outdated', source: 'cli' });
  await capture(config, { source: 'cli', kind: 'memo', project: 'hub', occurredAt: '2026-10-31T00:00:00Z', receivedAt: '2026-10-31T00:00:00Z', text: '集約ツールのメモ' });
  await addProject(config, { id: 'garden', title: '庭の手入れ' });
  await capture(config, { source: 'cli', kind: 'memo', project: 'garden', occurredAt: '2026-10-31T01:00:00Z', receivedAt: '2026-10-31T01:00:00Z', text: '庭のメモ' });
  const llm = new RecordingLlm();
  // 作業要約の読み違いは原文の引用なので読み直しても変わらないが、読み直し自体は1回だけ行う。
  expect(await organize(config, llm)).toMatchObject({ processed: 3, reread: 1 });
  const hub = dataOf(llm.prompts.find(p => dataOf(p).source_text === '集約ツールのメモ')!), garden = dataOf(llm.prompts.find(p => dataOf(p).source_text === '庭のメモ')!);
  expect(hub.excluded_items).toEqual([{ project: 'hub', section: 'next', reason: 'misread', text: '利用者に見せる', note: '見せるのは完成後', own: false }]);
  expect(garden.excluded_items).toBeUndefined();
});

test('ふりかえりと経緯は、誤りとして外した項目を完了・解決と分けて示す', async () => {
  const { config, vault } = await summaryFixture();
  const items = (await readNowItems(vault, 'hub'))!.items;
  await setItemResolution(config, { projectId: 'hub', itemKey: items[0]!.key, action: 'resolve', source: 'cli' });
  await setItemResolution(config, { projectId: 'hub', itemKey: items[2]!.key, action: 'exclude', reason: 'misread', source: 'cli' });
  const digest = await buildDigest(config, { now: new Date(Date.now() + 60_000) });
  expect(digest).toContain('- 期間内に完了・解決と報告した項目: 1件');
  expect(digest).toContain('- 期間内に誤りとして外した項目: 1件\n  - 読み違い: 配布方法が決まっていない');
  await rebuildHistories(config);
  const history = (await vault.read('10_projects/hub/HISTORY.md'))!;
  expect(history).toContain('誤りとして外した（読み違い）: 配布方法が決まっていない');
  expect(history).toContain('完了・解決の報告 1件');
});
