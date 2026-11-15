import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { find } from '../src/retrieve.js';
import { doctor } from '../src/doctor.js';
import { buildIdeaIndex, ideaIndexPath, ideaIndexSchema, ideaSimilarity, ideaSummary, readIdeaLinks, setIdeaLink, similarPairs } from '../src/idea-links.js';
import type { Vault } from '../src/storage.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  const texts = ['開発再開を助ける仕組みがあると面白そう', '数日ぶりの開発再開を助ける仕組み、面白そう。', 'いつか週末にキャンプへ行く計画を立てたい'];
  const ids: string[] = [];
  for (const [i, text] of texts.entries()) ids.push((await capture(config, { source: 'cli', text, occurredAt: `2026-11-0${i + 1}T00:00:00Z` })).inputId);
  await organize(config, new MockLlm());
  const idea = (i: number) => `IDEA-${ids[i]!.slice(3)}`;
  return { config, vault, idea };
}
const index = async (vault: Vault) => ideaIndexSchema.parse(JSON.parse((await vault.read(ideaIndexPath))!));

test('似ている度合いは記号・URL・大文字小文字の違いを無視し、短すぎる要約は比べない', () => {
  expect(ideaSimilarity('開発再開を助ける仕組みがあると面白そう', '数日ぶりの開発再開を助ける仕組み、面白そう。')).toBeGreaterThan(0.6);
  expect(ideaSimilarity('ホーム画面のウィジェット', 'キャンプの計画')).toBe(0);
  expect(ideaSimilarity('ContextHubを英語化 https://example.com/a', 'contexthubを英語化 https://example.com/b')).toBe(1);
  expect(ideaSimilarity('猫', '猫')).toBe(0);
  expect(ideaSummary('# アイデア（AI生成・未検証）\n\n本文\n\n入力: [IN-1](x)\n出典: cli\n帰属候補: なし\n')).toBe('本文');
  const docs = [{ id: 'IDEA-B', summary: 'あいうえおかきくけこ', path: '', occurredAt: '', hash: '' }, { id: 'IDEA-A', summary: 'あいうえおかきくけ', path: '', occurredAt: '', hash: '' }, { id: 'IDEA-C', summary: 'さしすせそたちつてと', path: '', occurredAt: '', hash: '' }];
  expect(similarPairs(docs)).toEqual([{ ideas: ['IDEA-A', 'IDEA-B'], score: 0.941 }]);
});

test('似ているアイデアをHOMEと索引に出し、アプリからの依頼で束ね、検索では1件にまとめる', async () => {
  const { config, vault, idea } = await fixture();
  await rebuildDashboard(config);
  let current = await index(vault);
  expect(current.candidates.map(c => c.ideas)).toEqual([[idea(0), idea(1)].sort()]);
  expect(current.groups).toEqual([]);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('## 似ているアイデア（未確認1件）');
  expect(home).toContain(`(20_ideas/${idea(0)}.md)`);
  const [candidate] = current.candidates;
  const { requestId } = await packet(config, { operation: 'idea-link', idea_ids: candidate!.ideas, idea_hashes: candidate!.hashes, action: 'link', confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(1);
  const ack = (await readIntakeReceipts(config)).find(r => r.request_id === requestId)!;
  expect(ack.result).toMatchObject({ action: 'link', deduped: false });
  current = await index(vault);
  expect(current.candidates).toEqual([]);
  // 代表は元のメモが新しい方。
  expect(current.groups).toEqual([{ representative: idea(1), ideas: [idea(1), idea(0)], links: [[idea(0), idea(1)].sort()] }]);
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('## 束ねたアイデア（1組）');
  const found = await find(config, '開発再開', { kinds: ['idea'] });
  expect(found.match(/\[IDEA-/g)).toHaveLength(2); // 1件の見出しと、束ねた相手へのリンク
  expect(found).toContain('束ねたアイデア: ');
  // 再送は重複しない。
  expect((await ingest(config)).accepted).toBe(0);
  expect(await readIdeaLinks(vault)).toHaveLength(1);
  expect((await doctor(config)).issues).toEqual([]);
});

test('別の話にすると候補から外れ、束ねた組に記録すると束から外れる', async () => {
  const { config, vault, idea } = await fixture();
  let current = await buildIdeaIndex(vault);
  const [candidate] = current.candidates;
  await setIdeaLink(config, { ideas: [candidate!.ideas[1], candidate!.ideas[0]], hashes: [candidate!.hashes[1], candidate!.hashes[0]], action: 'link', source: 'cli' });
  expect((await buildIdeaIndex(vault)).groups).toHaveLength(1);
  await setIdeaLink(config, { ideas: [idea(0), idea(1)], action: 'separate', source: 'cli' });
  current = await buildIdeaIndex(vault);
  expect(current.groups).toEqual([]);
  expect(current.candidates).toEqual([]);
});

test('確認した後にアイデアが作り直されていたら束ねず、理由を受付の失敗に残す', async () => {
  const { config, vault } = await fixture();
  const [candidate] = (await buildIdeaIndex(vault)).candidates;
  await packet(config, { operation: 'idea-link', idea_ids: candidate!.ideas, idea_hashes: [candidate!.hashes[0], 'a'.repeat(64)], action: 'link', confirmed: true }, '');
  const result = await ingest(config);
  expect(result.accepted).toBe(0);
  expect(result.rejected).toBe(1);
  const [errorPath] = await vault.files('90_system/intake-errors');
  expect(JSON.parse((await vault.read(errorPath!))!).reason).toEqual({ code: 'idea-changed' });
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('確認した後にアイデアが作り直されています');
  await expect(setIdeaLink(config, { ideas: [candidate!.ideas[0], candidate!.ideas[0]], hashes: candidate!.hashes, action: 'link', source: 'cli' })).rejects.toThrow();
  await expect(setIdeaLink(config, { ideas: candidate!.ideas, action: 'link', source: 'cli' })).rejects.toThrow();
});

test('壊れた束ねの記録があってもHOMEは作り、doctorで示す', async () => {
  const { config, vault } = await fixture();
  await vault.write('90_system/idea-links/ILNK-01M2DSFVQMH65989604KSVE1PV.json', '{"broken":true}');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('似ているアイデアの一覧を更新できません');
  expect((await doctor(config)).issues.join('\n')).toContain('アイデアの束ねの記録が不正です');
});
