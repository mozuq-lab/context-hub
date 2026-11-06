import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault, markdown } from '../src/storage.js';
import { correctInput } from '../src/corrections.js';
import { capture } from '../src/capture.js';
import { addProject } from '../src/projects.js';
import { runCycle } from '../src/cycle.js';
import { MockLlm } from '../src/llm.js';
import { find, parseFindTime } from '../src/retrieve.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-find-')); roots.push(root);
  const config = defaultConfig(join(root, 'vault'), join(root, 'state')); await new Vault(config).init();
  await addProject(config, { id: 'context-hub', title: 'Context Hub' });
  await addProject(config, { id: 'garden', title: '家庭菜園' });
  const owned = await capture(config, { source: 'cli', sourceEventId: 'owned', occurredAt: '2026-09-10T00:00:00Z', project: 'context-hub', text: '同期の設計メモ' });
  const estimated = await capture(config, { source: 'cli', sourceEventId: 'estimated', occurredAt: '2026-09-12T00:00:00Z', text: 'Context Hub の同期を速くするアイデア' });
  const other = await capture(config, { source: 'cli', sourceEventId: 'other', occurredAt: '2026-09-14T00:00:00Z', project: 'garden', text: '同期 トマトの水やり' });
  await runCycle(config, new MockLlm());
  return { config, owned, estimated, other };
}
const ids = (output: string) => [...output.matchAll(/^- \[([^\]]+)\]/gm)].map(m => m[1]);

test('プロジェクトで絞り込み、AI推定の関連は区別して示す', async () => {
  const { config, owned, estimated, other } = await setup();
  const output = await find(config, '同期', { project: 'context-hub' });
  expect(ids(output)).toEqual(expect.arrayContaining([owned.inputId, estimated.inputId]));
  expect(ids(output)).not.toContain(other.inputId);
  const block = output.split('\n\n').find(b => b.includes(`[${estimated.inputId}](`))!;
  expect(block).toContain('関連候補（AI推定、帰属未確定）');
  expect(output.split('\n\n').find(b => b.includes(`[${owned.inputId}](`))).not.toContain('AI推定');
  // アイデアは元の入力の帰属に従い、別プロジェクトのNOWは出さない。
  expect(output).toMatch(/\[IDEA-/);
  expect(output).not.toContain('10_projects/garden/NOW.md');
  expect(await find(config, '同期', { project: 'unknown' })).toContain('プロジェクト未登録');
});

test('種類と期間（日本時間の日付）で絞り込む', async () => {
  const { config, owned, estimated, other } = await setup();
  const ideas = await find(config, '同期', { kinds: ['idea'] });
  expect(ids(ideas).every(id => id.startsWith('IDEA-'))).toBe(true);
  expect(ids(ideas)).toHaveLength(1);
  // 一致数が同じなら新しい順。
  expect(ids(await find(config, '同期', { kinds: ['memo'], since: '2026-09-12' }))).toEqual([other.inputId, estimated.inputId]);
  expect(ids(await find(config, '同期', { kinds: ['memo'], until: '2026-09-10' }))).toEqual([owned.inputId]);
  // 2026-09-12T00:00Z は日本時間の12日9時なので、12日の範囲に入る。
  expect(ids(await find(config, '同期', { kinds: ['memo'], since: '2026-09-12', until: '2026-09-12' }))).toEqual([estimated.inputId]);
  expect(ids(await find(config, '同期', { kinds: ['memo'], since: '2026-09-11T00:00:00+09:00', until: '2026-09-13T00:00:00+09:00' }))).toEqual([estimated.inputId]);
});

test('検索語なしは絞り込み条件が必要で、新しい順に並べる', async () => {
  const { config, owned, other } = await setup();
  await expect(find(config, '')).rejects.toThrow('検索語');
  expect(ids(await find(config, '', { kinds: ['memo'] }))[0]).toBe(other.inputId);
  expect(ids(await find(config, '', { project: 'garden', kinds: ['memo'] }))).toEqual([other.inputId]);
  expect(ids(await find(config, '同期', { kinds: ['memo'], sort: 'newest' })).at(-1)).toBe(owned.inputId);
});

test('件数と開始位置で続きを読み、範囲外は件数を示す', async () => {
  const { config } = await setup();
  const all = ids(await find(config, '同期', { kinds: ['memo'] }));
  expect(all).toHaveLength(3);
  const first = await find(config, '同期', { kinds: ['memo'], limit: 2, pagingHint: true });
  expect(ids(first)).toEqual(all.slice(0, 2));
  expect(first).toContain('該当3件中 1〜2件目。続きは --offset 2');
  const rest = await find(config, '同期', { kinds: ['memo'], limit: 2, offset: 2, pagingHint: true });
  expect(ids(rest)).toEqual(all.slice(2));
  expect(rest).toContain('該当3件中 3〜3件目');
  expect(rest).not.toContain('続きは');
  expect(await find(config, '同期', { kinds: ['memo'], offset: 5 })).toContain('開始位置が件数を超えています');
  // チャット経由（案内なし）では、続きがあってもCLIのオプションを案内しない。
  expect(await find(config, '同期', { kinds: ['memo'], limit: 2 })).not.toContain('該当');
  expect(await find(config, 'トマト', { pagingHint: true })).not.toContain('該当');
});

test('不正な条件は検索前に止める', async () => {
  const { config } = await setup();
  await expect(find(config, '同期', { since: '2026-02-30' })).rejects.toThrow('期間');
  await expect(find(config, '同期', { since: '2026-09-14T00:00:00' })).rejects.toThrow('期間');
  await expect(find(config, '同期', { since: '2026-09-14', until: '2026-09-13' })).rejects.toThrow('開始');
  await expect(find(config, '同期', { kinds: ['note' as never] })).rejects.toThrow('種類');
  await expect(find(config, '同期', { limit: 201 })).rejects.toThrow('表示件数');
  await expect(find(config, '同期', { project: '../x' })).rejects.toThrow('プロジェクトIDは英小文字');
  expect(parseFindTime('2026-09-14', true) - parseFindTime('2026-09-14')).toBe(86_400_000 - 1);
});

test('CLIの絞り込みオプションを検索に渡す', async () => {
  const { config, other } = await setup();
  const { spawn } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const file = join(config.statePath, 'config.json'); await writeFile(file, JSON.stringify(config));
  const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const p = spawn(process.execPath, [resolve('packages/core/dist/cli.js'), '--config', file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; }); p.on('error', reject); p.on('close', code => done({ code, out, err }));
  });
  const listed = await run(['find', '--project', 'garden', '--kind', 'memo,work-summary', '--since', '2026-09-14', '--limit', '5']);
  expect(listed.code).toBe(0); expect(ids(listed.out)).toEqual([other.inputId]);
  const bad = await run(['find', '同期', '--until', 'yesterday']);
  expect(bad.code).toBe(1); expect(bad.err).toContain('期間');
  expect((await run(['find'])).err).toContain('検索語');
});

test('訂正・アイデア・知識の帰属と、NOWの期間は最終根拠で判断する', async () => {
  const { config, owned, estimated } = await setup();
  const vault = new Vault(config);
  const fixed = await correctInput(config, owned.inputId, { source: 'cli', sourceEventId: 'fix', occurredAt: '2026-09-11T00:00:00Z', text: '同期の設計メモ（訂正）' });
  const blocks = (await find(config, '同期', { project: 'context-hub' })).split('\n\n');
  expect(blocks.find(b => b.includes(`[${fixed.inputId}](`))).not.toContain('AI推定');
  expect(blocks.find(b => b.includes('[IDEA-'))).toContain('関連候補（AI推定、帰属未確定）');
  expect(blocks.some(b => b.includes(`[${estimated.inputId}](`))).toBe(true);
  // プロジェクトの知識は含め、共通の知識は含めない。
  const knowledge = (id: string) => markdown({ schema_version: 1, id, approved_at: '2026-09-20T00:00:00Z', verified: true, input_ids: [] }, '同期は削除も伝える');
  await vault.write('10_projects/context-hub/knowledge/KNW-01M2DSFVQMH65989604KSVE1PA.md', knowledge('KNW-01M2DSFVQMH65989604KSVE1PA'));
  await vault.write('30_knowledge/KNW-01M2DSFVQMH65989604KSVE1PB.md', knowledge('KNW-01M2DSFVQMH65989604KSVE1PB'));
  const scoped = await find(config, '削除', { project: 'context-hub' });
  expect(scoped).toContain('KNW-01M2DSFVQMH65989604KSVE1PA');
  expect(scoped).not.toContain('KNW-01M2DSFVQMH65989604KSVE1PB');
  expect(await find(config, '削除', { kinds: ['knowledge'] })).toContain('KNW-01M2DSFVQMH65989604KSVE1PB');
  // NOWは再生成時刻ではなく最終根拠（9月）で期間を判断する。
  const now = await find(config, '', { project: 'garden', kinds: ['now'], until: '2026-09-30' });
  expect(now).toContain('10_projects/garden/NOW.md');
  expect(await find(config, '', { project: 'garden', kinds: ['now'], since: '2026-10-01' })).toBe('見つかりません');
  // 分類を取り消したアイデアは種類の絞り込みに含めない。
  const idea = (await vault.files('20_ideas'))[0]!;
  await vault.write(idea, (await vault.read(idea))!.replace('category: idea', 'category: idea\nretracted: true'));
  expect(await find(config, '同期', { kinds: ['idea'] })).toBe('見つかりません');
  expect(await find(config, '同期')).toContain('[IDEA-');
});
