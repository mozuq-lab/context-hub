import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture, readInputs } from '../src/capture.js';
import { ingest, intakeFeatures, intakeErrorSchema } from '../src/intake.js';
import { buildReferences, rebuildReferences, readReferenceIndex } from '../src/references.js';
import { readReferenceMarks } from '../src/reference-marks.js';
import { AttachmentError, FILE_NAME_BYTES, attachmentPath, fileNameSchema, sanitizeFileName } from '../src/attachments.js';
import { doctor } from '../src/doctor.js';
import { LockTimeoutError, Vault } from '../src/storage.js';
import { find } from '../src/retrieve.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

const at = (iso: string) => ({ occurredAt: iso, receivedAt: iso });
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール', keywords: ['集約'] });
  const outside = await mkdtemp(join(tmpdir(), 'ctx-attach-')); roots.push(outside);
  return { config, vault, outside };
}
/** 端末がInput/filesに置いたファイル。同期で届いてから時間が経った形にする。 */
async function transport(vaultPath: string, requestId: string, data: Buffer | string) {
  await mkdir(join(vaultPath, 'Input/files'), { recursive: true });
  const path = join(vaultPath, 'Input/files', requestId);
  await writeFile(path, data); await utimes(path, new Date(0), new Date(0));
  return path;
}

test('ファイル名は、使えない文字を置き換え、長い名前は拡張子を残してバイト数の上限に収める', () => {
  expect(sanitizeFileName('/tmp/見積書 (A社).pdf')).toBe('見積書 (A社).pdf');
  expect(sanitizeFileName('a:b*c?"d"<e>|f.png')).toBe('a_b_c__d__e__f.png');
  expect(sanitizeFileName('.hidden')).toBe('_hidden');
  expect(sanitizeFileName('名前. ')).toBe('名前');
  expect(sanitizeFileName('x.sync-conflict-20261123.pdf')).toBe('x.sync_conflict-20261123.pdf');
  expect(sanitizeFileName('改\n行\u202Eです.txt')).toBe('改_行_です.txt');
  expect(sanitizeFileName('')).toBe('file');
  const long = sanitizeFileName(`${'資料'.repeat(80)}.pdf`);
  expect(long.endsWith('.pdf')).toBe(true);
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(FILE_NAME_BYTES);
  // 整えた名前は本体が必ず受け付ける。
  for (const raw of ['/tmp/見積書 (A社).pdf', 'a:b*c?"d"<e>|f.png', '.hidden', '名前. ', '', `${'資料'.repeat(80)}.pdf`, '\uD800壊れ.txt', 'ｶﾀｶﾅ.pdf'])
    expect(fileNameSchema.safeParse(sanitizeFileName(raw)).success).toBe(true);
  for (const bad of ['a/b.pdf', '.x', 'x.', ' x', 'a\u0000b', 'x.sync-conflict-1.pdf', 'e\u0301.txt']) expect(fileNameSchema.safeParse(bad).success).toBe(false);
});

test('ファイルを添えたメモは、05_filesへ複製して資料棚に載り、ファイルへのリンクと大きさを示す。同じ依頼の再送では置き直さない', async () => {
  const { config, vault, outside } = await fixture();
  const data = Buffer.from('%PDF-1.4 架空の見積書'), file = join(outside, 'original.pdf');
  await writeFile(file, data);
  const request = { source: 'cli', sourceEventId: 'event-1', project: 'hub', ...at('2026-11-03T01:00:00Z'), text: 'A社の見積書', reference: true, attachment: { file, name: '見積書 (A社).pdf' } };
  const saved = await capture(config, request);
  const input = (await readInputs(config)).find(i => i.id === saved.inputId)!;
  expect(input.attachment).toEqual({ path: expect.stringMatching(/^05_files\/2026-11\/[0-9a-f]{24}\/見積書 \(A社\)\.pdf$/), name: '見積書 (A社).pdf', bytes: data.length, sha256: sha(data) });
  expect(await readFile(join(config.vaultPath, input.attachment!.path))).toEqual(data);
  // 資料として保存する記録も書く。
  expect((await readReferenceMarks(vault)).records).toEqual([expect.objectContaining({ input_id: saved.inputId, action: 'add' })]);
  await rebuildReferences(config);
  const text = await buildReferences(config, 'hub');
  expect(text).toContain('ファイル 1件');
  expect(text).toContain(`ファイル: [見積書 (A社).pdf](../../${input.attachment!.path.replace(' (', '%20%28').replace(')', '%29')})（1KB）`);
  expect((await readReferenceIndex(vault))!.entries[0]!.file).toEqual({ path: input.attachment!.path, name: '見積書 (A社).pdf', bytes: data.length });
  // ファイル名でも探せる。
  expect(await find(config, '見積書 (A社)')).toContain(saved.inputId);

  const again = await capture(config, request);
  expect(again).toMatchObject({ inputId: saved.inputId, deduped: true });
  expect(await vault.files('05_files')).toEqual([input.attachment!.path]);
  // 原文の保存前に止まった再送（ファイルだけが置かれた状態）でも、同じ場所の同じ内容を使う。違う内容があれば置き換えない。
  const placed = attachmentPath('cli', 'event-2', '2026-11', '見積書 (A社).pdf');
  await mkdir(dirname(join(config.vaultPath, placed)), { recursive: true });
  await writeFile(join(config.vaultPath, placed), 'ほかの内容');
  await expect(capture(config, { ...request, sourceEventId: 'event-2' })).rejects.toThrow('別の内容があります');
  await writeFile(join(config.vaultPath, placed), data);
  const retry = await capture(config, { ...request, sourceEventId: 'event-2' });
  const second = (await readInputs(config)).find(i => i.id === retry.inputId)!;
  expect(second.attachment!.path).toBe(placed);
  expect(await doctor(config)).toMatchObject({ issues: [] });
  // 消えたファイルはdoctorで示す。
  await rm(join(config.vaultPath, second.attachment!.path));
  expect((await doctor(config)).issues).toEqual([`添えたファイルがありません: ${second.attachment!.path}（${second.id}）`]);
});

test('ファイルはメモに資料として添える。大きすぎるファイル・秘密情報らしい名前は断る', async () => {
  const { config, outside } = await fixture();
  const file = join(outside, 'a.png'); await writeFile(file, 'x'.repeat(100));
  const base = { source: 'cli', ...at('2026-11-03T01:00:00Z'), text: '図', attachment: { file, name: 'a.png' } };
  await expect(capture(config, base)).rejects.toThrow('referenceが必要です');
  await expect(capture(config, { ...base, reference: true, kind: 'work-summary' })).rejects.toThrow('メモだけです');
  await expect(capture(config, { ...base, reference: true, attachment: { file, name: '../a.png' } })).rejects.toThrow();
  await expect(capture(config, { ...base, reference: true, attachment: { file: 'a.png', name: 'a.png' } })).rejects.toThrow('絶対パス');
  config.capture.maxFileBytes = 50;
  await expect(capture(config, { ...base, reference: true })).rejects.toThrow(AttachmentError);
  await expect(capture(config, { ...base, reference: true })).rejects.toThrow('上限50バイト');
  config.capture.maxFileBytes = undefined;
  await expect(capture(config, { ...base, reference: true, attachment: { file, name: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789.png' } })).rejects.toThrow('秘密情報');
  expect(await readInputs(config)).toEqual([]);
});

test('アプリの依頼は、Input/filesのファイルが届くまで保留し、受け付けた後にファイルを片付ける', async () => {
  const { config, vault } = await fixture();
  const data = Buffer.from('PNG架空の画像'), attachment = { name: '画面.png', bytes: data.length, sha256: sha(data) };
  const sent = await packet(config, { project: 'hub', reference: true, attachment }, '画面のメモ');
  // ファイルがまだ届いていない間は保留にし、断らない。
  let result = await ingest(config);
  expect(result).toMatchObject({ accepted: 0, rejected: 0, deferred: 1 });
  expect(await vault.files('90_system/intake-errors')).toEqual([]);
  expect(await vault.files('90_system/intake/pending')).toEqual([]);
  // 届く途中（小さい）も保留にする。
  await transport(config.vaultPath, sent.requestId, data.subarray(0, 3));
  expect(await ingest(config)).toMatchObject({ accepted: 0, deferred: 1 });
  await transport(config.vaultPath, sent.requestId, data);
  result = await ingest(config);
  expect(result).toMatchObject({ accepted: 1, rejected: 0 });
  const input = (await readInputs(config))[0]!;
  expect(input.attachment).toMatchObject({ name: '画面.png', bytes: data.length, sha256: sha(data) });
  expect(await readFile(join(config.vaultPath, input.attachment!.path))).toEqual(data);
  // 受け付けた後はInput/filesの写しを消す。Input/filesのフォルダー自体は依頼として扱わない。
  expect(await vault.files('Input/files')).toEqual([]);
  expect(await vault.files('90_system/intake-errors')).toEqual([]);
  expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 0, deferred: 0, deduped: 1 });
  // 受領の後に残ったファイル（受領の直後に停止した場合）も、次の受付で片付ける。
  await transport(config.vaultPath, sent.requestId, data);
  await ingest(config);
  expect(await vault.files('Input/files')).toEqual([]);
  expect(intakeFeatures(config)).toMatchObject({ capture_fields: expect.arrayContaining(['attachment']), attachments: { max_bytes: 25 * 1024 * 1024, name_max_bytes: FILE_NAME_BYTES } });
});

test('届いたファイルが依頼と違う・大きすぎる依頼は理由付きで断り、ファイルを片付けた後も保留に戻さない', async () => {
  const { config, vault } = await fixture();
  const data = Buffer.from('本物の内容'), other = Buffer.from('別物の内容');
  expect(other.length).toBe(data.length);
  const mismatch = await packet(config, { reference: true, attachment: { name: 'a.pdf', bytes: data.length, sha256: sha(data) } }, 'メモ');
  await transport(config.vaultPath, mismatch.requestId, other);
  config.capture.maxFileBytes = 1000;
  const big = await packet(config, { reference: true, attachment: { name: 'b.pdf', bytes: 2000, sha256: sha('x') } }, '大きい');
  await transport(config.vaultPath, big.requestId, Buffer.alloc(2000));
  // 依頼より大きいファイルは、届いた後で内容の不一致として断る。
  const longer = await packet(config, { reference: true, attachment: { name: 'c.pdf', bytes: 3, sha256: sha('abc') } }, '長い');
  await transport(config.vaultPath, longer.requestId, 'abcd');
  // 小さく申告して上限を超えるファイルを置いたときも、上限ではなく内容の不一致として断る。
  const over = await packet(config, { reference: true, attachment: { name: 'f.pdf', bytes: 10, sha256: sha('0123456789') } }, '申告より大きい');
  await transport(config.vaultPath, over.requestId, Buffer.alloc(2000));
  const result = await ingest(config);
  expect(result).toMatchObject({ accepted: 0, rejected: 4 });
  const errors = await Promise.all((await vault.files('90_system/intake-errors')).map(async p => intakeErrorSchema.parse(JSON.parse((await vault.read(p))!))));
  const reasonOf = (path: string) => errors.find(e => e.path === path)?.reason;
  expect(reasonOf(mismatch.path)).toEqual({ code: 'attachment-refused', cause: 'mismatch' });
  expect(reasonOf(big.path)).toEqual({ code: 'attachment-refused', cause: 'too-large', max_bytes: 1000 });
  expect(reasonOf(longer.path)).toEqual({ code: 'attachment-refused', cause: 'mismatch' });
  expect(reasonOf(over.path)).toEqual({ code: 'attachment-refused', cause: 'mismatch' });
  expect(await vault.files('Input/files')).toEqual([]);
  // 断った複製は、空のフォルダーも残さない（同期で各端末に広がるため）。
  expect(await readdir(join(config.vaultPath, '05_files')).catch(() => [])).toEqual([]);
  expect(await readInputs(config)).toEqual([]);
  // ファイルを片付けた後も、断った依頼は断ったまま（ファイル待ちの保留に戻らない）。
  expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 0, deferred: 0, deduped: 4 });
  // 行動・資料でないメモにはファイルを添えられない（受付形式の誤り）。
  await packet(config, { attachment: { name: 'd.pdf', bytes: 1, sha256: sha('d') } }, '資料でない');
  await packet(config, { kind: 'action', reference: true, attachment: { name: 'e.pdf', bytes: 1, sha256: sha('e') } }, '行動');
  expect(await ingest(config)).toMatchObject({ rejected: 2 });
});

test('断った記録を書けなかった回は、届いたファイルを消さず、次の受付で理由付きで断る', async () => {
  const { config, vault } = await fixture();
  const data = Buffer.from('本物の内容'), other = Buffer.from('別物の内容');
  const sent = await packet(config, { reference: true, attachment: { name: 'a.pdf', bytes: data.length, sha256: sha(data) } }, 'メモ');
  await transport(config.vaultPath, sent.requestId, other);
  // Writerの混雑で、断った記録だけを書けなかった回。
  const write = Vault.prototype.write;
  let failures = 1;
  Vault.prototype.write = async function (this: Vault, rel: string, text: string) {
    if (rel.startsWith('90_system/intake-errors/') && failures-- > 0) throw new LockTimeoutError('writer');
    return write.call(this, rel, text);
  };
  try { await ingest(config); } finally { Vault.prototype.write = write; }
  expect(await vault.files('90_system/intake-errors')).toEqual([]);
  expect(await vault.files('Input/files')).toEqual([`Input/files/${sent.requestId}`]);
  // 次の受付では、同じ理由で断って記録し、ファイルを片付ける。
  await ingest(config);
  const [error] = await Promise.all((await vault.files('90_system/intake-errors')).map(async p => intakeErrorSchema.parse(JSON.parse((await vault.read(p))!))));
  expect(error?.reason).toEqual({ code: 'attachment-refused', cause: 'mismatch' });
  expect(await vault.files('Input/files')).toEqual([]);
  expect(await vault.files('90_system/intake/pending')).toEqual([]);
});

test('doctorは、届かないファイル・依頼のないファイル・途中で止まった一時ファイルを注意として示す', async () => {
  const { config, vault } = await fixture();
  const data = Buffer.from('PNG架空の画像');
  const waiting = await packet(config, { reference: true, attachment: { name: 'a.png', bytes: data.length, sha256: sha(data) } }, '届かない');
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(join(config.vaultPath, waiting.path), old, old);
  const orphan = await transport(config.vaultPath, 'REQ-' + 'a'.repeat(32), data);
  const temp = await transport(config.vaultPath, '.ctx-1234.tmp', data);
  await mkdir(join(config.vaultPath, '05_files/2026-11/' + 'b'.repeat(24)), { recursive: true });
  const copy = join(config.vaultPath, '05_files/2026-11/' + 'b'.repeat(24), '.ctx-tmp-1');
  await writeFile(copy, data);
  for (const path of [orphan, temp, copy]) await utimes(path, old, old);
  // 保存したばかりの依頼と、新しいファイルは示さない。
  const fresh = await packet(config, { reference: true, attachment: { name: 'b.png', bytes: data.length, sha256: sha(data) } }, '保存したばかり');
  await utimes(join(config.vaultPath, fresh.path), new Date(), new Date());
  await transport(config.vaultPath, 'REQ-' + 'c'.repeat(32), data);
  await utimes(join(config.vaultPath, 'Input/files', 'REQ-' + 'c'.repeat(32)), new Date(), new Date());
  const result = await doctor(config);
  expect(result.issues).toEqual([]);
  expect(result.notices).toHaveLength(4);
  expect(result.notices).toEqual(expect.arrayContaining([
    expect.stringContaining(`添えたファイルが届いていない依頼: ${waiting.path}（48時間前に保存）`),
    expect.stringContaining('依頼のない添付ファイル: Input/files/REQ-' + 'a'.repeat(32) + '（2日前）'),
    expect.stringContaining('写す途中で止まった一時ファイル: Input/files/.ctx-1234.tmp'),
    expect.stringContaining('複製の途中で止まった一時ファイル: 05_files/2026-11/' + 'b'.repeat(24) + '/.ctx-tmp-1'),
  ]));
  expect(result.notices!.join('\n')).not.toContain(fresh.path);
  // 受け付けた後は示さない。
  await transport(config.vaultPath, waiting.requestId, data);
  await ingest(config);
  expect((await doctor(config)).notices?.some(n => n.includes(waiting.path)) ?? false).toBe(false);
});
