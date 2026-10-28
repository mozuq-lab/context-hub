import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { satisfiesPluginApiRange, VERIFIED_HOST_VERSIONS } from './plugin-api-range.mjs';

// ホストコードは実行せず、インストール版の型宣言だけを読み取る。
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostDir = process.argv[2] ?? resolve(dirname(process.execPath), '../lib/node_modules/openclaw');
const host = JSON.parse(await readFile(join(hostDir, 'package.json'), 'utf8'));
// 検証済みの版だけを受け付ける。新しい版はdocsと型契約を確認してから一覧へ追加する。
if (!VERIFIED_HOST_VERSIONS.includes(host.version)) throw new Error(`未検証のOpenClaw版です（${host.version}）。docsと型契約を再確認し、検証後に scripts/plugin-api-range.mjs の一覧へ追加してください。`);
const declared = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).openclaw?.compat?.pluginApi;
if (typeof declared !== 'string' || !satisfiesPluginApiRange(host.version, declared)) throw new Error(`package.json の openclaw.compat.pluginApi（${declared}）がホスト ${host.version} を含みません。`);
const temp = await mkdtemp(join(packageDir, '.sdk-check-'));
try {
  const filename = join(temp, 'check.ts');
  const sdkEntry = join(hostDir, 'dist/plugin-sdk/plugin-entry.js');
  await writeFile(filename, `import type { OpenClawPluginApi, OpenClawPluginDefinition, AnyAgentTool } from ${JSON.stringify(sdkEntry)};
import type { PluginApi, HubTool } from '../src/api.js';
import plugin from '../src/index.js';
const acceptApi = (api: OpenClawPluginApi): PluginApi => api;
const acceptTool = (tool: HubTool): AnyAgentTool => tool;
const definition: OpenClawPluginDefinition = plugin;
void acceptApi; void acceptTool; void definition;
`);
  const tsc = resolve(packageDir, '../../node_modules/.bin/tsc');
  const result = spawnSync(tsc, ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--types', 'node', filename], { cwd: packageDir, shell: false, stdio: 'inherit', timeout: 60_000 });
  if (result.error || result.status !== 0) process.exitCode = 1;
  else process.stdout.write(`OpenClaw ${host.version} の公開型との互換性を確認しました。\n`);
} finally { await rm(temp, { recursive: true, force: true }); }
