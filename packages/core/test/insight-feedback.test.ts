import { afterEach, describe, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { packet, workflowSetup } from './workflow-fixtures.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, intakeErrorMessage, intakeErrorSchema, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { rebuildDigest } from '../src/digest.js';
import { doctor } from '../src/doctor.js';
import { readSynthesisRuns, runSynthesis } from '../src/synthesis.js';
import { insightsPath, insightsSchema, setInsightReaction } from '../src/insights.js';
import { insightReactionDir, readInsightReactions } from '../src/insight-feedback.js';
import { parseIntake } from '../src/intake-format.js';
import { markdown, type Vault } from '../src/storage.js';
import type { LlmClient } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

interface PayloadMemo { ref: string; text: string; question?: string }
interface Payload { previous: { section: string; text: string; refs: string[]; reaction?: string; answered?: boolean }[]; memos: PayloadMemo[] }
const marker = '入力データ(JSON):\n';
const payloadOf = (prompt: string): Payload => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
const answer = (sections: Record<string, unknown[]>) => JSON.stringify({ connections: [], shifts: [], stalled: [], actions: [], questions: [], ...sections });
/** プロンプトを記録し、渡されたメモの本文から参照名を引いて応答を作る偽のモデル。 */
function fake(reply: (ref: (text: string) => string) => string) {
  const prompts: string[] = [];
  const llm: LlmClient = { complete: async prompt => {
    prompts.push(prompt);
    const payload = payloadOf(prompt);
    const ref = (text: string) => { const found = payload.memos.find(m => m.text.includes(text)); if (!found) throw new Error(`テストのメモが渡されていません: ${text}`); return found.ref; };
    return { text: reply(ref), model: 'test/model-a' };
  } };
  return { llm, prompts };
}
const at = (iso: string) => new Date(iso);
const view = async (vault: Vault) => insightsSchema.parse(JSON.parse((await vault.read(insightsPath))!));

/** 統合を有効にし、つながり1件と問い1件の気づきを作る。 */
async function setup() {
  const { config, vault } = await workflowSetup(roots);
  config.organize.maxItemsPerRun = 200;
  config.synthesis = { ...config.synthesis, enabled: true };
  for (const [text, when] of [['資格の講習に関心がある', '2026-11-03T09:00:00+09:00'], ['資格の講習を受ける必要がある', '2026-11-10T09:00:00+09:00'], ['動画の作り方を見直した', '2026-11-12T09:00:00+09:00']] as const)
    await capture(config, { source: 'cli', occurredAt: when, receivedAt: when, text });
  await organize(config, new MockLlm());
  const { llm } = fake(ref => answer({
    connections: [{ refs: [ref('関心がある'), ref('受ける必要がある')], text: '11/03の関心が、11/10には受ける必要へ進んでいるように見えます' }],
    questions: [{ refs: [ref('動画')], text: '見直した結果、次に試したいことはありますか' }],
  }));
  expect(await runSynthesis(config, llm, { now: at('2026-11-15T00:00:00Z') })).toMatchObject({ ran: true, status: 'ok', items: 2 });
  const run = (await readSynthesisRuns(vault)).runs[0]!;
  const item = (section: string) => run.items.find(i => i.section === section)!;
  return { config, vault, run, question: item('questions'), connection: item('connections') };
}
const reaction = (config: Parameters<typeof packet>[0], fields: Record<string, unknown>) =>
  packet(config, { operation: 'insight-reaction', source: 'context-hub-flutter', confirmed: true, occurred_at: '2026-11-16T10:00:00+09:00', ...fields }, '');

describe('今週の気づきへの反応', () => {
  test('反応を受け付けて一覧の項目に出し、判断した日時が最後の反応を有効にする。noneで外し、同じ受付IDは重ねない', async () => {
    const { config, vault, run, question, connection } = await setup();
    await reaction(config, { run_id: run.id, item_key: question.key, reaction: 'useful' });
    expect(await ingest(config)).toMatchObject({ accepted: 1, rejected: 0 });
    const [receipt] = await readIntakeReceipts(config);
    expect(receipt).toMatchObject({ operation: 'insight-reaction', result: { runId: run.id, itemKey: question.key, reaction: 'useful', deduped: false } });
    await rebuildDashboard(config, { now: at('2026-11-16T03:00:00Z') });
    let items = (await view(vault)).latest!.items;
    expect(items.find(i => i.key === question.key)!.reaction).toBe('useful');
    expect(items.find(i => i.key === connection.key)!.reaction).toBeNull();

    // 後から受け付けても、判断した日時が早い反応は、遅い反応を上書きしない。
    await reaction(config, { run_id: run.id, item_key: question.key, reaction: 'off-target', occurred_at: '2026-11-16T12:00:00+09:00' });
    await reaction(config, { run_id: run.id, item_key: question.key, reaction: 'none', occurred_at: '2026-11-16T11:00:00+09:00' });
    expect(await ingest(config)).toMatchObject({ accepted: 2, rejected: 0 });
    await rebuildDashboard(config, { now: at('2026-11-16T04:00:00Z') });
    expect((await view(vault)).latest!.items.find(i => i.key === question.key)!.reaction).toBe('off-target');

    const last = await reaction(config, { run_id: run.id, item_key: question.key, reaction: 'none', occurred_at: '2026-11-16T13:00:00+09:00' });
    expect(await ingest(config)).toMatchObject({ accepted: 1 });
    await rebuildDashboard(config, { now: at('2026-11-16T05:00:00Z') });
    items = (await view(vault)).latest!.items;
    expect(items.find(i => i.key === question.key)!.reaction).toBeNull();
    expect((await readInsightReactions(vault)).records).toHaveLength(4);

    // 同じ受付IDの依頼は記録を重ねず、別の内容なら断る。
    const again = await setInsightReaction(config, { runId: run.id, itemKey: question.key, reaction: 'none', source: 'context-hub-flutter', sourceEventId: last.requestId, decidedAt: '2026-11-16T13:00:00+09:00' });
    expect(again).toMatchObject({ deduped: true, reaction: 'none' });
    await expect(setInsightReaction(config, { runId: run.id, itemKey: question.key, reaction: 'useful', source: 'context-hub-flutter', sourceEventId: last.requestId })).rejects.toThrow();
    expect((await readInsightReactions(vault)).records).toHaveLength(4);
  });

  test('知らない実行・項目への反応は理由を付けて断り、同じ依頼を試し直さない', async () => {
    const { config, vault, run } = await setup();
    await reaction(config, { run_id: 'SYN-01JZ0000000000000000000000', item_key: 'a'.repeat(64), reaction: 'useful' });
    await reaction(config, { run_id: run.id, item_key: 'b'.repeat(64), reaction: 'off-target' });
    expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 2 });
    const paths = await vault.files('90_system/intake-errors');
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      const record = intakeErrorSchema.parse(JSON.parse((await vault.read(path))!));
      expect(record.reason).toEqual({ code: 'insight-missing' });
      expect(intakeErrorMessage(record)).toContain('今週の気づき');
    }
    expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 0, deduped: 2 });
    expect((await readInsightReactions(vault)).records).toHaveLength(0);
  });

  test('反応の依頼は、確認済みで本文が空のときだけ受け付ける', () => {
    const id = 'REQ-' + 'A'.repeat(32), path = `Input/${id}.md`;
    const fields = { schema_version: 1, request_id: id, source: 'context-hub-flutter', occurred_at: '2026-11-16T10:00:00+09:00', operation: 'insight-reaction', run_id: 'SYN-01JZ0000000000000000000000', item_key: 'a'.repeat(64), reaction: 'useful', confirmed: true };
    expect(parseIntake(path, markdown(fields, ''), 8000)).toMatchObject({ operation: 'insight-reaction', reaction: 'useful' });
    expect(() => parseIntake(path, markdown(fields, '本文'), 8000)).toThrow();
    expect(() => parseIntake(path, markdown({ ...fields, confirmed: false }, ''), 8000)).toThrow();
    expect(() => parseIntake(path, markdown({ ...fields, reaction: 'great' }, ''), 8000)).toThrow();
    expect(() => parseIntake(path, markdown({ ...fields, run_id: 'SYN-x' }, ''), 8000)).toThrow();
    expect(() => parseIntake(path, markdown({ ...fields, item_key: 'A'.repeat(64) }, ''), 8000)).toThrow();
  });

  test('壊れた反応の記録は飛ばして一覧を作り、doctorで示す', async () => {
    const { config, vault, run, question } = await setup();
    await reaction(config, { run_id: run.id, item_key: question.key, reaction: 'useful' });
    await ingest(config);
    const broken = `${insightReactionDir}/IRX-01JZ0000000000000000000000.json`;
    await vault.write(broken, '{"schema_version":1}\n');
    await rebuildDashboard(config, { now: at('2026-11-16T03:00:00Z') });
    expect((await view(vault)).latest!.items.find(i => i.key === question.key)!.reaction).toBe('useful');
    expect((await doctor(config)).issues).toContain(`今週の気づきへの反応の記録が不正です: ${broken}`);
  });
});

describe('今週の気づきの問いへの答え', () => {
  test('答えのメモを項目に結び付け、次の統合に問いと一緒に渡して、答え済みと反応を伝える', async () => {
    const { config, vault, run, question, connection } = await setup();
    const meta = (key: string, text: string) => ({ capture_mode: 'insight-answer', insight_run: run.id, insight_key: key, insight_question: text });
    await packet(config, { source: 'context-hub-flutter', occurred_at: '2026-11-16T09:00:00+09:00', meta: meta(question.key, question.text) }, '字幕の付け方を試したい');
    // 知らない項目への答えも、ふつうのメモとして保存する（項目には結び付けない）。
    await packet(config, { source: 'context-hub-flutter', occurred_at: '2026-11-16T09:10:00+09:00', meta: meta('c'.repeat(64), '前の週の問い') }, '前の週の問いへの答え');
    await reaction(config, { run_id: run.id, item_key: connection.key, reaction: 'off-target', occurred_at: '2026-11-16T09:30:00+09:00' });
    expect(await ingest(config)).toMatchObject({ accepted: 3, rejected: 0 });
    await organize(config, new MockLlm());
    await rebuildDashboard(config, { now: at('2026-11-16T03:00:00Z') });
    const items = (await view(vault)).latest!.items;
    expect(items.find(i => i.key === question.key)!.answers).toEqual([
      { input_id: expect.stringMatching(/^IN-/), path: expect.stringMatching(/^00_inbox\/2026-11-16_IN-.+\.md$/), occurred_at: '2026-11-16T09:00:00+09:00' },
    ]);
    expect(items.find(i => i.key === connection.key)!.answers).toEqual([]);

    // 次の回は、答えのメモに問いを添え、前回の項目に答え済み・反応を添えて渡す。
    await capture(config, { source: 'cli', occurredAt: '2026-11-18T09:00:00+09:00', receivedAt: '2026-11-18T09:00:00+09:00', text: '講習の申込期限を調べた' });
    await organize(config, new MockLlm());
    const second = fake(() => answer({}));
    expect(await runSynthesis(config, second.llm, { now: at('2026-11-23T00:00:00Z') })).toMatchObject({ ran: true });
    const payload = payloadOf(second.prompts[0]!);
    expect(payload.memos.find(m => m.text.includes('字幕'))!.question).toBe(question.text);
    expect(payload.memos.find(m => m.text.includes('前の週の問いへの答え'))!.question).toBe('前の週の問い');
    expect(payload.memos.find(m => m.text.includes('申込期限'))).not.toHaveProperty('question');
    expect(payload.previous).toEqual(expect.arrayContaining([
      { section: 'questions', text: question.text, refs: [expect.stringMatching(/^M\d+$/)], answered: true },
      { section: 'connections', text: connection.text, refs: [expect.stringMatching(/^M\d+$/), expect.stringMatching(/^M\d+$/)], reaction: 'off-target' },
    ]));
    expect(second.prompts[0]).toContain('off-target');
    expect(second.prompts[0]).toContain('answered');
    expect((await readSynthesisRuns(vault)).runs.at(-1)!.llm.prompt_version).toBe(2);
  });

  test('ふりかえりに、実行ごとの項目数と、反応・答えの件数を出す', async () => {
    const { config, vault, run, question, connection } = await setup();
    await packet(config, { source: 'context-hub-flutter', occurred_at: '2026-11-16T09:00:00+09:00', meta: { capture_mode: 'insight-answer', insight_run: run.id, insight_key: question.key, insight_question: question.text } }, '字幕の付け方を試したい');
    await reaction(config, { run_id: run.id, item_key: question.key, reaction: 'useful' });
    await reaction(config, { run_id: run.id, item_key: connection.key, reaction: 'off-target' });
    await ingest(config);
    await organize(config, new MockLlm());
    await rebuildDigest(config, { now: at('2026-11-16T03:00:00Z') });
    await rebuildDashboard(config, { now: at('2026-11-16T03:00:00Z') });
    const review = (await vault.read('REVIEW.md'))!;
    expect(review).toContain('## 今週の気づきへの反応');
    expect(review).toContain('- 2026-11-15の回: 2件のうち、役に立った1件・的外れ1件・答えた項目1件');
    expect(review.indexOf('## 今週の気づき（AI生成・未検証）')).toBeLessThan(review.indexOf('## 今週の気づきへの反応'));
    expect(review.indexOf('## 今週の気づきへの反応')).toBeLessThan(review.indexOf('## 概要'));
    expect(await vault.read('HOME.md')).not.toContain('気づきへの反応');
  });
});
