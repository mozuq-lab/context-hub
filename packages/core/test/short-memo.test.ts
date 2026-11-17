import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { Vault, parseMarkdown } from '../src/storage.js';
import { organize } from '../src/organize.js';
import { MockLlm, buildOrganizePrompt } from '../src/llm.js';
import { SHORT_MEMO_CHARS, shortMemoText } from '../src/short-memo.js';
import { addProject } from '../src/projects.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { readRereads } from '../src/item-rereads.js';
import type { HubConfig, Input, OrganizeResult } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(): Promise<{ config: HubConfig; vault: Vault }> {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-short-')); roots.push(root);
  const config = defaultConfig(path.join(root, 'vault'), path.join(root, 'state')), vault = new Vault(config); await vault.init(); return { config, vault };
}
const paraphrase = (extra: Partial<OrganizeResult> = {}): OrganizeResult => ({ category: 'idea', summary: 'モデルが言い換えた要約', project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null, ...extra });
const receiptOf = async (vault: Vault, id: string) => JSON.parse((await vault.read(`90_system/receipts/${id}.json`))!) as { result: OrganizeResult };
const at = '2026-11-01T09:00:00+09:00';
const memo = (text: string, extra: Partial<Input> = {}): Input => ({ schema_version: 1, id: 'IN-01JZ0000000000000000000000', kind: 'memo', source: 'cli', source_event_id: 'e', occurred_at: at, received_at: at, origin: 'user-note', text, path: '00_inbox/x.md', ...extra });

describe('短いメモは言い換えない', () => {
  test('訂正のない短いメモは、1行にした本人の言葉を返す', () => {
    const chain = (root: Input, revisions: Input[] = []) => ({ root, revisions });
    expect(shortMemoText(chain(memo('  朝に散歩すると\n考えがまとまる  ')))).toBe('朝に散歩すると 考えがまとまる');
    expect(shortMemoText(chain(memo('あ'.repeat(SHORT_MEMO_CHARS))))).toBe('あ'.repeat(SHORT_MEMO_CHARS));
    // 上限は文字数で数える（絵文字などを2文字と数えない）。
    expect(shortMemoText(chain(memo('😀'.repeat(SHORT_MEMO_CHARS))))).toBe('😀'.repeat(SHORT_MEMO_CHARS));
    expect(shortMemoText(chain(memo('あ'.repeat(SHORT_MEMO_CHARS + 1))))).toBeUndefined();
    expect(shortMemoText(chain(memo('## 現在地\n- [確認済み] 進めた', { kind: 'work-summary' })))).toBeUndefined();
    expect(shortMemoText(chain(memo('短いメモ'), [memo('訂正', { kind: 'correction' })]))).toBeUndefined();
  });

  test('短いメモの要約とアイデアには、モデルの言い換えではなく本人の言葉を使う', async () => {
    const { config, vault } = await setup();
    const saved = await capture(config, { source: 'cli', text: '朝に散歩すると\n考えがまとまる', occurredAt: at });
    await organize(config, new MockLlm([paraphrase()]));
    expect((await receiptOf(vault, saved.inputId)).result.summary).toBe('朝に散歩すると 考えがまとまる');
    const idea = parseMarkdown((await vault.read(`20_ideas/IDEA-${saved.inputId.slice(3)}.md`))!).text;
    expect(idea).toContain('\n\n朝に散歩すると 考えがまとまる\n\n');
    expect(idea).not.toContain('モデルが言い換えた要約');
  });

  test('長いメモ・作業要約・訂正のあるメモは、モデルの要約を使う', async () => {
    const { config, vault } = await setup();
    const long = await capture(config, { source: 'cli', text: 'あ'.repeat(SHORT_MEMO_CHARS + 1), occurredAt: at });
    const summary = await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', text: '## 現在地\n- [確認済み] 進めた', occurredAt: '2026-11-01T10:00:00+09:00' });
    await organize(config, new MockLlm([paraphrase(), paraphrase({ category: 'project-update', summary: '作業の要約' })]));
    expect((await receiptOf(vault, long.inputId)).result.summary).toBe('モデルが言い換えた要約');
    expect((await receiptOf(vault, summary.inputId)).result.summary).toBe('作業の要約');
    const short = await capture(config, { source: 'cli', text: '短いメモ', occurredAt: '2026-11-01T11:00:00+09:00' });
    await organize(config, new MockLlm([paraphrase()]));
    const revision = await correctInput(config, short.inputId, { source: 'cli', occurredAt: '2026-11-02T09:00:00+09:00', text: '場所は公園ではなく川沿い' });
    await organize(config, new MockLlm([paraphrase({ summary: '訂正を反映した要約' })]));
    expect((await receiptOf(vault, short.inputId)).result.summary).toBe('短いメモ');
    expect((await receiptOf(vault, revision.inputId)).result.summary).toBe('訂正を反映した要約');
  });

  test('短いメモからは恒久知識の候補を作らず、本人が明示した判断・好みの候補は残す', async () => {
    const { config, vault } = await setup();
    const candidate = (kind: 'knowledge' | 'decision' | 'preference') => paraphrase({ category: 'unclassified', knowledge_candidate: { kind, claim: '候補の主張', rationale: '理由' } });
    const fact = await capture(config, { source: 'cli', text: '散歩は朝がよい', occurredAt: at });
    const decision = await capture(config, { source: 'cli', text: '散歩は毎朝することに決めた', occurredAt: '2026-11-01T10:00:00+09:00' });
    const longFact = await capture(config, { source: 'cli', text: `${'散歩の効果について調べた。'.repeat(10)}`, occurredAt: '2026-11-01T11:00:00+09:00' });
    await organize(config, new MockLlm([candidate('knowledge'), candidate('decision'), candidate('knowledge')]));
    expect((await receiptOf(vault, fact.inputId)).result.knowledge_candidate).toBeNull();
    expect(await vault.read(`90_system/candidates/CAN-${fact.inputId.slice(3)}.md`)).toBeUndefined();
    expect((await receiptOf(vault, decision.inputId)).result.knowledge_candidate).toMatchObject({ kind: 'decision' });
    expect(await vault.read(`90_system/candidates/CAN-${decision.inputId.slice(3)}.md`)).toBeDefined();
    expect((await receiptOf(vault, longFact.inputId)).result.knowledge_candidate).toMatchObject({ kind: 'knowledge' });
  });

  test('秘密情報らしい文字列を含む短いメモは、伏せ字にした本文を要約に使う', async () => {
    const { config, vault } = await setup();
    const saved = await capture(config, { source: 'cli', text: '検証環境の password=abcdef123456 を変える', occurredAt: at });
    await organize(config, new MockLlm([paraphrase({ category: 'task' })]));
    const summary = (await receiptOf(vault, saved.inputId)).result.summary;
    expect(summary).toContain('[伏せ字:');
    expect(summary).not.toContain('abcdef123456');
  });

  test('短いメモの質問を誤りとして外すと、読み直しで言い換えられても同じ項目として外れたままになる', async () => {
    const { config, vault } = await setup();
    await addProject(config, { id: 'hub', title: '集約ツール' });
    const text = '集約ツールの配布はストア経由でよいだろうか？';
    const saved = await capture(config, { source: 'cli', text, occurredAt: at });
    await organize(config, new MockLlm());
    const item = (await readNowItems(vault, 'hub'))!.items[0]!;
    expect(item.text).toBe(text);
    await setItemResolution(config, { projectId: 'hub', itemKey: item.key, action: 'exclude', reason: 'misread', source: 'cli' });
    const reworded = paraphrase({ category: 'question', summary: '配布の経路を決めたい', project_candidates: [{ id: 'hub', confidence: 0.9 }] });
    expect(await organize(config, new MockLlm([reworded]))).toMatchObject({ reread: 1 });
    expect((await readRereads(vault)).records.get(saved.inputId)?.result?.summary).toBe(text);
    expect(await vault.read('10_projects/hub/NOW.md')).not.toContain('配布の経路を決めたい');
    expect((await readNowItems(vault, 'hub'))!.items.map(i => [i.key, i.resolution?.action])).toEqual([[item.key, 'exclude']]);
  });

  test('整理の依頼は、言い換えを避けることと知識候補の条件を伝える', () => {
    const prompt = buildOrganizePrompt(memo('朝に散歩すると考えがまとまる'), []);
    expect(prompt).toContain('summaryはsource_textの言葉を保ち');
    expect(prompt).toContain('source_textを言い換えただけの内容ではknowledge_candidateをnullにする');
  });
});
