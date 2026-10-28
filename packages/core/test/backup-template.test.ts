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
