import { constants } from 'node:fs';
import { mkdir, lstat, realpath, readdir, open, rename, link, unlink, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import type { HubConfig } from './types.js';

export const VAULT_DIRS = ['00_inbox', '10_projects', '20_ideas', '30_knowledge', '90_system/candidates', '90_system/receipts/events', '90_system/approvals', '90_system/conflicts'];
export function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function markdown(meta: Record<string, unknown>, text: string): string { return `---\n${stringify(meta)}---\n${text}`; }
export function parseMarkdown(content: string): { meta: Record<string, unknown>; text: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) throw new Error('frontmatter がありません');
  const meta: unknown = parse(match[1], { maxAliasCount: 0 });
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('frontmatter が不正です');
  return { meta: meta as Record<string, unknown>, text: content.slice(match[0].length) };
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

async function vaultRoot(config: HubConfig): Promise<string> {
  const given = resolve(config.vaultPath);
  if ((await lstat(given)).isSymbolicLink()) throw new Error('Vaultルートのsymlinkは禁止です');
  return realpath(given);
}
function outsideVault(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('ロック・状態はVault外に置いてください');
}
function localLockRoot(): string {
  if (!process.getuid) throw new Error('ローカルロックにはPOSIXの利用者IDが必要です');
  return join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', `context-hub-${process.getuid()}-locks`);
}
async function directoryInfo(path: string) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('ロックのパスはsymlinkでないディレクトリが必要です');
    return info;
  } catch (error) { if (missing(error)) return undefined; throw error; }
}
async function validateLockRoot(): Promise<void> {
  const info = await directoryInfo(localLockRoot());
  if (info && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)) throw new Error('ロックディレクトリの所有者・権限が不正です');
}

/**
 * writer: Vaultへ書き込む短い区間の排他。capture・承認・受付・整理の書き込みが共有する。
 * organize: 整理実行全体の排他。モデル呼び出し中はwriterを解放し、整理同士の重複送信だけを防ぐ。
 */
export type LockScope = 'writer' | 'organize';
export const LOCK_SCOPES: readonly LockScope[] = ['writer', 'organize'];
/** statePathやTMPDIRが変わっても同じ実Vaultには同じ利用者ローカルロックを使う。 */
export async function lockPath(config: HubConfig, scope: LockScope = 'writer'): Promise<string> {
  const root = await vaultRoot(config);
  outsideVault(root, localLockRoot());
  await validateLockRoot();
  return join(localLockRoot(), `${hash(root).slice(0, 24)}${scope === 'organize' ? '.organize' : ''}.lock`);
}
async function ensureLockRoot(): Promise<void> {
  try { await mkdir(localLockRoot(), { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await validateLockRoot();
}
interface LockOwner { pid: number; token: string; createdAt: string }
async function readLockOwner(lock: string) {
  const handle = await open(join(lock, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('ロック所有者の記録が不正です');
    const owner: LockOwner = JSON.parse(await handle.readFile('utf8'));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token || typeof owner.createdAt !== 'string' || !Number.isFinite(Date.parse(owner.createdAt))) throw new Error('ロック所有者の記録が不正です。全Writer停止後に手動で確認してください');
    return { owner, info };
  } finally { await handle.close(); }
}

/** 明示的な復旧専用。判断不能な所有者や回収残骸は手動確認に留める。 */
export async function unlockVault(config: HubConfig, scope: LockScope = 'writer'): Promise<boolean> {
  const lock = await lockPath(config, scope), reaper = `${lock}.reap`;
  await ensureLockRoot();
  try { await mkdir(reaper, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('ロック回収中または回収残骸があります。全Writer停止後に手動で確認してください');
    throw error;
  }
  try {
    const directory = await directoryInfo(lock);
    if (!directory) return false;
    const record = await readLockOwner(lock);
    try { process.kill(record.owner.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('所有者の生存を確認できないためロックを解除できません');
      const currentDirectory = await directoryInfo(lock), current = await readLockOwner(lock);
      if (!currentDirectory || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino || current.info.dev !== record.info.dev || current.info.ino !== record.info.ino || current.owner.token !== record.owner.token || current.owner.pid !== record.owner.pid) throw new Error('ロック所有者が変化したため解除を中止しました');
      await unlink(join(lock, 'owner.json'));
      await rmdir(lock);
      return true;
    }
    throw new Error('所有者が稼働中のためロックを解除できません');
  } finally { await rmdir(reaper); }
}

export class Vault {
  constructor(readonly config: HubConfig) {}
  private async root(): Promise<string> {
    return vaultRoot(this.config);
  }
  async path(rel: string, makeParents = false): Promise<string> {
    if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some(p => p === '..' || p === '.' || !p)) throw new Error('許可されない相対パスです');
    const root = await this.root();
    const parts = rel.split('/'); let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error('symlinkを経由する操作は禁止です');
        if (i < parts.length - 1 && !info.isDirectory()) throw new Error('親パスがディレクトリではありません');
      } catch (error) {
        if (!missing(error)) throw error;
        if (makeParents && i < parts.length - 1) { await mkdir(current, { mode: 0o700 }); await syncDirectory(dirname(current)); }
      }
    }
    return current;
  }
  async init(): Promise<void> {
    await mkdir(resolve(this.config.vaultPath), { recursive: true, mode: 0o700 });
    await this.root();
    await this.withLock(async () => {
      for (const rel of VAULT_DIRS) await this.path(`${rel}/.check`, true);
      const {policyInventory}=await import('./policy-manifest.js');
      if(await this.read('90_system/policies/index.json')===undefined&&(await policyInventory(this)).length===0){const {rebuildPoliciesLocked}=await import('./policies.js');await rebuildPoliciesLocked(this.config,this);}
    });
  }
  async read(rel: string): Promise<string | undefined> {
    const path = await this.path(rel);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try { return await handle.readFile('utf8'); } finally { await handle.close(); }
  }
  async readBytes(rel: string, maxBytes: number): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('読み取り上限が不正です');
    const path = await this.path(rel);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('受付ファイルの容量または種類が不正です');
      const buffer = Buffer.alloc(maxBytes + 1); let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxBytes) throw new Error('受付ファイルの容量が上限を超えています');
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }
  private async atomic(rel: string, text: string, exclusive: boolean): Promise<boolean> {
    const target = await this.path(rel, true), temp = join(dirname(target), `.ctx-tmp-${randomUUID()}`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      await this.path(rel);
      if (exclusive) {
        try { await link(temp, target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
      } else await rename(temp, target);
      await syncDirectory(dirname(target));
      return true;
    } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
  }
  async write(rel: string, text: string): Promise<void> { await this.atomic(rel, text, false); }
  async create(rel: string, text: string): Promise<boolean> { return this.atomic(rel, text, true); }
  async files(rel: string): Promise<string[]> {
    const base = await this.path(rel); let entries;
    try { entries = await readdir(base, { withFileTypes: true }); } catch (error) { if (missing(error)) return []; throw error; }
    const files: string[] = [];
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Vault内にsymlinkがあります');
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await this.files(child));
      else if (entry.isFile() && !entry.name.startsWith('.ctx-tmp-')) files.push(child);
    }
    return files;
  }
  async withLock<T>(fn: () => Promise<T>, scope: LockScope = 'writer'): Promise<T> {
    const root = await this.root();
    await mkdir(this.config.statePath, { recursive: true, mode: 0o700 });
    if ((await lstat(this.config.statePath)).isSymbolicLink()) throw new Error('状態ディレクトリのsymlinkは禁止です');
    outsideVault(root, await realpath(this.config.statePath));
    const lock = await lockPath(this.config, scope), reaper = `${lock}.reap`, token = randomUUID(), deadline = performance.now() + 10_000;
    await ensureLockRoot();
    while (true) {
      if (performance.now() >= deadline) throw new Error(scope === 'organize' ? '別の整理処理が実行中か、整理ロックの残骸があります。ctx doctorで確認してください' : '別のWriterまたはロック残骸があります。ctx doctorで確認してください');
      if (await directoryInfo(reaper)) { await pause(20); continue; }
      try {
        await mkdir(lock, { mode: 0o700 });
        try {
          const owner = await open(join(lock, 'owner.json'), 'wx', 0o600);
          try { await owner.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); await owner.sync(); } finally { await owner.close(); }
        } catch (error) { await rmdir(lock).catch(() => {}); throw error; }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await directoryInfo(lock);
        await pause(20);
      }
    }
    try { return await fn(); }
    finally {
      const { owner } = await readLockOwner(lock);
      if (owner.token === token) { await unlink(join(lock, 'owner.json')); await rmdir(lock); }
    }
  }
}
