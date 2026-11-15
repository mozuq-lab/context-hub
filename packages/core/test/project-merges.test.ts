import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { Vault, hash, parseMarkdown } from '../src/storage.js';
import { addProject, mergeIssues, mergeTargets, mergedSources, readProjects, resolveProject, ProjectMergedError } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { runCycle } from '../src/cycle.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { find, resume } from '../src/retrieve.js';
import { buildHistory } from '../src/history.js';
import { buildReferences } from '../src/references.js';
import { ingest, readIntakeReceipts, intakeErrorSchema, intakeErrorMessage } from '../src/intake.js';
import { readNowItems, setItemResolution, readItemResolutions } from '../src/item-resolutions.js';
import { setItemSchedule } from '../src/item-schedules.js';
import { setProjectStatus, candidateProjects } from '../src/project-status.js';
import { setProjectDefinition } from '../src/project-definition.js';
import { mergeProjects, unmergeProject, readProjectMerges, withMergeState, mergedTerms, ProjectMergeError } from '../src/project-merges.js';
import type { HubConfig, Project } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

const at = (iso: string) => ({ occurredAt: iso, receivedAt: iso });
const definition = async (vault: Vault, id: string) => (await vault.read(`10_projects/${id}/project.md`))!;
const hashes = async (vault: Vault, from: string, into: string) => ({ fromHash: hash(await definition(vault, from)), intoHash: hash(await definition(vault, into)) });
const merge = async (config: HubConfig, vault: Vault, from = 'tool', into = 'hub', extra: { sourceEventId?: string } = {}) => mergeProjects(config, { fromId: from, intoId: into, ...await hashes(vault, from, into), source: 'cli', ...extra });

/** 「集約ツール」（hub）と、同じものを指して別に作られた「まとめツール」（tool）。 */
async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール', aliases: ['ハブ'], keywords: ['集約'] });
  await addProject(config, { id: 'tool', title: 'まとめツール', aliases: ['まとめ', 'ハブ'], keywords: ['まとめる', '集約'] });
  const old = await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'tool', ...at('2026-09-10T01:00:00Z'), text: '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n## 未解決\n- 配布方法が決まっていない\n- 名前が決まっていない' });
  const memo = await capture(config, { source: 'cli', project: 'tool', ...at('2026-09-20T01:00:00Z'), text: '同期の仕様 https://example.com/spec' });
  // プロジェクトの指定はなく、名前からAIが結び付ける。
  const guessed = await capture(config, { source: 'cli', ...at('2026-09-25T01:00:00Z'), text: 'まとめツールの画面を直す' });
  const latest = await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', ...at('2026-10-05T01:00:00Z'), text: '## 現在地\n- [確認済み] 利用者に見せた\n## 次の一手\n- [確認済み] 名前を決める' });
  await organize(config, new MockLlm());
  return { config, vault, old, memo, guessed, latest };
}

test('統合先をたどり、見つからない・循環する統合先は統合として扱わず不整合として示す', () => {
  const base = { aliases: [], keywords: [], status: 'done' };
  const projects: Project[] = [
    { ...base, id: 'a1', title: 'A', merged_into: 'b1' }, { ...base, id: 'b1', title: 'B', merged_into: 'c1' }, { ...base, id: 'c1', title: 'C', status: 'active' },
    { ...base, id: 'x1', title: 'X', merged_into: 'y1' }, { ...base, id: 'y1', title: 'Y', merged_into: 'x1' }, { ...base, id: 'z1', title: 'Z', merged_into: 'gone' }, { ...base, id: 's1', title: 'S', merged_into: 's1' },
  ];
  expect([...mergeTargets(projects)]).toEqual([['a1', 'c1'], ['b1', 'c1']]);
  expect(resolveProject(projects, 'a1')).toBe('c1');
  expect(resolveProject(projects, 'x1')).toBe('x1');
  expect(resolveProject(projects, undefined)).toBeUndefined();
  expect(mergedSources(projects, 'c1')).toEqual(['a1', 'b1']);
  const issues = mergeIssues(projects);
  expect(issues).toHaveLength(5);
  expect(issues.filter(i => i.startsWith('統合先が循環しています'))).toHaveLength(3);
  expect(issues.some(i => i.startsWith('統合先のプロジェクトが見つかりません: 10_projects/z1/project.md'))).toBe(true);
  expect(issues.some(i => i.startsWith('統合先がさらに統合されています（c1として読み替えています）: 10_projects/a1/project.md'))).toBe(true);
  // 統合済みのプロジェクトは、本人が指定しない限りAIへ帰属候補として渡さない。
  expect(candidateProjects([{ ...base, id: 'm1', title: 'M', status: 'active', merged_into: 'c1' }, projects[2]!]).map(p => p.id)).toEqual(['c1']);
});

test('状態と統合先の行だけを書き換え、ほかのキー・コメント・本文を保つ', () => {
  const raw = '---\r\nid: tool\r\ntitle: まとめツール # 名前\r\naliases: [まとめ]\r\nkeywords: []\r\nstatus: paused\r\nowner: me\r\n---\r\n# 本文\r\n';
  const merged = withMergeState(raw, { status: 'done', mergedInto: 'hub' });
  expect(merged).toBe('---\r\nid: tool\r\ntitle: まとめツール # 名前\r\naliases: [まとめ]\r\nkeywords: []\r\nstatus: done\r\nowner: me\r\nmerged_into: hub\r\n---\r\n# 本文\r\n');
  expect(withMergeState(merged, { status: 'paused' })).toBe(raw);
  // 旧版の自由記述の状態も、YAMLとして読める形で戻す。
  expect(parseMarkdown(withMergeState(merged, { status: '検討中: 保留 #1' })).meta.status).toBe('検討中: 保留 #1');
  expect(() => withMergeState('本文だけ', { status: 'done' })).toThrow('frontmatter');
});

test('統合先に足す語は、既にある語・長すぎる語・上限を超える分を除く', () => {
  const into: Project = { id: 'hub', title: '集約ツール', aliases: ['ハブ'], keywords: ['集約'], status: 'active' };
  expect(mergedTerms({ id: 'tool', title: 'まとめツール', aliases: ['まとめ', 'ﾊﾌﾞ', ' HUB '], keywords: ['まとめる', '集約'], status: 'active' }, into)).toEqual({ aliases: ['まとめツール', 'まとめ'], keywords: ['まとめる'] });
  expect(mergedTerms({ id: 'tool', title: 'あ'.repeat(150), aliases: ['まとめ'], keywords: [], status: 'active' }, into).aliases).toEqual(['まとめ']);
  const full: Project = { ...into, aliases: Array.from({ length: 49 }, (_, i) => `別名${i}`) };
  expect(mergedTerms({ id: 'tool', title: 'まとめツール', aliases: ['まとめ'], keywords: [], status: 'active' }, full).aliases).toEqual(['まとめツール']);
});

test('統合すると、統合元の入力・AI推定の関連・完了報告・日付を統合先のものとして読み、原文と記録は書き換えない', async () => {
  const { config, vault, old, memo, guessed, latest } = await fixture();
  // 統合前に、統合元の未解決を1件解決し、もう1件に期日を付けておく。
  const before = (await readNowItems(vault, 'tool'))!.items.filter(i => i.section === 'open');
  const solved = before.find(i => i.text === '配布方法が決まっていない')!, dated = before.find(i => i.text === '名前が決まっていない')!;
  const resolution = await setItemResolution(config, { projectId: 'tool', itemKey: solved.key, action: 'resolve', source: 'cli' });
  await setItemSchedule(config, { projectId: 'tool', itemKey: dated.key, due: '2026-12-01', reviewAfter: null, source: 'cli' });
  const rawInputs = await Promise.all([old, memo, guessed].map(async i => vault.read(i.path)));
  const rawReceipts = await Promise.all([old, memo, guessed].map(async i => vault.read(`90_system/receipts/${i.inputId}.json`)));

  const result = await merge(config, vault);
  expect(result).toMatchObject({ fromId: 'tool', intoId: 'hub', action: 'merge', aliases: ['まとめツール', 'まとめ'], keywords: ['まとめる'], deduped: false });
  expect(parseMarkdown(await definition(vault, 'tool')).meta).toMatchObject({ id: 'tool', title: 'まとめツール', status: 'done', merged_into: 'hub' });
  expect(parseMarkdown(await definition(vault, 'hub')).meta).toMatchObject({ aliases: ['ハブ', 'まとめツール', 'まとめ'], keywords: ['集約', 'まとめる'], status: 'active' });
  expect(await readProjectMerges(vault)).toMatchObject([{ id: result.mergeId, action: 'merge', from_id: 'tool', into_id: 'hub', from_status: 'active', aliases: ['まとめツール', 'まとめ'], keywords: ['まとめる'] }]);
  // 原文と処理記録、完了報告の記録はそのまま。
  expect(await Promise.all([old, memo, guessed].map(async i => vault.read(i.path)))).toEqual(rawInputs);
  expect(await Promise.all([old, memo, guessed].map(async i => vault.read(`90_system/receipts/${i.inputId}.json`)))).toEqual(rawReceipts);
  expect((await readItemResolutions(vault, { raw: true }))[0]).toMatchObject({ id: resolution.resolutionId, project_id: 'tool', item_key: solved.key });

  // 統合先のNOWは、統合元の入力も根拠にする。本人が統合元を指定したメモには帰属候補の印を付けない。
  const now = (await vault.read('10_projects/hub/NOW.md'))!;
  expect(parseMarkdown(now).meta.input_ids).toEqual([old.inputId, memo.inputId, guessed.inputId, latest.inputId]);
  expect(now).toMatch(new RegExp(`- 未解決: 名前が決まっていない \\[${old.inputId}\\][^\\n]*利用者メモ・未検証\\]? — 期日 2026-12-01|- 未解決: 名前が決まっていない \\[${old.inputId}\\][^\\n]* — 期日 2026-12-01`));
  expect(now).not.toMatch(new RegExp(`\\[${old.inputId}\\][^\\n]*帰属候補`));
  expect(now).toMatch(new RegExp(`- 解決: 未解決: 配布方法が決まっていない \\[${old.inputId}\\][^\\n]* — 本人報告 [^\\n]* ${resolution.resolutionId}`));
  const items = (await readNowItems(vault, 'hub'))!.items;
  expect(items.find(i => i.text === '配布方法が決まっていない')).toMatchObject({ resolution: { id: resolution.resolutionId } });
  expect(items.find(i => i.text === '名前が決まっていない')).toMatchObject({ resolution: null, schedule: { due: '2026-12-01' } });
  // 統合元のNOWからは根拠がなくなる。
  expect(parseMarkdown((await vault.read('10_projects/tool/NOW.md'))!).meta.input_ids).toEqual([]);
  expect((await readNowItems(vault, 'tool'))!.items).toEqual([]);

  // HOME・検索・再開・経緯・資料は統合先として扱う。
  await runCycle(config, new MockLlm());
  const home = (await vault.read('HOME.md'))!;
  expect(home).toMatch(/## 統合済み（1件）\n[^\n]+\n- \[まとめツール\]\(10_projects\/tool\/project\.md\) — tool \/ 統合先: \[集約ツール\]\(10_projects\/hub\/NOW\.md\)（hub）/);
  expect(home).not.toMatch(/## 休止・完了/);
  const found = await find(config, '', { project: 'tool', kinds: ['memo', 'work-summary'] });
  for (const id of [old.inputId, memo.inputId, latest.inputId]) expect(found).toContain(id);
  expect(found).toMatch(new RegExp(`${guessed.inputId}[\\s\\S]*関連候補（AI推定、帰属未確定）`));
  expect(await resume(config, 'tool')).toMatch(/^注意: まとめツール（tool）は統合済みです。統合先の現在地を示します。\n\n# 集約ツール/);
  const history = await buildHistory(config, 'hub');
  expect(history).toContain(`まとめツール（tool）を統合した。統合元の入力・完了報告・日付をこのプロジェクトのものとして読み替える（${result.mergeId}）`);
  expect(history).toMatch(/入力 4件 \/ 完了・解決の報告 1件/);
  const fromHistory = await buildHistory(config, 'tool');
  expect(fromHistory).toContain('状態: 統合済み（統合先: 集約ツール（hub））');
  expect(fromHistory).toContain(`集約ツール（hub）へ統合した。入力・完了報告・日付は統合先のものとして読み替える（${result.mergeId}）`);
  expect(fromHistory).toContain('統合先の[NOW](../hub/NOW.md)を参照してください');
  expect(await buildReferences(config, 'hub')).toContain('<https://example.com/spec>');
  expect((await doctor(config)).issues).toEqual([]);
});

test('統合後に統合元を指定して届いたメモも、統合先の入力として整理する', async () => {
  const { config, vault } = await fixture();
  await merge(config, vault);
  const late = await capture(config, { source: 'cli', project: 'tool', ...at('2026-10-10T01:00:00Z'), text: '統合の前に別の端末で書いたメモ' });
  const unnamed = await capture(config, { source: 'cli', ...at('2026-10-11T01:00:00Z'), text: 'まとめツールの名前でまだ書いてしまう' });
  const seen: string[] = [];
  const llm = new MockLlm();
  await organize(config, { complete: async (prompt, opts) => { seen.push(prompt); return llm.complete(prompt, opts); } });
  const now = (await vault.read('10_projects/hub/NOW.md'))!;
  expect(parseMarkdown(now).meta.input_ids).toContain(late.inputId);
  expect(parseMarkdown(now).meta.input_ids).toContain(unnamed.inputId);
  // モデルには統合先だけを候補として見せ、本人の指定も統合先として示す。
  const prompt = seen.find(p => p.includes('別の端末で書いたメモ'))!;
  const data = JSON.parse(prompt.slice(prompt.indexOf('入力データ(JSON):\n') + '入力データ(JSON):\n'.length));
  expect(data.metadata.project).toBe('hub');
  expect(data.existing_projects.map((p: { id: string }) => p.id)).toEqual(['hub']);
  expect((await doctor(config)).issues).toEqual([]);
});

test('統合を取り消すと、統合元の状態・帰属・完了報告が元に戻り、統合で足した語のうち残っているものだけを外す', async () => {
  const { config, vault, old, memo } = await fixture();
  await setProjectStatus(config, { projectId: 'tool', status: 'paused', expectedHash: hash(await definition(vault, 'tool')), source: 'cli' });
  const original = await definition(vault, 'tool');
  const open = (await readNowItems(vault, 'tool'))!.items.find(i => i.text === '配布方法が決まっていない')!;
  await setItemResolution(config, { projectId: 'tool', itemKey: open.key, action: 'resolve', source: 'cli' });
  const merged = await merge(config, vault);
  // 統合の後に、本人が足された別名の1つを外し、別の語を足した。
  await setProjectDefinition(config, { projectId: 'hub', expectedHash: hash(await definition(vault, 'hub')), title: '集約ツール', aliases: ['ハブ', 'まとめツール', '手で足した別名'], keywords: ['集約', 'まとめる'], source: 'cli' });

  const result = await unmergeProject(config, { fromId: 'tool', intoId: 'hub', ...await hashes(vault, 'tool', 'hub'), source: 'cli' });
  expect(result).toMatchObject({ action: 'unmerge', aliases: ['まとめツール'], keywords: ['まとめる'], deduped: false });
  expect(await definition(vault, 'tool')).toBe(original);
  expect(parseMarkdown(await definition(vault, 'hub')).meta).toMatchObject({ aliases: ['ハブ', '手で足した別名'], keywords: ['集約'] });
  expect((await readProjectMerges(vault)).at(-1)).toMatchObject({ action: 'unmerge', from_status: 'paused', merge_id: merged.mergeId });
  expect(parseMarkdown((await vault.read('10_projects/tool/NOW.md'))!).meta.input_ids).toEqual(expect.arrayContaining([old.inputId, memo.inputId]));
  expect(parseMarkdown((await vault.read('10_projects/hub/NOW.md'))!).meta.input_ids).not.toContain(old.inputId);
  expect((await readNowItems(vault, 'tool'))!.items.find(i => i.key === open.key)).toMatchObject({ resolution: expect.anything() });
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).not.toContain('## 統合済み');
  await expect(unmergeProject(config, { fromId: 'tool', intoId: 'hub', ...await hashes(vault, 'tool', 'hub'), source: 'cli' })).rejects.toMatchObject({ reason: { code: 'project-merge-refused', cause: 'not-merged' } });
  expect((await doctor(config)).issues).toEqual([]);
});

test('同じ統合先に統合されたままのプロジェクトが持つ語は、取り消しで外さない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await addProject(config, { id: 'tool', title: 'まとめツール', aliases: ['共通の別名'] });
  await addProject(config, { id: 'kit', title: '道具箱', aliases: ['共通の別名'] });
  await merge(config, vault, 'tool', 'hub');
  await merge(config, vault, 'kit', 'hub');
  expect(parseMarkdown(await definition(vault, 'hub')).meta.aliases).toEqual(['まとめツール', '共通の別名', '道具箱']);
  await unmergeProject(config, { fromId: 'tool', intoId: 'hub', ...await hashes(vault, 'tool', 'hub'), source: 'cli' });
  expect(parseMarkdown(await definition(vault, 'hub')).meta.aliases).toEqual(['共通の別名', '道具箱']);
});

test('確認したハッシュが違う・統合先が統合済み・ほかの統合元がある場合は統合せず、理由を示す', async () => {
  const { config, vault } = await fixture();
  await addProject(config, { id: 'third', title: '三つ目' });
  const good = await hashes(vault, 'tool', 'hub');
  const refused = (cause: string) => ({ reason: expect.objectContaining({ code: 'project-merge-refused', cause }) });
  await expect(mergeProjects(config, { fromId: 'tool', intoId: 'hub', ...good, fromHash: '0'.repeat(64), source: 'cli' })).rejects.toMatchObject({ reason: { code: 'project-merge-changed' } });
  await expect(mergeProjects(config, { fromId: 'tool', intoId: 'hub', ...good, intoHash: '0'.repeat(64), source: 'cli' })).rejects.toBeInstanceOf(ProjectMergeError);
  await expect(mergeProjects(config, { fromId: 'tool', intoId: 'tool', ...good, source: 'cli' })).rejects.toMatchObject(refused('same'));
  await expect(mergeProjects(config, { fromId: 'tool', intoId: 'missing', ...good, source: 'cli' })).rejects.toMatchObject(refused('missing'));
  expect(await readProjectMerges(vault)).toEqual([]);
  await merge(config, vault);
  await expect(merge(config, vault, 'tool', 'third')).rejects.toMatchObject(refused('already-merged'));
  await expect(merge(config, vault, 'third', 'tool')).rejects.toMatchObject(refused('target-merged'));
  await expect(merge(config, vault, 'hub', 'third')).rejects.toMatchObject(refused('has-sources'));
  await expect(unmergeProject(config, { fromId: 'tool', intoId: 'third', ...await hashes(vault, 'tool', 'third'), source: 'cli' })).rejects.toMatchObject(refused('target-mismatch'));
  expect(await readProjectMerges(vault)).toHaveLength(1);
});

test('統合済みのプロジェクトへの状態・定義・項目の操作は、統合先を示して止める', async () => {
  const { config, vault } = await fixture();
  const item = (await readNowItems(vault, 'tool'))!.items.find(i => i.section === 'open')!;
  await merge(config, vault);
  const current = hash(await definition(vault, 'tool')), merged = { reason: { code: 'project-merged', project_id: 'hub' } };
  await expect(setProjectStatus(config, { projectId: 'tool', status: 'active', expectedHash: current, source: 'cli' })).rejects.toMatchObject(merged);
  await expect(setProjectDefinition(config, { projectId: 'tool', expectedHash: current, title: '別の名前', aliases: [], keywords: [], source: 'cli' })).rejects.toBeInstanceOf(ProjectMergedError);
  await expect(setItemResolution(config, { projectId: 'tool', itemKey: item.key, action: 'resolve', source: 'cli' })).rejects.toMatchObject(merged);
  await expect(setItemSchedule(config, { projectId: 'tool', itemKey: item.key, due: '2026-12-01', reviewAfter: null, source: 'cli' })).rejects.toMatchObject(merged);
  // 統合先の同じ項目には、統合先のキーで操作できる。
  const moved = (await readNowItems(vault, 'hub'))!.items.find(i => i.text === item.text)!;
  expect(moved.key).not.toBe(item.key);
  await expect(setItemResolution(config, { projectId: 'hub', itemKey: moved.key, action: 'resolve', source: 'cli' })).resolves.toMatchObject({ deduped: false });
});

test('記録の後・定義の書き込み前に止まっても、同じ受付IDの再送で統合を完了する', async () => {
  const { config, vault } = await fixture();
  const fromBefore = await definition(vault, 'tool'), intoBefore = await definition(vault, 'hub'), request = { fromId: 'tool', intoId: 'hub', fromHash: hash(fromBefore), intoHash: hash(intoBefore), source: 'quickadd', sourceEventId: 'REQ-1' };
  const first = await mergeProjects(config, request);
  const fromAfter = await definition(vault, 'tool'), intoAfter = await definition(vault, 'hub');
  // 統合先だけ、続いて両方が書き込み前の状態に戻った停止を再現する。
  for (const stopped of [[fromAfter, intoBefore], [fromBefore, intoBefore]] as const) {
    await vault.write('10_projects/tool/project.md', stopped[0]); await vault.write('10_projects/hub/project.md', stopped[1]);
    expect(await mergeProjects(config, request)).toMatchObject({ mergeId: first.mergeId, deduped: true });
    expect(await definition(vault, 'tool')).toBe(fromAfter);
    expect(await definition(vault, 'hub')).toBe(intoAfter);
  }
  expect(await mergeProjects(config, request)).toMatchObject({ mergeId: first.mergeId, deduped: true });
  expect(await readProjectMerges(vault)).toHaveLength(1);
  // 同じ受付IDで別の内容は受け付けず、止まっている間に定義が変わっていれば書き込まない。
  await expect(mergeProjects(config, { ...request, intoId: 'tool', fromId: 'hub' })).rejects.toThrow('同じ受付IDで別の統合の操作が記録されています');
  await vault.write('10_projects/hub/project.md', intoBefore.replace('人が保守するプロジェクト定義です。', '手で書き足した'));
  await expect(mergeProjects(config, request)).rejects.toMatchObject({ reason: { code: 'project-merge-changed' } });
});

test('Inputからの統合と取り消しを受け付け、確認後に定義が変わっていれば理由を記録する', async () => {
  const { config, vault } = await fixture();
  const fields = async () => { const h = await hashes(vault, 'tool', 'hub'); return { project_id: 'tool', project_hash: h.fromHash, into_id: 'hub', into_hash: h.intoHash, confirmed: true }; };
  const stale = await packet(config, { operation: 'project-merge', ...await fields(), into_hash: '0'.repeat(64) }, '');
  expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 1 });
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(stale.path)}.json`))!));
  expect(error.reason).toEqual({ code: 'project-merge-changed' });
  expect(intakeErrorMessage(error)).toContain('確認した後にプロジェクト定義が変更されています');
  await vault.remove(stale.path);

  const request = await packet(config, { operation: 'project-merge', ...await fields() }, '');
  expect(await ingest(config)).toMatchObject({ accepted: 1 });
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === request.requestId)!;
  expect(receipt).toMatchObject({ operation: 'project-merge', result: { fromId: 'tool', intoId: 'hub', action: 'merge', deduped: false } });
  expect((await readProjects(config)).find(p => p.id === 'tool')).toMatchObject({ status: 'done', merged_into: 'hub' });
  // 統合済みのプロジェクトへの状態変更の依頼には、統合先を示す理由を記録する。
  const status = await packet(config, { operation: 'project-status', project_id: 'tool', project_hash: hash(await definition(vault, 'tool')), status: 'active', confirmed: true }, '');
  await ingest(config);
  const refused = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(status.path)}.json`))!));
  expect(refused.reason).toEqual({ code: 'project-merged', project_id: 'hub' });
  expect(intakeErrorMessage(refused)).toContain('hubに統合されています');
  await vault.remove(status.path);

  const undo = await packet(config, { operation: 'project-unmerge', ...await fields() }, '');
  expect(await ingest(config)).toMatchObject({ accepted: 1 });
  expect((await readIntakeReceipts(config)).find(r => r.request_id === undo.requestId)).toMatchObject({ operation: 'project-unmerge', result: { action: 'unmerge' } });
  expect((await readProjects(config)).find(p => p.id === 'tool')).toEqual(expect.not.objectContaining({ merged_into: expect.anything() }));
  // 本文のある依頼・確認のない依頼は受け付けない。
  await packet(config, { operation: 'project-merge', ...await fields() }, '本文は不可');
  await packet(config, { operation: 'project-merge', ...await fields(), confirmed: false }, '');
  expect((await ingest(config)).rejected).toBe(2);
});

test('手で書いた統合先の不整合はHOMEとdoctorに示し、そのプロジェクトのまま読む', async () => {
  const { config, vault } = await fixture();
  await vault.write('10_projects/tool/project.md', (await definition(vault, 'tool')).replace('status: active', 'status: active\nmerged_into: gone'));
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('統合先のプロジェクトが見つかりません: 10_projects/tool/project.md（merged\\_into: gone）'.replace('\\_', '_'));
  expect((await doctor(config)).issues).toContain('統合先のプロジェクトが見つかりません: 10_projects/tool/project.md（merged_into: gone）');
  expect(await find(config, '', { project: 'tool', kinds: ['work-summary'] })).not.toBe('見つかりません');
});
