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
import { AgeCommandError, BackupArchiveError, archiveCreatedAt, backupExtractLimits, backupStatus, extractArchive, latestArchive, readBackupChecks, verifyBackup, type BackupCheck } from '../src/backup-check.js';
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
/** いまからhoursAgo時間前を名前にした、所定の形のアーカイブ名。実際のバックアップと同じく、名前の日時と更新時刻をそろえるために使う。 */
function stamp(hoursAgo = 0): string {
  const local = new Date(Date.now() + 9 * 3_600_000 - hoursAgo * 3_600_000).toISOString();
  return `vault-${local.slice(0, 10).replaceAll('-', '')}-${local.slice(11, 19).replaceAll(':', '')}.tar.gz`;
}
/** scripts/vault-backup.sh と同じ形（Vaultの中身を . から）でアーカイブを作る。 */
function archiveOf(config: HubConfig, backups: string, name = stamp(), extra: string[] = []): string {
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
  archiveOf(config, backups, stamp(2));
  const name = stamp(1), archive = archiveOf(config, backups, name);
  await writeFile(join(backups, 'notes.txt'), '無関係なファイル');
  expect(await latestArchive(backups)).toBe(archive);
  // バックアップの後に届いたメモは、バックアップに入っていなくてよい。
  await capture(config, { source: 'cli', kind: 'memo', occurredAt: new Date().toISOString(), text: 'バックアップの後のメモ' });
  const work = await tempDir();
  const { check, restoredTo } = await verifyBackup(config, { workDir: work });
  expect(check).toMatchObject({ status: 'ok', archive: name, restored: { inputs: 2, projects: 1, receipts: 2 }, live: { inputs: 3, projects: 1 }, verify_max_age_days: 7, issues: [] });
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
  expect(report.backup).toEqual({ restore_point: name, restore_point_age_days: 0, warnings: [] });
  // --keep のときだけ展開先を残す。
  const kept = await verifyBackup(config, { workDir: work, keep: true });
  expect(await readFile(join(kept.restoredTo!, '10_projects/hub/NOW.md'), 'utf8')).toContain('# 現在地');
  // pax形式（macOSのtarの既定に近い形式）と、長い日本語のファイル名も読める。
  const longName = `${'覚え書き'.repeat(12)}.md`;
  await writeFile(join(config.vaultPath, '10_projects/hub', longName), '手で置いたノート');
  const paxName = stamp();
  archiveOf(config, backups, paxName, ['--format=pax']);
  const paxCheck = await verifyBackup(config, { workDir: work, keep: true });
  expect(paxCheck.check).toMatchObject({ status: 'ok', archive: paxName });
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
  const archive = archiveOf(config, backups, stamp(240));
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
  archiveOf(config, backups, stamp(2));
  const good = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(good.status).toBe('ok');
  // 原文が1件入っていないアーカイブ。
  archiveOf(config, backups, stamp(1), [`--exclude=./${first.path}`]);
  const missing = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(missing).toMatchObject({ status: 'failed', restored: { inputs: 1 } });
  expect(missing.issues).toContain('バックアップより前に受け取った原文が1件入っていません');
  // バックアップの後で現在のVaultの原文が変わっている（原文は不変のはず）。
  const changedName = stamp();
  archiveOf(config, backups, changedName);
  const original = (await vault.read(first.path))!;
  await writeFile(join(config.vaultPath, first.path), original.replace('最初のメモ', '書き換えたメモ'));
  const changed = (await verifyBackup(config, { workDir: await tempDir() })).check;
  expect(changed.issues).toContain('バックアップと現在のVaultで内容が違う原文が1件あります');
  await writeFile(join(config.vaultPath, first.path), original);
  const status = backupStatus(config, (await readBackupChecks(vault)).records);
  expect(status.restorePoint?.id).toBe(good.id);
  expect(status.latest?.id).toBe(changed.id);
  expect(status.warnings[0]).toContain(`最後の確認でバックアップ（${changedName}）から復元できませんでした`);
  await rebuildDashboard(config);
  const home = (await vault.read('HOME.md'))!;
  expect(home).toContain('最後に確かめた復元点: ');
  expect(home).toContain(`- バックアップ: 最後の確認でバックアップ（${changedName}）から復元できませんでした`);
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

test('ファイルと同じ名前のフォルダーを含むアーカイブは、止まらずに復元できないと記録する', async () => {
  const { config, vault, backups } = await fixture();
  await writeFile(join(backups, 'vault-20261110-033000.tar.gz'), gzipSync(Buffer.concat([
    tarEntry('./', '', '5'), tarEntry('./00_inbox', 'ファイル'), tarEntry('./00_inbox/a.md', '原文A'), tarEntry('./00_inbox/sub/', '', '5'), tarEnd,
  ])));
  const work = await tempDir();
  const { check } = await verifyBackup(config, { workDir: work });
  expect(check.status).toBe('failed');
  expect(check.issues).toEqual(expect.arrayContaining(['展開しなかったエントリー — ファイルと同じ名前のフォルダー: ./00_inbox/a.md', '展開しなかったエントリー — ファイルと同じ名前のフォルダー: ./00_inbox/sub/']));
  expect((await readBackupChecks(vault)).records).toHaveLength(1);
  expect(await readdir(work)).toEqual([]);
});

test('確かめた復元点は復元できたいちばん新しいバックアップで、古いアーカイブを後から確かめても古くならない', async () => {
  const { config, vault, backups } = await fixture();
  const newer = archiveOf(config, backups, 'vault-20261110-033000.tar.gz'), older = archiveOf(config, backups, 'vault-20261020-033000.tar.gz');
  await utimes(newer, new Date('2026-11-09T18:30:00Z'), new Date('2026-11-09T18:30:00Z'));
  await utimes(older, new Date('2026-10-19T18:30:00Z'), new Date('2026-10-19T18:30:00Z'));
  const now = new Date('2026-11-10T00:00:00Z'), work = await tempDir();
  expect((await verifyBackup(config, { workDir: work, now })).check.archive).toBe('vault-20261110-033000.tar.gz');
  expect((await verifyBackup(config, { archive: older, workDir: work, now })).check).toMatchObject({ status: 'ok', archive: 'vault-20261020-033000.tar.gz' });
  const status = backupStatus(config, (await readBackupChecks(vault)).records, now);
  expect(status.latest?.archive).toBe('vault-20261020-033000.tar.gz');
  expect(status.restorePoint?.archive).toBe('vault-20261110-033000.tar.gz');
  expect(status.warnings).toEqual([]);
});

test('写し直して更新時刻が新しくなったアーカイブは、名前の日時を作成時刻として扱う', async () => {
  const named = Date.parse('2026-11-01T03:30:00+09:00');
  // 更新時刻が名前の日時に近ければ、更新時刻を使う（端末の時刻のずれを吸収する）。
  expect(archiveCreatedAt('vault-20261101-033000.tar.gz', named + 5 * 60_000, 'Asia/Tokyo')).toBe(named + 5 * 60_000);
  expect(archiveCreatedAt('vault-20261101-033000.tar.gz', named - 9 * 3_600_000, 'Asia/Tokyo')).toBe(named - 9 * 3_600_000);
  expect(archiveCreatedAt('vault-20261101-033000.tar.gz', named + 5 * 86_400_000, 'Asia/Tokyo')).toBe(named);
  expect(archiveCreatedAt('vault-20261101-033000.tar.gz', named + 5 * 86_400_000, 'UTC')).toBe(Date.parse('2026-11-01T03:30:00Z'));
  expect(archiveCreatedAt('copy.tar.gz', named + 5 * 86_400_000, 'Asia/Tokyo')).toBe(named + 5 * 86_400_000);
  // バックアップの後に受け取ったメモは、写し直したアーカイブでも欠けと数えない。
  const { config, vault, backups } = await fixture();
  const archive = archiveOf(config, backups, 'vault-20261101-033000.tar.gz');
  await capture(config, { source: 'cli', kind: 'memo', occurredAt: '2026-11-03T00:00:00Z', receivedAt: '2026-11-03T00:00:00Z', text: 'バックアップの後のメモ' });
  await utimes(archive, new Date('2026-11-08T00:00:00Z'), new Date('2026-11-08T00:00:00Z'));
  const { check } = await verifyBackup(config, { workDir: await tempDir(), now: new Date('2026-11-08T01:00:00Z') });
  expect(check).toMatchObject({ status: 'ok', archive_created_at: '2026-10-31T18:30:00.000Z' });
  expect((await readBackupChecks(vault)).records).toHaveLength(1);
});

test('最初のメモより前のバックアップは、原文がなくても復元できないとは判定しない', async () => {
  const { config: base } = await workflowSetup(roots);
  const backups = join(base.vaultPath, '..', 'backups'); await mkdir(backups);
  const config: HubConfig = { ...base, backup: { dir: backups, verifyMaxAgeDays: 7 } };
  const archive = archiveOf(config, backups, 'vault-20261110-033000.tar.gz');
  await utimes(archive, new Date('2026-11-09T18:30:00Z'), new Date('2026-11-09T18:30:00Z'));
  await capture(config, { source: 'cli', kind: 'memo', occurredAt: '2026-11-10T00:00:00Z', receivedAt: '2026-11-10T00:00:00Z', text: 'バックアップの後の最初のメモ' });
  expect((await verifyBackup(config, { workDir: await tempDir(), now: new Date('2026-11-10T01:00:00Z') })).check).toMatchObject({ status: 'ok', restored: { inputs: 0 }, live: { inputs: 1 } });
});

test('展開先は確認のたびに片付け、途中で止まった古い展開先も片付ける。--keepで残したものは消さない', async () => {
  const { config, vault, backups } = await fixture();
  archiveOf(config, backups);
  const work = await tempDir();
  // 前回の確認が途中で止まって残った展開先（1日以上前）と、まだ新しいもの、関係のないフォルダー。
  for (const name of ['ctx-backup-verify-OLD001', 'ctx-backup-verify-NEW001', 'ctx-backup-restored-KEEP01', 'other']) { await mkdir(join(work, name, 'vault'), { recursive: true }); await writeFile(join(work, name, 'vault', 'a.md'), 'x'); }
  const longAgo = new Date(Date.now() - 3 * 86_400_000);
  for (const name of ['ctx-backup-verify-OLD001', 'ctx-backup-restored-KEEP01', 'other']) await utimes(join(work, name), longAgo, longAgo);
  const kept = await verifyBackup(config, { workDir: work, keep: true });
  expect(kept.restoredTo).toMatch(/ctx-backup-restored-[A-Za-z0-9]{6}\/vault$/);
  expect((await readdir(kept.restoredTo!)).sort()).toContain('00_inbox');
  expect((await readdir(work)).filter(n => n.startsWith('ctx-backup-verify-'))).toEqual(['ctx-backup-verify-NEW001']);
  expect((await readdir(work)).sort()).toEqual(expect.arrayContaining(['ctx-backup-restored-KEEP01', 'other']));
  // 現在のVaultを読めないときは、展開を始める前に止まり、展開先を残さない。
  const before = (await readdir(work)).sort();
  await vault.write('00_inbox/2026-11-11_IN-01K5ABCDEFGHJKMNPQRSTVWXYZ.md', '壊れた原文');
  await expect(verifyBackup(config, { workDir: work })).rejects.toThrow();
  expect((await readdir(work)).sort()).toEqual(before);
});

test('確認結果は新しい30件と、最後に復元できた1件を残す', async () => {
  const { config, vault, backups } = await fixture();
  const template: BackupCheck = { schema_version: 1, id: '', archive: 'vault-20261001-033000.tar.gz', archive_created_at: old, archive_bytes: 10, checked_at: old, status: 'failed', restored: null, verify_max_age_days: 7, live: { inputs: 2, projects: 1 }, issues: ['アーカイブが途中で終わっています'], notes: [] };
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
  expect(validateConfig({ ...base, backup: { dir: '/tmp/ctx-backups', verifyMaxAgeDays: 3 } }).backup).toEqual({ dir: '/tmp/ctx-backups', verifyMaxAgeDays: 3, ageIdentity: null, ageCommand: 'age' });
  expect(validateConfig(base).backup).toEqual({ dir: null, verifyMaxAgeDays: 7, ageIdentity: null, ageCommand: 'age' });
  expect(() => validateConfig({ ...base, backup: { dir: '/tmp/ctx-vault/backups', verifyMaxAgeDays: 7 } })).toThrow('Vaultの外');
  expect(() => validateConfig({ ...base, backup: { dir: 'relative/backups', verifyMaxAgeDays: 7 } })).toThrow();
});

test('確認の展開上限はVaultの大きさと空き容量から決め、空きが足りなければ展開しない', () => {
  const MiB = 1024 ** 2, GiB = 1024 ** 3;
  // 小さいVaultでも256MiBまでは展開できる。
  expect(backupExtractLimits(10 * MiB).maxBytes).toBe(256 * MiB);
  // 大きいVaultは4倍まで。64GiBは超えない。
  expect(backupExtractLimits(2 * GiB).maxBytes).toBe(8 * GiB);
  expect(backupExtractLimits(40 * GiB).maxBytes).toBe(64 * GiB);
  // 空き容量が分かれば、256MiBを残した分までにする。
  expect(backupExtractLimits(2 * GiB, 5 * GiB).maxBytes).toBe(5 * GiB - 256 * MiB);
  expect(() => backupExtractLimits(2 * GiB, 2 * GiB)).toThrow('空き容量が足りません');
});

/** ageとage-keygenがあるときだけ、暗号化したバックアップを試す（CIではインストールしてから実行する）。 */
const hasAge = spawnSync('age', ['--version']).status === 0 && spawnSync('age-keygen', ['--help']).error === undefined;
// CIではageを入れたうえでCTX_REQUIRE_AGE=1を指定し、暗号化の試験が黙って飛ばされないようにする。
if (!hasAge && process.env.CTX_REQUIRE_AGE === '1') throw new Error('ageとage-keygenが見つかりません');
/** 架空の鍵の組。秘密鍵はVaultとバックアップ先の外に置く。 */
async function ageKeys(): Promise<{ identity: string; recipient: string }> {
  const dir = await tempDir(), identity = join(dir, 'backup-key.txt');
  const made = spawnSync('age-keygen', ['-o', identity], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  const pub = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' });
  return { identity, recipient: pub.stdout.trim() };
}
/** scripts/vault-backup.sh と同じ形で作ったtar.gzを、ageで暗号化して.tar.gz.ageにする。 */
async function encryptedArchiveOf(config: HubConfig, backups: string, recipient: string, name = stamp().replace(/\.tar\.gz$/, '.tar.gz.age')): Promise<string> {
  const plainDir = await tempDir(), plain = archiveOf(config, plainDir, 'plain.tar.gz'), out = join(backups, name);
  const result = spawnSync('age', ['-e', '-r', recipient, '-o', out, plain], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return out;
}

test.skipIf(!hasAge)('暗号化したバックアップを秘密鍵で復号して確かめ、HOMEに暗号化したバックアップとして示す', async () => {
  const { config, vault, backups } = await fixture();
  const { identity, recipient } = await ageKeys();
  // 名前は1回だけ決める（時刻をまたいで作り直すと、別の名前になることがある）。
  const plainName = stamp(3);
  archiveOf(config, backups, plainName);
  const name = stamp(1).replace(/\.tar\.gz$/, '.tar.gz.age'), archive = await encryptedArchiveOf(config, backups, recipient, name);
  // 暗号化したものと、しないものが混ざっていても、いちばん新しいものを選ぶ。
  expect(await latestArchive(backups)).toBe(archive);
  const encrypted: HubConfig = { ...config, backup: { ...config.backup!, ageIdentity: identity } };
  const work = await tempDir();
  const { check } = await verifyBackup(encrypted, { workDir: work });
  expect(check).toMatchObject({ status: 'ok', archive: name, encrypted: true, restored: { inputs: 2, projects: 1, receipts: 2 }, issues: [] });
  expect(await readdir(work)).toEqual([]);
  // 記録には秘密鍵の場所を残さない。
  const raw = (await vault.read(`90_system/backup-checks/${check.id}.json`))!;
  expect(raw).not.toContain(identity);
  expect(raw).not.toContain('AGE-SECRET-KEY');
  await rebuildDashboard(encrypted);
  expect((await vault.read('HOME.md'))!).toMatch(/\n最後に確かめた復元点: \d{4}-\d{2}-\d{2} \d{2}:\d{2}の暗号化したバックアップ（0日前 \/ 今日復元できることを確認）\n/);
  // 暗号化していないアーカイブの記録には、encryptedを書かない。
  const plainCheck = await verifyBackup(encrypted, { archive: join(backups, plainName), workDir: work });
  expect(plainCheck.check.status).toBe('ok');
  expect(plainCheck.check).not.toHaveProperty('encrypted');
});

test.skipIf(!hasAge)('鍵が違う・壊れた・途中で切れた暗号化アーカイブは、復号できないとして記録する', async () => {
  const { config, backups } = await fixture();
  const right = await ageKeys(), wrong = await ageKeys();
  const archive = await encryptedArchiveOf(config, backups, right.recipient, 'vault-20261110-033000.tar.gz.age');
  const work = await tempDir();
  const withKey = (identity: string): HubConfig => ({ ...config, backup: { ...config.backup!, ageIdentity: identity } });
  const reason = '暗号化したアーカイブを復号できません（鍵が違う、壊れている、または途中で切れています）';
  expect((await verifyBackup(withKey(wrong.identity), { archive, workDir: work })).check).toMatchObject({ status: 'failed', encrypted: true, restored: null, issues: [reason] });
  const bytes = await readFile(archive);
  // 末尾を切ったもの（認証できた途中までしか出てこない）。
  await writeFile(archive, bytes.subarray(0, bytes.length - 40));
  expect((await verifyBackup(withKey(right.identity), { archive, workDir: work })).check).toMatchObject({ status: 'failed', issues: [reason] });
  // 本文の1バイトを書き換えたもの。
  const tampered = Buffer.from(bytes); tampered[tampered.length - 30] ^= 0xff;
  await writeFile(archive, tampered);
  expect((await verifyBackup(withKey(right.identity), { archive, workDir: work })).check).toMatchObject({ status: 'failed', issues: [reason] });
  expect(await readdir(work)).toEqual([]);
});

test.skipIf(!hasAge)('復号の途中でこちらが止めたとき（展開の上限など）は、復号の失敗ではなく、止めた理由を示す', async () => {
  const { config, backups } = await fixture();
  const { identity, recipient } = await ageKeys();
  const archive = await encryptedArchiveOf(config, backups, recipient, 'vault-20261110-033000.tar.gz.age');
  const decrypt = { command: 'age', identity };
  await expect(extractArchive(archive, await tempDir(), { maxFiles: 1, maxBytes: 1024 ** 3 }, decrypt)).rejects.toThrow('エントリー数が上限');
  await expect(extractArchive(archive, await tempDir(), { maxFiles: 1000, maxBytes: 8 }, decrypt)).rejects.toThrow('展開後の大きさが上限');
  // 止めずに最後まで読めば、復号して展開できる。
  expect((await extractArchive(archive, await tempDir(), undefined, decrypt)).files).toBeGreaterThan(0);
});

test('暗号化したバックアップは、秘密鍵やageがなければ「復元できない」とは記録せずに止める', async () => {
  const { config, vault, backups } = await fixture();
  // 中身は問わない（鍵がない・コマンドがないことを、復号の前に見つける）。
  const archive = join(backups, 'vault-20261110-033000.tar.gz.age');
  await writeFile(archive, 'age-encryption.org/v1\n');
  const work = await tempDir();
  await expect(verifyBackup(config, { workDir: work })).rejects.toThrow('backup.ageIdentity');
  await expect(verifyBackup({ ...config, backup: { ...config.backup!, ageIdentity: join(work, 'none.txt') } }, { workDir: work })).rejects.toThrow('秘密鍵のファイルを読めません');
  // パスフレーズで守った鍵は、無人の確認では入力できずに止まるため、展開の前に断る。
  const locked = join(work, 'locked.txt'); await writeFile(locked, 'age-encryption.org/v1\n-> scrypt 架空\n');
  await expect(verifyBackup({ ...config, backup: { ...config.backup!, ageIdentity: locked } }, { archive, workDir: work })).rejects.toThrow('パスフレーズ');
  await rm(locked);
  const key = join(work, 'key.txt'); await writeFile(key, '# 架空の鍵\n');
  const missing: HubConfig = { ...config, backup: { ...config.backup!, ageIdentity: key, ageCommand: join(work, 'no-such-age') } };
  await expect(verifyBackup(missing, { archive, workDir: work })).rejects.toThrow(AgeCommandError);
  await expect(verifyBackup(missing, { archive, workDir: work })).rejects.toThrow('backup.ageCommand');
  expect((await readBackupChecks(vault)).records).toEqual([]);
  expect((await readdir(work)).sort()).toEqual(['key.txt']);
});

test('ageの秘密鍵は、Vaultの中やバックアップ先の中には設定できない', async () => {
  const base = defaultConfig('/tmp/ctx-key-vault', '/tmp/ctx-key-state');
  const ok = validateConfig({ ...base, backup: { dir: '/tmp/ctx-key-backups', verifyMaxAgeDays: 7, ageIdentity: '/tmp/ctx-keys/backup.txt', ageCommand: '/opt/homebrew/bin/age' } });
  expect(ok.backup).toMatchObject({ ageIdentity: '/tmp/ctx-keys/backup.txt', ageCommand: '/opt/homebrew/bin/age' });
  // 書かなければ鍵なし・コマンドはageになる（今までの設定ファイルのまま読める）。
  expect(validateConfig({ ...base, backup: { dir: null, verifyMaxAgeDays: 7 } }).backup).toEqual({ dir: null, verifyMaxAgeDays: 7, ageIdentity: null, ageCommand: 'age' });
  expect(() => validateConfig({ ...base, backup: { dir: null, verifyMaxAgeDays: 7, ageIdentity: '/tmp/ctx-key-vault/keys/backup.txt' } })).toThrow('Vaultの外');
  expect(() => validateConfig({ ...base, backup: { dir: '/tmp/ctx-key-backups', verifyMaxAgeDays: 7, ageIdentity: '/tmp/ctx-key-backups/backup.txt' } })).toThrow('バックアップ先の外');
  expect(() => validateConfig({ ...base, backup: { dir: null, verifyMaxAgeDays: 7, ageIdentity: 'keys/backup.txt' } })).toThrow();
});
