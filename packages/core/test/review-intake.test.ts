import {afterEach,expect,test,vi} from 'vitest';
import {rm} from 'node:fs/promises';
import {workflowSetup,packet} from './workflow-fixtures.js';
import {aiCandidate} from './review-fixtures.js';
import {propose} from '../src/approvals.js';
import {ingest,readIntakeReceipts,intakeReceiptSchema} from '../src/intake.js';
import {parseIntake} from '../src/intake-format.js';
import {Vault,markdown} from '../src/storage.js';
import {readInputs} from '../src/capture.js';
import {correctInput} from '../src/corrections.js';
import {doctor} from '../src/doctor.js';
const roots:string[]=[];afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test.each(['knowledge','decision','preference'] as const)('Inputから%sを採用し別REQの同判断を集約する',async kind=>{
 const{config,vault}=await workflowSetup(roots),c=await propose(config,{kind,claim:'Markdownを使う'});
 const fields={operation:'knowledge-approve',scope:'global',candidate_id:c.candidateId,candidate_hash:c.hash,confirmed:true};
 const p=await packet(config,fields,''),before=await vault.read(p.path);
 expect((await ingest(config)).accepted).toBe(1);
 await packet(config,fields,'');expect((await ingest(config)).accepted).toBe(1);
 expect(await vault.files('30_knowledge')).toHaveLength(1);expect(await vault.files('90_system/approvals')).toHaveLength(1);
 const acks=await readIntakeReceipts(config);expect(acks).toHaveLength(2);expect(acks.every(a=>'approvalId'in a.result)).toBe(true);
 await packet(config,{operation:'knowledge-reject',candidate_id:c.candidateId,candidate_hash:c.hash,confirmed:true},'');expect((await ingest(config)).rejected).toBe(1);
 expect(await vault.read(p.path)).toBe(before);expect(await readInputs(config)).toHaveLength(0);expect((await doctor(config)).issues.join(' ')).not.toContain('受付記録が不正');
});
test('確認・hash・本文・結果型の組合せを厳密に検証する',()=>{
 const id='REQ-'+'a'.repeat(32),meta={schema_version:1,request_id:id,operation:'knowledge-approve',scope:'global',candidate_id:'CAN-'+'0'.repeat(26),candidate_hash:'a'.repeat(64),confirmed:true,source:'quickadd',occurred_at:'2026-11-01T00:00:00Z'},path=`Input/${id}.md`;
 expect(parseIntake(path,markdown(meta,''),8000).operation).toBe('knowledge-approve');
 for(const extra of [{confirmed:false},{candidate_hash:'x'},{candidate_id:'PCAN-'+'0'.repeat(26)}])expect(()=>parseIntake(path,markdown({...meta,...extra},''),8000)).toThrow();
 expect(()=>parseIntake(path,markdown(meta,'採用する'),8000)).toThrow();
 expect(intakeReceiptSchema.safeParse({schema_version:1,request_id:id,request_hash:'a'.repeat(64),path,operation:'capture',status:'accepted',received_at:meta.occurred_at,result:{candidateId:meta.candidate_id,approvalId:'APR-'+'0'.repeat(26),deduped:false}}).success).toBe(false);
});
test('候補hashが同じでも根拠の訂正後は受け付けない',async()=>{
 const f=await aiCandidate(roots);await correctInput(f.config,f.input.inputId,{source:'cli',occurredAt:'2026-11-01T02:00:00Z',text:'正本方針を再検討'});
 await packet(f.config,{operation:'knowledge-approve',scope:'global',candidate_id:f.id,candidate_hash:f.hash,confirmed:true},'');
 expect((await ingest(f.config)).rejected).toBe(1);expect(await f.vault.files('90_system/approvals')).toHaveLength(0);
});
test('承認記録の直後に停止しても受付snapshotから同じ知識へ回復する',async()=>{
 const{config,vault}=await workflowSetup(roots),c=await propose(config,{claim:'保存方針'}),p=await packet(config,{operation:'knowledge-approve',scope:'global',candidate_id:c.candidateId,candidate_hash:c.hash,confirmed:true},'');
 const create=Vault.prototype.create;vi.spyOn(Vault.prototype,'create').mockImplementation(async function(this:Vault,path,text){if(path.startsWith('30_knowledge/'))throw new Error('停止');return create.call(this,path,text);});
 expect((await ingest(config)).rejected).toBe(1);expect(await vault.files('90_system/approvals')).toHaveLength(1);vi.restoreAllMocks();
 await rm(await vault.path(p.path));expect((await ingest(config)).accepted).toBe(1);expect(await vault.files('30_knowledge')).toHaveLength(1);
});
