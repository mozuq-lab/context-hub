import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultConfig } from '../src/config.js';
import { Vault, markdown } from '../src/storage.js';
import { parseIntake, decodeIntake } from '../src/intake-format.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const id = 'REQ-aB012345678901234567890123456789';
const meta = { schema_version: 1, request_id: id, operation: 'capture', source: 'quickadd', occurred_at: '2026-10-03T10:00:00+09:00', kind: 'memo' };
test('受付本文の改行と引用符を保持する', () => {
  expect(parseIntake(`Input/${id}.md`, markdown(meta, '日本語\r\n"引用"\n'), 8000)).toMatchObject({ request_id: id, text: '日本語\r\n"引用"\n' });
  expect(parseIntake(`Input/${id.replace('aB','Cc')}.md`, markdown({ ...meta, request_id: id.replace('aB','Cc') }, '日本語\r\n"引用"\n'), 8000).request_id).not.toBe(id);
});
test('不一致ID・未知キー・空本文と上限超過を拒否する', () => {
  for (const data of [{ ...meta, request_id: 'REQ-'+'x'.repeat(32) }, { ...meta, approved: true }]) expect(() => parseIntake(`Input/${id}.md`, markdown(data, '本文'), 8000)).toThrow();
  expect(() => parseIntake(`Input/${id}.md`, markdown(meta, '  '), 8000)).toThrow();
  expect(() => parseIntake(`Input/${id}.md`, markdown(meta, 'abc'), 2)).toThrow();
  expect(() => parseIntake(`Input/../${id}.md`, markdown(meta, '本文'), 8000)).toThrow();
  expect(() => decodeIntake(Buffer.from([0xff, 0xfe]))).toThrow();
});
test('Mac保存ツールは受付だけを作りcoreが受理する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-format-')); roots.push(root);
  const config = defaultConfig(join(root, 'vault'), join(root, 'state')); const vault = new Vault(config); await vault.init();
  const file = join(root, 'body.txt'); await writeFile(file, '作業の記録\r\n次の一手\n');
  await promisify(execFile)(process.execPath, ['scripts/submit-input.mjs', '--vault', config.vaultPath, '--kind', 'work-summary', '--file', file, '--source', 'other-mac', '--tool', 'codex']);
  const paths = await vault.files('Input'); expect(paths).toHaveLength(1);
  const packet = parseIntake(paths[0], decodeIntake((await vault.readBytes(paths[0], 50000))!), 8000);
  expect(packet).toMatchObject({ operation: 'capture', kind: 'work-summary', source: 'other-mac', tool: 'codex', text: '作業の記録\r\n次の一手\n' });
  expect(await vault.files('00_inbox')).toHaveLength(0);
  await expect(vault.readBytes(paths[0], 2)).rejects.toThrow();
});
