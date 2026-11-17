import {afterEach,expect,test} from 'vitest';
import {fixture,fakeServices} from './fixtures.mjs';
import {loadConfig} from '../config.mjs';
import {inspectServices,stopServices,resumeServices,verifyServices,jobHash} from '../services.mjs';
const fs=[];afterEach(async()=>{for(const f of fs.splice(0))await f.cleanup();});
const hashJob={id:'fixture-job',enabled:true,createdAtMs:1,schedule:{kind:'every',everyMs:3600000},payload:{kind:'command',argv:['node','/fake/cli.js','cycle'],env:{CONTEXT_HUB_CONFIG:'/fake/hub.json'}},delivery:{mode:'none'}};
test('OpenClawのread viewに付く実行履歴・予定・revisionはジョブ設定のhashから除く',()=>{
 const projected={...hashJob,state:{lastRunAtMs:1},status:'ok',updatedAtMs:2,effectiveAgentId:'fixture-agent',configRevision:'fixture-revision',nextRunAtMs:3,lastRunAtMs:1,lastRunStatus:'ok',lastRunError:'fixture error',lastDelivered:true,lastDeliveryStatus:'delivered',lastDeliveryError:'fixture delivery',deliverySuppressionReason:'fixture suppression',lastFailureNotificationDelivered:true,lastFailureNotificationDeliveryStatus:'delivered',lastFailureNotificationDeliveryError:'fixture notification'};
 expect(jobHash(projected)).toBe(jobHash(hashJob));expect(projected.state).toEqual({lastRunAtMs:1});
});
test.each(['enabled','schedule','argv','env','delivery','unknown'])('ジョブの%s設定の変更はhashで検出する',kind=>{
 const changed=structuredClone(hashJob);
 if(kind==='enabled')changed.enabled=false;
 else if(kind==='schedule')changed.schedule.everyMs=7200000;
 else if(kind==='argv')changed.payload.argv[1]='/fake/different-cli.js';
 else if(kind==='env')changed.payload.env.CONTEXT_HUB_CONFIG='/fake/different-hub.json';
 else if(kind==='delivery')changed.delivery.mode='announce';else changed.futureSetting='different';
 expect(jobHash(changed)).not.toBe(jobHash(hashJob));
});
test('明示したGateway・同期・既存ジョブだけを停止し、周期とpayloadを保って再開する',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps),before=fake.getJob();await stopServices(c,snapshot,deps);
 expect([...fake.serviceState.values()]).toEqual([false,false]);expect(fake.getJob().enabled).toBe(false);
 await resumeServices(c,snapshot,deps);expect([...fake.serviceState.values()]).toEqual([true,true]);expect(fake.getJob()).toEqual(before);
 expect(fake.calls.some(x=>x.includes('run')||x.includes('create'))).toBe(false);
});
test('無効なジョブを有効にせず、未対応版と実行中ジョブは操作前に拒否する',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 fake.setJob({...fake.getJob(),enabled:false});const s=await inspectServices(c,f.repository,deps);await stopServices(c,s,deps);await resumeServices(c,s,deps);expect(fake.getJob().enabled).toBe(false);
 fake.setJob({...fake.getJob(),state:{runningAtMs:1}});await expect(inspectServices(c,f.repository,deps)).rejects.toThrow(/実行中/);
 await expect(inspectServices(c,f.repository,{...deps,run:async()=>({code:0,stdout:'2027.1.1',stderr:''})})).rejects.toThrow(/未対応/);
});
test('停止済みGatewayへ問い合わせず、停止前に記録したジョブ休止状態から再開する',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps);await stopServices(c,snapshot,deps);
 await expect(stopServices(c,snapshot,{...deps,jobPaused:true})).resolves.toBeUndefined();
 await resumeServices(c,snapshot,deps);expect(fake.getJob().enabled).toBe(true);
});
test.each([
 ['errors',{id:'context-hub',origin:'config',activated:true,activationSource:'explicit',error:'fixture registration failure'}],
 ['unavailable',{id:'context-hub',state:'configured-unavailable',diagnostic:{kind:'plugin-verification',reason:'fixture-verification-failed',detail:'fixture unavailable'}}]
])('Gatewayのcontext-hub %sをCLI単独のimport成功で代用しない',async(field,diagnostic)=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps),health={ok:true,plugins:{errors:[],unavailable:[],[field]:[diagnostic]}};
 const execute=async(exe,args,o)=>exe===c.openclaw.executable&&args[0]==='gateway'&&args[1]==='health'?{code:0,stdout:JSON.stringify(health),stderr:''}:fake.execute(exe,args,o);
 await expect(verifyServices(c,snapshot,{...deps,run:execute})).rejects.toThrow(/context-hub/);
});
test('Gateway healthの不正なJSONを成功扱いしない',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps);
 const execute=async(exe,args,o)=>exe===c.openclaw.executable&&args[0]==='gateway'&&args[1]==='health'?{code:0,stdout:'invalid health json',stderr:''}:fake.execute(exe,args,o);
 await expect(verifyServices(c,snapshot,{...deps,run:execute})).rejects.toThrow();
});
test.each([['boolean',true],['array',[]],['number',17],['null',null],['ok:false',{ok:false}],['ok欠損',{}]])('Gateway healthがobjectかつok:trueでなければ失敗する: %s',async(_kind,health)=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps);
 const execute=async(exe,args,o)=>exe===c.openclaw.executable&&args[0]==='gateway'&&args[1]==='health'?{code:0,stdout:JSON.stringify(health),stderr:''}:fake.execute(exe,args,o);
 await expect(verifyServices(c,snapshot,{...deps,run:execute})).rejects.toThrow();
});
test('対象外pluginの既知診断があってもcontext-hubの検証を続ける',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps),health={ok:true,plugins:{errors:[{id:'other-plugin',activated:true,activationSource:'explicit',error:'fixture existing failure'}],unavailable:[{id:'another-plugin',state:'configured-unavailable',diagnostic:{kind:'plugin-verification',reason:'fixture-existing-failure',detail:'fixture unavailable'}}]}};
 const execute=async(exe,args,o)=>exe===c.openclaw.executable&&args[0]==='gateway'&&args[1]==='health'?{code:0,stdout:JSON.stringify(health),stderr:''}:fake.execute(exe,args,o);
 await expect(verifyServices(c,snapshot,{...deps,run:execute})).resolves.toBeUndefined();
});
test('同期bootstrap後にrunningへ戻らなければ期限付きで失敗し、ジョブを再開しない',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps);await stopServices(c,snapshot,deps);let elapsed=0;
 const execute=async(exe,args,o)=>{
  const r=await fake.execute(exe,args,o);
  return exe==='launchctl'&&args[0]==='print'&&args[1].endsWith('/com.context-hub.sync')&&r.code===0?{code:0,stdout:'state = exited\nlast exit code = 1\n',stderr:''}:r;
 };
 await expect(resumeServices(c,snapshot,{...deps,run:execute,now:()=>elapsed,pause:async()=>{elapsed+=250;}})).rejects.toThrow(/起動|再開/);
 expect(fake.getJob().enabled).toBe(false);expect(elapsed).toBeGreaterThan(0);expect(elapsed).toBeLessThan(60000);
});
test('同期が遅れてrunningになるまでジョブを再開せず待つ',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f),c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready};
 const snapshot=await inspectServices(c,f.repository,deps);await stopServices(c,snapshot,deps);let elapsed=0;
 const execute=async(exe,args,o)=>{
  const r=await fake.execute(exe,args,o);
  return exe==='launchctl'&&args[0]==='print'&&args[1].endsWith('/com.context-hub.sync')&&r.code===0&&elapsed<500?{code:0,stdout:'state = waiting\n',stderr:''}:r;
 };
 await resumeServices(c,snapshot,{...deps,run:execute,now:()=>elapsed,pause:async()=>{expect(fake.getJob().enabled).toBe(false);elapsed+=250;}});
 expect(elapsed).toBeGreaterThanOrEqual(500);expect(fake.getJob().enabled).toBe(true);
});
test.each(['backupPlist','backupVerifyPlist'])('予定実行型%sはrunningを要求せずloaded復帰を確認する',async role=>{
 const agent={role,path:'/fake/backup.plist',label:'com.context-hub.backup',loaded:true,running:true};let active=false;
 const execute=async(exe,args)=>{
  if(exe==='launchctl'&&args[0]==='print')return active?{code:0,stdout:'state = waiting\n',stderr:''}:{code:113,stdout:'',stderr:'Could not find service'};
  if(exe==='launchctl'&&args[0]==='bootstrap'&&args[2]===agent.path){active=true;return{code:0,stdout:'',stderr:''};}
  throw new Error('予期しないfakeコマンド');
 };
 await expect(resumeServices({openclaw:null},{agents:[agent],job:null},{run:execute})).resolves.toBeUndefined();expect(active).toBe(true);
});
test('bootstrapが成功しても予定実行型LaunchAgentがloadedに戻らなければ失敗する',async()=>{
 const agent={role:'backupPlist',path:'/fake/backup.plist',label:'com.context-hub.backup',loaded:true,running:false};let elapsed=0;
 const execute=async(exe,args)=>{
  if(exe==='launchctl'&&args[0]==='print')return{code:113,stdout:'',stderr:'Could not find service'};
  if(exe==='launchctl'&&args[0]==='bootstrap'&&args[2]===agent.path)return{code:0,stdout:'',stderr:''};
  throw new Error('予期しないfakeコマンド');
 };
 await expect(resumeServices({openclaw:null},{agents:[agent],job:null},{run:execute,now:()=>elapsed,pause:async()=>{elapsed+=250;}})).rejects.toThrow(/起動|再開/);
 expect(elapsed).toBeGreaterThan(0);expect(elapsed).toBeLessThan(60000);
});
test('元から未登録の同期を再開しない',async()=>{
 const f=await fixture();fs.push(f);const fake=await fakeServices(f);fake.serviceState.set('com.context-hub.sync',false);
 const c=await loadConfig(f.file,f.repository),deps={run:fake.execute,platform:'darwin',ready:fake.ready},snapshot=await inspectServices(c,f.repository,deps);
 await stopServices(c,snapshot,deps);await resumeServices(c,snapshot,deps);expect(fake.serviceState.get('com.context-hub.sync')).toBe(false);
});
