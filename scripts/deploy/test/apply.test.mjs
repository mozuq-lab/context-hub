import {afterEach,expect,test} from 'vitest';
import {writeFile,readFile,access,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixture,fakeServices,project} from './fixtures.mjs';
import {preparePlan} from '../prepare.mjs';
import {applyPlan} from '../apply.mjs';
import {deploymentStatus} from '../status.mjs';
import {unlockVault} from '../../../packages/core/dist/storage.js';
const fs=[];afterEach(async()=>{for(const f of fs.splice(0))await f.cleanup();});
async function setup(){const f=await fixture();fs.push(f);return f;}
const options=f=>({repository:f.repository,run:f.execute});
test('初回を配置し、原文を変えずに通常更新し、同版の再適用は変更なしになる',async()=>{
 const f=await setup();await writeFile(join(f.vault,'00_inbox','sentinel.txt'),'immutable original\n');
 const p=await preparePlan(f.file,options(f));await applyPlan(p.planPath,p.planHash,{run:f.execute});
 const first=await deploymentStatus(f.file);expect(first.commit).toBe(p.summary.commit);expect(first.pending).toBeNull();
 expect(await readFile(join(f.vault,'AGENTS.md'),'utf8')).toBe('# 架空の利用指示 v1\n');
 await writeFile(join(f.repository,'agents.md'),'# 架空の利用指示 v2\n');await writeFile(join(f.repository,'code.txt'),'version two\n');f.git('add','.');f.git('commit','-qm','架空の第2版');
 const p2=await preparePlan(f.file,options(f));await applyPlan(p2.planPath,p2.planHash,{run:f.execute});
 expect(await readFile(join(f.config.installDir,'runtime/code.txt'),'utf8')).toBe('version two\n');expect(await readFile(join(f.vault,'00_inbox/sentinel.txt'),'utf8')).toBe('immutable original\n');
 expect((await applyPlan(p2.planPath,p2.planHash,{run:f.execute})).unchanged).toBe(true);
 expect((await deploymentStatus(f.file)).drift).toEqual([]);
},30000);
test('未確認plan・plan後の配布物変更・候補改変は本番書き込み前に拒否する',async()=>{
 const f=await setup(),p=await preparePlan(f.file,options(f));
 await expect(applyPlan(p.planPath,'wrong',{run:f.execute})).rejects.toThrow(/確認/);
 await writeFile(join(f.vault,'AGENTS.md'),'parallel edit');await expect(applyPlan(p.planPath,p.planHash,{run:f.execute})).rejects.toThrow(/変更/);
 expect(await readFile(join(f.vault,'AGENTS.md'),'utf8')).toBe('parallel edit');
});
test('停止中に入った独自変更をバックアップの後から上書きしない',async()=>{
 const f=await setup(),p=await preparePlan(f.file,options(f));
 await expect(applyPlan(p.planPath,p.planHash,{run:f.execute,onProgress:async s=>{if(s.phase==='stopped')await writeFile(join(f.vault,'AGENTS.md'),'late local edit');}})).rejects.toThrow(/変更/);
 expect(await readFile(join(f.vault,'AGENTS.md'),'utf8')).toBe('late local edit');
});
test('復旧用ファイルが欠損していても、元から存在した配布物を削除しない',async()=>{
 const f=await setup(),p=await preparePlan(f.file,options(f));await applyPlan(p.planPath,p.planHash,{run:f.execute});
 await writeFile(join(f.repository,'agents.md'),'# v2\n');f.git('add','.');f.git('commit','-qm','第2版');const next=await preparePlan(f.file,options(f));
 await expect(applyPlan(next.planPath,next.planHash,{run:f.execute,onProgress:async s=>{if(s.phase==='files-written'){await unlink(join(next.planPath,'../backup/0.before'));throw new Error('fixture rollback');}}})).rejects.toThrow(/fixture/);
 expect(await readFile(join(f.vault,'AGENTS.md'),'utf8')).toBe('# v2\n');expect((await deploymentStatus(f.file)).pending.phase).toBe('recovery-required');
});
test('Gateway再開後にRPCが壊れてもGatewayと同期の停止を試みる',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready};const p=await preparePlan(f.file,{repository:f.repository,...deps});let broken=false;
 const fail=async(exe,args,o)=>{if(exe===f.config.openclaw.executable&&args[0]==='plugins')broken=true;if(broken&&exe===f.config.openclaw.executable)return{code:1,stdout:'',stderr:'RPC unavailable'};return fake.execute(exe,args,o);};
 await expect(applyPlan(p.planPath,p.planHash,{...deps,run:fail})).rejects.toThrow(/失敗/);expect([...fake.serviceState.values()]).toEqual([false,false]);expect((await deploymentStatus(f.file)).pending.phase).toBe('recovery-required');
});
test('通常更新でもHub設定とdeployment設定を利用者専用で退避する',async()=>{
 const f=await setup(),p=await preparePlan(f.file,options(f)),r=await applyPlan(p.planPath,p.planHash,{run:f.execute}),backup=join(r.backup,'..');
 expect(await readFile(join(backup,'hub-config.json'),'utf8')).toBe(await readFile(f.config.hubConfigPath,'utf8'));expect(await readFile(join(backup,'deployment.json'),'utf8')).toBe(await readFile(f.file,'utf8'));expect((await lstat(r.backup)).mode&0o077).toBe(0);
});
test('同じcommitで新しくplanを作っても、再配置やサービス停止を行わない',async()=>{
 const f=await setup(),p=await preparePlan(f.file,options(f));await applyPlan(p.planPath,p.planHash,{run:f.execute});
 const next=await preparePlan(f.file,options(f));expect((await applyPlan(next.planPath,next.planHash,{run:f.execute})).unchanged).toBe(true);
});
test('初回の既存参照を移し、認証・ジョブの周期とpayloadを保持する',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const p=await preparePlan(f.file,{repository:f.repository,...deps}),before=fake.getJob();await applyPlan(p.planPath,p.planHash,deps);
 const cfg=JSON.parse(await readFile(f.config.openclaw.configPath,'utf8'));
 expect(cfg.channels.discord.token).toBe('fake-token-retained');expect(cfg.plugins.load.paths).toEqual([join(f.config.installDir,'runtime/packages/openclaw-plugin')]);
 expect(fake.getJob().schedule).toEqual(before.schedule);expect(fake.getJob().payload.env).toEqual(before.payload.env);expect(fake.getJob().payload.argv[1]).toBe(join(f.config.installDir,'runtime/packages/core/dist/cli.js'));expect(fake.getJob().enabled).toBe(true);
},30000);
test('切り替え前の失敗では元の状態へ戻し、Gateway再開後の失敗では巻き戻さず停止する',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const p=await preparePlan(f.file,{repository:f.repository,...deps});
 await expect(applyPlan(p.planPath,p.planHash,{...deps,onProgress:async s=>{if(s.phase==='swapping')throw new Error('fixture failure');}})).rejects.toThrow(/fixture failure/);
 expect(fake.getJob().enabled).toBe(true);expect((await deploymentStatus(f.file)).pending).toBeNull();
 const p2=await preparePlan(f.file,{repository:f.repository,...deps});
 const bad=async(exe,args,o)=>args[0]==='plugins'?{code:1,stdout:'',stderr:'fixture plugin failure'}:fake.execute(exe,args,o);
 await expect(applyPlan(p2.planPath,p2.planHash,{...deps,run:bad})).rejects.toThrow(/失敗/);
 const status=await deploymentStatus(f.file);expect(status.pending.writersResumed).toBe(true);expect(fake.getJob().enabled).toBe(false);expect([...fake.serviceState.values()]).toEqual([false,false]);
},30000);
test.each(['swapping','old-moved','installed'])('実プロセスが%sで強制終了しても、同じplanで記録を照合して再開できる',async phase=>{
 const f=await setup(),p=await preparePlan(f.file,options(f));
 const script=`import {applyPlan} from ${JSON.stringify(pathToFileURL(join(project,'scripts/deploy/apply.mjs')).href)};await applyPlan(process.env.CTX_TEST_PLAN,process.env.CTX_TEST_CONFIRM,{onProgress:s=>{if(s.phase===process.env.CTX_TEST_PHASE)process.kill(process.pid,'SIGKILL');}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,CTX_TEST_PLAN:p.planPath,CTX_TEST_CONFIRM:p.planHash,CTX_TEST_PHASE:phase},stdio:['ignore','pipe','pipe']});
 let err='';child.stderr.on('data',b=>{err+=b;});const result=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
 expect(result,{stderr:err}).toEqual({code:null,signal:'SIGKILL'});
 await unlockVault(f.hub,'writer');await unlockVault(f.hub,'organize');
 await applyPlan(p.planPath,p.planHash,{run:f.execute});expect((await deploymentStatus(f.file)).commit).toBe(p.summary.commit);
},30000);
