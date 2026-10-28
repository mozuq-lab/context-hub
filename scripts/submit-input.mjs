#!/usr/bin/env node
// 別Macから使える、依存パッケージ不要の受付保存ツール。
import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({ options: { vault: { type: 'string' }, kind: { type: 'string', default: 'memo' }, file: { type: 'string' }, source: { type: 'string', default: 'mac-agent' }, project: { type: 'string' }, tool: { type: 'string' } } });
  if (!values.vault || !['memo','work-summary'].includes(values.kind)) throw new Error('保存先と入力種別を確認してください');
  if (!values.source.trim() || values.source.length > 200 || (values.tool?.length ?? 0) > 100 || (values.project && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(values.project))) throw new Error('出典・ツール・プロジェクト指定が不正です');
  const given = resolve(values.vault);
  if ((await lstat(given)).isSymbolicLink()) throw new Error('Vaultルートのsymlinkは禁止です');
  const root = await realpath(given), folder = join(root, 'Input');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Inputは通常ディレクトリにしてください');
  if (!values.file && process.stdin.isTTY) throw new Error('本文を標準入力または--fileで指定してください');
  const input = values.file ? (await open(values.file,'r')).createReadStream() : process.stdin;
  const chunks = []; let size = 0;
  for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32000) throw new Error('本文が文字数上限を超えています'); chunks.push(bytes); }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  if (!text.trim() || text.length > 8000) throw new Error('本文が空か8000文字を超えています');
  const id = `REQ-${randomBytes(16).toString('hex')}`;
  const meta = { schema_version: 1, request_id: id, operation: 'capture', source: values.source, occurred_at: new Date().toISOString(), kind: values.kind, ...(values.project ? { project: values.project } : {}), ...(values.tool ? { tool: values.tool } : {}) };
  const handle = await open(join(folder, `${id}.md`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`---\n${JSON.stringify(meta)}\n---\n${text}`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  const dir = await open(folder, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  process.stdout.write(JSON.stringify({ requestId: id, path: `Input/${id}.md`, status: '端末保存済み・同期と受付待ち' }) + '\n');
} catch { process.stderr.write('受付保存に失敗しました。引数・本文・保存先を確認してください。\n'); process.exitCode = 1; }
