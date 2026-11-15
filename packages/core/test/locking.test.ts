import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault, lockPath, unlockVault } from '../src/storage.js';
import type { HubConfig } from '../src/types.js';

const roots: string[] = [];
const lockArtifacts: string[] = [];
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-lock-test-')); roots.push(root);
  const config = defaultConfig(join(root, 'vault'), join(root, 'state'));
  await new Vault(config).init();
  return { root, config };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of lockArtifacts.splice(0)) await rm(path, { recursive: true, force: true });
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

async function ownerFixture(config: HubConfig, pid: number): Promise<{ lock: string; owner: string }> {
  const lock = await lockPath(config); lockArtifacts.push(lock);
  await mkdir(lock);
  const owner = JSON.stringify({ pid, token: 'fixture-owner', createdAt: '2026-09-14T00:00:00Z' });
  await writeFile(join(lock, 'owner.json'), owner);
  return { lock, owner };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid!;
}

describe('Vault単位の単一Writer', () => {
  test('同一VaultのstatePathが違っても後続Writerは先行Writerの終了を待つ', async () => {
    const { root, config } = await setup();
    const other = defaultConfig(config.vaultPath, join(root, 'other-state'));
    const entered = deferred(), release = deferred(); let secondEntered = false;
    const first = new Vault(config).withLock(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const second = new Vault(other).withLock(async () => { secondEntered = true; });
    await pause(100);
    const overlapped = secondEntered;
    release.resolve();
    await Promise.all([first, second]);
    expect(overlapped).toBe(false);
    expect(secondEntered).toBe(true);
  });

  test('回収中の残骸があっても待機は10秒までで失敗し処理に入らない', async () => {
    const { config } = await setup();
    const lock = await lockPath(config);
    const reaper = `${lock}.reap`; await mkdir(reaper); lockArtifacts.push(reaper);
    let entered = false;
    const pending = new Vault(config).withLock(async () => { entered = true; }).then(() => 'entered', () => 'rejected');
    const result = await Promise.race([pending, pause(10_600).then(() => 'timeout')]);
    await rmdir(reaper);
    await pending;
    expect(result).toBe('rejected');
    expect(entered).toBe(false);
  }, 12_000);

  test('死亡した所有者のロックだけ明示解除でき、解除後は保存を再開できる', async () => {
    const { config } = await setup();
    await ownerFixture(config, await deadPid());
    expect(await unlockVault(config)).toBe(true);
    await expect(new Vault(config).withLock(async () => '再開')).resolves.toBe('再開');
    expect(await unlockVault(config)).toBe(false);
  });

  test('稼働中の所有者は明示解除せず、先行Writerが正常に解放する', async () => {
    const { config } = await setup();
    await new Vault(config).withLock(async () => {
      const lock = await lockPath(config), before = await readFile(join(lock, 'owner.json'), 'utf8');
      await expect(unlockVault(config)).rejects.toThrow();
      expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(before);
    });
    await expect(new Vault(config).withLock(async () => '再開')).resolves.toBe('再開');
  });

  test('PIDの権限が不明なときは明示解除を拒否する', async () => {
    const { config } = await setup(); const { lock, owner } = await ownerFixture(config, await deadPid());
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('確認不可'), { code: 'EPERM' }); });
    await expect(unlockVault(config)).rejects.toThrow();
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(owner);
  });

  test.each(['{', '{"pid":0,"token":"broken"}'])('壊れたownerは明示解除せず保持する %s', async owner => {
    const { config } = await setup(); const { lock } = await ownerFixture(config, process.pid);
    await writeFile(join(lock, 'owner.json'), owner);
    await expect(unlockVault(config)).rejects.toThrow();
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(owner);
  });

  test('lockがsymlinkなら明示解除も通常取得も拒否しリンク先を消さない', async () => {
    const { root, config } = await setup(); const lock = await lockPath(config);
    const outside = join(root, 'outside'); await mkdir(outside);
    const owner = JSON.stringify({ pid: await deadPid(), token: 'outside-owner', createdAt: '2026-09-14T00:00:00Z' });
    await writeFile(join(outside, 'owner.json'), owner); await symlink(outside, lock); lockArtifacts.push(lock);
    await expect(unlockVault(config)).rejects.toThrow();
    await expect(new Vault(config).withLock(async () => {})).rejects.toThrow();
    expect(await readFile(join(outside, 'owner.json'), 'utf8')).toBe(owner);
  });

  test('死亡したownerがあっても並行Writerは自動回収せず有限時間で停止する', async () => {
    const { config } = await setup(); const { lock, owner } = await ownerFixture(config, await deadPid());
    let entered = 0;
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => new Vault(config).withLock(async () => { entered++; })));
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(entered).toBe(0);
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(owner);
  }, 12_000);
});

test.each(['SIGTERM', 'SIGINT'] as const)('CLIが%sで終了するときは保持中のロックを解放し、後続のWriterが待たずに書ける', async signal => {
  const { config } = await setup();
  const dist = new URL('../dist/storage.js', import.meta.url).href;
  // CLIと同じく、シグナルを受けたら保持中のロックを解放して終了する。
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {Vault,releaseLocksOnSignal} from ${JSON.stringify(dist)};releaseLocksOnSignal();const v=new Vault(${JSON.stringify(config)});await v.withLock(()=>v.withLock(()=>new Promise(r=>{console.log('locked');setTimeout(r,60000);}),'writer'),'organize');`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout!, 'data');
  child.kill(signal);
  const [code, received] = await once(child, 'exit') as [number | null, string | null];
  expect(received === signal || code === 128 + (signal === 'SIGTERM' ? 15 : 2)).toBe(true);
  for (const scope of ['writer', 'organize'] as const) await expect(readFile(join(await lockPath(config, scope), 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const started = performance.now();
  await new Vault(config).withLock(async () => {});
  expect(performance.now() - started).toBeLessThan(2000);
}, 20_000);
test('ロック区間内で使い回した読み取りは、書き込み・削除の後に捨てて読み直す（処理中に読んだ値も残さない）',async()=>{
 const{mkdtemp}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const{defaultConfig}=await import('../src/config.js'),{Vault,readOncePerLock}=await import('../src/storage.js');
 const root=await mkdtemp(join(tmpdir(),'ctx-memo-'));const config=defaultConfig(join(root,'vault'),join(root,'state'));const vault=new Vault(config);await vault.init();
 try{
  await vault.withLock(async()=>{
   let loads=0;const read=()=>readOncePerLock(config,'memo-test',['20_ideas'],async()=>++loads);
   expect(await read()).toBe(1);expect(await read()).toBe(1);
   // 書き込み・削除の途中に読んだ値も、終わった後には使わない。
   const writing=vault.write('20_ideas/a.md','x');expect(await read()).toBe(2);await writing;expect(await read()).toBe(3);
   const removing=vault.remove('20_ideas/a.md');expect(await read()).toBe(4);await removing;expect(await read()).toBe(5);
   // 関係のない場所への書き込みでは捨てない。
   await vault.write('30_knowledge/b.md','y');expect(await read()).toBe(5);
  });
 }finally{await rm(root,{recursive:true,force:true});}
});
