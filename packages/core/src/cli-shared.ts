import type { Command } from 'commander';
import { open } from 'node:fs/promises';
import type { ConfigOverrides } from './config.js';
import { MockLlm } from './llm.js';
import { OpenClawInferLlm } from './infer.js';
import { synthesisLlmConfig } from './synthesis.js';
import type { HubConfig } from './types.js';

/** 全体のオプション（--config・--vault・--state）を反映した設定を読む。overridesはコマンドごとの上書き。 */
export type LoadConfig = (overrides?: ConfigOverrides) => Promise<HubConfig>;
/** コマンドを登録する関数。cli-program.tsが`--help`の並び順に呼ぶ。 */
export type RegisterCommand = (program: Command, config: LoadConfig) => void;

/** 文字列はそのまま（末尾が改行でなければ1つ足す）、それ以外はJSONで標準出力へ書く。 */
export const output = (value: unknown): void => {
  process.stdout.write(typeof value === 'string' ? value.replace(/\n?$/, '\n') : JSON.stringify(value, null, 2) + '\n');
};

export function positive(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('正の整数を指定してください');
  return n;
}

/** CLIで書く望む結果。引数の中の「\\n」を改行として読み、「\\\\」は「\\」1つとして読む（「C:\\\\new」のように書ける）。 */
export const outcomeArg = (value: string) => value.replace(/\\([\\n])/g, (_, c: string) => c === 'n' ? '\n' : '\\');

/** 繰り返し指定できるオプションの値を配列に集める。 */
export const collect = (value: string, previous: string[]) => [...previous, value];

/** 本文を、引数・--file・標準入力のどれか1つから読む（UTF-8だけを受け付ける）。 */
export async function inputText(text: string | undefined, file: string | undefined, max: number): Promise<string> {
  if (text !== undefined && file) throw new Error('本文と --file は同時に指定できません');
  if (text !== undefined) return text;
  const stream = file ? (await open(file, 'r')).createReadStream() : process.stdin;
  if (!file && process.stdin.isTTY) throw new Error('本文、--file、または標準入力が必要です');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > max * 4) throw new Error('入力が文字数上限を超えています');
      chunks.push(bytes);
    }
  } finally {
    if (file) stream.destroy();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('文字コードがUTF-8ではありません。変換してから取り込んでください');
  }
}

/** 整理（organize・cycle・ask）に使うモデル。 */
export const organizeClient = (c: HubConfig) => c.organize.llm.provider === 'mock' ? new MockLlm() : new OpenClawInferLlm(c.organize.llm);

/** 週次の統合に使うモデル。接続先は整理と同じで、思考の深さと出力の上限は統合用の設定を使う。 */
export const synthesisClient = (c: HubConfig) => c.organize.llm.provider === 'mock' ? new MockLlm() : new OpenClawInferLlm(synthesisLlmConfig(c));
