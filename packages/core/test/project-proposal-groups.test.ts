import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault, hash } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { readProjects } from '../src/projects.js';
import { decideProject, listProjectCandidates, type ProjectCandidate } from '../src/project-proposals.js';
import { PROPOSAL_GROUP_MAX, groupProposals, relatedProposals } from '../src/project-proposal-groups.js';
import { readReviewCandidates } from '../src/candidate-review.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { rebuildDigest } from '../src/digest.js';
import { doctor } from '../src/doctor.js';
import { parseIntake } from '../src/intake-format.js';
import { ingest } from '../src/intake.js';
import type { HubConfig, OrganizeResult } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-proposal-groups-')); roots.push(root);
  const config = defaultConfig(join(root, 'vault'), join(root, 'state')), vault = new Vault(config); await vault.init();
  return { config, vault };
}
const proposing = (title: string, aliases: string[] = []): OrganizeResult => ({ category: 'unclassified', summary: `${title}のメモ`, project_candidates: [], next_action_suggestions: [], extracted: { current: [], next: [], open: [] }, knowledge_candidate: null, new_project_hint: null, project_proposal: { title, aliases, keywords: [], rationale: `${title}の取り組みが書かれている` } });
/** プロジェクト案の付いたメモを1件ずつ、発生日時の順に整理する。 */
async function propose(config: HubConfig, titles: (string | [string, string[]])[]): Promise<void> {
  for (const [i, entry] of titles.entries()) {
    const [title, aliases] = typeof entry === 'string' ? [entry, []] : entry;
    await capture(config, { source: 'cli', occurredAt: `2026-10-0${i + 1}T10:00:00Z`, text: `${title}について考えた` });
    await organize(config, new MockLlm([proposing(title, aliases)]));
  }
}
const byTitle = async (config: HubConfig) => new Map((await listProjectCandidates(config)).map(c => [c.proposal.title, c]));
const cover = (c: ProjectCandidate) => ({ candidateId: c.candidateId, expectedHash: c.candidateHash });
const request = (c: ProjectCandidate, action: 'approve' | 'reject', covers?: { candidateId: string; expectedHash: string }[]) => ({ candidateId: c.candidateId, expectedHash: c.candidateHash, confirmationToken: c.confirmationToken, action, source: 'quickadd', sourceEventId: `REQ-${action === 'approve' ? 'a' : 'b'}${c.candidateId.slice(-31)}`, confirmed: true as const, ...(covers ? { covers } : {}) });
const names = (title: string, aliases: string[] = []) => ({ title, aliases });
const papr = (c: ProjectCandidate) => `90_system/project-approvals/PAPR-${c.candidateId.slice(5)}.json`;

describe('同じ対象を指すプロジェクト案の判定', () => {
  test('名前・別名が一致するか、4文字以上の名前がもう一方の名前に含まれる案を同じ対象と見なす', () => {
    expect(relatedProposals(names('家庭菜園'), names('ベランダ栽培', ['家庭菜園']))).toBe(true);
    expect(relatedProposals(names('家庭菜園'), names('家庭菜園の水やり自動化'))).toBe(true);
    expect(relatedProposals(names('家庭菜園の水やり自動化'), names('家庭菜園'))).toBe(true);
    // 全角・半角と大文字・小文字の違いは同じ名前として扱う。
    expect(relatedProposals(names('Ｇａｒｄｅｎ　Ｌｏｇ'), names('garden log 公開'))).toBe(true);
    // 短い語が含まれるだけではまとめない（一致すればまとめる）。
    expect(relatedProposals(names('菜園'), names('菜園の水やり'))).toBe(false);
    expect(relatedProposals(names('菜園'), names('栽培', ['菜園']))).toBe(true);
    expect(relatedProposals(names('家庭菜園'), names('読書記録'))).toBe(false);
  });

  test('別名は一致だけを見る（広い語の別名がほかの案の名前に含まれても、同じ対象と見なさない）', () => {
    expect(relatedProposals(names('確定申告', ['アプリ開発']), names('家計簿アプリ開発'))).toBe(false);
    expect(relatedProposals(names('ベランダ家庭菜園'), names('栽培記録', ['家庭菜園']))).toBe(false);
    expect(relatedProposals(names('栽培記録', ['ベランダ家庭菜園']), names('家庭菜園'))).toBe(false);
    expect(relatedProposals(names('確定申告', ['アプリ開発']), names('家計簿', ['アプリ開発']))).toBe(true);
  });

  const item = (id: string, title: string, generatedAt: string, aliases: string[] = []) => ({ id, proposal: names(title, aliases), generatedAt });
  const shape = (groups: ReturnType<typeof groupProposals<ReturnType<typeof item>>>) => groups.map(g => [g.representative.id, g.duplicates.map(d => d.id)]);

  test('ほかの案と最も多く重なる案（同数なら短い名前、古い案）を代表にし、代表と重なる案を1組にまとめる', () => {
    const groups = groupProposals([
      item('a', '家庭菜園の水やり自動化', '2026-10-01T00:00:00Z'), item('b', '読書記録', '2026-10-02T00:00:00Z'),
      item('c', '家庭菜園', '2026-10-03T00:00:00Z'), item('d', 'ベランダ家庭菜園', '2026-10-04T00:00:00Z'),
    ]);
    expect(shape(groups)).toEqual([['c', ['a', 'd']], ['b', []]]);
    // 2件の組は、名前の短い案を代表にする。同じ長さなら古い案。
    expect(groupProposals([item('x', '家庭菜園の記録', '2026-10-01T00:00:00Z'), item('y', '家庭菜園', '2026-10-02T00:00:00Z')])[0]!.representative.id).toBe('y');
    expect(groupProposals([item('x', '家庭菜園', '2026-10-02T00:00:00Z'), item('y', '家庭菜園', '2026-10-01T00:00:00Z')])[0]!.representative.id).toBe('y');
  });

  test('代表と直接は重ならない案を、ほかの案を介してまとめない', () => {
    // p-q-r-s と順に重なる案。qを代表にするとsはqと重ならないので、同じ組に入れない。
    const chain = [
      item('p', '旅行の計画', '2026-10-01T00:00:00Z'), item('q', '夏の旅行', '2026-10-02T00:00:00Z', ['旅行の計画', '写真の整理']),
      item('r', '写真の整理', '2026-10-03T00:00:00Z', ['アルバム作り']), item('s', 'アルバム作り', '2026-10-04T00:00:00Z'),
    ];
    expect(shape(groupProposals(chain))).toEqual([['q', ['p', 'r']], ['s', []]]);
    // 並べる順が違っても同じ組になる。
    expect(shape(groupProposals([...chain].reverse()))).toEqual([['q', ['p', 'r']], ['s', []]]);
    // 広い語の別名を持つ案を介して、別の取り組みをまとめない。
    expect(shape(groupProposals([item('t', '確定申告', '2026-10-01T00:00:00Z', ['アプリ開発']), item('u', '家計簿アプリ開発', '2026-10-02T00:00:00Z'), item('v', '英語学習アプリ開発', '2026-10-03T00:00:00Z')]))).toEqual([['t', []], ['u', []], ['v', []]]);
  });

  test('代表は、名前の短さより、重なる案の数を先に見て選ぶ', () => {
    // 「家庭菜園の記録」は3件と重なる。名前がいちばん短い「菜園」は1件としか重ならない。
    const items = [
      item('l', '菜園', '2026-10-01T00:00:00Z', ['家庭菜園の記録']), item('a', '家庭菜園の記録', '2026-10-02T00:00:00Z'),
      item('b', '家庭菜園の記録と写真', '2026-10-03T00:00:00Z'), item('c', 'ベランダ家庭菜園の記録', '2026-10-04T00:00:00Z'),
    ];
    expect(shape(groupProposals(items))).toEqual([['a', ['l', 'b', 'c']]]);
  });

  test('組に入った案は、残りの案の重なりの数から除く。結果は渡す順に依存しない', () => {
    // 「写真の整理」は3件と重なるが、うち2件は「旅行」の組に入る。残るのは「写真」との重なりだけなので、名前の短い「写真」が代表になる。
    const items = [
      item('h', '旅行', '2026-10-01T00:00:00Z', ['e1', 'e2', 'e3']), item('a', '旅行A案', '2026-10-02T00:00:00Z', ['e1', 'f1']),
      item('b', '旅行B案', '2026-10-03T00:00:00Z', ['e2', 'f2']), item('c', '旅行C案', '2026-10-04T00:00:00Z', ['e3']),
      item('x', '写真の整理', '2026-10-05T00:00:00Z', ['f1', 'f2', 'g1']), item('y', '写真', '2026-10-06T00:00:00Z', ['g1']),
    ];
    const expected = [['h', ['a', 'b', 'c']], ['y', ['x']]];
    expect(shape(groupProposals(items))).toEqual(expected);
    // 決まった乱数で並べ替えても、同じ組になる。
    let seed = 7; const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 30; round++) {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
      expect(shape(groupProposals(shuffled))).toEqual(expected);
    }
  });

  test('1組にまとめる案は上限までとし、残りは別の組にする', () => {
    const same = Array.from({ length: PROPOSAL_GROUP_MAX + 3 }, (_, i) => item(`i${String(i).padStart(2, '0')}`, '家庭菜園', new Date(Date.UTC(2026, 9, 1, i)).toISOString()));
    const groups = groupProposals(same);
    expect(groups.map(g => [g.representative.id, g.duplicates.length])).toEqual([['i00', PROPOSAL_GROUP_MAX], [`i${PROPOSAL_GROUP_MAX + 1}`, 1]]);
    // まとめるのは古い案から。
    expect(groups[0]!.duplicates.map(d => d.id)).toEqual(same.slice(1, PROPOSAL_GROUP_MAX + 1).map(d => d.id));
  });
});

describe('重複するプロジェクト案をまとめて確認する', () => {
  const titles = ['家庭菜園の水やり自動化', '読書記録', '家庭菜園', 'ベランダ家庭菜園'];

  test('確認待ちの一覧は、同じ対象の案を代表の1件にまとめ、まとめた案を示す', async () => {
    const { config } = await setup(); await propose(config, titles);
    const c = await byTitle(config);
    expect(c.get('家庭菜園')).toMatchObject({ status: 'pending', duplicates: [c.get('家庭菜園の水やり自動化')!.candidateId, c.get('ベランダ家庭菜園')!.candidateId] });
    expect(c.get('ベランダ家庭菜園')).toMatchObject({ status: 'pending', duplicateOf: c.get('家庭菜園')!.candidateId });
    expect(c.get('読書記録')!.duplicateOf).toBeUndefined();
    expect(c.get('読書記録')!.duplicates).toBeUndefined();
    const review = new Map((await readReviewCandidates(config)).map(i => [i.title, i]));
    expect(review.get('家庭菜園')).toMatchObject({ status: 'pending', duplicates: [c.get('家庭菜園の水やり自動化')!.candidateId, c.get('ベランダ家庭菜園')!.candidateId] });
    expect(review.get('家庭菜園の水やり自動化')).toMatchObject({ status: 'pending', duplicateOf: c.get('家庭菜園')!.candidateId });
    expect(review.get('読書記録')).not.toHaveProperty('duplicates');
    expect(review.get('読書記録')).not.toHaveProperty('duplicateOf');
  });

  test('HOMEとふりかえりは、まとめた組を1件として数え、根拠のメモの件数を示す', async () => {
    const { config, vault } = await setup(); await propose(config, titles);
    await rebuildDigest(config); await rebuildDashboard(config);
    const home = (await vault.read('HOME.md'))!;
    expect(home).toContain('## 確認待ち（2件）');
    expect(home).toMatch(/- \[家庭菜園\]\(90_system\/project-candidates\/PCAN-[0-9A-Z]{26}\.md\) — プロジェクト案（根拠のメモ3件。まとめた案: 家庭菜園の水やり自動化、ベランダ家庭菜園） \/ 未承認/);
    expect(home).not.toMatch(/- \[ベランダ家庭菜園\]/);
    expect(home).toMatch(/- \[読書記録\]\([^)]+\) — プロジェクト案 \/ 未承認/);
    const review = (await vault.read('REVIEW.md'))!;
    expect(review).toContain('確認待ちの候補: 2件');
    expect(review).toMatch(/- \[家庭菜園\]\([^)]+\)（根拠のメモ3件）/);
    expect(review).not.toMatch(/- \[ベランダ家庭菜園\]/);
  });

  test('代表の案を承認すると、まとめた案も同じ判断として扱い、確認待ちと要確認に残さない', async () => {
    const { config, vault } = await setup(); await propose(config, titles);
    const c = await byTitle(config), main = c.get('家庭菜園')!, a = c.get('家庭菜園の水やり自動化')!, d = c.get('ベランダ家庭菜園')!;
    await decideProject(config, request(main, 'approve', [cover(a), cover(d)]));
    expect(await readProjects(config)).toMatchObject([{ id: main.projectId, title: '家庭菜園' }]);
    const after = await byTitle(config);
    expect([...after.values()].map(x => [x.proposal.title, x.status]).sort()).toEqual([['ベランダ家庭菜園', 'approved'], ['家庭菜園', 'approved'], ['家庭菜園の水やり自動化', 'approved'], ['読書記録', 'pending']]);
    expect(after.get('ベランダ家庭菜園')).toMatchObject({ coveredBy: main.candidateId });
    // まとめた案に、あとから反対の判断はできない。同じ判断は、代表の案の判断記録へまとめる。
    await expect(decideProject(config, request(d, 'reject'))).rejects.toThrow('異なる承認・却下記録');
    expect(await decideProject(config, request(d, 'approve'))).toEqual({ candidateId: d.candidateId, projectId: main.projectId, decisionId: `PAPR-${main.candidateId.slice(5)}`, deduped: true });
    expect(await readProjects(config)).toHaveLength(1);
    const review = new Map((await readReviewCandidates(config)).map(i => [i.title, i]));
    expect(review.get('ベランダ家庭菜園')).toMatchObject({ status: 'approved', reflected: true, coveredBy: main.candidateId, decisionId: `PAPR-${main.candidateId.slice(5)}`, targetPath: `10_projects/${main.projectId}/project.md`, warnings: [] });
    expect(review.get('ベランダ家庭菜園')!.confirmationToken).toBeUndefined();
    // まとめて判断された案は、代表の案の判断記録に依存する（自分の判断記録はないことを確かめる）。
    expect(review.get('ベランダ家庭菜園')!.dependencies).toMatchObject({ [d.path]: d.candidateHash, [papr(d)]: null, [papr(main)]: hash((await vault.read(papr(main)))!) });
    expect(review.get('家庭菜園')).toMatchObject({ status: 'approved', reflected: true, duplicates: [a.candidateId, d.candidateId] });
    await rebuildDashboard(config);
    const home = (await vault.read('HOME.md'))!;
    expect(home).toContain('## 確認待ち（1件）');
    expect(home).toContain('## 要確認（0件）');
    expect(home).toMatch(/- \[ベランダ家庭菜園\]\([^)]+\) — プロジェクト案 \/ 承認済み・反映済み（「家庭菜園」とまとめて判断）/);
  });

  test('代表の案を却下すると、まとめた案も却下として扱う', async () => {
    const { config, vault } = await setup(); await propose(config, titles);
    const c = await byTitle(config), main = c.get('家庭菜園')!;
    await decideProject(config, request(main, 'reject', [cover(c.get('家庭菜園の水やり自動化')!), cover(c.get('ベランダ家庭菜園')!)]));
    expect(await readProjects(config)).toHaveLength(0);
    expect([...(await byTitle(config)).values()].map(x => [x.proposal.title, x.status]).sort()).toEqual([['ベランダ家庭菜園', 'rejected'], ['家庭菜園', 'rejected'], ['家庭菜園の水やり自動化', 'rejected'], ['読書記録', 'pending']]);
    const review = new Map((await readReviewCandidates(config)).map(i => [i.title, i]));
    expect(review.get('家庭菜園の水やり自動化')).toMatchObject({ status: 'rejected', reflected: true, coveredBy: main.candidateId });
    // 同じ判断の再送は、同じ記録へまとめる。
    expect(await decideProject(config, request(main, 'reject', [cover(c.get('家庭菜園の水やり自動化')!), cover(c.get('ベランダ家庭菜園')!)]))).toMatchObject({ deduped: true });
    // まとめる案の並びが違うだけの再送も、同じ判断として扱う。
    expect(await decideProject(config, request(main, 'reject', [cover(c.get('ベランダ家庭菜園')!), cover(c.get('家庭菜園の水やり自動化')!)]))).toMatchObject({ deduped: true });
    // 記録した案の一部だけを添えた再送と、添えない再送（QuickAdd・CLI・対応前のアプリ）も、同じ判断として扱う。
    expect(await decideProject(config, request(main, 'reject', [cover(c.get('ベランダ家庭菜園')!)]))).toMatchObject({ deduped: true });
    expect(await decideProject(config, request(main, 'reject'))).toMatchObject({ deduped: true });
    // 記録にない案を添えた再送、内容の違う案を添えた再送、反対の判断は受け付けない。
    await expect(decideProject(config, request(main, 'reject', [cover(c.get('家庭菜園の水やり自動化')!), cover(c.get('読書記録')!)]))).rejects.toThrow('異なる承認・却下記録');
    await expect(decideProject(config, request(main, 'reject', [{ ...cover(c.get('家庭菜園の水やり自動化')!), expectedHash: '0'.repeat(64) }, cover(c.get('ベランダ家庭菜園')!)]))).rejects.toThrow('異なる承認・却下記録');
    await expect(decideProject(config, request(main, 'approve', [cover(c.get('家庭菜園の水やり自動化')!), cover(c.get('ベランダ家庭菜園')!)]))).rejects.toThrow('異なる承認・却下記録');
    // まとめて判断された案への同じ判断は、代表の案の判断記録へまとめる。反対の判断は受け付けない。
    const d = c.get('ベランダ家庭菜園')!;
    expect(await decideProject(config, request(d, 'reject'))).toEqual({ candidateId: d.candidateId, projectId: main.projectId, decisionId: `PAPR-${main.candidateId.slice(5)}`, deduped: true });
    await expect(decideProject(config, request(d, 'approve'))).rejects.toThrow('異なる承認・却下記録');
    await expect(decideProject(config, { ...request(d, 'reject'), confirmationToken: '0'.repeat(64) })).rejects.toThrow('異なる承認・却下記録');
    expect(await vault.read(papr(d))).toBeUndefined();
  });

  test('まとめる案を指定しない判断は、その案だけに効く（まとめる前の判断記録も同じ）', async () => {
    const { config } = await setup(); await propose(config, titles);
    const c = await byTitle(config);
    await decideProject(config, request(c.get('ベランダ家庭菜園')!, 'reject'));
    const after = await byTitle(config);
    expect(after.get('ベランダ家庭菜園')!.status).toBe('rejected');
    expect(after.get('家庭菜園')).toMatchObject({ status: 'pending', duplicates: [c.get('家庭菜園の水やり自動化')!.candidateId] });
    expect(after.get('家庭菜園の水やり自動化')).toMatchObject({ status: 'pending', duplicateOf: c.get('家庭菜園')!.candidateId });
  });

  test('同じ対象ではない案・内容が変わった案・確認待ちではない案は、まとめて判断できない', async () => {
    const { config } = await setup(); await propose(config, titles);
    const c = await byTitle(config), main = c.get('家庭菜園')!, a = c.get('家庭菜園の水やり自動化')!;
    await expect(decideProject(config, request(main, 'approve', [cover(c.get('読書記録')!)]))).rejects.toThrow('まとめて判断する案');
    await expect(decideProject(config, request(main, 'approve', [{ ...cover(a), expectedHash: '0'.repeat(64) }]))).rejects.toThrow('まとめて判断する案');
    await expect(decideProject(config, request(main, 'approve', [cover(a), cover(a)]))).rejects.toThrow();
    await expect(decideProject(config, request(main, 'approve', [cover(main)]))).rejects.toThrow();
    await decideProject(config, request(a, 'reject'));
    await expect(decideProject(config, request(main, 'approve', [cover(a)]))).rejects.toThrow('まとめて判断する案');
    expect(await readProjects(config)).toHaveLength(0);
    expect((await byTitle(config)).get('家庭菜園')!.status).toBe('pending');
  });

  test('判断する案と直接は同じ対象ではない案は、まとめて判断できない', async () => {
    const { config } = await setup(); await propose(config, ['旅行の計画', ['夏の旅行', ['旅行の計画', '写真の整理']], '写真の整理']);
    const c = await byTitle(config), p = c.get('旅行の計画')!, q = c.get('夏の旅行')!, r = c.get('写真の整理')!;
    expect(q.duplicates).toEqual([p.candidateId, r.candidateId]);
    // 「旅行の計画」と「写真の整理」は、代表の「夏の旅行」を介して同じ組にあるだけで、互いには重ならない。
    await expect(decideProject(config, request(p, 'reject', [cover(q), cover(r)]))).rejects.toThrow('まとめて判断する案');
    await decideProject(config, request(q, 'reject', [cover(p), cover(r)]));
    expect([...(await byTitle(config)).values()].map(x => x.status)).toEqual(['rejected', 'rejected', 'rejected']);
  });

  test('同じ対象ではない候補のファイルが読めなくても、まとめた判断を受け付ける', async () => {
    const { config } = await setup(); await propose(config, titles);
    const c = await byTitle(config), main = c.get('家庭菜園')!, a = c.get('家庭菜園の水やり自動化')!, d = c.get('ベランダ家庭菜園')!, other = c.get('読書記録')!;
    await writeFile(join(config.vaultPath, other.path), '壊れた候補');
    await decideProject(config, request(main, 'approve', [cover(a), cover(d)]));
    const review = new Map((await readReviewCandidates(config)).map(i => [i.id, i]));
    expect([main, a, d, other].map(x => review.get(x.candidateId)!.status)).toEqual(['approved', 'approved', 'approved', 'unavailable']);
  });

  test('まとめる案のファイルが読めないときは、判断を受け付けない', async () => {
    const { config } = await setup(); await propose(config, titles);
    const c = await byTitle(config), main = c.get('家庭菜園')!, a = c.get('家庭菜園の水やり自動化')!;
    await writeFile(join(config.vaultPath, a.path), '壊れた候補');
    await expect(decideProject(config, request(main, 'approve', [cover(a)]))).rejects.toThrow('まとめて判断する案');
    expect(await readProjects(config)).toHaveLength(0);
  });

  test('読めない判断記録がある間は、判断前の案を確認待ちに戻さず、判断を止める', async () => {
    const { config, vault } = await setup(); await propose(config, titles);
    const c = await byTitle(config), main = c.get('家庭菜園')!, a = c.get('家庭菜園の水やり自動化')!, d = c.get('ベランダ家庭菜園')!, other = c.get('読書記録')!;
    await decideProject(config, request(main, 'reject', [cover(a), cover(d)]));
    const record = (await vault.read(papr(main)))!;
    // 代表の案の判断記録が途中までしか届いていない。どの案をまとめて判断したかを確かめられない。
    await writeFile(join(config.vaultPath, papr(main)), record.slice(0, 40));
    const broken = new Map((await readReviewCandidates(config)).map(i => [i.id, i]));
    expect(broken.get(main.candidateId)!.status).toBe('unavailable');
    for (const x of [a, d, other]) {
      expect(broken.get(x.candidateId)).toMatchObject({ status: 'stale', warnings: [expect.stringContaining('読めない判断記録')] });
      expect(broken.get(x.candidateId)).not.toHaveProperty('duplicates');
      expect(broken.get(x.candidateId)).not.toHaveProperty('duplicateOf');
    }
    await expect(decideProject(config, request(d, 'approve'))).rejects.toThrow('読めない判断記録');
    await expect(decideProject(config, request(other, 'approve'))).rejects.toThrow('読めない判断記録');
    expect(await readProjects(config)).toHaveLength(0);
    // 判断記録が読めるようになれば、まとめて判断した状態に戻る。
    await writeFile(join(config.vaultPath, papr(main)), record);
    const restored = new Map((await readReviewCandidates(config)).map(i => [i.id, i]));
    expect([main, a, d, other].map(x => restored.get(x.candidateId)!.status)).toEqual(['rejected', 'rejected', 'rejected', 'pending']);
    expect(restored.get(d.candidateId)).toMatchObject({ coveredBy: main.candidateId, warnings: [] });
  });

  test('読めない判断記録があっても、読める判断記録の内容はそのまま使う', async () => {
    const { config, vault } = await setup(); await propose(config, [...titles, '旅行の計画']);
    const c = await byTitle(config), main = c.get('家庭菜園')!, a = c.get('家庭菜園の水やり自動化')!, d = c.get('ベランダ家庭菜園')!, other = c.get('読書記録')!, trip = c.get('旅行の計画')!;
    await decideProject(config, request(other, 'reject'));
    await decideProject(config, request(main, 'reject', [cover(a), cover(d)]));
    // まとめた判断とは関係のない案の判断記録が壊れている。
    await writeFile(join(config.vaultPath, papr(other)), '{');
    const review = new Map((await readReviewCandidates(config)).map(i => [i.id, i]));
    expect([main, a, d, other, trip].map(x => review.get(x.candidateId)!.status)).toEqual(['rejected', 'rejected', 'rejected', 'unavailable', 'stale']);
    expect(review.get(d.candidateId)).toMatchObject({ coveredBy: main.candidateId, warnings: [] });
    // 読める判断記録への同じ判断の再送は、これまでどおり同じ記録へまとめる。判断前の案は受け付けない。
    expect(await decideProject(config, request(main, 'reject', [cover(a), cover(d)]))).toMatchObject({ deduped: true });
    await expect(decideProject(config, request(trip, 'approve'))).rejects.toThrow('読めない判断記録');
    // doctorは、読めない判断記録のパスを示す。
    expect((await doctor(config)).issues).toContain(`プロジェクトの判断記録を読めません: ${papr(other)}`);
  });

  test('確認待ちの行は、案の名前に含まれる記法でリンクを作らせない', async () => {
    const { config, vault } = await setup(); await propose(config, ['\\[資料\\](https://example.com/p) の整理']);
    await rebuildDashboard(config);
    expect(await vault.read('HOME.md')).toMatch(/- \[\\\\\\\[資料\\\\\\\]\(https:\/\/example\.com\/p\) の整理\]\(90_system\/project-candidates\/PCAN-[0-9A-Z]{26}\.md\) — プロジェクト案 \/ 未承認/);
  });

  test('受付の依頼でも、まとめる案をIDとハッシュの組で指定できる', async () => {
    const { config, vault } = await setup(); await propose(config, ['家庭菜園', 'ベランダ家庭菜園']);
    const c = await byTitle(config), main = c.get('家庭菜園')!, d = c.get('ベランダ家庭菜園')!;
    const id = `REQ-${'c'.repeat(32)}`, head = `schema_version: 1\nrequest_id: ${id}\nsource: app\noccurred_at: 2026-10-05T00:00:00Z\noperation: project-approve\ncandidate_id: ${main.candidateId}\ncandidate_hash: ${main.candidateHash}\nconfirmation_token: ${main.confirmationToken}\nconfirmed: true\n`;
    const packet = (extra: string) => `---\n${head}${extra}---\n`;
    // IDとハッシュの数が合わない依頼は受け付けない。
    expect(() => parseIntake(`Input/${id}.md`, packet(`cover_ids:\n  - ${d.candidateId}\n`), 1000)).toThrow();
    expect(() => parseIntake(`Input/${id}.md`, packet(`cover_ids:\n  - ${d.candidateId}\ncover_hashes: []\n`), 1000)).toThrow();
    await vault.create(`Input/${id}.md`, packet(`cover_ids:\n  - ${d.candidateId}\ncover_hashes:\n  - ${d.candidateHash}\n`));
    // 受付は書き込み直後のファイルを待つので、保存済みの時刻にする。
    await utimes(join(config.vaultPath, `Input/${id}.md`), new Date(0), new Date(0));
    expect(await ingest(config)).toMatchObject({ accepted: 1 });
    expect([...(await byTitle(config)).values()].map(x => x.status)).toEqual(['approved', 'approved']);
    expect((await byTitle(config)).get('ベランダ家庭菜園')!.coveredBy).toBe(main.candidateId);
  });
});
