import { expect, test } from 'vitest';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const backupScript = fileURLToPath(new URL('../../../scripts/vault-backup.sh', import.meta.url));

test.skipIf(process.platform === 'win32').each([
  '通常の子ディレクトリ', 'Vault末尾のスラッシュ', '親ディレクトリ経由',
  'Vault側のシンボリックリンク', '保存先側のシンボリックリンク', '末尾スラッシュ付きの同一Vault',
])('バックアップ先がVault内なら書き込み前に拒否する: %s', async variant => {
  const folder = await mkdtemp(join(tmpdir(), 'ctx-backup-boundary-'));
  try {
    const vault = join(folder, 'chosen vault'), alias = join(folder, 'vault-link');
    await mkdir(join(vault, '00_inbox'), { recursive: true });
    const original = '架空のバックアップ対象\n';
    await writeFile(join(vault, '00_inbox', 'sample.md'), original);
    await symlink(vault, alias);
    await mkdir(join(folder, 'staging'));
    let source = vault, destination = join(vault, 'backups');
    if (variant === 'Vault末尾のスラッシュ') source += '/';
    if (variant === '親ディレクトリ経由') destination = `${folder}/staging/../chosen vault/backups`;
    if (variant === 'Vault側のシンボリックリンク') source = alias;
    if (variant === '保存先側のシンボリックリンク') destination = join(alias, 'backups');
    if (variant === '末尾スラッシュ付きの同一Vault') { source += '/'; destination = vault; }
    const result = spawnSync('/bin/sh', [backupScript], {
      env: { ...process.env, HOME: folder, CTX_VAULT: source, CTX_BACKUP_DIR: destination, CTX_BACKUP_KEEP_DAYS: '30' }, encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect((await readdir(vault)).sort()).toEqual(['00_inbox']);
    expect(await readFile(join(vault, '00_inbox', 'sample.md'), 'utf8')).toBe(original);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('大小文字の別表記が同じVaultなら保存を拒否する', async ({ skip }) => {
  const folder = await mkdtemp(join(tmpdir(), 'ctx-backup-case-'));
  try {
    const vault = join(folder, 'Case Vault'), alias = join(folder, 'case vault');
    await mkdir(join(vault, '00_inbox'), { recursive: true });
    try { await access(alias); } catch { skip(); return; }
    await writeFile(join(vault, '00_inbox', 'sample.md'), '架空の原文\n');
    const result = spawnSync('/bin/sh', [backupScript], {
      env: { ...process.env, HOME: folder, CTX_VAULT: vault, CTX_BACKUP_DIR: join(alias, 'backups'), CTX_BACKUP_KEEP_DAYS: '30' }, encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect((await readdir(vault)).sort()).toEqual(['00_inbox']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'darwin')('相対パスとリンクを含むVault外の新規保存先へ復元可能なバックアップを作る', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ctx-backup-outside-'));
  try {
    const vault = join(folder, 'chosen vault'), backups = join(folder, 'chosen vault backups');
    await mkdir(join(vault, '00_inbox'), { recursive: true });
    await mkdir(backups);
    await symlink(backups, join(folder, 'outside-link'));
    const original = '架空の原文を保持する\n';
    await writeFile(join(vault, '00_inbox', 'sample.md'), original);
    const result = spawnSync('/bin/sh', [backupScript], {
      cwd: folder, env: { ...process.env, HOME: folder, CTX_VAULT: 'chosen vault/', CTX_BACKUP_DIR: 'outside-link/new nested/', CTX_BACKUP_KEEP_DAYS: '30' }, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const destination = join(backups, 'new nested');
    const archives = (await readdir(destination)).filter(name => /^vault-.*\.tar\.gz$/.test(name));
    expect(archives).toHaveLength(1);
    const restored = spawnSync('tar', ['-xOzf', join(destination, archives[0]), './00_inbox/sample.md'], { encoding: 'utf8' });
    expect(restored.status).toBe(0);
    expect(restored.stdout).toBe(original);
    expect((await readdir(vault)).sort()).toEqual(['00_inbox']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'darwin')('launchd例は選んだVaultと保存先をバックアップへ渡す', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ctx-backup-template-'));
  try {
    const vault = join(folder, 'chosen vault'), backup = join(folder, 'chosen backups');
    await mkdir(join(vault, '00_inbox'), { recursive: true });
    const original = '架空のバックアップ対象\n';
    await writeFile(join(vault, '00_inbox', 'sample.md'), original);
    const repo = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
    let template = await readFile(join(repo, 'examples/launchd/com.context-hub.vault-backup.plist'), 'utf8');
    for (const [name, value] of Object.entries({ __REPO_PATH__: repo, __HOME__: folder, __VAULT_PATH__: vault, __BACKUP_DIR__: backup })) template = template.replaceAll(name, value);
    const plist = join(folder, 'backup.plist');
    await writeFile(plist, template);
    const field = (path: string) => {
      const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + path, plist], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      return r.stdout.trim();
    };
    const env = { ...process.env, CTX_VAULT: field('EnvironmentVariables:CTX_VAULT'), CTX_BACKUP_DIR: field('EnvironmentVariables:CTX_BACKUP_DIR'), CTX_BACKUP_KEEP_DAYS: field('EnvironmentVariables:CTX_BACKUP_KEEP_DAYS') };
    expect(env.CTX_VAULT).toBe(vault);
    expect(env.CTX_BACKUP_DIR).toBe(backup);
    const result = spawnSync(field('ProgramArguments:0'), [field('ProgramArguments:1')], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect((await readdir(backup)).filter(name => /^vault-.*\.tar\.gz$/.test(name))).toHaveLength(1);
    expect(await readFile(join(vault, '00_inbox', 'sample.md'), 'utf8')).toBe(original);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('バックアップの完了行は、どのOSでもアーカイブのバイト数を示す', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ctx-backup-size-'));
  try {
    const vault = join(folder, 'vault'), backups = join(folder, 'backups');
    await mkdir(join(vault, '00_inbox'), { recursive: true });
    await writeFile(join(vault, '00_inbox', 'sample.md'), '架空の原文\n');
    const result = spawnSync('/bin/sh', [backupScript], { env: { ...process.env, HOME: folder, CTX_VAULT: vault, CTX_BACKUP_DIR: backups, CTX_BACKUP_KEEP_DAYS: '30' }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const archive = (await readdir(backups)).find(name => /^vault-.*\.tar\.gz$/.test(name))!;
    const size = (await readFile(join(backups, archive))).length;
    expect(result.stdout).toMatch(new RegExp(` ok .*${archive} ${size} bytes kept=1\\n$`));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

const hasAge = spawnSync('age', ['--version']).status === 0 && spawnSync('age-keygen', ['--help']).error === undefined;
// CIではageを入れたうえでCTX_REQUIRE_AGE=1を指定し、暗号化の試験が黙って飛ばされないようにする。
if (!hasAge && process.env.CTX_REQUIRE_AGE === '1') throw new Error('ageとage-keygenが見つかりません');
/** 架空のVault・保存先・鍵の組を作り、バックアップのスクリプトへ渡す環境を返す。 */
async function encryptedSetup(folder: string) {
  const vault = join(folder, 'vault'), backups = join(folder, 'backups'), keys = join(folder, 'keys'), work = join(folder, 'work');
  await mkdir(join(vault, '00_inbox'), { recursive: true }); await mkdir(keys); await mkdir(work);
  await writeFile(join(vault, '00_inbox', 'sample.md'), '架空の原文\n');
  const identity = join(keys, 'backup-key.txt'), recipients = join(keys, 'backup-recipients.txt');
  expect(spawnSync('age-keygen', ['-o', identity]).status).toBe(0);
  await writeFile(recipients, spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' }).stdout);
  const env = { ...process.env, HOME: folder, CTX_VAULT: vault, CTX_BACKUP_DIR: backups, CTX_BACKUP_KEEP_DAYS: '30', CTX_BACKUP_AGE_RECIPIENTS: recipients, CTX_BACKUP_WORK_DIR: work };
  return { vault, backups, identity, recipients, work, env };
}

test.skipIf(process.platform === 'win32' || !hasAge)('受取人の公開鍵を指定すると、暗号化したアーカイブだけを保存先へ置く', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ctx-backup-age-'));
  try {
    const { vault, backups, identity, work, env } = await encryptedSetup(folder);
    // 暗号化に切り替える前の平文のアーカイブも、同じ保持日数で数える。
    await mkdir(backups); await writeFile(join(backups, 'vault-20261101-033000.tar.gz'), 'x');
    const result = spawnSync('/bin/sh', [backupScript], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const names = (await readdir(backups)).sort();
    expect(names).toHaveLength(2);
    const archive = names.find(name => /^vault-\d{8}-\d{6}\.tar\.gz\.age$/.test(name))!;
    expect(archive).toBeDefined();
    const bytes = await readFile(join(backups, archive));
    expect(bytes.subarray(0, 21).toString('latin1')).toBe('age-encryption.org/v1');
    expect(bytes.includes(Buffer.from('架空の原文'))).toBe(false);
    expect(result.stdout).toMatch(new RegExp(` ok .*${archive.replaceAll('.', '\\.')} ${bytes.length} bytes kept=2\\n$`));
    // 平文の一時ファイルは残さない。
    expect(await readdir(work)).toEqual([]);
    const plain = spawnSync('age', ['-d', '-i', identity, join(backups, archive)]);
    expect(plain.status).toBe(0);
    const restored = spawnSync('tar', ['-xOzf', '-', './00_inbox/sample.md'], { input: plain.stdout, encoding: 'utf8' });
    expect(restored.stdout).toBe('架空の原文\n');
    expect((await readdir(vault)).sort()).toEqual(['00_inbox']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32' || !hasAge)('暗号化の設定の取り違えは、何も作らずに止める', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ctx-backup-age-bad-'));
  try {
    const { vault, backups, identity, env } = await encryptedSetup(folder);
    const run = (extra: Record<string, string>) => spawnSync('/bin/sh', [backupScript], { env: { ...env, ...extra }, encoding: 'utf8' });
    // 秘密鍵を受取人として渡した。
    let result = run({ CTX_BACKUP_AGE_RECIPIENTS: identity });
    expect(result.status).toBe(2); expect(result.stderr).toContain('秘密鍵');
    // 受取人のファイルがない・公開鍵が書かれていない。
    expect(run({ CTX_BACKUP_AGE_RECIPIENTS: join(folder, 'none.txt') }).status).toBe(2);
    const empty = join(folder, 'empty.txt'); await writeFile(empty, '# 公開鍵なし\n');
    expect(run({ CTX_BACKUP_AGE_RECIPIENTS: empty }).status).toBe(2);
    // ageが見つからない。
    result = run({ CTX_BACKUP_AGE: join(folder, 'no-such-age') });
    expect(result.status).toBe(2); expect(result.stderr).toContain('CTX_BACKUP_AGE');
    // 平文を置く一時フォルダーがVaultや保存先の中にある。
    expect(run({ CTX_BACKUP_WORK_DIR: vault }).status).toBe(2);
    await mkdir(join(backups, 'tmp'), { recursive: true });
    expect(run({ CTX_BACKUP_WORK_DIR: join(backups, 'tmp') }).status).toBe(2);
    expect(await readdir(backups)).toEqual(['tmp']);
    expect((await readdir(vault)).sort()).toEqual(['00_inbox']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
