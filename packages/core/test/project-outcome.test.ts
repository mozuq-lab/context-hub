import { afterEach, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { Vault, hash, parseMarkdown } from '../src/storage.js';
import { addProject, readProjects, normalizeOutcome, outcomeLines } from '../src/projects.js';
import { setProjectDefinition, readProjectDefinitionChanges, withDefinition } from '../src/project-definition.js';
import { ingest, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { runCycle } from '../src/cycle.js';
import { MockLlm, buildOrganizePrompt } from '../src/llm.js';
import { doctor } from '../src/doctor.js';
import { resume, context } from '../src/retrieve.js';
import { buildDigest } from '../src/digest.js';
import { buildHistory } from '../src/history.js';
import { projectRegistryHash } from '../src/associations.js';
import { createProject } from '../src/project-creations.js';
import { decideProject, listProjectCandidates } from '../src/project-proposals.js';
import type { Input } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const path = '10_projects/garden/project.md';
const read = async (vault: Vault) => (await vault.read(path))!;
const summary = '## 現在地\n- [確認済み] 苗を育てている\n## 次の一手\n- [確認済み] 水やりの当番を決める';

test('望む結果を正規化し、上限と使えない文字は受け付けない', () => {
  expect(normalizeOutcome('  夏に収穫する \r\n\r\n\t家族で食べる  ')).toBe('夏に収穫する\n家族で食べる');
  expect(normalizeOutcome(' \n ')).toBe('');
  expect(() => normalizeOutcome('あ'.repeat(501))).toThrow('500文字');
  expect(() => normalizeOutcome(Array.from({ length: 11 }, (_, i) => `${i}`).join('\n'))).toThrow('10行');
  expect(() => normalizeOutcome('ベル\u0007')).toThrow('使えない文字');
  // 表示では箇条書きの印を外す（「-5kg」のような文は残す）。
  expect(outcomeLines('- 収穫する\n・食べる\n-5kg減らす\n\n')).toEqual(['収穫する', '食べる', '-5kg減らす']);
});

test('望む結果を追加・変更・削除でき、ほかの行・コメント・本文は保ち、指定しない変更では消さない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園', aliases: ['菜園'] });
  await vault.write(path, (await read(vault)).replace('status: active', 'status: active # 手で書いたコメント\nowner: 本人').replace('人が保守するプロジェクト定義です。', '手で書いたメモ'));
  const base = { projectId: 'garden', title: '家庭菜園', aliases: ['菜園'], keywords: [], source: 'cli' };
  // 追加（複数行はブロックで書く）。
  const added = await setProjectDefinition(config, { ...base, outcome: ' 夏にトマトを収穫する\n家族で食べる ', expectedHash: hash(await read(vault)) });
  expect(added.changed).toEqual(['outcome']);
  let saved = await read(vault);
  expect(saved).toContain('outcome: |-\n  夏にトマトを収穫する\n  家族で食べる\n');
  expect(saved).toContain('# 手で書いたコメント');
  expect(parseMarkdown(saved).text).toContain('手で書いたメモ');
  expect((await readProjects(config))[0]).toMatchObject({ outcome: '夏にトマトを収穫する\n家族で食べる' });
  // 望む結果を送らない変更（対応していない版のアプリ・CLI）は、望む結果を消さない。
  await setProjectDefinition(config, { ...base, aliases: ['菜園', '畑'], expectedHash: hash(saved) });
  saved = await read(vault);
  expect((await readProjects(config))[0]).toMatchObject({ aliases: ['菜園', '畑'], outcome: '夏にトマトを収穫する\n家族で食べる' });
  // 同じ文は変更なし。
  await expect(setProjectDefinition(config, { ...base, aliases: ['菜園', '畑'], outcome: '夏にトマトを収穫する\n家族で食べる', expectedHash: hash(saved) })).rejects.toThrow('望む結果に変更がありません');
  // 変更（1行）。
  await setProjectDefinition(config, { ...base, aliases: ['菜園', '畑'], outcome: 'トマト: 10個', expectedHash: hash(saved) });
  saved = await read(vault);
  expect(saved).toContain('outcome: "トマト: 10個"\n');
  expect(saved).not.toContain('家族で食べる');
  // 確認後に定義が変わっていたら受け付けない。
  await expect(setProjectDefinition(config, { ...base, outcome: '別の文', expectedHash: hash(saved.replace('トマト', 'ナス')) })).rejects.toThrow('変更されています');
  await expect(setProjectDefinition(config, { ...base, outcome: 'あ'.repeat(501), expectedHash: hash(saved) })).rejects.toThrow('500文字');
  // 削除（行ごと外す）。
  const removed = await setProjectDefinition(config, { ...base, aliases: ['菜園', '畑'], outcome: '', expectedHash: hash(saved) });
  expect(removed.changed).toEqual(['outcome']);
  saved = await read(vault);
  expect(saved).not.toContain('outcome');
  expect(saved).toContain('status: active # 手で書いたコメント\nowner: 本人');
  expect((await readProjects(config))[0]!.outcome).toBeUndefined();
  const changes = await readProjectDefinitionChanges(vault);
  expect(changes.map(c => [c.before.outcome, c.after.outcome])).toEqual([[undefined, '夏にトマトを収穫する\n家族で食べる'], ['夏にトマトを収穫する\n家族で食べる', undefined], ['夏にトマトを収穫する\n家族で食べる', 'トマト: 10個'], ['トマト: 10個', '']]);
  // 経緯に変更が残る。
  const history = await buildHistory(config, 'garden');
  expect(history).toContain('望む結果を記入「夏にトマトを収穫する / 家族で食べる」');
  expect(history).toContain('望む結果を変更「トマト: 10個」');
  expect(history).toContain('望む結果を外した');
});

test('手で書いた望む結果（空・null・ブロック・改行コードCRLF）を読み、書き換えでは続きの行ごと置き換える', async () => {
  const raw = '---\r\nid: garden\r\ntitle: 家庭菜園\r\noutcome: |\r\n  一行目\r\n\r\n  二行目\r\n# 次のコメント\r\naliases: []\r\nkeywords: []\r\nstatus: active\r\n---\r\n本文\r\n';
  const next = withDefinition(raw, { title: '家庭菜園', aliases: [], keywords: [], outcome: '新しい文' });
  expect(next).toBe('---\r\nid: garden\r\ntitle: 家庭菜園\r\noutcome: 新しい文\r\n# 次のコメント\r\naliases: []\r\nkeywords: []\r\nstatus: active\r\n---\r\n本文\r\n');
  expect(withDefinition(raw, { title: '家庭菜園', aliases: [], keywords: [], outcome: '' })).toBe('---\r\nid: garden\r\ntitle: 家庭菜園\r\n# 次のコメント\r\naliases: []\r\nkeywords: []\r\nstatus: active\r\n---\r\n本文\r\n');
  // 指定しなければ触らない。
  expect(withDefinition(raw, { title: '家庭菜園', aliases: [], keywords: [] })).toBe(raw);
  // 引用符が要る複数行の文も元の文に戻る形で書く。
  const tricky = withDefinition('---\nid: garden\ntitle: g\naliases: []\nkeywords: []\nstatus: active\n---\n', { title: 'g', aliases: [], keywords: [], outcome: '"引用"\n#見出しではない' });
  expect(parseMarkdown(tricky).meta.outcome).toBe('"引用"\n#見出しではない');

  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  await addProject(config, { id: 'work', title: '仕事' });
  for (const value of ['outcome:', 'outcome: ""', 'outcome: null']) {
    await vault.write(path, (await read(vault)).replace(/\noutcome:[^\n]*/, '').replace('status: active', `status: active\n${value}`));
    expect((await readProjects(config)).find(p => p.id === 'garden')!.outcome).toBeUndefined();
  }
  // 望む結果のない既存の定義も、手で書いた上限超えの文も読める。上限超えはdoctorで示す。
  await vault.write(path, (await read(vault)).replace(/\noutcome:[^\n]*/, '').replace('status: active', `status: active\noutcome: ${'長'.repeat(501)}`));
  expect((await readProjects(config)).find(p => p.id === 'garden')!.outcome).toHaveLength(501);
  const issues = (await doctor(config)).issues;
  expect(issues.filter(i => i.includes('望む結果'))).toEqual(['望む結果は500文字・10行までにしてください（AIへは先頭の500文字だけを渡します）: 10_projects/garden/project.md']);
  expect(issues.join(' ')).not.toContain('プロジェクト定義が不正です');
  // 文字列でない値は、ほかの項目と同じく不正な定義。
  await vault.write(path, (await read(vault)).replace(/\noutcome:[^\n]*/, '\noutcome: [a, b]'));
  await expect(readProjects(config)).rejects.toThrow('望む結果（outcome）');
});

test('望む結果を整理と再関連付けのAIへ渡し、書いていない定義の登録簿ハッシュは変えない', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  const before = await readProjects(config);
  // 対応前と同じハッシュ（outcomeのキーを含めない）。
  expect(projectRegistryHash(before)).toBe(hash(JSON.stringify([{ id: 'garden', title: '家庭菜園', aliases: [], keywords: [], status: 'active' }])));
  const input = { id: 'IN-01J00000000000000000000000', kind: 'memo', source: 'cli', occurred_at: '2026-10-01T10:00:00Z', received_at: '2026-10-01T10:00:00Z', origin: 'user-note', text: '苗を買った', path: '00_inbox/x.md' } as Input;
  expect(buildOrganizePrompt(input, before)).not.toContain('outcome');
  await setProjectDefinition(config, { projectId: 'garden', title: '家庭菜園', aliases: [], keywords: [], outcome: '- 夏に収穫する', expectedHash: hash(await read(vault)), source: 'cli' });
  const after = await readProjects(config);
  expect(projectRegistryHash(after)).not.toBe(projectRegistryHash(before));
  const prompt = buildOrganizePrompt(input, after);
  expect(prompt).toContain('"outcome":"夏に収穫する"');
  expect(prompt).toContain('existing_projectsのoutcomeは、本人が書いたそのプロジェクトの望む結果');
});

test('望む結果を書き換えると、帰属未確定のメモを次の整理で関連付け直す', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '庭仕事' });
  await capture(config, { source: 'cli', occurredAt: '2026-10-01T10:00:00Z', text: 'トマトの苗を植えた' });
  await organize(config, new MockLlm());
  const llm = { complete: vi.fn(async (prompt: string) => ({ text: JSON.stringify({ project_candidates: prompt.includes('トマト') && prompt.includes('"outcome"') ? [{ id: 'garden', confidence: 0.9 }] : [] }) })) };
  await setProjectDefinition(config, { projectId: 'garden', title: '庭仕事', aliases: [], keywords: [], outcome: 'トマトを収穫する', expectedHash: hash(await read(vault)), source: 'cli' });
  await organize(config, llm as never);
  expect(llm.complete).toHaveBeenCalledTimes(1);
  expect(llm.complete.mock.calls[0]![0]).toContain('"outcome":"トマトを収穫する"');
});

test('NOW・resume・context・ふりかえりに望む結果を示し、手で書き換えた定義はcycleでNOWに反映する', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  await addProject(config, { id: 'idle', title: '休みの計画' });
  await capture(config, { source: 'cli', kind: 'work-summary', project: 'garden', occurredAt: '2026-10-01T10:00:00Z', text: summary });
  await organize(config, new MockLlm());
  const nowPath = '10_projects/garden/NOW.md';
  expect(await vault.read(nowPath)).not.toContain('望む結果');
  // 書いていないうちは、ふりかえりに「未記入」と件数を示す。
  let digest = await buildDigest(config);
  expect(digest).toContain('- 望む結果が未記入の進行中のプロジェクト: 2件');
  expect(digest).toContain('- 望む結果: 未記入');

  await setProjectDefinition(config, { projectId: 'garden', title: '家庭菜園', aliases: [], keywords: [], outcome: '夏にトマトを収穫する\n<!-- 印ではない -->', expectedHash: hash(await read(vault)), source: 'cli' });
  const now = (await vault.read(nowPath))!;
  expect(now).toContain('<!-- ctx:auto:start -->\n# 望む結果（本人が書いた完了の基準）\n- 夏にトマトを収穫する\n- &lt;!-- 印ではない -->\n\n# 現在地\n');
  const resumed = await resume(config, 'garden');
  expect(resumed.match(/# 望む結果/g)).toHaveLength(1);
  expect(resumed).toContain('# 望む結果（本人が書いた完了の基準）\n- 夏にトマトを収穫する');
  expect(resumed.indexOf('# 望む結果')).toBeLessThan(resumed.indexOf('# 現在地'));
  expect(await context(config, 'garden')).toContain('- 夏にトマトを収穫する');
  // NOWのないプロジェクトのresumeにも示す。
  await setProjectDefinition(config, { projectId: 'idle', title: '休みの計画', aliases: [], keywords: [], outcome: '行き先を決める', expectedHash: hash((await vault.read('10_projects/idle/project.md'))!), source: 'cli' });
  expect(await resume(config, 'idle')).toContain('# 休みの計画\n\n# 望む結果（本人が書いた完了の基準）\n- 行き先を決める\n\n# 現在地\n不明');
  digest = await buildDigest(config);
  expect(digest).not.toContain('望む結果が未記入');
  expect(digest).toContain('- 望む結果: 夏にトマトを収穫する / &lt;!-- 印ではない -->');
  expect(digest).toContain('- 望む結果: 行き先を決める');

  // 手で書き換えた定義は、resumeは今の定義を示し、次のcycleでNOWの欄を合わせる（モデルは呼ばない）。
  await vault.write(path, (await read(vault)).replace(/\noutcome: [\s\S]*?\n---/, '\noutcome: 秋まで続ける\n---'));
  expect(await resume(config, 'garden')).toContain('- 秋まで続ける');
  expect(await resume(config, 'garden')).not.toContain('夏にトマト');
  const llm = { complete: vi.fn(async () => { throw new Error('呼ばない'); }) };
  await runCycle(config, llm);
  expect(llm.complete).not.toHaveBeenCalled();
  expect(await vault.read(nowPath)).toContain('# 望む結果（本人が書いた完了の基準）\n- 秋まで続ける\n\n# 現在地');
  // 外すと欄も消える。
  await vault.write(path, (await read(vault)).replace(/\noutcome: [^\n]*/, ''));
  await runCycle(config, llm);
  expect(await vault.read(nowPath)).not.toContain('望む結果');
});

test('Inputから望む結果を変更・作成・採用でき、送らない変更では消さない', async () => {
  const { config, vault } = await workflowSetup(roots);
  expect(intakeFeatures(config)).toMatchObject({ project_outcome: { max_chars: 500, max_lines: 10 } });
  await addProject(config, { id: 'garden', title: '家庭菜園', outcome: '夏に収穫する' });
  const fields = { operation: 'project-definition', project_id: 'garden', title: '家庭菜園', aliases: ['菜園'], keywords: [], confirmed: true };
  await packet(config, { ...fields, project_hash: hash(await read(vault)), outcome: 'あ'.repeat(501) }, '');
  expect((await ingest(config)).rejected).toBe(1);
  // 望む結果を送らない依頼（対応していない版のアプリ）。
  await packet(config, { ...fields, project_hash: hash(await read(vault)) }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readProjects(config))[0]).toMatchObject({ aliases: ['菜園'], outcome: '夏に収穫する' });
  await packet(config, { ...fields, project_hash: hash(await read(vault)), outcome: '秋まで続ける\n家族で食べる' }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readProjects(config))[0]).toMatchObject({ outcome: '秋まで続ける\n家族で食べる' });
  expect((await readIntakeReceipts(config)).map(r => r.result)).toEqual(expect.arrayContaining([expect.objectContaining({ changed: ['outcome'] })]));

  // 作成。
  const id = 'project-01jabcdefghjkmnpqrstvwxyz0';
  await packet(config, { operation: 'project-create', project_id: id, title: '読書', aliases: [], keywords: [], outcome: ' 月に2冊読む ', confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readProjects(config)).find(p => p.id === id)).toMatchObject({ outcome: '月に2冊読む' });
  expect(await buildHistory(config, id)).toContain('プロジェクトを作成: 読書（望む結果: 月に2冊読む）');
  await expect(createProject(config, { projectId: 'project-01jabcdefghjkmnpqrstvwxyz1', title: '別', aliases: [], keywords: [], outcome: 'あ'.repeat(501), occurredAt: '2026-10-03T10:00:00Z', source: 'cli' })).rejects.toThrow('500文字');
  // 却下に望む結果は付けられない。
  await packet(config, { operation: 'project-reject', candidate_id: 'PCAN-' + 'A'.repeat(26), candidate_hash: 'a'.repeat(64), confirmation_token: 'b'.repeat(64), outcome: 'x', confirmed: true }, '');
  expect((await ingest(config)).rejected).toBe(1);
});

test('プロジェクト案の採用で望む結果を書き添えられ、同じ受付の再送は同じ文のときだけ受け付ける', async () => {
  const { config } = await workflowSetup(roots);
  const proposal = { title: '家庭菜園', aliases: ['菜園'], keywords: ['栽培'], rationale: '継続した活動の記録' };
  await capture(config, { source: 'cli', occurredAt: '2026-10-03T10:00:00Z', text: '家庭菜園を始めたい' });
  await organize(config, new MockLlm([{ category: 'idea', summary: '菜園を試したい', project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null, project_proposal: proposal }]));
  const c = (await listProjectCandidates(config))[0]!;
  const request = { candidateId: c.candidateId, expectedHash: c.candidateHash, confirmationToken: c.confirmationToken, action: 'approve' as const, source: 'quickadd', sourceEventId: 'REQ-' + 'a'.repeat(32), confirmed: true as const };
  await expect(decideProject(config, { ...request, action: 'reject', outcome: 'x' })).rejects.toThrow();
  await decideProject(config, { ...request, outcome: '夏に収穫する' });
  expect((await readProjects(config))[0]).toMatchObject({ title: '家庭菜園', outcome: '夏に収穫する' });
  expect(await decideProject(config, { ...request, outcome: ' 夏に収穫する ' })).toMatchObject({ deduped: true });
  expect(await decideProject(config, request)).toMatchObject({ deduped: true });
  await expect(decideProject(config, { ...request, outcome: '別の文' })).rejects.toThrow('異なる承認');
});
