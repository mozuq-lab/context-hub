import {afterEach,expect,test} from 'vitest';
import {writeFile,readFile,access,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixture,fakeServices,intakeFailure,project} from './fixtures.mjs';
import {preparePlan} from '../prepare.mjs';
import {applyPlan} from '../apply.mjs';
import {deploymentStatus} from '../status.mjs';
import {unlockVault} from '../../../packages/core/dist/storage.js';
import {sha} from '../common.mjs';
const fs=[];afterEach(async()=>{for(const f of fs.splice(0))await f.cleanup();});
async function setup(){const f=await fixture();fs.push(f);return f;}
const options=f=>({repository:f.repository,run:f.execute});
test('plan後の定期実行とCLI更新に伴うread viewの変化だけなら、同じplanを適用できる',async()=>{
 const f=await setup(),fake=await fakeServices(f);let lastRun=1;
 const execute=async(exe,args,o)=>{
  const r=await fake.execute(exe,args,o);
  if(exe===f.config.openclaw.executable&&args[0]==='automations'&&r.code===0){
   const j=JSON.parse(r.stdout);Object.assign(j,{lastRunAtMs:lastRun,nextRunAtMs:lastRun+3600000,lastRunStatus:'ok',configRevision:sha(JSON.stringify([j.enabled,j.payload.argv]))});return{...r,stdout:JSON.stringify(j)};
  }
  return r;
 };
 const deps={run:execute,platform:'darwin',ready:fake.ready},p=await preparePlan(f.file,{repository:f.repository,...deps});lastRun=2;
 await applyPlan(p.planPath,p.planHash,deps);expect((await deploymentStatus(f.file)).commit).toBe(p.summary.commit);expect(fake.getJob().enabled).toBe(true);expect([...fake.serviceState.values()]).toEqual([true,true]);
},30000);
test('plan後の設定revisionの変更は、サービス停止前に拒否する',async()=>{
 const f=await setup(),fake=await fakeServices(f);let revision='fixture-revision-1';
 const execute=async(exe,args,o)=>{
  const r=await fake.execute(exe,args,o);
  return exe===f.config.openclaw.executable&&args[0]==='automations'&&r.code===0?{...r,stdout:JSON.stringify({...JSON.parse(r.stdout),configRevision:revision})}:r;
 };
 const deps={run:execute,platform:'darwin',ready:fake.ready},p=await preparePlan(f.file,{repository:f.repository,...deps});revision='fixture-revision-2';fake.calls.length=0;
 await expect(applyPlan(p.planPath,p.planHash,deps)).rejects.toThrow(/変更/);expect(fake.calls.some(([exe,arg])=>exe==='launchctl'&&arg==='bootout')).toBe(false);
 expect(fake.calls.some(([exe,op,verb])=>exe===f.config.openclaw.executable&&op==='automations'&&['disable','enable','edit'].includes(verb))).toBe(false);
});
test('既存の受付失敗を保持して更新し、受付ファイルと停止回復記録を変えない',async()=>{
 const f=await setup(),failure=await intakeFailure(f),paths=Object.values(failure.paths),before=await Promise.all(paths.map(p=>readFile(p)));
 const p=await preparePlan(f.file,options(f));await applyPlan(p.planPath,p.planHash,{run:f.execute});
 expect((await deploymentStatus(f.file)).commit).toBe(p.summary.commit);expect(await Promise.all(paths.map(p=>readFile(p)))).toEqual(before);
},30000);
test('plan後の新しい受付失敗は、サービスを停止する前に拒否する',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready},p=await preparePlan(f.file,{repository:f.repository,...deps});
 await intakeFailure(f);fake.calls.length=0;
 await expect(applyPlan(p.planPath,p.planHash,deps)).rejects.toThrow(/新し|診断/);
 expect(fake.calls.some(([exe,args])=>exe==='launchctl'&&args==='bootout')).toBe(false);expect([...fake.serviceState.values()]).toEqual([true,true]);
});
test('更新後の新しい受付失敗では復旧し、既存・新規の受付記録を削除しない',async()=>{
 const f=await setup(),existing=await intakeFailure(f),before=await Promise.all(Object.values(existing.paths).map(p=>readFile(p))),p=await preparePlan(f.file,options(f));let added;
 const execute=async(exe,args,o)=>{
  if(!added&&exe===process.execPath&&args[0]===join(f.config.installDir,'runtime/packages/core/dist/cli.js'))added=await intakeFailure(f,`REQ-${'b'.repeat(32)}`);
  return f.execute(exe,args,o);
 };
 await expect(applyPlan(p.planPath,p.planHash,{run:execute})).rejects.toThrow(/新し|診断/);
 expect((await deploymentStatus(f.file)).commit).toBeNull();expect(await Promise.all(Object.values(existing.paths).map(p=>readFile(p)))).toEqual(before);
 for(const path of Object.values(added.paths))await expect(readFile(path)).resolves.toBeDefined();
},30000);
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
},30000);
test('Gateway再開後にRPCが壊れてもGatewayと同期の停止を試みる',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready};const p=await preparePlan(f.file,{repository:f.repository,...deps});let broken=false;
 const fail=async(exe,args,o)=>{if(exe===f.config.openclaw.executable&&args[0]==='plugins')broken=true;if(broken&&exe===f.config.openclaw.executable)return{code:1,stdout:'',stderr:'RPC unavailable'};return fake.execute(exe,args,o);};
 await expect(applyPlan(p.planPath,p.planHash,{...deps,run:fail})).rejects.toThrow(/失敗/);expect([...fake.serviceState.values()]).toEqual([false,false]);expect((await deploymentStatus(f.file)).pending.phase).toBe('recovery-required');
});
test('rollbackの再開RPCが失敗しても、再開済みGatewayと同期を止めて診断を残す',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const p=await preparePlan(f.file,{repository:f.repository,...deps});
 const fail=async(exe,args,o)=>exe===f.config.openclaw.executable&&args[0]==='automations'&&args[1]==='enable'?{code:1,stdout:'',stderr:'fixture rollback RPC failure'}:fake.execute(exe,args,o);
 await expect(applyPlan(p.planPath,p.planHash,{...deps,run:fail,onProgress:s=>{if(s.phase==='swapping')throw new Error('fixture original update failure');}})).rejects.toThrow('fixture original update failure');
 expect([...fake.serviceState.values()]).toEqual([false,false]);
 const status=await deploymentStatus(f.file);
 expect(status.pending.phase).toBe('recovery-required');expect(status.pending.writersResumed).toBe(true);
 expect(status.pending.stopResults).toEqual(expect.arrayContaining([{role:'gateway',confirmed:true},{role:'syncPlist',confirmed:true}]));
 expect(status.pending.failure).toMatchObject({phase:'swapping',message:'fixture original update failure'});
 expect(status.pending.recoveryFailure).toMatchObject({phase:'rollback-starting',name:'Error'});
});
test('rollbackで最初のサービスを起動する前に再開意図がjournalへ保存される',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready},p=await preparePlan(f.file,{repository:f.repository,...deps});
 const observed=[];
 const inspect=async(exe,args,o)=>{
  if(exe==='launchctl'&&args[0]==='bootstrap')observed.push(JSON.parse(await readFile(join(f.config.installDir,'deployment-state.json'),'utf8')));
  return fake.execute(exe,args,o);
 };
 await expect(applyPlan(p.planPath,p.planHash,{...deps,run:inspect,onProgress:s=>{if(s.phase==='swapping')throw new Error('fixture rollback trigger');}})).rejects.toThrow('fixture rollback trigger');
 expect(observed).toHaveLength(2);
 for(const state of observed)expect(state).toMatchObject({phase:'rollback-starting',writersResumed:true});
 expect((await deploymentStatus(f.file)).pending).toBeNull();expect([...fake.serviceState.values()]).toEqual([true,true]);
});
test('rollbackの再開意図を記録した直後の失敗も、自動再実行せず停止結果を残す',async()=>{
 const f=await setup(),fake=await fakeServices(f),deps={run:fake.execute,platform:'darwin',ready:fake.ready},p=await preparePlan(f.file,{repository:f.repository,...deps});
 await expect(applyPlan(p.planPath,p.planHash,{...deps,onProgress:s=>{if(s.phase==='swapping')throw new Error('fixture rollback trigger');if(s.phase==='rollback-starting')throw new Error('fixture recovery interrupted');}})).rejects.toThrow('fixture rollback trigger');
 const status=await deploymentStatus(f.file);expect(status.pending).toMatchObject({phase:'recovery-required',writersResumed:true,recoveryFailure:{message:'fixture recovery interrupted'}});
 expect([...fake.serviceState.values()]).toEqual([false,false]);
 await expect(applyPlan(p.planPath,p.planHash,deps)).rejects.toThrow(/自動再開できません/);
});
test('通常更新でもHub設定とdeployment設定を利用者専用で退避する',async()=>{
 const f=await setup(),p=await preparePlan(f.file,options(f)),r=await applyPlan(p.planPath,p.planHash,{run:f.execute}),backup=join(r.backup,'..');
 expect(await readFile(join(backup,'hub-config.json'),'utf8')).toBe(await readFile(f.config.hubConfigPath,'utf8'));expect(await readFile(join(backup,'deployment.json'),'utf8')).toBe(await readFile(f.file,'utf8'));expect((await lstat(r.backup)).mode&0o077).toBe(0);
});
test('同じcommitで新しくplanを作っても、再配置やサービス停止を行わない',async()=>{
 const f=await setup(),p=await preparePlan(f.file,options(f));await applyPlan(p.planPath,p.planHash,{run:f.execute});
 const next=await preparePlan(f.file,options(f));expect((await applyPlan(next.planPath,next.planHash,{run:f.execute})).unchanged).toBe(true);
},30000);
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
