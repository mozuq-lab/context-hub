import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Vault, parseMarkdown } from '../src/storage.js';
import { propose, approve, reject, listCandidates } from '../src/approvals.js';
import type { HubConfig } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(): Promise<HubConfig> { const root = await mkdtemp(path.join(tmpdir(), 'hub-approval-')); roots.push(root); const config = defaultConfig(path.join(root, 'vault'), path.join(root, 'state')); await new Vault(config).init(); return config; }

describe('人の承認と追記履歴', () => {
  test('閲覧した内容のハッシュが一致したときだけ知識を生成する', async () => {
    const config = await setup(); const vault = new Vault(config); const candidate = await propose(config, { claim: '正本はMarkdownとする', kind: 'decision', rationale: '復旧しやすい' });
    const listing = await listCandidates(config); expect(listing).toContain(candidate.candidateId); expect(listing).toContain(candidate.hash); expect(listing).toContain('正本はMarkdown');
    await expect(approve(config, candidate.candidateId, '0'.repeat(64),{scope:'global'})).rejects.toThrow(); expect(await vault.files('30_knowledge')).toEqual([]); expect(await vault.files('90_system/approvals')).toEqual([]);
    const result = await approve(config, candidate.candidateId, candidate.hash,{scope:'global'}); expect(result.knowledgeId).toMatch(/^KNW-/);
    const knowledge = parseMarkdown((await vault.read(`30_knowledge/${result.knowledgeId}.md`))!); expect(knowledge.meta.verified).toBe(true); expect(knowledge.text).toContain('正本はMarkdown');
    expect(await vault.files('90_system/approvals')).toHaveLength(1);
    const logFiles = await readdir(config.logging.dir); const logs = await readFile(path.join(config.logging.dir, logFiles[0]!), 'utf8'); expect(logs).toContain('\"op\":\"approve\"'); expect(logs).toContain('\"op\":\"propose\"');
    expect((await approve(config, candidate.candidateId, candidate.hash,{scope:'global'})).deduped).toBe(true); expect(await vault.files('30_knowledge')).toHaveLength(1); expect(await vault.files('90_system/approvals')).toHaveLength(1);
  });
  test('表示後に変更された候補を以前のハッシュで承認できない', async () => {
    const config = await setup(); const vault = new Vault(config); const candidate = await propose(config, { claim: '旧内容' }); await vault.write(candidate.path, `${await vault.read(candidate.path)}\n変更\n`);
    await expect(approve(config, candidate.candidateId, candidate.hash,{scope:'global'})).rejects.toThrow(/ハッシュ/); expect(await vault.files('30_knowledge')).toEqual([]);
  });
  test('却下は履歴を残し知識を作らず同じ候補の承認も拒否する', async () => {
    const config = await setup(); const vault = new Vault(config); const candidate = await propose(config, { claim: '保留の案' }); await reject(config, candidate.candidateId, candidate.hash);
    expect(await vault.files('30_knowledge')).toEqual([]); expect(await vault.files('90_system/approvals')).toHaveLength(1); expect(await listCandidates(config)).not.toContain(candidate.candidateId);
    await expect(approve(config, candidate.candidateId, candidate.hash,{scope:'global'})).rejects.toThrow();
  });
  test('変更を新候補として承認すると旧知識の本文を残して後継を記録する', async () => {
    const config = await setup(); const vault = new Vault(config); const one = await propose(config, { claim: '旧方針' }); const first = await approve(config, one.candidateId, one.hash,{scope:'global'});
    const two = await propose(config, { claim: '新方針', supersedes: first.knowledgeId }); const second = await approve(config, two.candidateId, two.hash,{scope:'global'});
    const old = parseMarkdown((await vault.read(`30_knowledge/${first.knowledgeId}.md`))!); expect(old.text).toContain('旧方針'); expect(old.meta.superseded_by).toBe(second.knowledgeId);
    expect(await vault.files('30_knowledge')).toHaveLength(2); expect(await vault.files('90_system/approvals')).toHaveLength(2);
  });
  test('承認記録後の停止は再実行で知識を復元し履歴を増やさない', async () => {
    const config = await setup(); const vault = new Vault(config); const candidate = await propose(config, { claim: '耐久化する' }); const create = Vault.prototype.create;
    vi.spyOn(Vault.prototype, 'create').mockImplementation(async function (this: Vault, relative, text) { if (relative.startsWith('30_knowledge/')) throw new Error('停止'); return create.call(this, relative, text); });
    await expect(approve(config, candidate.candidateId, candidate.hash,{scope:'global'})).rejects.toThrow('停止'); expect(await vault.files('90_system/approvals')).toHaveLength(1);
    vi.restoreAllMocks(); const restored = await approve(config, candidate.candidateId, candidate.hash,{scope:'global'}); expect(restored.deduped).toBe(true); expect(await vault.files('30_knowledge')).toHaveLength(1); expect(await vault.files('90_system/approvals')).toHaveLength(1);
  });
  test('候補IDと後継IDのパス逸脱を拒否する', async () => {
    const config = await setup(); await expect(approve(config, '../../outside', '0'.repeat(64),{scope:'global'})).rejects.toThrow(); await expect(propose(config, { claim: '変更', supersedes: '../../outside' })).rejects.toThrow();
  });
});
