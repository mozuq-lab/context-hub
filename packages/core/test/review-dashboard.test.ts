import {afterEach,expect,test} from 'vitest';
import {rm} from 'node:fs/promises';
import {workflowSetup} from './workflow-fixtures.js';
import {aiCandidate} from './review-fixtures.js';
import {propose,approve,reject} from '../src/approvals.js';
import {correctInput} from '../src/corrections.js';
import {rebuildDashboard} from '../src/dashboard.js';
import {encodeReviewIndex,type ReviewCandidate} from '../src/candidate-review.js';
import {hash} from '../src/storage.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test('HOMEに全種の未承認と履歴と要確認を分けindexを保存する',async()=>{
 const f=await aiCandidate(roots,true);await propose(f.config,{kind:'knowledge',claim:'知識'});await propose(f.config,{kind:'preference',claim:'好み'});
 const history=await propose(f.config,{claim:'承認済み'});await approve(f.config,history.candidateId,history.hash,{scope:'global'});
 const no=await propose(f.config,{claim:'却下済み'});await reject(f.config,no.candidateId,no.hash);
 await f.vault.create('90_system/candidates/CAN-'+'0'.repeat(26)+'.md','破損');
 await rebuildDashboard(f.config);const home=(await f.vault.read('HOME.md'))!,index=JSON.parse((await f.vault.read('90_system/review/index.json'))!);
 expect(home).toContain('## 確認待ち（4件）');expect(home).toContain('## 要確認（1件）');expect(home).toContain('## 判断履歴');expect(index.items.filter((i:ReviewCandidate)=>i.status==='pending')).toHaveLength(4);
 await correctInput(f.config,f.input.inputId,{source:'cli',occurredAt:'2026-11-01T03:00:00Z',text:'訂正'});await rebuildDashboard(f.config);expect(await f.vault.read('HOME.md')).toContain('## 確認待ち（2件）');
});
test('大きい一覧を512KiB以下のhash参照pageへ分ける',()=>{
 const item:ReviewCandidate={id:'CAN-'+'0'.repeat(26),kind:'knowledge',path:'90_system/candidates/CAN-'+'0'.repeat(26)+'.md',title:'例',claim:'例'.repeat(1000),rationale:'理由'.repeat(500),inputIds:[],candidateHash:'a'.repeat(64),status:'pending',warnings:[],reflected:false,retired:false,projectSuggestions:[],dependencies:{}};
 const encoded=encodeReviewIndex({schema_version:1,generated_at:'2026-11-01T00:00:00Z',projects:[],items:Array.from({length:200},(_,n)=>({...item,id:`CAN-${n.toString().padStart(26,'0')}`}))});
 const root=JSON.parse(encoded.get('90_system/review/index.json')!);expect(root.items).toEqual([]);expect(root.pages.length).toBeGreaterThan(1);
 for(const p of root.pages){const raw=encoded.get(p.path)!;expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(512*1024);expect(hash(raw)).toBe(p.hash);}
 expect(root.pages.flatMap((p:{path:string})=>JSON.parse(encoded.get(p.path)!).items)).toHaveLength(200);
});
