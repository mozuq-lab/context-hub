import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfig, loadConfig, validateConfig } from '../src/config.js';
import { Vault } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { runCycle } from '../src/cycle.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { rebuildDigest } from '../src/digest.js';
import { doctor } from '../src/doctor.js';
import { addProject } from '../src/projects.js';
import { previewSynthesis, readSynthesisRuns, runSynthesis, synthesisDir, synthesisLlmConfig, synthesisRunSchema, synthesisWarnings, SYNTHESIS_SLOW_MS, type SynthesisRun } from '../src/synthesis.js';
import { insightsPath, insightsSchema } from '../src/insights.js';
import { SYNTHESIS_HEAD_CHARS, SYNTHESIS_ITEMS_PER_SECTION } from '../src/synthesis-prompt.js';
import type { HubConfig, LlmClient, OrganizeResult } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup(synthesis: Partial<HubConfig['synthesis']> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-synthesis-')); roots.push(root);
  const config = defaultConfig(join(root, 'vault'), join(root, 'state')), vault = new Vault(config); await vault.init();
  config.organize.maxItemsPerRun = 200;
  config.synthesis = { ...config.synthesis, enabled: true, ...synthesis };
  return { root, config, vault };
}
const organized = (extra: Partial<OrganizeResult> = {}): OrganizeResult => ({ category: 'idea', summary: 'AIの要約', project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null, ...extra });
/** メモを1件保存して整理する。受信日時は、指定がなければ発生日時と同じにする。 */
async function memo(config: HubConfig, text: string, at: string, extra: { result?: Partial<OrganizeResult>; project?: string; receivedAt?: string } = {}): Promise<string> {
  const saved = await capture(config, { source: 'cli', occurredAt: at, receivedAt: extra.receivedAt ?? at, text, ...(extra.project ? { project: extra.project } : {}) });
  await organize(config, new MockLlm([organized(extra.result)]));
  return saved.inputId;
}
interface PayloadMemo { ref: string; date: string; new?: boolean; form: string; kind: string; category: string | null; project: string | null; text: string }
interface Payload { operation: string; mode: string; today: string; projects: { title: string; status: string }[]; previous: { section: string; text: string; refs: string[] }[]; memos: PayloadMemo[] }
const marker = '入力データ(JSON):\n';
const payloadOf = (prompt: string): Payload => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
type Sections = Partial<Record<'connections' | 'shifts' | 'stalled' | 'actions' | 'questions', unknown[]>>;
const answer = (sections: Sections) => JSON.stringify({ connections: [], shifts: [], stalled: [], actions: [], questions: [], ...sections });
/** プロンプトを記録し、渡されたメモの本文から参照名を引いて応答を作る偽のモデル。 */
function fake(reply: (ref: (text: string) => string, payload: Payload, call: number) => string | Error) {
  const prompts: string[] = [];
  const llm: LlmClient = { complete: async (prompt) => {
    prompts.push(prompt);
    const payload = payloadOf(prompt);
    const ref = (text: string) => { const found = payload.memos.find(m => m.text.includes(text)); if (!found) throw new Error(`テストのメモが渡されていません: ${text}`); return found.ref; };
    const out = reply(ref, payload, prompts.length);
    if (out instanceof Error) throw out;
    return { text: out, model: 'test/model-a' };
  } };
  return { llm, prompts };
}
const forbidden: LlmClient = { complete: async () => { throw new Error('モデルは呼ばれないはず'); } };
const at = (iso: string) => new Date(iso);
const runs = async (vault: Vault) => (await readSynthesisRuns(vault)).runs;
const view = async (vault: Vault) => insightsSchema.parse(JSON.parse((await vault.read(insightsPath))!));

describe('週次の統合', () => {
  test('既定では無効で、cycleは統合を実行せず、記録もHOMEの欄も作らない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctx-synthesis-')); roots.push(root);
    const config = defaultConfig(join(root, 'vault'), join(root, 'state')), vault = new Vault(config); await vault.init();
    expect(config.synthesis).toEqual({ enabled: false, intervalDays: 7, thinking: 'medium', timeoutSec: 150, maxFocusMemos: 30, maxContextMemos: 100, maxCalls: 1 });
    await capture(config, { source: 'cli', occurredAt: '2026-11-01T09:00:00+09:00', text: '動画の作り方を見直したい' });
    const result = await runCycle(config, new MockLlm(), {}, { synthesisLlm: forbidden });
    expect(result.synthesis).toBeUndefined();
    expect(await vault.files(synthesisDir)).toEqual([]);
    expect(await vault.read(insightsPath)).toBeUndefined();
    expect(await vault.read('HOME.md')).not.toContain('今週の気づき');
    expect(await vault.read('REVIEW.md')).not.toContain('今週の気づき');
    expect(await runSynthesis(config, forbidden)).toEqual({ ran: false, reason: 'disabled' });
  });

  test('初回はたまったメモを対象にし、根拠を確かめられた項目だけを記録・一覧・HOME・ふりかえりに出す', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'garden', title: '菜園づくり' });
    const a = await memo(config, '資格の講習に関心がある', '2026-11-03T09:00:00+09:00');
    const b = await memo(config, '資格の講習を受ける必要がある', '2026-11-10T09:00:00+09:00', { result: { category: 'task' } });
    const c = await memo(config, '菜園の土を調べたい', '2026-10-20T09:00:00+09:00', { project: 'garden' });
    const d = await memo(config, '動画の作り方を見直した', '2026-11-12T09:00:00+09:00');
    const { llm, prompts } = fake(ref => answer({
      connections: [
        { refs: [ref('関心がある'), ref('受ける必要がある')], text: '11/03の関心が、11/10には受ける必要へ進んでいるように見えます' },
        { refs: [ref('関心がある'), 'M99'], text: '存在しないメモを挙げた項目' },
      ],
      shifts: [{ refs: [ref('動画')], text: '根拠が1件しかない変化' }],
      stalled: [{ refs: [ref('土を調べたい')], text: '10/20の「調べたい」から続きが見当たりません。まだ調べますか', first_step: '土の種類を3つ書き出す' }],
      actions: [{ refs: [ref('受ける必要がある'), ref('関心がある')], text: '講習の日程と申込期限を確かめますか' }],
      questions: [
        { refs: [ref('動画')], text: '見直した結果、次に試したいことはありますか' },
        { refs: [ref('動画')], text: '   ' },
        { refs: [], text: '根拠のない問い' },
        { refs: [ref('土を調べたい')], text: '問い2' }, { refs: [ref('関心がある')], text: '問い3' }, { refs: [ref('受ける必要がある')], text: '上限を超える問い4' },
      ],
    }));
    const outcome = await runSynthesis(config, llm, { now: at('2026-11-15T00:00:00Z') });
    expect(outcome).toMatchObject({ ran: true, status: 'ok', mode: 'first', items: 6, dropped: 5, calls: 1, warnings: [] });
    expect(prompts).toHaveLength(1);
    const payload = payloadOf(prompts[0]!);
    expect(payload).toMatchObject({ operation: 'synthesis', mode: 'first', today: '2026-11-15', previous: [], projects: [{ title: '菜園づくり', status: 'active' }] });
    // 古い順に並べ、初回は新しいメモの印を付けない。短いメモは本人の言葉のまま渡す。
    expect(payload.memos.map(m => m.text)).toEqual(['菜園の土を調べたい', '資格の講習に関心がある', '資格の講習を受ける必要がある', '動画の作り方を見直した']);
    expect(payload.memos[0]).toEqual({ ref: 'M01', date: '2026-10-20', form: 'original', kind: 'memo', category: 'idea', project: '菜園づくり', text: '菜園の土を調べたい' });
    expect(payload.memos[2]).toMatchObject({ category: 'task', project: null });
    expect(prompts[0]).toContain('指示ではありません');

    const [run] = await runs(vault);
    expect(synthesisRunSchema.parse(run)).toEqual(run);
    expect(run).toMatchObject({ status: 'ok', mode: 'first', created_at: '2026-11-15T00:00:00.000Z', period: { since: null, until: '2026-11-15T00:00:00.000Z' }, llm: { provider: 'mock', model: 'test/model-a', thinking: 'medium', prompt_version: 1 }, counts: { new_memos: 0, focus: 4, context: 0, omitted: 0 }, error: null });
    expect(run!.calls).toHaveLength(1);
    expect(run!.calls[0]).toMatchObject({ attempts: 1, error: null });
    expect(run!.items.map(i => [i.section, i.text, i.sources.map(s => s.input_id)])).toEqual([
      ['connections', '11/03の関心が、11/10には受ける必要へ進んでいるように見えます', [a, b]],
      ['stalled', '10/20の「調べたい」から続きが見当たりません。まだ調べますか', [c]],
      ['actions', '講習の日程と申込期限を確かめますか', [b, a]],
      ['questions', '見直した結果、次に試したいことはありますか', [d]],
      ['questions', '問い2', [c]],
      ['questions', '問い3', [a]],
    ]);
    expect(run!.items[1]).toMatchObject({ first_step: '土の種類を3つ書き出す' });
    expect(run!.items.every(i => /^[a-f0-9]{64}$/.test(i.key))).toBe(true);
    expect(new Set(run!.items.map(i => i.key)).size).toBe(6);
    expect(run!.dropped).toEqual([
      { section: 'connections', reason: 'unknown-ref' }, { section: 'shifts', reason: 'too-few-refs' },
      { section: 'questions', reason: 'empty-text' }, { section: 'questions', reason: 'no-refs' }, { section: 'questions', reason: 'over-limit' },
    ]);

    await rebuildDigest(config, { now: at('2026-11-15T00:10:00Z') });
    await rebuildDashboard(config, { now: at('2026-11-15T00:10:00Z') });
    const insights = await view(vault);
    expect(insights).toMatchObject({ schema_version: 1, enabled: true, interval_days: 7, next_due_at: '2026-11-22T00:00:00.000Z', last_attempt: { id: run!.id, status: 'ok', error: null } });
    expect(insights.latest).toMatchObject({ id: run!.id, created_at: '2026-11-15T00:00:00.000Z', mode: 'first', counts: { new_memos: 0, focus: 4, context: 0, omitted: 0 } });
    expect(insights.latest!.items).toHaveLength(6);
    expect(insights.latest!.items[0]).toEqual({ key: run!.items[0]!.key, section: 'connections', text: '11/03の関心が、11/10には受ける必要へ進んでいるように見えます', sources: [
      { input_id: a, path: expect.stringMatching(new RegExp(`^00_inbox/2026-11-03_${a}\\.md$`)), occurred_at: '2026-11-03T09:00:00+09:00', corrected: false },
      { input_id: b, path: expect.stringMatching(new RegExp(`^00_inbox/2026-11-10_${b}\\.md$`)), occurred_at: '2026-11-10T09:00:00+09:00', corrected: false },
    ] });
    const home = (await vault.read('HOME.md'))!, review = (await vault.read('REVIEW.md'))!;
    for (const text of [home, review]) {
      expect(text).toContain('## 今週の気づき（AI生成・未検証）');
      expect(text).toContain('### つながり\n- 11/03の関心が、11/10には受ける必要へ進んでいるように見えます — 根拠: ');
      expect(text).toContain(`[2026-11-03のメモ](00_inbox/2026-11-03_${a}.md)、[2026-11-10のメモ](00_inbox/2026-11-10_${b}.md)`);
      expect(text).toContain('### 止まっている意図\n- 10/20の「調べたい」から続きが見当たりません。まだ調べますか（最初の一歩: 土の種類を3つ書き出す） — 根拠: ');
      expect(text).toContain('### 次の一手の提案\n- 講習の日程と申込期限を確かめますか');
      expect(text).toContain('### 問い\n- 見直した結果、次に試したいことはありますか');
      expect(text).not.toContain('存在しないメモ');
      expect(text).not.toContain('### 考えの変化');
    }
    // 気づきは、行動につながるほかの欄より前に置く。
    expect(home.indexOf('## 今週の気づき')).toBeLessThan(home.indexOf('## 次の一手（進行中のプロジェクト）'));
    expect(home.indexOf('## 今週の気づき')).toBeLessThan(home.indexOf('## プロジェクト一覧'));
    expect(review.indexOf('## 今週の気づき')).toBeLessThan(review.indexOf('## 概要'));
    // 同じ内容なら、一覧のファイルを書き直さない。
    const before = await vault.read(insightsPath);
    await rebuildDashboard(config, { now: at('2026-11-15T03:00:00Z') });
    expect(await vault.read(insightsPath)).toBe(before);
    expect((await doctor(config)).issues).toEqual([]);
  });

  test('間隔が空くまでは実行せず、次の回は新しく届いたメモを中心にして、前回と同じ項目を繰り返さない', async () => {
    const { config, vault } = await setup();
    const a = await memo(config, '資格の講習に関心がある', '2026-11-03T09:00:00+09:00');
    const b = await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const first = fake(ref => answer({ stalled: [{ refs: [ref('土を調べたい')], text: '土の件は続きが見当たりません' }], connections: [{ refs: [ref('関心がある'), ref('土を調べたい')], text: '前回のつながり' }] }));
    expect(await runSynthesis(config, first.llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', mode: 'first', items: 2 });
    // 3日後はまだ実行しない。
    expect(await runSynthesis(config, forbidden, { now: at('2026-11-11T00:00:00Z') })).toEqual({ ran: false, reason: 'not-due', nextDueAt: '2026-11-15T00:00:00.000Z' });
    const c = await memo(config, '資格の講習を受ける必要がある', '2026-11-10T09:00:00+09:00');
    const d = await memo(config, '講習の申込は月末まで', '2026-11-12T09:00:00+09:00');
    // 発生は古いが、前回の後に届いたメモも新しいメモとして扱う。
    const e = await memo(config, '出先で書いた土の覚え書き', '2026-11-01T09:00:00+09:00', { receivedAt: '2026-11-13T09:00:00+09:00' });
    const second = fake(ref => answer({
      connections: [
        { refs: [ref('関心がある'), ref('受ける必要がある')], text: '関心が必要へ進んだように見えます' },
        { refs: [ref('関心がある'), ref('土を調べたい')], text: '古いメモだけのつながり' },
      ],
      stalled: [
        { refs: [ref('土を調べたい')], text: '土の件は、言い方を変えただけの同じ指摘' },
        { refs: [ref('関心がある')], text: '古いメモだけでも、止まっている意図は出せる' },
      ],
      questions: [{ refs: [ref('土を調べたい')], text: '古いメモだけの問い' }, { refs: [ref('月末まで')], text: '申込はいつしますか' }],
    }));
    const outcome = await runSynthesis(config, second.llm, { now: at('2026-11-15T00:00:00Z') });
    expect(outcome).toMatchObject({ ran: true, status: 'ok', mode: 'weekly', items: 3, dropped: 3 });
    const payload = payloadOf(second.prompts[0]!);
    expect(payload.mode).toBe('weekly');
    expect(payload.memos.map(m => [m.text, m.new])).toEqual([
      ['出先で書いた土の覚え書き', true], ['資格の講習に関心がある', false], ['菜園の土を調べたい', false], ['資格の講習を受ける必要がある', true], ['講習の申込は月末まで', true],
    ]);
    // 新しいメモは全文、それ以前のメモは1行にして渡す。
    expect(payload.memos.map(m => m.form)).toEqual(['original', 'head', 'head', 'original', 'original']);
    // 前回示した項目を渡し、繰り返さないよう伝える。
    expect(payload.previous).toEqual([
      { section: 'connections', text: '前回のつながり', refs: ['M02', 'M03'] },
      { section: 'stalled', text: '土の件は続きが見当たりません', refs: ['M03'] },
    ]);
    const all = await runs(vault), run = all[1]!;
    expect(all).toHaveLength(2);
    expect(run).toMatchObject({ mode: 'weekly', period: { since: '2026-11-08T00:00:00.000Z', until: '2026-11-15T00:00:00.000Z' }, counts: { new_memos: 3, focus: 3, context: 2, omitted: 0 } });
    expect(run.items.map(i => [i.section, i.sources.map(s => s.input_id)])).toEqual([['connections', [a, c]], ['stalled', [a]], ['questions', [d]]]);
    expect(run.dropped).toEqual([{ section: 'connections', reason: 'no-new-memo' }, { section: 'stalled', reason: 'repeated' }, { section: 'questions', reason: 'no-new-memo' }]);
    expect([b, e].every(id => !run.items.some(i => i.sources.some(s => s.input_id === id)))).toBe(true);
  });

  test('前回から新しい入力がなければ、モデルを呼ばず前回の気づきを出したままにする', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const first = fake(ref => answer({ stalled: [{ refs: [ref('土')], text: '土の件は続きが見当たりません' }] }));
    await runSynthesis(config, first.llm, { now: at('2026-11-08T00:00:00Z') });
    expect(await runSynthesis(config, forbidden, { now: at('2026-11-20T00:00:00Z') })).toEqual({ ran: false, reason: 'no-new-input' });
    expect(await runs(vault)).toHaveLength(1);
    await rebuildDashboard(config, { now: at('2026-11-20T00:00:00Z') });
    const home = (await vault.read('HOME.md'))!;
    expect(home).toContain('土の件は続きが見当たりません');
    // 古い結果には、何日前のものかを添える。
    expect(home).toContain('12日前');
    // 本人が明示したときは、新しい入力がなくても実行する。
    const forced = fake(() => answer({}));
    expect(await runSynthesis(config, forced.llm, { now: at('2026-11-20T00:00:00Z'), force: true })).toMatchObject({ ran: true, status: 'empty', mode: 'quiet', items: 0 });
    // 足せる気づきがなかった回の後は、欄を出さない。
    await rebuildDashboard(config, { now: at('2026-11-20T01:00:00Z') });
    expect(await vault.read('HOME.md')).not.toContain('今週の気づき');
    expect((await view(vault)).latest).toMatchObject({ mode: 'quiet', items: [] });
  });

  test('メモが1件もなければ実行しない', async () => {
    const { config, vault } = await setup();
    expect(await runSynthesis(config, forbidden, { now: at('2026-11-08T00:00:00Z') })).toEqual({ ran: false, reason: 'no-memos' });
    expect(await runs(vault)).toEqual([]);
  });

  test('新しいメモが少ない週は、以前のメモの見直しに切り替える', async () => {
    const { config, vault } = await setup();
    const old = await memo(config, '菜園の土を調べたい', '2026-10-01T09:00:00+09:00');
    await memo(config, '資格の講習に関心がある', '2026-10-03T09:00:00+09:00');
    await runSynthesis(config, fake(() => answer({})).llm, { now: at('2026-10-10T00:00:00Z') });
    const fresh = await memo(config, '久しぶりのメモ', '2026-11-05T09:00:00+09:00');
    const quiet = fake(ref => answer({ questions: [{ refs: [ref('土を調べたい')], text: '10/01のこのメモ、今はどう考えますか' }], connections: [{ refs: [ref('土を調べたい'), ref('関心がある')], text: '以前のメモ同士のつながり' }] }));
    expect(await runSynthesis(config, quiet.llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', mode: 'quiet', items: 2, dropped: 0 });
    const payload = payloadOf(quiet.prompts[0]!);
    expect(payload.mode).toBe('quiet');
    // 以前のメモも全文で渡し、見直しの対象にする。
    expect(payload.memos.map(m => [m.text, m.new, m.form])).toEqual([['菜園の土を調べたい', false, 'original'], ['資格の講習に関心がある', false, 'original'], ['久しぶりのメモ', true, 'original']]);
    expect(quiet.prompts[0]).toContain('今はどう考えますか');
    const run = (await runs(vault))[1]!;
    expect(run.counts).toEqual({ new_memos: 1, focus: 3, context: 0, omitted: 0 });
    expect(run.items[1]!.sources).toEqual([{ input_id: old, latest_id: old }]);
    expect(run.items.some(i => i.sources.some(s => s.input_id === fresh))).toBe(false);
  });

  test('形式が崩れた応答は1回だけ作り直させ、2回続けば失敗として記録して、次の間隔まで自動では実行しない', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    // コードブロックで囲んだ応答は読み取る。1回目が読めなければ、理由を添えて1回だけ作り直させる。
    const recovered = fake((ref, _payload, call) => call === 1 ? 'すみません、うまく作れませんでした' : '```json\n' + answer({ stalled: [{ refs: [ref('土')], text: '続きが見当たりません' }] }) + '\n```');
    expect(await runSynthesis(config, recovered.llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', items: 1, calls: 1 });
    expect(recovered.prompts).toHaveLength(2);
    expect(recovered.prompts[0]).not.toContain('前回の応答は形式不正');
    expect(recovered.prompts[1]).toContain('前回の応答は形式不正');
    expect((await runs(vault))[0]!.calls[0]).toMatchObject({ attempts: 2, error: null });

    await memo(config, '資格の講習に関心がある', '2026-11-10T09:00:00+09:00');
    const broken = fake(() => '{"connections": "配列ではない"}');
    expect(await runSynthesis(config, broken.llm, { now: at('2026-11-15T00:00:00Z') })).toMatchObject({ ran: true, status: 'failed', error: 'invalid-output', items: 0 });
    expect(broken.prompts).toHaveLength(2);
    const failed = (await runs(vault))[1]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'invalid-output', items: [] });
    expect(failed.calls[0]).toMatchObject({ attempts: 2, error: 'invalid-output' });
    // 失敗の後は、次の間隔まで自動では実行しない。
    expect(await runSynthesis(config, forbidden, { now: at('2026-11-16T00:00:00Z') })).toEqual({ ran: false, reason: 'not-due', nextDueAt: '2026-11-22T00:00:00.000Z' });
    // HOMEには前回の気づきを出したまま、失敗とやり直し方を示す。
    await rebuildDashboard(config, { now: at('2026-11-16T00:00:00Z') });
    const home = (await vault.read('HOME.md'))!;
    expect(home).toContain('続きが見当たりません');
    expect(home).toMatch(/## 失敗と競合\n[\s\S]*週次の統合に失敗しました（応答の形式が不正）[^\n]*ctx cycle --retry-failed/);
    expect(await view(vault)).toMatchObject({ last_attempt: { id: failed.id, status: 'failed', error: 'invalid-output' }, latest: { items: [{ text: '続きが見当たりません' }] }, next_due_at: '2026-11-22T00:00:00.000Z' });
    // 失敗分の再試行を明示すると、間隔を待たずにやり直す（3回まで）。
    const retry = fake(() => new Error('障害'));
    expect(await runSynthesis(config, retry.llm, { now: at('2026-11-16T00:00:00Z'), retryFailed: true })).toMatchObject({ ran: true, status: 'failed', error: 'llm-error' });
    expect(await runSynthesis(config, retry.llm, { now: at('2026-11-16T01:00:00Z'), retryFailed: true })).toMatchObject({ ran: true, status: 'failed', error: 'llm-error' });
    expect(await runSynthesis(config, forbidden, { now: at('2026-11-16T02:00:00Z'), retryFailed: true })).toMatchObject({ ran: false, reason: 'not-due' });
    // 最後の試行から間隔が空けば、自動でもう一度実行する。
    const later = fake(ref => answer({ questions: [{ refs: [ref('関心がある')], text: '講習はいつ受けますか' }] }));
    expect(await runSynthesis(config, later.llm, { now: at('2026-11-23T01:00:00Z') })).toMatchObject({ ran: true, status: 'ok', mode: 'quiet', items: 1 });
    // 失敗した回は基準にせず、最後に成功した回の後に届いたメモを新しいメモとして扱う。
    expect(payloadOf(later.prompts[0]!).memos.map(m => m.new)).toEqual([false, true]);
  });

  test('時間切れは失敗として記録し、所要時間を残す', async () => {
    const { config, vault } = await setup({ timeoutSec: 1 });
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const slow: LlmClient = { complete: () => new Promise(done => setTimeout(() => done({ text: answer({}) }), 3000)) };
    expect(await runSynthesis(config, slow, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'failed', error: 'timeout' });
    const run = (await runs(vault))[0]!;
    expect(run.calls[0]).toMatchObject({ attempts: 1, error: 'timeout' });
    expect(run.calls[0]!.elapsed_ms).toBeGreaterThanOrEqual(900);
    await rebuildDashboard(config, { now: at('2026-11-08T00:00:00Z') });
    expect(await vault.read('HOME.md')).toMatch(/週次の統合に失敗しました（応答待ちの時間切れ）/);
  }, 15000);

  test('モデルを呼ぶ前に実行の開始を記録し、途中で止められた実行も1回として数えて呼び出しを重ねない', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    let during: SynthesisRun[] = [];
    const watching: LlmClient = { complete: async () => { during = await runs(vault); return { text: answer({}) }; } };
    await runSynthesis(config, watching, { now: at('2026-11-08T00:00:00Z') });
    // モデルを待つ間は、開始の記録（途中で止まった扱い）だけがある。終わると同じ記録を結果で置き換える。
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ status: 'failed', error: 'interrupted', mode: 'first', calls: [], items: [], counts: { focus: 1 } });
    const done = await runs(vault);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: during[0]!.id, status: 'empty', error: null });
    // ジョブの制限時間や再起動で止められると、開始の記録だけが残る。
    await memo(config, '資格の講習に関心がある', '2026-11-10T09:00:00+09:00');
    const stopped: SynthesisRun = { ...during[0]!, id: 'SYN-01M8ABCDEFGHJKMNPQRSTVWXYZ', created_at: '2026-11-15T00:00:00.000Z', mode: 'quiet', period: { since: '2026-11-08T00:00:00.000Z', until: '2026-11-15T00:00:00.000Z' } };
    await vault.write(`${synthesisDir}/${stopped.id}.json`, JSON.stringify(stopped, null, 2) + '\n');
    // 始まった直後は実行中かもしれないので、失敗とは示さない。
    await rebuildDashboard(config, { now: at('2026-11-15T00:01:00Z') });
    expect(await vault.read('HOME.md')).not.toContain('週次の統合に失敗しました');
    expect((await view(vault)).last_attempt).toMatchObject({ id: stopped.id, status: 'running', error: null });
    // 時間が過ぎても結果がなければ失敗として示し、次の間隔まで自動では実行しない。
    expect(await runSynthesis(config, forbidden, { now: at('2026-11-15T01:00:00Z') })).toEqual({ ran: false, reason: 'not-due', nextDueAt: '2026-11-22T00:00:00.000Z' });
    await rebuildDashboard(config, { now: at('2026-11-15T01:00:00Z') });
    expect(await vault.read('HOME.md')).toMatch(/週次の統合に失敗しました（実行が途中で止まった）[^\n]*ctx cycle --retry-failed/);
    expect((await view(vault)).last_attempt).toMatchObject({ id: stopped.id, status: 'failed', error: 'interrupted' });
    const retried = fake(() => answer({}));
    expect(await runSynthesis(config, retried.llm, { now: at('2026-11-15T02:00:00Z'), retryFailed: true })).toMatchObject({ ran: true, status: 'empty' });
  });

  test('時間の上限は実行全体に掛け、残りが少なければ作り直しや次の呼び出しを始めない', async () => {
    const { config, vault } = await setup({ timeoutSec: 20, maxFocusMemos: 1, maxCalls: 2 });
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const broken = fake(() => '形式が崩れた応答');
    expect(await runSynthesis(config, broken.llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'failed', error: 'invalid-output' });
    // 残り時間が1回の呼び出しに足りないので、作り直しを頼まない。
    expect(broken.prompts).toHaveLength(1);
    expect((await runs(vault))[0]!.calls).toMatchObject([{ attempts: 1, error: 'invalid-output' }]);
    await memo(config, '資格の講習に関心がある', '2026-11-10T09:00:00+09:00');
    const first = fake(() => answer({}));
    expect(await runSynthesis(config, first.llm, { now: at('2026-11-15T00:00:00Z') })).toMatchObject({ ran: true, status: 'empty', calls: 2, warnings: ['partial'] });
    // 2回目の呼び出しは始めず、時間切れとして記録する。
    expect(first.prompts).toHaveLength(1);
    expect((await runs(vault))[1]!.calls).toMatchObject([{ attempts: 1, error: null }, { attempts: 0, error: 'timeout', elapsed_ms: 0 }]);
  });

  test('1回に渡すメモを上限で区切り、長いメモは要約で、秘密情報らしい文字列は伏せて渡す', async () => {
    const { config, vault } = await setup({ maxFocusMemos: 3, maxContextMemos: 2 });
    for (let i = 1; i <= 4; i++) await memo(config, `古いメモ${i}。${'あ'.repeat(100)}`, `2026-10-0${i}T09:00:00+09:00`, { result: { summary: `古いメモ${i}の要約。${'い'.repeat(100)}` } });
    await memo(config, `長い作業メモ。${'う'.repeat(400)}`, '2026-11-01T09:00:00+09:00', { result: { summary: '長い作業メモの要約' } });
    await memo(config, 'password=abcdef123456 を替える', '2026-11-02T09:00:00+09:00');
    await memo(config, '最新のメモ', '2026-11-03T09:00:00+09:00');
    // 整理が済んでいない長いメモは、冒頭だけを渡す。
    await capture(config, { source: 'cli', occurredAt: '2026-11-04T09:00:00+09:00', receivedAt: '2026-11-04T09:00:00+09:00', text: `未整理の長いメモ。${'え'.repeat(400)}` });
    const { llm, prompts } = fake(() => answer({}));
    const preview = await previewSynthesis(config, { now: at('2026-11-08T00:00:00Z') });
    expect(preview).toMatchObject({ enabled: true, due: true, mode: 'first', counts: { new_memos: 0, focus: 3, context: 2, omitted: 3 }, calls: 1, next_due_at: null });
    expect(preview.prompt_bytes).toHaveLength(1);
    expect(await runs(vault)).toEqual([]);
    expect(await runSynthesis(config, llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'empty', mode: 'first' });
    expect(Buffer.byteLength(prompts[0]!, 'utf8')).toBe(preview.prompt_bytes[0]);
    const payload = payloadOf(prompts[0]!);
    expect(payload.memos.map(m => m.form)).toEqual(['head', 'head', 'original', 'original', 'excerpt']);
    // 以前のメモは新しい順に上限まで、1行（要約の先頭）にして渡す。
    expect(payload.memos[0]!.text).toBe(`古いメモ4の要約。${'い'.repeat(SYNTHESIS_HEAD_CHARS - 9)}…`);
    expect(payload.memos[1]!.text).toBe('長い作業メモの要約');
    expect(payload.memos[2]!.text).toContain('[伏せ字:');
    expect(prompts[0]).not.toContain('abcdef123456');
    expect(payload.memos[4]!.text).toBe(`未整理の長いメモ。${'え'.repeat(291)}…`);
    expect(payload.memos[4]).toMatchObject({ category: null });
    expect((await runs(vault))[0]!.counts).toEqual({ new_memos: 0, focus: 3, context: 2, omitted: 3 });
  });

  test('maxCallsを増やすと、全文で渡すメモを複数回の呼び出しに分けて、結果を上限までまとめる', async () => {
    const { config, vault } = await setup({ maxFocusMemos: 2, maxContextMemos: 10, maxCalls: 2 });
    for (let i = 1; i <= 5; i++) await memo(config, `メモ${i}の本文`, `2026-11-0${i}T09:00:00+09:00`);
    const { llm, prompts } = fake((ref, payload, call) => {
      const full = payload.memos.filter(m => m.form === 'original').map(m => m.ref);
      return answer({
        questions: [{ refs: [full[0]!], text: `呼び出し${call}の問いA` }, { refs: [full[1]!], text: `呼び出し${call}の問いB` }],
        connections: [{ refs: [ref('メモ1'), ref('メモ5')], text: `呼び出し${call}のつながり` }],
      });
    });
    const outcome = await runSynthesis(config, llm, { now: at('2026-11-08T00:00:00Z') });
    expect(outcome).toMatchObject({ ran: true, status: 'ok', calls: 2, items: 4, dropped: 2 });
    expect(prompts).toHaveLength(2);
    // 全文で渡すのは新しい4件で、2件ずつに分ける。ほかの回の分と古い1件は1行で渡す。
    expect(prompts.map(p => payloadOf(p).memos.map(m => m.form))).toEqual([
      ['head', 'original', 'original', 'head', 'head'],
      ['head', 'head', 'head', 'original', 'original'],
    ]);
    const run = (await runs(vault))[0]!;
    expect(run.counts).toEqual({ new_memos: 0, focus: 4, context: 1, omitted: 0 });
    expect(run.calls).toHaveLength(2);
    // 呼び出しごとの結果を交互に採り、同じ根拠の重なりと上限を超えた分を落とす。
    expect(run.items.map(i => i.text)).toEqual(['呼び出し1のつながり', '呼び出し1の問いA', '呼び出し2の問いA', '呼び出し1の問いB']);
    expect(run.dropped).toEqual([{ section: 'connections', reason: 'duplicate' }, { section: 'questions', reason: 'over-limit' }]);
    expect(run.items.filter(i => i.section === 'questions')).toHaveLength(SYNTHESIS_ITEMS_PER_SECTION);
    // 片方の呼び出しが失敗しても、成功した分は出す。
    await memo(config, 'メモ6の本文', '2026-11-10T09:00:00+09:00');
    for (let i = 7; i <= 9; i++) await memo(config, `メモ${i}の本文`, `2026-11-1${i - 6}T09:00:00+09:00`);
    const partial = fake((_ref, payload, call) => call === 1 ? new Error('障害') : answer({ questions: [{ refs: [payload.memos.filter(m => m.form === 'original')[0]!.ref], text: '2回目だけの問い' }] }));
    expect(await runSynthesis(config, partial.llm, { now: at('2026-11-15T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', mode: 'weekly', calls: 2, items: 1, warnings: ['partial'] });
    expect((await runs(vault))[1]!.calls.map(c => c.error)).toEqual(['llm-error', null]);
  });

  test('訂正の整理を待つメモは渡さず、根拠のメモが後から訂正されたら訂正ありと示す', async () => {
    const { config, vault } = await setup();
    const a = await memo(config, '菜園の土を調べたい', '2026-11-03T09:00:00+09:00');
    const b = await memo(config, '資格の講習に関心がある', '2026-11-04T09:00:00+09:00');
    await correctInput(config, b, { source: 'cli', occurredAt: '2026-11-05T09:00:00+09:00', receivedAt: '2026-11-05T09:00:00+09:00', text: 'やはり講習は受けない' });
    const first = fake(ref => answer({ stalled: [{ refs: [ref('土')], text: '土の件は続きが見当たりません' }] }));
    await runSynthesis(config, first.llm, { now: at('2026-11-08T00:00:00Z') });
    // 訂正の整理が済むまで、古い解釈をモデルへ渡さない。
    expect(payloadOf(first.prompts[0]!).memos.map(m => m.text)).toEqual(['菜園の土を調べたい']);
    // 訂正を整理した後は、訂正を重ねた要約で渡す。
    await organize(config, new MockLlm([organized({ summary: '講習は受けないことにした' })]));
    const second = fake(ref => answer({ questions: [{ refs: [ref('受けないことにした'), ref('土')], text: '講習の代わりに何をしますか' }] }));
    expect(await runSynthesis(config, second.llm, { now: at('2026-11-15T00:00:00Z'), force: true })).toMatchObject({ ran: true, status: 'ok', mode: 'quiet', items: 1 });
    expect(payloadOf(second.prompts[0]!).memos.map(m => [m.text, m.form])).toEqual([['菜園の土を調べたい', 'original'], ['講習は受けないことにした', 'summary']]);
    await rebuildDashboard(config, { now: at('2026-11-15T01:00:00Z') });
    const sources = async () => (await view(vault)).latest!.items[0]!.sources.map(s => [s.input_id, s.corrected]);
    expect(await sources()).toEqual([[b, false], [a, false]]);
    // 気づきを作った後に根拠のメモが訂正されたら、訂正ありと示す。
    await correctInput(config, a, { source: 'cli', occurredAt: '2026-11-16T09:00:00+09:00', text: '土はもう調べた' });
    await rebuildDashboard(config, { now: at('2026-11-16T03:00:00Z') });
    expect(await sources()).toEqual([[b, false], [a, true]]);
    expect(await vault.read('HOME.md')).toMatch(/講習の代わりに何をしますか — 根拠: \[2026-11-04のメモ\]\([^)]+\)、\[2026-11-03のメモ\]\([^)]+\)（訂正あり）/);
  });

  test('無効に戻すと、一覧を空にしてHOMEから欄を外す', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    await runSynthesis(config, fake(ref => answer({ stalled: [{ refs: [ref('土')], text: '続きが見当たりません' }] })).llm, { now: at('2026-11-08T00:00:00Z') });
    await rebuildDashboard(config, { now: at('2026-11-08T01:00:00Z') });
    expect(await vault.read('HOME.md')).toContain('今週の気づき');
    config.synthesis.enabled = false;
    await rebuildDigest(config, { now: at('2026-11-08T02:00:00Z') });
    await rebuildDashboard(config, { now: at('2026-11-08T02:00:00Z') });
    expect(await vault.read('HOME.md')).not.toContain('今週の気づき');
    expect(await vault.read('REVIEW.md')).not.toContain('今週の気づき');
    expect(await view(vault)).toMatchObject({ enabled: false, latest: null, last_attempt: null, next_due_at: null });
    // 実行の記録は消さない。
    expect(await runs(vault)).toHaveLength(1);
  });

  test('所要時間がOpenClawの待ち時間に近い実行は、注意としてHOMEに示す', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    await runSynthesis(config, fake(ref => answer({ stalled: [{ refs: [ref('土')], text: '続きが見当たりません' }] })).llm, { now: at('2026-11-08T00:00:00Z') });
    const run = (await runs(vault))[0]!;
    expect(synthesisWarnings(run)).toEqual([]);
    // 形式の作り直しを含めた合計ではなく、1回の試行の長さで判定する。
    const retried: SynthesisRun = { ...run, calls: [{ ...run.calls[0]!, attempts: 2, elapsed_ms: SYNTHESIS_SLOW_MS + 5000, slowest_ms: 50_000 }] };
    expect(synthesisWarnings(retried)).toEqual([]);
    const slow: SynthesisRun = { ...run, calls: [{ ...run.calls[0]!, elapsed_ms: SYNTHESIS_SLOW_MS + 5000, slowest_ms: SYNTHESIS_SLOW_MS + 5000 }] };
    expect(synthesisWarnings(slow)).toEqual(['slow']);
    await vault.write(`${synthesisDir}/${run.id}.json`, JSON.stringify(slow, null, 2) + '\n');
    await rebuildDashboard(config, { now: at('2026-11-08T01:00:00Z') });
    expect(await vault.read('HOME.md')).toMatch(/## 失敗と競合\n[\s\S]*週次の統合で、モデルの応答に95秒かかりました。OpenClawの待ち時間（120秒）に近づいています/);
  });

  test('根拠が20件を超える項目は落とし、ほかの項目は残す', async () => {
    const { config, vault } = await setup();
    for (let n = 0; n < 22; n++) await memo(config, `連番のメモ${String(n).padStart(2, '0')}番`, `2026-11-0${1 + (n % 7)}T${String(n).padStart(2, '0')}:00:00+09:00`);
    const { llm } = fake((ref, payload) => answer({
      connections: [{ refs: payload.memos.map(m => m.ref), text: 'すべてのメモがつながっています' }],
      questions: [{ refs: [ref('連番のメモ03番')], text: '3番目のメモの続きはありますか' }],
    }));
    expect(await runSynthesis(config, llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', items: 1 });
    const run = (await runs(vault))[0]!;
    expect(run.items.map(i => i.section)).toEqual(['questions']);
    expect(run.dropped).toEqual([{ section: 'connections', reason: 'too-many-refs' }]);
  });

  test('訂正の整理を待つ間に外したメモは、整理が済んだ後の回で新しいメモとして渡す', async () => {
    const { config, vault } = await setup();
    const a = await memo(config, '菜園の土を調べたい', '2025-01-01T09:00:00+09:00');
    await runSynthesis(config, fake(() => answer({})).llm, { now: at('2025-01-02T00:00:00Z') });
    await memo(config, '資格の講習に関心がある', '2025-01-03T09:00:00+09:00');
    // 訂正が届いたが、次の回までに整理されなかった。
    await correctInput(config, a, { source: 'cli', occurredAt: '2025-01-04T09:00:00+09:00', receivedAt: '2025-01-04T09:00:00+09:00', text: '菜園の土はもう調べた。次は肥料を選ぶ' });
    const second = fake(() => answer({}));
    await runSynthesis(config, second.llm, { now: at('2025-01-09T00:00:00Z') });
    expect(payloadOf(second.prompts[0]!).memos.map(m => m.text)).toEqual(['資格の講習に関心がある']);
    // 訂正の整理が済んだ後の回では、訂正を重ねたメモを新しいメモとして渡す。
    await organize(config, new MockLlm([organized({ summary: '肥料を選ぶ段階に進んだ' })]));
    const third = fake(() => answer({}));
    expect(await runSynthesis(config, third.llm, { now: at('2025-01-16T00:00:00Z') })).toMatchObject({ ran: true });
    const corrected = payloadOf(third.prompts[0]!).memos.find(m => m.text === '肥料を選ぶ段階に進んだ');
    expect(corrected).toMatchObject({ new: true });
    expect((await runs(vault))[2]!.counts.new_memos).toBe(1);
  });

  test('前回の項目の根拠に訂正が届いた後は、同じ欄・同じ根拠の項目を繰り返しとして落とさない', async () => {
    const { config, vault } = await setup();
    const a = await memo(config, '菜園の土を調べたい', '2026-11-01T09:00:00+09:00');
    await runSynthesis(config, fake(ref => answer({ stalled: [{ refs: [ref('土')], text: '土を調べる続きが見当たりません' }] })).llm, { now: at('2026-11-02T00:00:00Z') });
    await correctInput(config, a, { source: 'cli', occurredAt: '2026-11-05T09:00:00+09:00', receivedAt: '2026-11-05T09:00:00+09:00', text: '菜園の土はもう調べた。次は肥料を選ぶ' });
    await organize(config, new MockLlm([organized({ summary: '肥料を選ぶ段階に進んだ' })]));
    const { llm } = fake(ref => answer({ stalled: [{ refs: [ref('肥料')], text: '肥料を選ぶ続きが見当たりません' }] }));
    expect(await runSynthesis(config, llm, { now: at('2026-11-09T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', items: 1 });
    expect((await runs(vault))[1]!.dropped).toEqual([]);
  });

  test('参照の誤りで応答の項目がすべて落ちたときは、形式の不正として1回だけ作り直させる', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const wrong = () => answer({ stalled: [{ refs: ['M1'], text: '続きが見当たりません' }] });
    const fixed = fake((ref, _payload, call) => call === 1 ? wrong() : answer({ stalled: [{ refs: [ref('土')], text: '続きが見当たりません' }] }));
    expect(await runSynthesis(config, fixed.llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', items: 1 });
    expect(fixed.prompts).toHaveLength(2);
    expect(fixed.prompts[1]).toContain('前回の応答は形式不正です');
    // 作り直しても同じなら、失敗として記録する（前回の成功の時刻を進めない）。
    const again = fake(() => wrong());
    expect(await runSynthesis(config, again.llm, { now: at('2026-11-15T00:00:00Z'), force: true })).toMatchObject({ ran: true, status: 'failed', error: 'invalid-output' });
    expect(again.prompts).toHaveLength(2);
    expect((await runs(vault))[1]!.calls[0]).toMatchObject({ attempts: 2, error: 'invalid-output' });
  });

  test('前回と同じ項目しか返らなかった回の後も、前回までの気づきを出したままにする', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const same = () => fake(ref => answer({ stalled: [{ refs: [ref('土')], text: '続きが見当たりません' }] })).llm;
    await runSynthesis(config, same(), { now: at('2026-11-08T00:00:00Z') });
    expect(await runSynthesis(config, same(), { now: at('2026-11-08T01:00:00Z'), force: true })).toMatchObject({ ran: true, status: 'empty' });
    await rebuildDashboard(config, { now: at('2026-11-08T02:00:00Z') });
    const insights = await view(vault);
    expect(insights.latest?.id).toBe((await runs(vault))[0]!.id);
    expect(insights.latest?.items).toHaveLength(1);
    expect(await vault.read('HOME.md')).toContain('## 今週の気づき（AI生成・未検証）');
    // 足せる項目がなかった回（繰り返しも落とした項目もない）の後は、欄を出さない。
    await runSynthesis(config, fake(() => answer({})).llm, { now: at('2026-11-08T03:00:00Z'), force: true });
    await rebuildDashboard(config, { now: at('2026-11-08T04:00:00Z') });
    expect((await view(vault)).latest?.items).toEqual([]);
    expect(await vault.read('HOME.md')).not.toContain('## 今週の気づき');
  });

  test('モデルの本文の制御文字を除き、行頭の記号がMarkdownの見出しや引用として読まれないようにする', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const { llm } = fake(ref => answer({
      stalled: [{ refs: [ref('土')], text: '1. 番号のような意図‮', first_step: '> 引用のような一歩\u0007' }],
      questions: [{ refs: [ref('土')], text: '# 見出しのような\u001b問い' }],
    }));
    await runSynthesis(config, llm, { now: at('2026-11-08T00:00:00Z') });
    const run = (await runs(vault))[0]!;
    expect(run.items.map(i => i.text)).toEqual(['1. 番号のような意図', '# 見出しのような問い']);
    expect(run.items[0]!.first_step).toBe('> 引用のような一歩');
    await rebuildDashboard(config, { now: at('2026-11-08T01:00:00Z') });
    const home = (await vault.read('HOME.md'))!;
    expect(home).toContain('\n- 1\\. 番号のような意図（最初の一歩: > 引用のような一歩）');
    expect(home).toContain('\n- \\# 見出しのような問い — 根拠:');
    expect(home).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/);
  });

  test('壊れた記録があれば自動では実行せず、HOMEとdoctorで示す', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    await vault.write(`${synthesisDir}/SYN-01K5ABCDEFGHJKMNPQRSTVWXYZ.json`, '{"schema_version":1,"id":"別の値"}\n');
    expect(await runSynthesis(config, forbidden, { now: at('2026-11-08T00:00:00Z') })).toEqual({ ran: false, reason: 'record-problem' });
    expect((await doctor(config)).issues).toContain(`週次の統合の記録が不正です: ${synthesisDir}/SYN-01K5ABCDEFGHJKMNPQRSTVWXYZ.json`);
    await rebuildDashboard(config, { now: at('2026-11-08T00:00:00Z') });
    expect(await vault.read('HOME.md')).toContain(`[週次の統合の記録が不正です](${synthesisDir}/SYN-01K5ABCDEFGHJKMNPQRSTVWXYZ.json)`);
  });

  test('モデルの出力はHOMEの1行に収まるよう無害化し、長すぎる項目は落とす', async () => {
    const { config, vault } = await setup();
    await memo(config, '菜園の土を調べたい', '2026-11-04T09:00:00+09:00');
    const { llm } = fake(ref => answer({
      stalled: [{ refs: [ref('土')], text: '見出しに\n# 見える行と [リンク](https://example.com/) と <!-- コメント', first_step: 'あ'.repeat(500) }],
      questions: [{ refs: [ref('土')], text: 'い'.repeat(500) }, { refs: [ref('土'), ref('土')], text: '同じメモを二度挙げた問い' }, { refs: ref('土'), text: '形の崩れた項目' }, 'ただの文字列'],
    }));
    expect(await runSynthesis(config, llm, { now: at('2026-11-08T00:00:00Z') })).toMatchObject({ status: 'ok', items: 2, dropped: 3 });
    const run = (await runs(vault))[0]!;
    expect(run.items[0]).toEqual({ key: run.items[0]!.key, section: 'stalled', text: '見出しに # 見える行と [リンク](https://example.com/) と <!-- コメント', sources: run.items[0]!.sources });
    expect(run.items[1]!.sources).toHaveLength(1);
    expect(run.dropped).toEqual([{ section: 'questions', reason: 'too-long' }, { section: 'questions', reason: 'malformed' }, { section: 'questions', reason: 'malformed' }]);
    await rebuildDashboard(config, { now: at('2026-11-08T01:00:00Z') });
    const home = (await vault.read('HOME.md'))!;
    expect(home).toContain('- 見出しに # 見える行と \\[リンク\\](https://example.com/) と &lt;!-- コメント — 根拠: ');
  });

  test('cycleは整理の後に統合を実行し、同じcycleのHOMEに出す。provider=mockでも決まった形で応える', async () => {
    const { config, vault } = await setup();
    await capture(config, { source: 'cli', occurredAt: '2026-11-03T09:00:00+09:00', text: '菜園の土を調べたい' });
    await capture(config, { source: 'cli', occurredAt: '2026-11-04T09:00:00+09:00', text: '菜園の水やりを決めたい' });
    const result = await runCycle(config, new MockLlm());
    expect(result.synthesis).toMatchObject({ ran: true, status: 'ok', mode: 'first' });
    expect((await runs(vault))[0]!.llm).toMatchObject({ provider: 'mock', model: 'mock' });
    expect(await vault.read('HOME.md')).toContain('## 今週の気づき（AI生成・未検証）');
    // 間隔が空くまで、次のcycleでは実行しない。
    expect((await runCycle(config, new MockLlm(), {}, { synthesisLlm: forbidden })).synthesis).toMatchObject({ ran: false, reason: 'not-due' });
    // dry-runでは実行しない。
    config.synthesis.intervalDays = 1;
    expect((await runCycle(config, new MockLlm(), { dryRun: true }, { synthesisLlm: forbidden, now: at('2030-01-01T00:00:00Z') })).synthesis).toBeUndefined();
  });

  test('統合用のモデル設定は、整理の設定に思考の深さと出力の上限だけを重ねる', async () => {
    const { config } = await setup({ thinking: 'high' });
    config.organize.llm = { provider: 'openclaw-infer', model: 'x/y', maxOutputChars: 4000, executable: '/opt/openclaw', agent: 'hub', thinking: 'low' };
    expect(synthesisLlmConfig(config)).toEqual({ provider: 'openclaw-infer', model: 'x/y', maxOutputChars: 12000, executable: '/opt/openclaw', agent: 'hub', thinking: 'high' });
  });
});

describe('週次の統合の設定', () => {
  test('一部だけ書いた設定は既定値で補い、範囲外の値は拒否する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctx-synthesis-')); roots.push(root);
    const file = join(root, 'config.json'), base = defaultConfig(join(root, 'vault'), join(root, 'state'));
    const { synthesis: _unused, ...withoutSynthesis } = base;
    await writeFile(file, JSON.stringify(withoutSynthesis));
    expect((await loadConfig(file)).synthesis).toEqual(base.synthesis);
    await writeFile(file, JSON.stringify({ ...withoutSynthesis, synthesis: { enabled: true, thinking: 'low' } }));
    expect((await loadConfig(file)).synthesis).toEqual({ ...base.synthesis, enabled: true, thinking: 'low' });
    expect((await loadConfig(file, { synthesis: { thinking: 'high' } })).synthesis.thinking).toBe('high');
    for (const bad of [{ maxCalls: 0 }, { maxCalls: 5 }, { intervalDays: 0 }, { thinking: 'max' }, { timeoutSec: 601 }, { maxFocusMemos: 0 }, { maxContextMemos: -1 }, { unknown: 1 }]) {
      expect(() => validateConfig({ ...base, synthesis: { ...base.synthesis, ...bad } })).toThrow();
    }
    await writeFile(file, JSON.stringify({ ...withoutSynthesis, synthesis: { maxCalls: 9 } }));
    await expect(loadConfig(file)).rejects.toThrow('synthesis.maxCalls');
  });
});

describe('ctx synthesize', () => {
  function cli(config: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((done, reject) => {
      const p = spawn(process.execPath, [resolve('packages/core/dist/cli.js'), '--config', config, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTEXT_HUB_CONFIG: config } });
      let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); p.on('error', reject); p.on('close', code => done({ code, out, err }));
    });
  }
  test('無効のときは実行を断り、dry-runは件数と送る量だけを示す。有効にすると実行してHOMEへ出す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctx-synthesis-')); roots.push(root);
    const file = join(root, 'config.json'), base = defaultConfig(join(root, 'vault'), join(root, 'state'));
    await writeFile(file, JSON.stringify(base));
    expect((await cli(file, ['init'])).code).toBe(0);
    await capture(base, { source: 'cli', occurredAt: '2026-11-03T09:00:00+09:00', text: '菜園の土を調べたい' });
    await capture(base, { source: 'cli', occurredAt: '2026-11-04T09:00:00+09:00', text: '菜園の水やりを決めたい' });
    const refused = await cli(file, ['synthesize']);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('synthesis.enabled');
    const dry = await cli(file, ['synthesize', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ enabled: false, due: true, mode: 'first', counts: { focus: 2, context: 0, omitted: 0 }, calls: 1 });
    const vault = new Vault(base);
    expect(await vault.files(synthesisDir)).toEqual([]);
    await writeFile(file, JSON.stringify({ ...base, synthesis: { ...base.synthesis, enabled: true } }));
    const ran = await cli(file, ['synthesize']);
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out)).toMatchObject({ ran: true, status: 'ok', mode: 'first' });
    expect(await vault.read('HOME.md')).toContain('## 今週の気づき（AI生成・未検証）');
    expect(JSON.parse((await cli(file, ['synthesize'])).out)).toMatchObject({ ran: false, reason: 'not-due' });
    expect(JSON.parse((await cli(file, ['synthesize', '--force'])).out)).toMatchObject({ ran: true });
    expect((await cli(file, ['synthesize', '--thinking', 'bogus'])).code).not.toBe(0);
  }, 30000);
});
