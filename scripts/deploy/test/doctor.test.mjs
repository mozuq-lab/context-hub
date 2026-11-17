import {afterEach,expect,test} from 'vitest';
import {readFile,writeFile,unlink,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fixture,intakeFailure,project} from './fixtures.mjs';
import {loadConfig} from '../config.mjs';
import {coreDoctor,preparePlan} from '../prepare.mjs';
const roots=[];afterEach(async()=>{for(const f of roots.splice(0))await f.cleanup();});
async function setup(){const f=await fixture();roots.push(f);return{f,c:await loadConfig(f.file,f.repository)};}

test('既存の正式な受付失敗と停止回復待ちをplanへ示し、受付記録を変更しない',async()=>{
 const{f}=await setup(),failure=await intakeFailure(f),paths=Object.values(failure.paths),before=await Promise.all(paths.map(p=>readFile(p)));
 const result=await preparePlan(f.file,{repository:f.repository,run:f.execute}),plan=JSON.parse(await readFile(result.planPath,'utf8'));
 expect(plan.doctor.issues).toHaveLength(2);expect(plan.doctor.intake).toHaveLength(1);expect(plan.doctor.intake[0].requestId).toBe(failure.requestId);
 expect(result.summary.existingIntakeIssues).toEqual(plan.doctor.issues);expect(await Promise.all(paths.map(p=>readFile(p)))).toEqual(before);
});
test('受付の再試行時刻だけの変化と、既存問題の解消を許可する',async()=>{
 const{f,c}=await setup(),failure=await intakeFailure(f),baseline=await coreDoctor(project,c);
 const error=JSON.parse(await readFile(failure.paths.error,'utf8'));error.updated_at='2026-11-01T10:00:00Z';await writeFile(failure.paths.error,JSON.stringify(error));
 expect((await coreDoctor(project,c,{},baseline)).intake).toEqual(baseline.intake);
 await unlink(failure.paths.pending);await unlink(failure.paths.error);
 expect((await coreDoctor(project,c,{},baseline)).issues).toEqual([]);
});
test.each(['input','pending','error'])('同じ診断でも受付の%sが変わった場合は停止する',async kind=>{
 const{f,c}=await setup(),failure=await intakeFailure(f),baseline=await coreDoctor(project,c);
 if(kind==='input')await writeFile(failure.paths.input,(await readFile(failure.paths.input,'utf8')).replace('架空の欠損対象','別の欠損対象'));
 else if(kind==='pending'){
  const d=JSON.parse(await readFile(failure.paths.pending,'utf8'));d.raw=d.raw.replace('架空の欠損対象','別の欠損対象');const{sha}=await import('../common.mjs');d.request_hash=sha(d.raw);await writeFile(failure.paths.pending,JSON.stringify(d));
 }else{
  const d=JSON.parse(await readFile(failure.paths.error,'utf8'));d.file_hash='f'.repeat(64);await writeFile(failure.paths.error,JSON.stringify(d));
 }
 await expect(coreDoctor(project,c,{},baseline)).rejects.toThrow(/変更|診断/);
});
test('新しい受付失敗と、旧形式planの診断なしbaselineからの異常を拒否する',async()=>{
 const{f,c}=await setup();await intakeFailure(f);const baseline=await coreDoctor(project,c);
 await expect(coreDoctor(project,c,{}, {issues:0,inputs:0})).rejects.toThrow(/新し|診断/);
 await intakeFailure(f,`REQ-${'b'.repeat(32)}`);await expect(coreDoctor(project,c,{},baseline)).rejects.toThrow(/新し|診断/);
});
test('受付記録の破損は、既存の受付失敗と区別して停止する',async()=>{
 const{f,c}=await setup(),failure=await intakeFailure(f);await writeFile(failure.paths.pending,'broken');
 await expect(coreDoctor(project,c)).rejects.toThrow(/doctor|診断/);
});
test.each(['input','pending','error'])('plan前から受付と記録のhashが食い違う場合も停止する（%s）',async kind=>{
 const{f,c}=await setup(),failure=await intakeFailure(f);
 if(kind==='input')await writeFile(failure.paths.input,(await readFile(failure.paths.input,'utf8')).replace('架空の欠損対象','別の欠損対象'));
 else if(kind==='pending'){
  const d=JSON.parse(await readFile(failure.paths.pending,'utf8'));d.raw=d.raw.replace('架空の欠損対象','別の欠損対象');const{sha}=await import('../common.mjs');d.request_hash=sha(d.raw);await writeFile(failure.paths.pending,JSON.stringify(d));
 }else{const d=JSON.parse(await readFile(failure.paths.error,'utf8'));d.file_hash='f'.repeat(64);await writeFile(failure.paths.error,JSON.stringify(d));}
 await expect(coreDoctor(project,c)).rejects.toThrow(/診断|一致/);
});
test('Inputが消えていても、整合する停止回復snapshotがあれば既存診断を保持できる',async()=>{
 const{f,c}=await setup(),failure=await intakeFailure(f);await unlink(failure.paths.input);
 expect((await coreDoctor(project,c)).intake[0].inputHash).toBeNull();
});
test('停止回復記録だけで失敗記録がない既存の受付も保持できる',async()=>{
 const{f,c}=await setup(),failure=await intakeFailure(f);await unlink(failure.paths.error);
 const d=await coreDoctor(project,c);expect(d.issues).toHaveLength(1);expect(d.intake[0].errorHash).toBeNull();
});
test.each([{signal:'SIGTERM'},{timedOut:true}])('doctorの中断・期限超過は、出力済みの正式な診断があっても拒否する（%j）',async status=>{
 const{f,c}=await setup();await intakeFailure(f);
 await expect(coreDoctor(project,c,{run:async(...args)=>({...await f.execute(...args),...status})})).rejects.toThrow(/診断/);
});
test.each(['misplaced','duplicate'])('受付失敗記録の配置・重複の不整合も停止する（%s）',async kind=>{
 const{f,c}=await setup(),failure=await intakeFailure(f),other=join(dirname(failure.paths.error),'misplaced.json');
 if(kind==='misplaced')await rename(failure.paths.error,other);
 else{const d=JSON.parse(await readFile(failure.paths.error,'utf8'));delete d.reason;d.code='架空の別の失敗';await writeFile(other,JSON.stringify(d));}
 await expect(coreDoctor(project,c)).rejects.toThrow(/診断/);
});
test.each([
 {code:2,stdout:JSON.stringify({issues:[],inputs:0})},
 {code:1,stdout:JSON.stringify({issues:[],inputs:0})},
 {code:0,stdout:JSON.stringify({issues:[false],inputs:0})},
 {code:0,stdout:JSON.stringify({issues:[],inputs:'0'})},
 {code:0,stdout:'null'},
 {code:0,stdout:'not json'},
])('doctorの不正な応答・終了状態を成功として扱わない（%j）',async result=>{
 const{c}=await setup();await expect(coreDoctor(project,c,{run:async()=>({...result,stderr:''})})).rejects.toThrow();
});
