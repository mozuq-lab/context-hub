import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workflowSetup } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { defaultConfig, validateConfig } from '../src/config.js';
import { BackupArchiveError, backupStatus, extractArchive, latestArchive, readBackupChecks, verifyBackup, type BackupCheck } from '../src/backup-check.js';
import type { HubConfig } from '../src/types.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const old = '2026-10-01T00:00:00Z';

/** 架空のVaultと、Vaultの外のバックアップ先。 */
async function fixture() {
  const { config: base, vault } = await workflowSetup(roots);
  const backups = join(base.vaultPath, '..', 'backups');
  await mkdir(backups);
  const config: HubConfig = { ...base, backup: { dir: backups, verifyMaxAgeDays: 7 } };
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const first = await capture(config, { source: 'cli', kind: 'memo', project: 'hub', occurredAt: old, receivedAt: old, text: '最初のメモ' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: old, receivedAt: old, text: '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる' });
  await organize(config, new MockLlm());
  return { config, vault, backups, first };
}
/** scripts/vault-backup.sh と同じ形（Vaultの中身を . から）でアーカイブを作る。 */
function archiveOf(config: HubConfig, backups: string, name = 'vault-20261110-033000.tar.gz', extra: string[] = []): string {
  const out = join(backups, name), result = spawnSync('tar', [...extra, '-czf', out, '-C', config.vaultPath, '.'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return out;
}
/** 検査用の小さなtar。typeは通常ファイル'0'、ディレクトリ'5'、リンク'2'、拡張見出し'x'・'L'。 */
function tarEntry(name: string, content: string | Buffer = '', type = '0', linkname = ''): Buffer {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content), header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8'); header.write('0000644\0', 100, 'latin1'); header.write('0000000\0', 108, 'latin1'); header.write('0000000\0', 116, 'latin1');
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1'); header.write('00000000000\0', 136, 'latin1');
  header.write('        ', 148, 'latin1'); header.write(type, 156, 'latin1'); header.write(linkname, 157, 100, 'utf8'); header.write('ustar\0' + '00', 257, 'latin1');
  let sum = 0; for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const tarEnd = Buffer.alloc(1024);
const pax = (records: Record<string, string>) => Buffer.from(Object.entries(records).map(([k, v]) => { const body = ` ${k}=${v}\n`; let length = Buffer.byteLength(body) + 1; while (Buffer.byteLength(String(length)) + Buffer.byteLength(body) !== length) length++; return `${length}${body}`; }).join(''));
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ctx-backup-check-')); roots.push(dir); return dir; }

test('バックアップを展開して確かめ、復元できた結果を記録してHOMEとdoctorに復元点を示す', async () => {
  const { config, vault, backups } = await fixture();
  archiveOf(config, backups, 'vault-20261109-033000.tar.gz');
  const archive = archiveOf(config, backups);
  await writeFile(join(backups, 'notes.txt'), '無関係なファイル');
  expect(await latestArchive(backups)).toBe(archive);
  // バックアップの後に届いたメモは、バックアップに入っていなくてよい。
  await capture(config, { source: 'cli', kind: 'memo', occurredAt: new Date().toISOString(), text: 'バックアップの後のメモ' });
  const work = await tempDir();
  const { check, restoredTo } = await verifyBackup(config, { workDir: work });
  expect(check).toMatchObject({ status: 'ok', archive: 'vault-20261110-033000.tar.gz', restored: { inputs: 2, projects: 1, receipts: 2 }, live: { inputs: 3, projects: 1 }, issues: [] });
  expect(check.restored!.files).toBeGreaterThan(5);
  expect(restoredTo).toBeUndefined();
  expect(await readdir(work)).toEqual([]);
  // 記録にはアーカイブの名前だけを書き、バックアップ先のパスを書かない。
  const raw = (await vault.read(`90_system/backup-checks/${check.id}.json`))!;
  expect(raw).not.toContain(backups);
  expect((await readBackupChecks(vault)).records.map(r => r.id)).toEqual([check.id]);
  await rebuildDashboard(config);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toMatch(/\n最後に確かめた復元点: \d{4}-\d{2}-\d{2} \d{2}:\d{2}のバックアップ（0日前 \/ 今日復元できることを確認）\n/);
  expect(home).not.toContain('- バックアップ:');
  const report = await doctor(config);
  expect(report.issues).toEqual([]);
  expect(report.backup).toEqual({ restore_point: 'vault-20261110-033000.tar.gz', restore_point_age_days: 0, warnings: [] });
  // --keep のときだけ展開先を残す。
  const kept = await verifyBackup(config, { workDir: work, keep: true });
  expect(await readFile(join(kept.restoredTo!, '10_projects/hub/NOW.md'), 'utf8')).toContain('# 現在地');
  // pax形式（macOSのtarの既定に近い形式）と、長い日本語のファイル名も読める。
  const longName = `${'覚え書き'.repeat(12)}.md`;
  await writeFile(join(config.vaultPath, '10_projects/hub', longName), '手で置いたノート');
  archiveOf(config, backups, 'vault-20261111-033000.tar.gz', ['--format=pax']);
  const paxCheck = await verifyBackup(config, { workDir: work, keep: true });
  expect(paxCheck.check).toMatchObject({ status: 'ok', archive: 'vault-20261111-033000.tar.gz' });
  expect(await readFile(join(paxCheck.restoredTo!, '10_projects/hub', longName), 'utf8')).toBe('手で置いたノート');
});

test('バックアップ先を設定していない間は何も示さず、設定後に未確認・古い復元点を知らせる', async () => {
  const { config, vault, backups } = await fixture();
  const plain: HubConfig = { ...config, backup: { dir: null, verifyMaxAgeDays: 7 } };
  await rebuildDashboard(plain);
  expect(await vault.read('HOME.md')).not.toContain('バックアップ');
  expect((await doctor(plain)).backup).toBeUndefined();
  await expect(verifyBackup(plain)).rejects.toThrow('バックアップ先が設定されていません');
  await expect(verifyBackup(config)).rejects.toThrow('確かめるバックアップが見つかりません');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('- バックアップ: 復元できると確かめたバックアップがまだありません');
  const archive = archiveOf(config, backups);
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
  await utimes(archive, tenDaysAgo, tenDaysAgo);
  const { check } = await verifyBackup(config, { workDir: await tempDir() });
  expect(check.status).toBe('ok');
  const status = backupStatus(config, [check]);
  expect(status).toMatchObject({ restorePointAgeDays: 10, warnings: [expect.stringContaining('確かめた復元点が10日前のバックアップです（目安は7日以内）')] });
  await rebuildDashboard(config);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('のバックアップ（10日前 / 今日復元できることを確認）');
  expect(home).toContain('- バックアップ: 確かめた復元点が10日前のバックアップです');
  // 展開先をVaultの中に指定させない。
  await expect(verifyBackup(config, { workDir: join(config.vaultPath, '00_inbox') })).rejects.toThrow('展開先はVaultの外');
});

test('原文が欠けた・現在と違うバックアップは復元できないと記録し、最後に復元できた復元点は残す', async () => {
  const { config, vault, backups, first } = await fixture();
  archiveOf(config, backups, 'vault-20261109-033000.tar.gz');
  const good = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(good.status).toBe('ok');
  // 原文が1件入っていないアーカイブ。
  archiveOf(config, backups, 'vault-20261110-033000.tar.gz', [`--exclude=./${first.path}`]);
  const missing = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(missing).toMatchObject({ status: 'failed', restored: { inputs: 1 } });
  expect(missing.issues).toContain('バックアップより前に受け取った原文が1件入っていません');
  // バックアップの後で現在のVaultの原文が変わっている（原文は不変のはず）。
  archiveOf(config, backups, 'vault-20261111-033000.tar.gz');
  const original = (await vault.read(first.path))!;
  await writeFile(join(config.vaultPath, first.path), original.replace('最初のメモ', '書き換えたメモ'));
  const changed = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(changed.issues).toContain('バックアップと現在のVaultで内容が違う原文が1件あります');
  await writeFile(join(config.vaultPath, first.path), original);
  const status = backupStatus(config, (await readBackupChecks(vault)).records);
  expect(status.restorePoint?.id).toBe(good.id);
  expect(status.latest?.id).toBe(changed.id);
  expect(status.warnings[0]).toContain('最後の確認でバックアップ（vault-20261111-033000.tar.gz）から復元できませんでした');
  await rebuildDashboard(config);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('最後に確かめた復元点: ');
  expect(home).toContain('- バックアップ: 最後の確認でバックアップ（vault-20261111-033000.tar.gz）から復元できませんでした');
  // 壊れた確認結果の記録は、doctorとHOMEで示す。
  await vault.write('90_system/backup-checks/BKC-broken.json', '{');
  expect((await doctor(config)).issues).toContain('バックアップの確認結果の記録が不正です: 90_system/backup-checks/BKC-broken.json');
});

test('途中で切れた・壊れたアーカイブは復元できないと記録する', async () => {
  const { config, backups } = await fixture();
  const archive = archiveOf(config, backups), bytes = await readFile(archive);
  await writeFile(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const truncated = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(truncated).toMatchObject({ status: 'failed', restored: null });
  expect(truncated.issues[0]).toMatch(/アーカイブ/);
  await writeFile(archive, 'tar.gzではないファイル');
  expect((await verifyBackup(config, { workDir: await tempDir() })).check).toMatchObject({ status: 'failed', restored: null, issues: ['アーカイブの圧縮を解けません（壊れているか、途中で切れています）'] });
  // 圧縮は正しいが、終端のないtar。
  await writeFile(archive, gzipSync(tarEntry('./00_inbox/a.md', 'x')));
  expect((await verifyBackup(config, { workDir: await tempDir() })).check.issues).toEqual(['アーカイブが途中で終わっています']);
});

test('展開は通常ファイルとディレクトリだけを展開先の中へ書き、リンクや外を指すパスは書かずに報告する', async () => {
  const dir = await tempDir(), dest = join(dir, 'out'), archive = join(dir, 'crafted.tar.gz');
  await mkdir(dest);
  const longName = `./00_inbox/${'長い名前'.repeat(15)}.md`;
  await writeFile(archive, gzipSync(Buffer.concat([
    tarEntry('./', '', '5'), tarEntry('./00_inbox/', '', '5'), tarEntry('./00_inbox/a.md', '原文A'), tarEntry('./00_inbox/empty.md', ''),
    tarEntry('./00_inbox/._a.md', 'メタデータ'), tarEntry('../outside.md', '外へ'), tarEntry('/abs.md', '絶対パス'), tarEntry('./00_inbox/x/../../../up.md', '親へ'),
    tarEntry('./link.md', '', '2', '/etc/passwd'), tarEntry('./hard.md', '', '1', './00_inbox/a.md'), tarEntry('./fifo', '', '6'),
    tarEntry('./PaxHeader/long', pax({ path: longName }), 'x'), tarEntry('./00_inbox/short.md', '長い名前の本文'),
    tarEntry('././@LongLink', Buffer.from('./00_inbox/gnu-long.md\0'), 'L'), tarEntry('./00_inbox/gnu', 'GNUの長い名前'),
    tarEntry('./00_inbox/a.md', '重複'), tarEnd,
  ])));
  const outcome = await extractArchive(archive, dest);
  expect(outcome).toMatchObject({ files: 4, appleDouble: 1 });
  expect(outcome.rejected).toEqual([
    '展開先の外を指すパス: ../outside.md', '展開先の外を指すパス: /abs.md', '展開先の外を指すパス: ./00_inbox/x/../../../up.md',
    'リンク: ./link.md', 'リンク: ./hard.md', '特殊ファイル: ./fifo', '同じパスが重複: ./00_inbox/a.md',
  ]);
  expect((await readdir(dir)).sort()).toEqual(['crafted.tar.gz', 'out']);
  expect((await readdir(dest)).sort()).toEqual(['00_inbox']);
  expect((await readdir(join(dest, '00_inbox'))).sort()).toEqual(['a.md', 'empty.md', 'gnu-long.md', `${'長い名前'.repeat(15)}.md`].sort());
  expect(await readFile(join(dest, '00_inbox/a.md'), 'utf8')).toBe('原文A');
  expect(await readFile(join(dest, '00_inbox/gnu-long.md'), 'utf8')).toBe('GNUの長い名前');
  // 検査値の合わない見出しは、アーカイブとして読まない。
  const bad = tarEntry('./a.md', 'x'); bad[0] = 0x41;
  await writeFile(archive, gzipSync(Buffer.concat([bad, tarEnd])));
  await expect(extractArchive(archive, join(dir, 'out'))).rejects.toBeInstanceOf(BackupArchiveError);
  // 上限を超える展開は止める。
  await writeFile(archive, gzipSync(Buffer.concat([tarEntry('./big.md', 'x'.repeat(2000)), tarEnd])));
  await mkdir(join(dir, 'limited'));
  await expect(extractArchive(archive, join(dir, 'limited'), { maxFiles: 10, maxBytes: 1000 })).rejects.toThrow('展開後の大きさが上限を超えました');
});

test('確認結果は新しい30件と、最後に復元できた1件を残す', async () => {
  const { config, vault, backups } = await fixture();
  const template: BackupCheck = { schema_version: 1, id: '', archive: 'vault-20261001-033000.tar.gz', archive_created_at: old, archive_bytes: 10, checked_at: old, status: 'failed', restored: null, live: { inputs: 2, projects: 1 }, issues: ['アーカイブが途中で終わっています'], notes: [] };
  const id = (i: number) => `BKC-000000000000000000000000${String(i).padStart(2, '0')}`;
  const write = (r: BackupCheck) => vault.write(`90_system/backup-checks/${r.id}.json`, JSON.stringify(r));
  await write({ ...template, id: id(0), status: 'ok', issues: [], restored: { files: 9, inputs: 2, projects: 1, receipts: 2 } });
  for (let i = 1; i <= 31; i++) await write({ ...template, id: id(i) });
  await writeFile(join(backups, 'vault-20261112-033000.tar.gz'), 'broken');
  const last = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(last.status).toBe('failed');
  const ids = (await readBackupChecks(vault)).records.map(r => r.id);
  expect(ids).toEqual([id(0), ...Array.from({ length: 29 }, (_, i) => id(i + 3)), last.id]);
});

test('バックアップ先はVaultの外に設定する', async () => {
  const base = defaultConfig('/tmp/ctx-vault', '/tmp/ctx-state');
  expect(validateConfig({ ...base, backup: { dir: '/tmp/ctx-backups', verifyMaxAgeDays: 3 } }).backup).toEqual({ dir: '/tmp/ctx-backups', verifyMaxAgeDays: 3 });
  expect(validateConfig(base).backup).toEqual({ dir: null, verifyMaxAgeDays: 7 });
  expect(() => validateConfig({ ...base, backup: { dir: '/tmp/ctx-vault/backups', verifyMaxAgeDays: 7 } })).toThrow('Vaultの外');
  expect(() => validateConfig({ ...base, backup: { dir: 'relative/backups', verifyMaxAgeDays: 7 } })).toThrow();
});
