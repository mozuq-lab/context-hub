import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { mergeProjects } from '../src/project-merges.js';
import { hash } from '../src/storage.js';
import { capture, readInputs } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm, PREVIOUS_MEMO_CHARS } from '../src/llm.js';
import { ingest, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { readReceipts } from '../src/views.js';
import { bundle } from '../src/retrieve.js';
import type { LlmClient } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T01:00:00Z`;

test('続きは前のメモにつながり、プロジェクトを選ばなければ前のメモで指定したプロジェクトを引き継ぐ', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await addProject(config, { id: 'garden', title: '庭' });
  const first = await capture(config, { source: 'cli', text: '会議で配布方法を話した', project: 'hub', occurredAt: at(1) });
  const loose = await capture(config, { source: 'cli', text: '思いつき', occurredAt: at(1) });
  const inherited = await capture(config, { source: 'cli', text: '続き: 配布はストア経由に決めた', continues: first.inputId, occurredAt: at(2) });
  const chosen = await capture(config, { source: 'cli', text: '続きだが庭の話', continues: first.inputId, project: 'garden', occurredAt: at(2) });
  const noProject = await capture(config, { source: 'cli', text: '思いつきの続き', continues: loose.inputId, occurredAt: at(2) });
  // 訂正を指しても、元の入力につなぐ。
  const fixed = await correctInput(config, first.inputId, { source: 'cli', text: '会議で配布方法と価格を話した', occurredAt: at(3) });
  const viaCorrection = await capture(config, { source: 'cli', text: '価格の続き', continues: fixed.inputId, occurredAt: at(3) });
  // 見つからない前のメモは、つながない普通のメモとして保存する。
  const missing = await capture(config, { source: 'cli', text: '前のメモがない続き', continues: 'IN-01JZ0000000000000000000000', occurredAt: at(3) });
  const inputs = new Map((await readInputs(config)).map(i => [i.id, i]));
  expect(inputs.get(inherited.inputId)).toMatchObject({ continues_input_id: first.inputId, project: 'hub' });
  expect(inputs.get(chosen.inputId)).toMatchObject({ continues_input_id: first.inputId, project: 'garden' });
  expect(inputs.get(noProject.inputId)).toMatchObject({ continues_input_id: loose.inputId });
  expect(inputs.get(noProject.inputId)!.project).toBeUndefined();
  expect(inputs.get(viaCorrection.inputId)).toMatchObject({ continues_input_id: first.inputId, project: 'hub' });
  expect(inputs.get(missing.inputId)!.continues_input_id).toBeUndefined();
  // 行動には前のメモを付けられない。
  await expect(capture(config, { source: 'cli', kind: 'action', text: '配布を進める', project: 'hub', continues: first.inputId, occurredAt: at(3) })).rejects.toThrow('前のメモ');

  // 前のメモのプロジェクトが統合済みなら、統合先を引き継ぐ。
  await addProject(config, { id: 'tool', title: 'まとめツール' });
  const other = await capture(config, { source: 'cli', text: '別名側のメモ', project: 'tool', occurredAt: at(4) });
  const definition = async (id: string) => hash((await vault.read(`10_projects/${id}/project.md`))!);
  await mergeProjects(config, { fromId: 'tool', intoId: 'hub', fromHash: await definition('tool'), intoHash: await definition('hub'), source: 'cli' });
  const next = await capture(config, { source: 'cli', text: '別名側の続き', continues: other.inputId, occurredAt: at(5) });
  expect((await readInputs(config)).find(i => i.id === next.inputId)).toMatchObject({ continues_input_id: other.inputId, project: 'hub' });

  // 束ねると、前のメモを示す。
  const text = await bundle(config, [inherited.inputId], 20000);
  expect(text).toContain(`前のメモの続き: [${first.inputId}](`);
});

test('受付ファイルの続きを受け付け、端末に欄の対応を知らせる', async () => {
  const { config } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const first = await capture(config, { source: 'cli', text: '会議メモ', project: 'hub', occurredAt: at(1) });
  expect(intakeFeatures(config).capture_fields).toEqual(['happened_on', 'continues']);
  const p = await packet(config, { continues: first.inputId }, '会議メモの続き');
  // 行動に前のメモは付けられない。
  await packet(config, { kind: 'action', project: 'hub', continues: first.inputId }, '行動');
  await packet(config, { continues: 'IN-bad' }, '不正なID');
  const result = await ingest(config);
  expect(result).toMatchObject({ accepted: 1, rejected: 2 });
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  const saved = (await readInputs(config)).find(i => i.id === (receipt.result as { inputId: string }).inputId)!;
  expect(saved).toMatchObject({ continues_input_id: first.inputId, project: 'hub', text: '会議メモの続き' });
  // 同じ受付の再処理でも、引き継いだプロジェクトを食い違いとして扱わない。
  expect((await ingest(config)).rejected).toBe(0);
});

test('整理では前のメモの最新の本文を前提としてだけ渡し、前のメモを根拠にした項目は落とす', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const first = await capture(config, { source: 'cli', text: '会議: 配布方法を決める必要がある', project: 'hub', occurredAt: at(1) });
  await organize(config, new MockLlm());
  await correctInput(config, first.inputId, { source: 'cli', text: '会議: 配布方法と価格を決める必要がある', occurredAt: at(2) });
  await organize(config, new MockLlm());
  const prompts: string[] = [];
  const llm: LlmClient = {
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return { text: JSON.stringify({ category: 'project-update', summary: 'ストア経由に決めた', project_candidates: [], next_action_suggestions: [], extracted: { current: [{ text: 'ストア経由に決めた', status: 'unverified' }], next: [{ text: '配布方法と価格を決める', status: 'unverified', input_id: first.inputId }], open: [] }, knowledge_candidate: null, new_project_hint: null }) };
    },
  };
  const next = await capture(config, { source: 'cli', text: 'さっきの件、ストア経由に決めた', continues: first.inputId, occurredAt: at(3) });
  expect((await organize(config, llm)).processed).toBe(1);
  expect(prompts).toHaveLength(1);
  const data = JSON.parse(prompts[0]!.slice(prompts[0]!.lastIndexOf('入力データ(JSON):\n') + '入力データ(JSON):\n'.length));
  expect(data.previous_memo).toMatchObject({ id: first.inputId, text: '会議: 配布方法と価格を決める必要がある' });
  expect(data.source_text).toBe('さっきの件、ストア経由に決めた');
  expect(prompts[0]).toContain('previous_memoの内容からextracted');
  const receipt = (await readReceipts(config)).find(r => r.input_id === next.inputId)!;
  expect(receipt.status).toBe('organized');
  expect(receipt.result!.extracted.next).toEqual([]);
  expect(receipt.result!.extracted.current).toMatchObject([{ text: 'ストア経由に決めた' }]);
  expect(await vault.read('10_projects/hub/NOW.md')).toContain('ストア経由に決めた');

  // 前のメモが長いときは、続きに近い末尾を残す。続きでないメモには前のメモを渡さない。
  const long = await capture(config, { source: 'cli', text: `${'あ'.repeat(PREVIOUS_MEMO_CHARS)}最後の段落`, occurredAt: at(4) });
  await organize(config, new MockLlm());
  prompts.length = 0;
  await capture(config, { source: 'cli', text: '長いメモの続き', continues: long.inputId, occurredAt: at(5) });
  await capture(config, { source: 'cli', text: '続きではないメモ', occurredAt: at(6) });
  await organize(config, llm);
  const sent = prompts.map(p => JSON.parse(p.slice(p.lastIndexOf('入力データ(JSON):\n') + '入力データ(JSON):\n'.length)));
  const cont = sent.find(d => d.source_text === '長いメモの続き')!, plain = sent.find(d => d.source_text === '続きではないメモ')!;
  expect(cont.previous_memo.text.startsWith('（前半を省略）')).toBe(true);
  expect(cont.previous_memo.text.endsWith('最後の段落')).toBe(true);
  expect(plain.previous_memo).toBeUndefined();
});
