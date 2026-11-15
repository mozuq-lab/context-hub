import {afterEach,expect,test} from 'vitest';
import {fixture,fakeServices} from './fixtures.mjs';
import {loadConfig} from '../config.mjs';
import {inspectServices,stopServices,resumeServices} from '../services.mjs';
const fs=[];afterEach(async()=>{for(const f of fs.splice(0))await f.cleanup();});
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
