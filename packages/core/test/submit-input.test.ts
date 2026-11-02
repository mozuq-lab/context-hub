import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
const node = process.env.CONTEXT_HUB_SUBMIT_TEST_NODE ?? process.execPath;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-submit-')); roots.push(root);
  const given = join(root, 'vault'); await mkdir(given); const vault = await realpath(given);
  const run = (args: string[] = [], input = '架空のメモ', preload?: string) => spawnSync(node,
    [...(preload ? ['--import', preload] : []), resolve('scripts/submit-input.mjs'), '--vault', vault, ...args],
    { encoding: 'utf8', input });
  const requests = async () => {
    try { return (await readdir(join(vault, 'Input'))).filter(name => /^REQ-.*\.md$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  return { root, vault, run, requests };
}

test.each([
  { name: '入力種別の誤り', args: ['--kind', 'unknown'], body: '架空のメモ' },
  { name: '未対応オプション', args: ['--session', 'example'], body: '架空のメモ' },
  { name: '空本文', args: [], body: '  ' },
])('$nameはREQ未作成の終了2を返す', async ({ args, body }) => {
  const { run, requests } = await setup(); const result = run(args, body);
  expect(result.status).toBe(2); expect(result.stderr).toContain('未作成');
  expect(await requests()).toEqual([]);
});

test('終了2の引数を修正して保存するとREQは1件だけになる', async () => {
  const { vault, run, requests } = await setup();
  expect(run(['--kind', 'unknown']).status).toBe(2);
  const result = run(['--kind', 'memo']); expect(result.status).toBe(0);
  const reply = JSON.parse(result.stdout); expect(await requests()).toEqual([`${reply.requestId}.md`]);
  expect(await readFile(join(vault, reply.path), 'utf8')).toContain('架空のメモ');
});

test('REQ作成後のディレクトリsync失敗は結果不明の終了1となる', async () => {
  const { root, vault, run, requests } = await setup(); const preload = join(root, 'fail-sync.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.open;
fs.open = async (path, ...args) => {
  const handle = await original(path, ...args);
  if (String(path) === ${JSON.stringify(join(vault, 'Input'))}) handle.sync = async () => { throw new Error('injected sync failure'); };
  return handle;
};
syncBuiltinESMExports();\n`);
  const result = run([], '保存結果を確認する架空の本文', preload);
  expect(result.status).toBe(1); expect(result.stderr).toContain('結果が不明');
  expect(result.stderr).not.toContain('未作成');
  const files = await requests(); expect(files).toHaveLength(1);
  expect(await readFile(join(vault, 'Input', files[0]), 'utf8')).toContain('保存結果を確認する架空の本文');
});

test('REQ作成のopenで失敗しても未作成を保証せず終了1となる', async () => {
  const { root, run, requests } = await setup(); const preload = join(root, 'fail-open.mjs');
  await writeFile(preload, `import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.open;
fs.open = async (path, ...args) => {
  if (String(path).endsWith('.md')) throw new Error('injected open failure');
  return original(path, ...args);
};
syncBuiltinESMExports();\n`);
  const result = run([], '架空のメモ', preload);
  expect(result.status).toBe(1); expect(result.stderr).toContain('結果が不明');
  expect(result.stderr).not.toContain('未作成'); expect(await requests()).toEqual([]);
});

test('Node22未満の版判定ではREQ作成前に終了2で止まる', async () => {
  const { root, run, requests } = await setup(); const preload = join(root, 'older-version.mjs');
  await writeFile(preload, "Object.defineProperty(process.versions, 'node', {value: '20.0.0'});\n");
  const result = run([], '架空のメモ', preload);
  expect(result.status).toBe(2); expect(result.stderr).toContain('未作成'); expect(await requests()).toEqual([]);
});
