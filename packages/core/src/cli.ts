#!/usr/bin/env node
import { createProgram } from './cli-program.js';
import { userFacingError } from './error-message.js';
import { releaseLocksOnSignal } from './storage.js';

// コマンドの定義はcli-program.tsとcommands/にある。ここでは解析・実行と、エラーの表示だけを行う。
const program = createProgram();
// Ctrl+Cやサービス停止で終了しても、ロックの残骸で後続のWriterを止めない。
releaseLocksOnSignal();
try { await program.parseAsync(); }
catch (error) {
  // パス・本文・外部プロセスのstderrを例外から転記しない。
  process.stderr.write(`エラー: ${userFacingError(error)}\n`);process.exitCode=1;
}
