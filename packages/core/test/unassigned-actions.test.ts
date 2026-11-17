import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { addProject } from '../src/projects.js';
import { readEffectiveInputs } from '../src/effective-inputs.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { UNASSIGNED_HOME_MEMOS, UNASSIGNED_MEMOS_MAX, UNASSIGNED_SUGGESTIONS_PER_MEMO, buildUnassignedActions, unassignedActionsPath, unassignedActionsSchema } from '../src/unassigned-actions.js';
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

  test('HOMEは次の一手とプロジェクト未定の次の一手を、プロジェクト一覧より前に置く', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    await memo(config, '講習の申込をする', '2026-11-01T09:00:00+09:00', result({ category: 'task' }));
    await rebuildDashboard(config);
    const home = (await vault.read('HOME.md'))!, order = ['## 次の一手（進行中のプロジェクト）', '## プロジェクト未定の次の一手', '## プロジェクト一覧', '## 確認待ち', '## 受領と整理状況', '## 失敗と競合'].map(h => home.indexOf(h));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
