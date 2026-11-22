import { afterEach, describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault, markdown } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { addProject } from '../src/projects.js';
import { readEffectiveInputs } from '../src/effective-inputs.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { UNASSIGNED_CLOSED_MAX, UNASSIGNED_HOME_MEMOS, UNASSIGNED_MEMOS_MAX, UNASSIGNED_SUGGESTIONS_PER_MEMO, buildUnassignedActions, unassignedActionsPath, unassignedActionsSchema, unassignedItemKey, unassignedItemsPath } from '../src/unassigned-actions.js';
import { parseIntake } from '../src/intake-format.js';
import { ItemTargetError, UNASSIGNED_SCOPE, nowItemsSchema, readItemResolutions, readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { addDays, completeOccurrence, readItemSchedules, setItemSchedule, todayIn } from '../src/item-schedules.js';
import { setItemEffort } from '../src/item-efforts.js';
import { buildDigest } from '../src/digest.js';
import { CALENDAR_PATH } from '../src/calendar.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { readInputs } from '../src/capture.js';
import { packet } from './workflow-fixtures.js';
import { moveAction } from '../src/action-moves.js';
import { setItemWait } from '../src/item-waits.js';
import type { LlmClient } from '../src/types.js';
import type { HubConfig, OrganizeResult } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-unassigned-')); roots.push(root);
  const config = defaultConfig(join(root, 'vault'), join(root, 'state')), vault = new Vault(config); await vault.init();
  config.organize.maxItemsPerRun = 100;
  return { config, vault };
}
const result = (extra: Partial<OrganizeResult> = {}): OrganizeResult => ({ category: 'unclassified', summary: 'AIの要約', project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null, ...extra });
/** メモを1件保存して、指定した整理結果で整理する。 */
async function memo(config: HubConfig, text: string, at: string, organized: OrganizeResult, extra: { project?: string } = {}): Promise<string> {
  const saved = await capture(config, { source: 'cli', occurredAt: at, text, ...extra });
  await organize(config, new MockLlm([organized]));
  return saved.inputId;
}
const actions = async (config: HubConfig) => buildUnassignedActions(config, await readEffectiveInputs(config), new Date('2026-11-10T00:00:00Z'));
const inbox = (id: string) => expect.stringMatching(new RegExp(`^00_inbox/[^/]+_${id}\\.md$`));

describe('プロジェクト未定の次の一手', () => {
  test('どのプロジェクトにも結び付いていないメモの、タスクの分類とAIの提案を新しい順に集める', async () => {
    const { config } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const task = await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    const suggested = await memo(config, '動画の作り方を見直したい', '2026-11-03T09:00:00+09:00', result({ category: 'idea', next_action_suggestions: ['手順を書き出す', '手順を書き出す', '詰まった所を3つ挙げる', '道具を比べる', '試作を1本作る'] }));
    const long = await memo(config, `${'長い作業メモ。'.repeat(20)}`, '2026-11-02T09:00:00+09:00', result({ category: 'task', summary: '長いメモの要約', next_action_suggestions: ['分ける'] }));
    // 対象外: 提案もタスクの分類もないメモ、本人がプロジェクトを指定したメモ、AIが帰属を推定したメモ。
    await memo(config, '思いつき', '2026-11-04T09:00:00+09:00', result({ category: 'idea' }));
    await memo(config, '集約ツールの画面を直す', '2026-11-05T09:00:00+09:00', result({ category: 'task', next_action_suggestions: ['直す'] }), { project: 'hub' });
    await memo(config, '同期の見直し', '2026-11-06T09:00:00+09:00', result({ category: 'task', project_candidates: [{ id: 'hub', confidence: 0.9 }], next_action_suggestions: ['見直す'] }));
    // 帰属の確信度が基準より低いメモは、未定として扱う。
    const weak = await memo(config, '関係が薄いメモ', '2026-10-30T09:00:00+09:00', result({ project_candidates: [{ id: 'hub', confidence: 0.3 }], next_action_suggestions: ['確かめる'] }));
    const built = await actions(config);
    expect(unassignedActionsSchema.parse(built)).toEqual(built);
    expect(built).toMatchObject({ schema_version: 1, generated_at: '2026-11-10T00:00:00.000Z', total_memos: 4 });
    expect(built.memos).toEqual([
      // 短いメモは本人の言葉を、長いメモはAIの要約を示す。同じ提案は1件にまとめる。
      { input_id: suggested, path: inbox(suggested), occurred_at: '2026-11-03T09:00:00+09:00', text: '動画の作り方を見直したい', own_words: true, task: false, suggestions: ['手順を書き出す', '詰まった所を3つ挙げる', '道具を比べる', '試作を1本作る'] },
      { input_id: long, path: inbox(long), occurred_at: '2026-11-02T09:00:00+09:00', text: '長いメモの要約', own_words: false, task: true, suggestions: ['分ける'] },
      { input_id: task, path: inbox(task), occurred_at: '2026-11-01T09:00:00+09:00', text: '講習の申込をする', own_words: true, task: true, suggestions: [] },
      { input_id: weak, path: inbox(weak), occurred_at: '2026-10-30T09:00:00+09:00', text: '関係が薄いメモ', own_words: true, task: false, suggestions: ['確かめる'] },
    ]);
  });

  test('整理に失敗したメモ・訂正の反映を待つメモは載せず、秘密情報らしい文字列は伏せる', async () => {
    const { config } = await setup();
    const corrected = await memo(config, '訂正前のタスク', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    await correctInput(config, corrected, { source: 'cli', occurredAt: '2026-11-02T09:00:00+09:00', text: 'やはり不要' });
    await capture(config, { source: 'cli', occurredAt: '2026-11-03T09:00:00+09:00', text: 'タスク: 失敗するメモ' });
    // 訂正と新しいメモの整理が、どちらも失敗する。
    expect(await organize(config, { complete: async () => { throw new Error('障害'); } })).toMatchObject({ failed: 2 });
    const secret = await memo(config, 'password=abcdef123456 を替える', '2026-11-04T09:00:00+09:00', result({ category: 'task' }));
    const built = await actions(config);
    expect(built.memos.map(m => m.input_id)).toEqual([secret]);
    expect(built.memos[0]!.text).toContain('[伏せ字:');
    expect(JSON.stringify(built)).not.toContain('abcdef123456');
  });

  test('一覧は新しい順に上限までを載せ、全体の件数を別に示す', async () => {
    const { config } = await setup();
    for (let i = 0; i < UNASSIGNED_MEMOS_MAX + 2; i++) await capture(config, { source: 'cli', occurredAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString(), text: `タスク: 作業${i}` });
    await organize(config, new MockLlm());
    const built = await actions(config);
    expect(built.total_memos).toBe(UNASSIGNED_MEMOS_MAX + 2);
    expect(built.memos).toHaveLength(UNASSIGNED_MEMOS_MAX);
    expect(built.memos[0]!.text).toBe(`タスク: 作業${UNASSIGNED_MEMOS_MAX + 1}`);
  });

  test('HOMEの生成で一覧を書き出し、内容が変わらなければ書き直さない', async () => {
    const { config, vault } = await setup();
    await rebuildDashboard(config);
    expect(unassignedActionsSchema.parse(JSON.parse((await vault.read(unassignedActionsPath))!))).toMatchObject({ total_memos: 0, memos: [] });
    expect(await vault.read('HOME.md')).not.toContain('プロジェクト未定の次の一手');
    const ids: string[] = [];
    for (let i = 0; i <= UNASSIGNED_HOME_MEMOS; i++) ids.push(await memo(config, `メモ${i}の本文`, `2026-11-0${i + 1}T09:00:00+09:00`, result({ category: i === 5 ? 'task' : 'idea', next_action_suggestions: [`提案${i}のA`, `提案${i}のB`, `提案${i}の[C]`, ...(i === 5 ? [`提案${i}のD`, `提案${i}のE`] : [])] })));
    await rebuildDashboard(config, { now: new Date('2026-11-10T00:00:00Z') });
    const first = (await vault.read(unassignedActionsPath))!;
    expect(JSON.parse(first)).toMatchObject({ generated_at: '2026-11-10T00:00:00.000Z', total_memos: 6 });
    expect(JSON.parse(first).memos[0].suggestions).toHaveLength(5);
    const home = (await vault.read('HOME.md'))!, section = home.split('## プロジェクト未定の次の一手')[1]!.split('\n## ')[0]!;
    expect(section).toMatch(/^（メモ6件）\n/);
    expect(section).toContain('AI生成・未検証');
    expect(section).toContain('新しい5件を載せます');
    // 新しい5件を、メモの本人の言葉と原文へのリンク、AIの提案とともに載せる。
    expect(section).toContain(`- 2026-11-06 メモ5の本文 — [${ids[5]}](00_inbox/`);
    // 提案はメモ1件につき上限までを載せ、残りは件数で示す。
    expect(UNASSIGNED_SUGGESTIONS_PER_MEMO).toBe(3);
    expect(section).toContain(' / タスク候補\n  - AI提案: 提案5のA\n  - AI提案: 提案5のB\n  - AI提案: 提案5の\\[C\\]\n  - ほかAI提案2件');
    expect(section).toContain(`[${ids[1]}]`);
    expect(section).not.toContain(`[${ids[0]}]`);
    await rebuildDashboard(config, { now: new Date('2026-11-11T00:00:00Z') });
    expect(await vault.read(unassignedActionsPath)).toBe(first);
    // 長いメモはAIの一行要約で示し、本人の言葉と区別できるよう印を付ける。
    const long = await memo(config, '長い作業メモ。'.repeat(20), '2026-11-08T09:00:00+09:00', result({ category: 'task', summary: '長いメモの要約' }));
    await rebuildDashboard(config, { now: new Date('2026-11-12T00:00:00Z') });
    expect(await vault.read('HOME.md')).toContain(`- 2026-11-08 AI要約: 長いメモの要約 — [${long}](00_inbox/`);
    expect(JSON.parse((await vault.read(unassignedActionsPath))!).memos[0]).toMatchObject({ input_id: long, own_words: false });
  });

  test('受信箱の下の階層にあるメモも載せ、一覧を書き直し続けない', async () => {
    const { config, vault } = await setup();
    const saved = await capture(config, { source: 'cli', occurredAt: '2026-11-01T09:00:00+09:00', text: '講習の申込をする' });
    // 年ごとのフォルダへ移した原文。
    const name = saved.path.split('/').at(-1)!;
    await mkdir(join(config.vaultPath, '00_inbox/2026'), { recursive: true });
    await rename(join(config.vaultPath, saved.path), join(config.vaultPath, '00_inbox/2026', name));
    await organize(config, new MockLlm([result({ category: 'task' })]));
    const built = await actions(config);
    expect(unassignedActionsSchema.parse(built)).toEqual(built);
    expect(built.memos).toMatchObject([{ input_id: saved.inputId, path: `00_inbox/2026/${name}` }]);
    await rebuildDashboard(config, { now: new Date('2026-11-10T00:00:00Z') });
    const first = (await vault.read(unassignedActionsPath))!;
    expect(unassignedActionsSchema.parse(JSON.parse(first)).memos).toHaveLength(1);
    expect(await vault.read('HOME.md')).toContain(`[${saved.inputId}](00_inbox/2026/${name})`);
    await rebuildDashboard(config, { now: new Date('2026-11-11T00:00:00Z') });
    expect(await vault.read(unassignedActionsPath)).toBe(first);
    // 空白や括弧を含むフォルダの原文へも、リンクが切れないように書く。
    const spaced = await capture(config, { source: 'cli', occurredAt: '2026-11-02T09:00:00+09:00', text: '会場を予約する' });
    const spacedName = spaced.path.split('/').at(-1)!;
    await mkdir(join(config.vaultPath, '00_inbox/2026 archive (old)'), { recursive: true });
    await rename(join(config.vaultPath, spaced.path), join(config.vaultPath, '00_inbox/2026 archive (old)', spacedName));
    await organize(config, new MockLlm([result({ category: 'task' })]));
    await rebuildDashboard(config, { now: new Date('2026-11-12T00:00:00Z') });
    expect(await vault.read('HOME.md')).toContain(`[${spaced.inputId}](<00_inbox/2026 archive (old)/${spacedName}>)`);
  });

  test('形式に合わないメモは一覧に載せず、一覧をいつも検証できる形に保つ', async () => {
    const { config } = await setup();
    await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    const units = await readEffectiveInputs(config);
    // 受信箱の外を指す原文のパス（通常は起きない）。
    const moved = units.map(u => ({ ...u, chain: { ...u.chain, root: { ...u.chain.root, path: '10_projects/x.md' } } }));
    const built = buildUnassignedActions(config, moved, new Date('2026-11-10T00:00:00Z'));
    expect(unassignedActionsSchema.parse(built)).toMatchObject({ total_memos: 0, memos: [] });
  });

  test('HOMEの行では、メモと提案に含まれるリンクやHTMLの記法を無効にする', async () => {
    const { config, vault } = await setup();
    await memo(config, '\\[資料\\](https://example.com/x) を読む', '2026-11-01T09:00:00+09:00', result({ category: 'task', next_action_suggestions: ['<img src=https://example.com/p.png> を確かめる', '`[手順](https://example.com/y)` を見る'] }));
    await rebuildDashboard(config);
    const section = (await vault.read('HOME.md'))!.split('## プロジェクト未定の次の一手')[1]!.split('\n## ')[0]!;
    // バックスラッシュで角括弧の無効化を打ち消せない。
    expect(section).toContain('- 2026-11-01 \\\\\\[資料\\\\\\](https://example.com/x) を読む — [IN-');
    expect(section).toContain('  - AI提案: &lt;img src=https://example.com/p.png> を確かめる');
    expect(section).toContain('  - AI提案: \\`\\[手順\\](https://example.com/y)\\` を見る');
    expect(section).not.toContain('<img');
  });

  test('長い本文は、無効化の記号の途中で切らない', async () => {
    const { config, vault } = await setup();
    const text = `${'あ'.repeat(119)}[x] の続き`;
    await memo(config, 'メモ', '2026-11-01T09:00:00+09:00', result({ category: 'task', next_action_suggestions: [text] }));
    await rebuildDashboard(config);
    expect(await vault.read('HOME.md')).toContain(`  - AI提案: ${'あ'.repeat(119)}\\[…\n`);
  });

  test('HOMEは次の一手とプロジェクト未定の次の一手を、プロジェクト一覧より前に置く', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    await rebuildDashboard(config);
    const home = (await vault.read('HOME.md'))!, order = ['## 次の一手（進行中のプロジェクト）', '## プロジェクト未定の次の一手', '## プロジェクト一覧', '## 確認待ち', '## 受領と整理状況', '## 失敗と競合'].map(h => home.indexOf(h));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('行ごとに項目キーを付け、完了・却下した行を一覧から外し、未解決へ戻すと戻す', async () => {
    const { config, vault } = await setup();
    const id = await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task', next_action_suggestions: ['日程を調べる', '費用を確かめる'] }));
    await rebuildDashboard(config, { now: new Date('2026-11-10T00:00:00Z') });
    const items = nowItemsSchema.parse(JSON.parse((await vault.read(unassignedItemsPath))!));
    expect(unassignedItemsPath).toBe('90_system/now-items/_unassigned.json');
    expect(items).toMatchObject({ project: UNASSIGNED_SCOPE, items: [
      { key: unassignedItemKey(id, '講習の申込をする'), section: 'next', label: '', text: '講習の申込をする', input_id: id, resolution: null },
      { key: unassignedItemKey(id, '日程を調べる'), label: 'AI提案: ', text: '日程を調べる', resolution: null },
      { key: unassignedItemKey(id, '費用を確かめる'), label: 'AI提案: ', text: '費用を確かめる', resolution: null },
    ] });
    // 提案を完了、メモの行を却下（もう古い）にする。却下は「もう古い」だけを受け付ける。
    await expect(setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: items.items[0]!.key, action: 'exclude', reason: 'misread', source: 'cli' })).rejects.toThrow('もう古い');
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: items.items[1]!.key, action: 'resolve', source: 'cli' });
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: items.items[0]!.key, action: 'exclude', reason: 'outdated', note: 'もう申し込んだ', source: 'cli' });
    // 記録の直後に一覧と項目一覧を作り直す（HOMEの作り直しを待たない）。
    expect(JSON.parse((await vault.read(unassignedActionsPath))!).memos).toEqual([expect.objectContaining({ input_id: id, task: false, suggestions: ['費用を確かめる'] })]);
    const after = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items;
    expect(after.map(i => [i.text, i.resolution?.action ?? (i.resolution ? 'resolve' : null)])).toEqual([['費用を確かめる', null], ['講習の申込をする', 'exclude'], ['日程を調べる', 'resolve']]);
    expect(after[1]!.resolution).toMatchObject({ reason: 'outdated', note: 'もう申し込んだ' });
    await expect(setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: items.items[1]!.key, action: 'resolve', source: 'cli' })).rejects.toBeInstanceOf(ItemTargetError);
    // 残りの行も片付けるとメモごと一覧から外れ、HOMEからも消える。
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: items.items[2]!.key, action: 'resolve', source: 'cli' });
    await rebuildDashboard(config, { now: new Date('2026-11-11T00:00:00Z') });
    expect(JSON.parse((await vault.read(unassignedActionsPath))!)).toMatchObject({ total_memos: 0, memos: [] });
    expect(await vault.read('HOME.md')).not.toContain('## プロジェクト未定の次の一手');
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items).toHaveLength(3);
    // 未解決へ戻すと、元の行へ戻る。
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: items.items[0]!.key, action: 'reopen', source: 'cli' });
    expect(JSON.parse((await vault.read(unassignedActionsPath))!).memos).toEqual([expect.objectContaining({ input_id: id, task: true, suggestions: [] })]);
    // 記録はプロジェクトの代わりに置き場を残す。期日は付けられない。
    expect((await readItemResolutions(vault)).every(r => r.project_id === UNASSIGNED_SCOPE)).toBe(true);
    await expect(setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: items.items[0]!.key, due: '2026-11-20', reviewAfter: null, source: 'cli' })).rejects.toThrow();
  });

  test('受付ファイルの形式で、プロジェクト未定の行の却下は「もう古い」だけに限る', () => {
    const id = 'REQ-' + 'B'.repeat(32), path = `Input/${id}.md`;
    const fields = { schema_version: 1, request_id: id, source: 'context-hub-flutter', occurred_at: '2026-11-16T10:00:00+09:00', operation: 'item-resolution', project_id: UNASSIGNED_SCOPE, item_key: 'a'.repeat(64), action: 'exclude', reason: 'outdated', confirmed: true };
    expect(parseIntake(path, markdown(fields, ''), 8000)).toMatchObject({ operation: 'item-resolution', project_id: UNASSIGNED_SCOPE });
    // 形式の段階で断り、受付を回復待ちのまま繰り返さない。
    expect(() => parseIntake(path, markdown({ ...fields, reason: 'misread' }, ''), 8000)).toThrow('もう古い');
    expect(parseIntake(path, markdown({ ...fields, project_id: 'context-hub', reason: 'misread' }, ''), 8000)).toMatchObject({ reason: 'misread' });
  });

  test('受付ファイルから完了・却下を受け付ける', async () => {
    const { config, vault } = await setup();
    const id = await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    await rebuildDashboard(config);
    const key = unassignedItemKey(id, '講習の申込をする');
    await packet(config, { operation: 'item-resolution', source: 'flutter', project_id: UNASSIGNED_SCOPE, item_key: key, action: 'exclude', reason: 'outdated', confirmed: true }, '');
    const run = await ingest(config);
    expect(run).toMatchObject({ accepted: 1 });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items[0]!.resolution).toMatchObject({ action: 'exclude', reason: 'outdated' });
    expect(JSON.parse((await vault.read('90_system/intake-features.json'))!).item_scopes).toEqual([UNASSIGNED_SCOPE]);
  });

  test('片付けた行は新しい報告から上限までを項目一覧に残す', async () => {
    const { config, vault } = await setup();
    const suggestions = Array.from({ length: 10 }, (_, i) => `提案${i}`);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await memo(config, `メモ${i}`, `2026-11-0${i + 1}T09:00:00+09:00`, result({ next_action_suggestions: suggestions })));
    await rebuildDashboard(config);
    for (const id of ids) for (const s of suggestions) await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: unassignedItemKey(id, s), action: 'resolve', source: 'cli' });
    const items = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items;
    expect(items).toHaveLength(UNASSIGNED_CLOSED_MAX);
    expect(items.every(i => i.resolution !== null)).toBe(true);
    expect(items[0]!.input_id).toBe(ids[3]);
  });
});

describe('プロジェクトを決めずに追加した行動', () => {
  const noModel: LlmClient = { complete: async () => { throw new Error('モデルは呼ばない'); } };
  const home = async (vault: Vault) => (await vault.read('HOME.md'))!.split('## プロジェクト未定の次の一手')[1]?.split('\n## ')[0];

  test('受付ファイルからプロジェクトなしで追加した行動は、モデルを呼ばずにプロジェクト未定の項目一覧の先頭とHOMEに載る', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const id = await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    await packet(config, { kind: 'action', source: 'flutter-mac' }, '牛乳を買う');
    expect(await ingest(config)).toMatchObject({ accepted: 1 });
    const [action] = (await readInputs(config)).filter(i => i.kind === 'action');
    expect(action).toMatchObject({ kind: 'action', text: '牛乳を買う' });
    expect(action!.project).toBeUndefined();
    expect((await readIntakeReceipts(config))[0]!.result).toMatchObject({ inputId: action!.id });
    // 保存した時点で（HOMEの作り直しを待たずに）項目一覧の先頭に載る。メモの一覧（旧版のアプリが読む形）には載せない。
    const items = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items;
    const key = unassignedItemKey(action!.id, '牛乳を買う');
    expect(items[0]).toEqual({ key, section: 'next', label: '本人が追加: ', text: '牛乳を買う', input_id: action!.id, resolution: null, action: {} });
    expect(items[1]).toMatchObject({ input_id: id, text: '講習の申込をする' });
    expect(JSON.parse((await vault.read(unassignedActionsPath))!).memos.map((m: { input_id: string }) => m.input_id)).toEqual([id]);
    // どのプロジェクトのNOWにも載らない。モデルは呼ばない。
    await organize(config, noModel);
    expect((await vault.read('10_projects/hub/NOW.md')) ?? '').not.toContain('牛乳を買う');
    await rebuildDashboard(config);
    const section = (await home(vault))!;
    expect(section).toMatch(/^（本人が追加した行動1件・メモ1件）/);
    expect(section).toContain(`- 本人が追加: 牛乳を買う — [${action!.id}](${action!.path})`);
    expect(section.indexOf('牛乳を買う')).toBeLessThan(section.indexOf('講習の申込をする'));
    expect(JSON.parse((await vault.read('90_system/intake-features.json'))!).action_scopes).toEqual([UNASSIGNED_SCOPE]);
  });

  test('完了・却下（もう古い）・未解決へ戻すが使え、片付けるとHOMEから外れる', async () => {
    const { config, vault } = await setup();
    const saved = await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-01T00:00:00Z', text: '歯医者を予約する' });
    const key = unassignedItemKey(saved.inputId, '歯医者を予約する');
    await rebuildDashboard(config);
    expect(await home(vault)).toContain('本人が追加: 歯医者を予約する');
    await expect(setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: key, action: 'exclude', reason: 'misread', source: 'cli' })).rejects.toThrow('もう古い');
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: key, action: 'resolve', source: 'cli' });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items).toEqual([expect.objectContaining({ key, action: {}, resolution: expect.objectContaining({ source: 'cli' }) })]);
    await rebuildDashboard(config);
    expect(await home(vault)).toBeUndefined();
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: key, action: 'reopen', source: 'cli' });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items).toEqual([expect.objectContaining({ key, resolution: null })]);
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: key, action: 'exclude', reason: 'outdated', source: 'cli' });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items[0]!.resolution).toMatchObject({ action: 'exclude', reason: 'outdated' });
  });

  test('文面を直すとすぐに一覧へ反映し、完了の報告は引き継がない', async () => {
    const { config, vault } = await setup();
    const saved = await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-01T00:00:00Z', text: '牛乳を買う' });
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: unassignedItemKey(saved.inputId, '牛乳を買う'), action: 'resolve', source: 'cli' });
    await correctInput(config, saved.inputId, { source: 'cli', occurredAt: '2026-11-02T00:00:00Z', text: '牛乳と卵を買う\n' });
    const items = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items;
    expect(items.map(i => [i.text, i.resolution === null])).toEqual([['牛乳と卵を買う', true]]);
    expect(items[0]!.key).toBe(unassignedItemKey(saved.inputId, '牛乳と卵を買う'));
  });

  test('多くのメモが届いても、本人が追加した行動は項目一覧から押し出さない', async () => {
    const { config } = await setup();
    const saved = await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-10-01T00:00:00Z', text: '古い行動' });
    const units = await readEffectiveInputs(config);
    // 整理済みのメモを上限より多く並べたものと同じ入力を作る（モデルは使わない）。
    const memoUnit = units[0]!;
    const many = Array.from({ length: 120 }, (_, i) => {
      const id = `IN-${String(i).padStart(26, '0')}`;
      const root = { ...memoUnit.chain.root, id, kind: 'memo' as const, project: undefined, text: `メモ${i}`, path: `00_inbox/2026-11-01_${id}.md`, occurred_at: '2026-11-01T00:00:00Z' };
      return { chain: { root, revisions: [], latest: root, evidenceHash: '' }, receipt: { input_id: id, status: 'organized', result: result({ category: 'task' }) } as never, pendingCorrection: false };
    });
    const { items } = (await import('../src/unassigned-actions.js')).buildUnassigned(config, [...units, ...many], new Date('2026-11-10T00:00:00Z'));
    expect(items.items[0]).toMatchObject({ input_id: saved.inputId, text: '古い行動', action: {} });
    expect(items.items).toHaveLength(101);
  });

  test('片付けた本人の行動は、片付けたAIの行の上限とは別に項目一覧へ残す', async () => {
    const { config } = await setup();
    const saved = await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-10-01T00:00:00Z', text: '古い行動' });
    const units = await readEffectiveInputs(config), memoUnit = units[0]!;
    const memos = Array.from({ length: 40 }, (_, i) => {
      const id = `IN-${String(i).padStart(26, '0')}`;
      const root = { ...memoUnit.chain.root, id, kind: 'memo' as const, project: undefined, text: `メモ${i}`, path: `00_inbox/2026-11-01_${id}.md`, occurred_at: '2026-11-01T00:00:00Z' };
      return { chain: { root, revisions: [], latest: root, evidenceHash: '' }, receipt: { input_id: id, status: 'organized', result: result({ category: 'task' }) } as never, pendingCorrection: false };
    });
    const at = (n: number) => `RES-${String(n).padStart(26, '0')}`;
    const resolution = (n: number, inputId: string, text: string) => ({ schema_version: 1 as const, id: at(n), project_id: UNASSIGNED_SCOPE, item_key: unassignedItemKey(inputId, text), section: 'next' as const, text, input_id: inputId, action: 'resolve' as const, source: 'cli', created_at: '2026-11-02T00:00:00Z' });
    // 本人の行動を最初に片付け、その後にAIの行を上限より多く片付ける。
    const resolutions = [resolution(1, saved.inputId, '古い行動'), ...memos.map((m, i) => resolution(i + 2, m.chain.root.id, m.chain.root.text))];
    const { items } = (await import('../src/unassigned-actions.js')).buildUnassigned(config, [...units, ...memos], new Date('2026-11-10T00:00:00Z'), resolutions);
    expect(items.items.filter(i => !i.action)).toHaveLength(UNASSIGNED_CLOSED_MAX);
    expect(items.items.find(i => i.action)).toMatchObject({ input_id: saved.inputId, resolution: expect.objectContaining({ id: at(1) }) });
  });

  test('プロジェクト未定のAIの行を行動にすると一覧から外し、プロジェクトのNOWの行もプロジェクトを決めない行動にできる', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const id = await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task', next_action_suggestions: ['日程を調べる', '費用を確かめる'] }));
    await rebuildDashboard(config);
    const taskKey = unassignedItemKey(id, '講習の申込をする');
    // メモの行は項目キー付きで、提案は直した文面でプロジェクトの行動にする。
    const own = await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-02T00:00:00Z', text: '講習の申込をする', meta: { action_from_input: id, action_from_text: '講習の申込をする', action_from_key: taskKey } });
    await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-02T01:00:00Z', text: '費用を確かめて予算に入れる', meta: { action_from_input: id, action_from_text: '費用を確かめる' } });
    const items = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items;
    expect(items.map(i => [i.label, i.text])).toEqual([['本人が追加: ', '講習の申込をする'], ['AI提案: ', '日程を調べる']]);
    expect(items[0]!.action).toEqual({ from: { input_id: id, text: '講習の申込をする', key: taskKey } });
    expect(items[0]!.input_id).toBe(own.inputId);
    expect(JSON.parse((await vault.read(unassignedActionsPath))!).memos).toEqual([expect.objectContaining({ input_id: id, task: false, suggestions: ['日程を調べる'] })]);
    expect((await vault.read('10_projects/hub/NOW.md'))!).toContain('本人が追加: 費用を確かめて予算に入れる');

    // プロジェクトのNOWの提案を、プロジェクトを決めない行動にする。元の行はプロジェクトのNOWから外れる。
    const hubMemo = await memo(config, '集約ツールの画面を直す', '2026-11-03T09:00:00+09:00', result({ category: 'idea', next_action_suggestions: ['色を決める'] }), { project: 'hub' });
    expect((await vault.read('10_projects/hub/NOW.md'))!).toContain('AI提案: 色を決める');
    await capture(config, { source: 'cli', kind: 'action', occurredAt: '2026-11-04T00:00:00Z', text: '色を決める', meta: { action_from_input: hubMemo, action_from_text: '色を決める' } });
    expect((await vault.read('10_projects/hub/NOW.md'))!).not.toContain('色を決める');
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.map(i => i.text)).toContain('色を決める');
    // 同じ受付IDの再送では保存せず、一覧の作り直しだけを行う。
    const again = { source: 'cli', sourceEventId: 'ev-1', kind: 'action' as const, occurredAt: '2026-11-05T00:00:00Z', text: '電池を買う' };
    const first = await capture(config, again);
    expect(await capture(config, again)).toMatchObject({ inputId: first.inputId, deduped: true });
    expect((await readInputs(config)).filter(i => i.kind === 'action')).toHaveLength(4);
  });
});

describe('プロジェクト未定の行動の期日と手間の目安', () => {
  const home = async (vault: Vault) => (await vault.read('HOME.md'))!;
  const unassignedSection = (text: string) => text.split('## プロジェクト未定の次の一手')[1]?.split('\n## ')[0];
  const action = async (config: HubConfig, text: string, at = '2026-11-01T00:00:00Z') => {
    const saved = await capture(config, { source: 'cli', kind: 'action', occurredAt: at, text });
    return { id: saved.inputId, key: unassignedItemKey(saved.inputId, text) };
  };

  test('本人が追加した行動に期日・見直す日・手間の目安を付けると、項目一覧に載り、期日が近いものはプロジェクトの項目と一緒にHOMEの期日の欄へ出る', async () => {
    const { config, vault } = await setup();
    const today = todayIn(config.timezone);
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const soon = await action(config, '歯医者を予約する'), later = await action(config, '本を返す'), resting = await action(config, '棚を片付ける'), plain = await action(config, '牛乳を買う');
    const work = await capture(config, { source: 'cli', kind: 'work-summary', project: 'hub', tool: 'codex', occurredAt: '2026-11-01T00:00:00Z', text: '## 次の一手\n- [確認済み] 説明を書く' });
    await organize(config, new MockLlm());
    const projectKey = (await readNowItems(vault, 'hub'))!.items.find(i => i.input_id === work.inputId)!.key;
    await setItemSchedule(config, { projectId: 'hub', itemKey: projectKey, due: addDays(today, 3), reviewAfter: null, source: 'cli' });
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: soon.key, due: addDays(today, 1), reviewAfter: null, source: 'cli' });
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: later.key, due: addDays(today, 30), reviewAfter: null, source: 'cli' });
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: resting.key, due: null, reviewAfter: addDays(today, 10), source: 'cli' });
    await setItemEffort(config, { projectId: UNASSIGNED_SCOPE, itemKey: soon.key, effort: 'quick', source: 'cli' });
    const items = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items;
    expect(items.find(i => i.key === soon.key)).toMatchObject({ schedule: { due: addDays(today, 1), review_after: null }, effort: 'quick' });
    expect(items.find(i => i.key === plain.key)!.schedule).toBeUndefined();
    await rebuildDashboard(config);
    const text = await home(vault), dated = text.split('### 7日以内')[1]!.split('### プロジェクトごと')[0]!;
    // 期日順に、プロジェクトの項目と並ぶ。
    expect(dated.indexOf('歯医者を予約する')).toBeGreaterThan(-1);
    expect(dated.indexOf('歯医者を予約する')).toBeLessThan(dated.indexOf('説明を書く'));
    expect(dated).toContain(`- 期日 ${addDays(today, 1)} — プロジェクト未定 次の一手: 本人が追加: 歯医者を予約する（手間 15分ほど）`);
    expect(text).toContain('見直す日まで休ませている項目: 1件');
    // プロジェクト未定の欄には、期日の欄へ出した行動を件数だけで示し、ほか（休ませている行動を含む）は日付付きで載せる。
    const section = unassignedSection(text)!;
    expect(section).toMatch(/^（本人が追加した行動4件）/);
    expect(section).not.toContain('歯医者を予約する');
    expect(section).toContain(`- 本人が追加: 棚を片付ける（見直す日 ${addDays(today, 10)}） — `);
    expect(section).toContain(`- 本人が追加: 本を返す（期日 ${addDays(today, 30)}） — `);
    expect(section).toContain('- 本人が追加: 牛乳を買う — ');
    expect(section).toContain('期日が近い行動1件は、「次の一手」の期日の欄で示します');
    expect(JSON.parse((await vault.read('90_system/intake-features.json'))!).item_record_scopes).toEqual([UNASSIGNED_SCOPE]);
    // 日付の付いた行があっても、内容が変わらなければ作り直しで書き換えない（端末は作成時刻で反映を判断する）。
    const before = await vault.read(unassignedItemsPath);
    await rebuildDashboard(config, { now: new Date('2030-01-01T00:00:00Z') });
    expect(await vault.read(unassignedItemsPath)).toBe(before);
  });

  test('進行中のプロジェクトがなくても、期日が近い行動はHOMEの期日の欄に出る', async () => {
    const { config, vault } = await setup();
    const today = todayIn(config.timezone), own = await action(config, '書類を出す');
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, due: today, reviewAfter: null, source: 'cli' });
    await rebuildDashboard(config);
    const text = await home(vault);
    expect(text.split('### 今日（1件）')[1]).toContain('プロジェクト未定 次の一手: 本人が追加: 書類を出す');
  });

  test('AIの行には付けられない。文面を直しても日付と手間の目安は同じ行動に残り、片付けると期日の欄から外れる', async () => {
    const { config, vault } = await setup();
    const id = await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    await rebuildDashboard(config);
    const aiKey = unassignedItemKey(id, '講習の申込をする');
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.map(i => i.key)).toContain(aiKey);
    await expect(setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: aiKey, due: '2026-12-01', reviewAfter: null, source: 'cli' })).rejects.toThrow('本人が追加した行動だけ');
    await expect(setItemEffort(config, { projectId: UNASSIGNED_SCOPE, itemKey: aiKey, effort: 'hour', source: 'cli' })).rejects.toThrow('本人が追加した行動だけ');
    const own = await action(config, '牛乳を買う');
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, due: '2026-12-01', reviewAfter: null, source: 'cli' });
    await setItemEffort(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, effort: 'hour', source: 'cli' });
    await correctInput(config, own.id, { source: 'cli', occurredAt: '2026-11-02T00:00:00Z', text: '牛乳と卵を買う' });
    const edited = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === own.id)!;
    expect(edited).toMatchObject({ text: '牛乳と卵を買う', schedule: { due: '2026-12-01' }, effort: 'hour' });
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: edited.key, action: 'resolve', source: 'cli' });
    const closed = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === own.id)!;
    expect(closed.schedule).toBeUndefined();
    await expect(setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: edited.key, due: '2026-12-02', reviewAfter: null, source: 'cli' })).rejects.toThrow('解決済み');
  });

  test('定例の繰り返しを付けた行動は、今回を完了にすると期日が次の回へ進む', async () => {
    const { config, vault } = await setup();
    const own = await action(config, 'ゴミを出す');
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, due: '2026-11-20', reviewAfter: null, repeat: { unit: 'week', every: 1 }, source: 'cli' });
    const result = await completeOccurrence(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, action: 'done', due: '2026-11-20', source: 'cli', now: new Date('2026-11-21T00:00:00Z') });
    expect(result).toMatchObject({ projectId: UNASSIGNED_SCOPE, nextDue: '2026-11-27' });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items[0]).toMatchObject({ resolution: null, schedule: { due: '2026-11-27', repeat: { unit: 'week', every: 1 } } });
  });

  test('受付ファイルからプロジェクト未定の行動へ期日・手間の目安・定例の回を依頼できる', async () => {
    const { config, vault } = await setup();
    const own = await action(config, 'ゴミを出す'), base = { source: 'flutter', project_id: UNASSIGNED_SCOPE, item_key: own.key, confirmed: true };
    await packet(config, { ...base, request_id: `REQ-${'1'.repeat(32)}`, operation: 'item-schedule', due: '2026-11-20', review_after: null, repeat: { unit: 'week', every: 1 } }, '');
    await packet(config, { ...base, request_id: `REQ-${'2'.repeat(32)}`, operation: 'item-effort', effort: 'quick' }, '');
    expect(await ingest(config)).toMatchObject({ accepted: 2 });
    await packet(config, { ...base, request_id: `REQ-${'3'.repeat(32)}`, operation: 'item-occurrence', action: 'skip', due: '2026-11-20' }, '');
    expect(await ingest(config)).toMatchObject({ accepted: 1 });
    expect((await readIntakeReceipts(config)).map(r => r.result)).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: UNASSIGNED_SCOPE, scheduleId: expect.any(String) }), expect.objectContaining({ projectId: UNASSIGNED_SCOPE, effortId: expect.any(String) }), expect.objectContaining({ projectId: UNASSIGNED_SCOPE, occurrenceId: expect.any(String) })]));
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items[0]).toMatchObject({ effort: 'quick', schedule: { repeat: { unit: 'week', every: 1 } } });
    expect((await readItemSchedules(vault)).records.every(r => r.project_id === UNASSIGNED_SCOPE)).toBe(true);
  });

  test('カレンダーの書き出しを有効にすると、プロジェクト未定の行動の期日も予定になる', async () => {
    const { config, vault } = await setup();
    config.calendar = { enabled: true, reviewDates: false, titles: 'item' };
    const own = await action(config, '書類を出す');
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, due: '2026-12-01', reviewAfter: null, source: 'cli' });
    await rebuildDashboard(config);
    const ics = (await vault.read(CALENDAR_PATH))!;
    expect(ics).toContain('SUMMARY:[期日] プロジェクト未定: 本人が追加: 書類を出す');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261201');
    expect(ics).toContain('プロジェクト: 未定');
  });

  test('ふりかえりに、残っている行動と期間内に追加・完了・却下した件数を載せる', async () => {
    const { config } = await setup();
    const now = new Date();
    const done = await action(config, '書類を出す', new Date(now.getTime() - 2 * 86_400_000).toISOString());
    const dropped = await action(config, '古い用事', new Date(now.getTime() - 2 * 86_400_000).toISOString());
    await action(config, '本を返す', new Date(now.getTime() - 86_400_000).toISOString());
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: done.key, action: 'resolve', source: 'cli' });
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: dropped.key, action: 'exclude', reason: 'outdated', source: 'cli' });
    const digest = await buildDigest(config);
    const section = digest.split('## プロジェクト未定の行動')[1]!.split('\n## ')[0]!;
    expect(section).toContain('- 残っている行動: 1件 / 期間内に追加 3件・完了 1件・却下 1件');
    expect(section).toContain('  - 完了: 書類を出す');
    expect(section).toMatch(/- 残っている行動（追加した順に最大5件）:\n {2}- 本を返す \[IN-/);
  });
});

describe('プロジェクト未定の行動をプロジェクトへ移す', () => {
  const action = async (config: HubConfig, text: string, at = '2026-11-01T00:00:00Z') => {
    const saved = await capture(config, { source: 'cli', kind: 'action', occurredAt: at, text });
    return { id: saved.inputId, key: unassignedItemKey(saved.inputId, text) };
  };
  const move = (config: HubConfig, from: string, itemKey: string, to: string, sourceEventId?: string) => moveAction(config, { from, itemKey, to, source: 'cli', sourceEventId, occurredAt: '2026-11-05T00:00:00Z' });

  test('移すと、期日・手間の目安・連絡待ちを写して元の一覧から外し、移した先の行動をもう一度移すと戻る', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const own = await action(config, '見積もりを頼む'), other = await action(config, '牛乳を買う');
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, due: '2026-12-01', reviewAfter: null, repeat: { unit: 'week', every: 2 }, source: 'cli' });
    await setItemEffort(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, effort: 'hour', source: 'cli' });
    await setItemWait(config, { projectId: UNASSIGNED_SCOPE, itemKey: own.key, waiting: { who: '業者', since: '2026-11-02' }, source: 'cli' });
    const moved = await move(config, UNASSIGNED_SCOPE, own.key, 'hub', 'move-1');
    expect(moved).toMatchObject({ projectId: 'hub', deduped: false });
    // 元の行動は、プロジェクト未定の一覧から外れる（片付けた行としても残さない）。ほかの行動は残る。
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.map(i => i.input_id)).toEqual([other.id]);
    // 移した先の行動は、元の行動を元の行として指し、付けていた記録を引き継ぐ。
    const item = (await readNowItems(vault, 'hub'))!.items.find(i => i.key === moved.itemKey)!;
    expect(item).toMatchObject({ text: '見積もりを頼む', input_id: moved.inputId, resolution: null, action: { from: { input_id: own.id, text: '見積もりを頼む', key: own.key } },
      schedule: { due: '2026-12-01', review_after: null, repeat: { unit: 'week', every: 2 } }, effort: 'hour', waiting: { since: '2026-11-02', who: '業者' } });
    expect((await vault.read('10_projects/hub/NOW.md'))!).toContain('本人が追加: 見積もりを頼む');
    // 写した元の記録は付け直しを求めない。
    await rebuildDashboard(config);
    expect((await vault.read('HOME.md'))!).not.toContain('日付を付け直す項目');
    // 同じ受付IDの再送は、元の行動が一覧から外れた後でも重複しない。
    expect(await move(config, UNASSIGNED_SCOPE, own.key, 'hub', 'move-1')).toMatchObject({ inputId: moved.inputId, itemKey: moved.itemKey, deduped: true });
    await expect(move(config, UNASSIGNED_SCOPE, other.key, 'hub', 'move-1')).rejects.toThrow('同じ受付IDで別の内容');
    // 元の行動の文面を後から直しても、プロジェクト未定へは戻らない。
    await correctInput(config, own.id, { source: 'cli', occurredAt: '2026-11-06T00:00:00Z', text: '見積もりを2社に頼む' });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.map(i => i.input_id)).toEqual([other.id]);
    // 戻すときは、移した先の行動をもう一度移す。記録も一緒に戻る。
    const back = await move(config, 'hub', moved.itemKey, UNASSIGNED_SCOPE);
    expect((await readNowItems(vault, 'hub'))!.items.some(i => i.input_id === moved.inputId)).toBe(false);
    expect((await vault.read('10_projects/hub/NOW.md'))!).not.toContain('見積もりを頼む');
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.key === back.itemKey)).toMatchObject({ input_id: back.inputId, schedule: { due: '2026-12-01' }, effort: 'hour', waiting: { who: '業者' } });
  });

  test('受付ファイルから、元の行動を指す行動の追加として移せる', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const own = await action(config, '見積もりを頼む');
    await packet(config, { kind: 'action', project: 'hub', source: 'flutter-mac', meta: { action_from_input: own.id, action_from_text: '見積もりを頼む', action_from_key: own.key } }, '見積もりを頼む');
    expect(await ingest(config)).toMatchObject({ accepted: 1 });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items).toEqual([]);
    expect((await readNowItems(vault, 'hub'))!.items.map(i => [i.text, i.action?.from?.input_id])).toEqual([['見積もりを頼む', own.id]]);
    await rebuildDashboard(config);
    expect(JSON.parse((await vault.read('90_system/intake-features.json'))!).action_moves).toBe(true);
  });

  test('片付けた行動・AIの行・同じ置き場・ないプロジェクト・統合済みのプロジェクトへは移さない', async () => {
    const { config } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    await addProject(config, { id: 'old', title: '古い集約ツール' });
    const { mergeProjects } = await import('../src/project-merges.js'), { hash } = await import('../src/storage.js'), { readFile } = await import('node:fs/promises');
    const projectHash = async (id: string) => hash(await readFile(join(config.vaultPath, `10_projects/${id}/project.md`), 'utf8'));
    await mergeProjects(config, { fromId: 'old', intoId: 'hub', fromHash: await projectHash('old'), intoHash: await projectHash('hub'), source: 'cli' });
    const done = await action(config, '書類を出す'), open = await action(config, '本を返す');
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: done.key, action: 'resolve', source: 'cli' });
    await expect(move(config, UNASSIGNED_SCOPE, done.key, 'hub')).rejects.toThrow('未解決へ戻してから');
    const memoId = await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    await rebuildDashboard(config);
    await expect(move(config, UNASSIGNED_SCOPE, unassignedItemKey(memoId, '講習の申込をする'), 'hub')).rejects.toThrow('本人が追加した行動');
    await expect(move(config, UNASSIGNED_SCOPE, open.key, UNASSIGNED_SCOPE)).rejects.toThrow('同じ');
    await expect(move(config, UNASSIGNED_SCOPE, open.key, 'none')).rejects.toThrow('移す先のプロジェクトがありません');
    await expect(move(config, UNASSIGNED_SCOPE, open.key, 'old')).rejects.toThrow();
    await expect(move(config, UNASSIGNED_SCOPE, 'f'.repeat(64), 'hub')).rejects.toThrow('該当する項目がありません');
  });

  test('ふりかえりでは、移した行動を残っている件数に数えず、期間内に移した件数を示す', async () => {
    const { config } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const now = new Date();
    const moved = await action(config, '見積もりを頼む', new Date(now.getTime() - 2 * 86_400_000).toISOString());
    await action(config, '本を返す', new Date(now.getTime() - 86_400_000).toISOString());
    await moveAction(config, { from: UNASSIGNED_SCOPE, itemKey: moved.key, to: 'hub', source: 'cli', occurredAt: now.toISOString() });
    const section = (await buildDigest(config)).split('## プロジェクト未定の行動')[1]!.split('\n## ')[0]!;
    expect(section).toContain('- 残っている行動: 1件 / 期間内に追加 2件・完了 0件・却下 0件・プロジェクトへ移した 1件');
    expect(section).not.toContain('見積もりを頼む');
  });

  test('文面を直す前の記録を付け直しに出さず、移した先の同じ本文の無関係な記録を拾わない', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    // プロジェクトの行動に期日を付けてから文面を直し、新しい期日を付けて、プロジェクト未定へ移す。
    const own = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-01T00:00:00Z', text: '見積もりを頼む' });
    const k1 = (await readNowItems(vault, 'hub'))!.items.find(i => i.input_id === own.inputId)!.key;
    await setItemSchedule(config, { projectId: 'hub', itemKey: k1, due: '2026-12-01', reviewAfter: null, source: 'cli' });
    await correctInput(config, own.inputId, { source: 'cli', occurredAt: '2026-11-02T00:00:00Z', text: '見積もりを2社に頼む' });
    const k2 = (await readNowItems(vault, 'hub'))!.items.find(i => i.input_id === own.inputId)!.key;
    await setItemSchedule(config, { projectId: 'hub', itemKey: k2, due: '2026-12-10', reviewAfter: null, source: 'cli' });
    const moved = await move(config, 'hub', k2, UNASSIGNED_SCOPE);
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.key === moved.itemKey)!.schedule).toMatchObject({ due: '2026-12-10' });
    await rebuildDashboard(config);
    expect((await vault.read('HOME.md'))!).not.toContain('日付を付け直す項目');
    // 移す先のプロジェクトに、同じ本文で外れた記録（別の行動の直す前の文面）があっても引き継がない。
    const other = await capture(config, { source: 'cli', kind: 'action', project: 'hub', occurredAt: '2026-11-03T00:00:00Z', text: '電話する' });
    const h1 = (await readNowItems(vault, 'hub'))!.items.find(i => i.input_id === other.inputId)!.key;
    await setItemSchedule(config, { projectId: 'hub', itemKey: h1, due: '2026-12-01', reviewAfter: null, source: 'cli' });
    await correctInput(config, other.inputId, { source: 'cli', occurredAt: '2026-11-04T00:00:00Z', text: '電話をかける' });
    const plain = await action(config, '電話する');
    const second = await move(config, UNASSIGNED_SCOPE, plain.key, 'hub');
    expect((await readNowItems(vault, 'hub'))!.items.find(i => i.key === second.itemKey)!.schedule).toBeNull();
  });

  test('受付ファイルでも、片付けた行動・既に移した行動は移さず、古いキーを指しても今の行から記録を写す', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const done = await action(config, '書類を出す');
    await setItemResolution(config, { projectId: UNASSIGNED_SCOPE, itemKey: done.key, action: 'resolve', source: 'cli' });
    const from = (id: string, text: string, key: string) => ({ action_from_input: id, action_from_text: text, action_from_key: key });
    await packet(config, { kind: 'action', project: 'hub', source: 'flutter-mac', meta: from(done.id, '書類を出す', done.key) }, '書類を出す');
    expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === done.id)!.resolution).not.toBeNull();
    // 文面を直す前のキーを指した依頼でも、今の行の期日を写す。
    const own = await action(config, '本を返す');
    await correctInput(config, own.id, { source: 'cli', occurredAt: '2026-11-02T00:00:00Z', text: '図書館に本を返す' });
    const current = (await readNowItems(vault, UNASSIGNED_SCOPE))!.items.find(i => i.input_id === own.id)!;
    await setItemSchedule(config, { projectId: UNASSIGNED_SCOPE, itemKey: current.key, due: '2026-12-05', reviewAfter: null, source: 'cli' });
    await packet(config, { kind: 'action', project: 'hub', source: 'flutter-mac', meta: from(own.id, '本を返す', own.key) }, '本を返す');
    expect(await ingest(config)).toMatchObject({ accepted: 1 });
    expect((await readNowItems(vault, 'hub'))!.items.find(i => i.action?.from?.input_id === own.id)!.schedule).toMatchObject({ due: '2026-12-05' });
    // 同じ行動をもう一度移す依頼は断る（行動が2つにならない）。
    await packet(config, { kind: 'action', source: 'flutter-mac', meta: from(own.id, '図書館に本を返す', current.key) }, '図書館に本を返す');
    expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await readInputs(config)).filter(i => i.kind === 'action' && i.meta?.action_from_input === own.id)).toHaveLength(1);
  });
});

