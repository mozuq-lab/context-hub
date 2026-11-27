import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createProgram } from '../src/cli-program.js';

// 端末の幅や色の設定で文面が変わらないよう、幅80・色なしでヘルプを作る。
const plain = { getOutHelpWidth: () => 80, getOutHasColors: () => false };

/** すべてのコマンドの`--help`の文面を、コマンドの経路（例: "ctx item schedule"）ごとに集める。 */
function helps(command: Command, path: string[] = [], out: Record<string, string> = {}): Record<string, string> {
  const at = [...path, command.name()];
  out[at.join(' ')] = command.configureOutput(plain).helpInformation();
  for (const sub of command.commands) helps(sub, at, out);
  return out;
}

test('全コマンドの--helpの文面（説明・引数・オプション・既定値・選択肢・並び順）が変わらない', () => {
  // コマンドの説明やオプションを意図して変えたときは、差分を確かめてから vitest -u でスナップショットを更新する。
  expect(helps(createProgram())).toMatchSnapshot();
});

test('実CLIの--helpはcreateProgramの組み立てと同じ', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [resolve('packages/core/dist/cli.js'), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const all = helps(createProgram());
  for (const path of [[], ['item'], ['item', 'schedule'], ['project', 'edit']]) {
    const result = run([...path, '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(all[['ctx', ...path].join(' ')]);
  }
});
