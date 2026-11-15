import { afterEach, expect, test, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup } from './workflow-fixtures.js';
import { Vault } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { readKnowledgeCandidate } from '../src/knowledge-candidates.js';
import { approve } from '../src/approvals.js';
import { addProject } from '../src/projects.js';
import type { OrganizeResult } from '../src/types.js';
// 入力の件数Nと候補・承認の件数Kが増えても、1回の操作で原文（00_inbox）を候補・承認ごとに読み直さないこと（読み取り回数で確かめる）。
const roots:string[]=[];afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const N=12,K=6;
const withKnowledge=(i:number):OrganizeResult=>({category:'unclassified',summary:`要約${i}`,project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:{kind:'knowledge',claim:`主張${i}`,rationale:''},new_project_hint:null});
async function filled(){
 const{config,vault}=await workflowSetup(roots);config.organize.maxItemsPerRun=50;
 for(let i=0;i<N;i++)await capture(config,{source:'cli',occurredAt:`2026-10-01T${String(i).padStart(2,'0')}:00:00Z`,text:`メモ${i}`});
 await organize(config,new MockLlm(Array.from({length:K},(_,i)=>withKnowledge(i))),{limit:K});await organize(config,new MockLlm());
 return{config,vault};
}
function countInboxReads(){
 const reads={count:0},read=Vault.prototype.read;
 vi.spyOn(Vault.prototype,'read').mockImplementation(async function(this:Vault,path:string){if(path.startsWith('00_inbox/'))reads.count++;return read.call(this,path);});
 return reads;
}
test('HOMEの作り直しは、知識候補が何件あっても原文を候補ごとに読み直さない',async()=>{
 const{config,vault}=await filled();expect((await vault.files('90_system/candidates')).length).toBeGreaterThanOrEqual(K);
 const reads=countInboxReads();await rebuildDashboard(config);
 expect(reads.count).toBeLessThanOrEqual(2*N);
});
test('整理の開始時の承認回復は、承認済みの知識が何件あっても原文を承認ごとに読み直さない',async()=>{
 const{config,vault}=await filled();
 for(const path of (await vault.files('90_system/candidates')).filter(p=>p.endsWith('.md'))){const id=path.split('/').at(-1)!.slice(0,-3),c=await readKnowledgeCandidate(config,id);await approve(config,id,c.candidateHash,{scope:'global'});}
 const reads=countInboxReads();await organize(config,{complete:async()=>{throw new Error('モデルは呼ばない');}});
 // 整理はWriterロックの区間を数回に分けて取る。読み直しは区間ごとに1回までで、承認の件数Kには比例しない。
 expect(reads.count).toBeLessThanOrEqual(4*N);
});
test('記録を1件足すときと同じイベントの再送では、既にある原文を全件は読まない',async()=>{
 const{config}=await workflowSetup(roots);
 for(let i=0;i<N;i++)await capture(config,{source:'cli',sourceEventId:`ev-${i}`,occurredAt:'2026-10-01T00:00:00Z',text:`メモ${i}`});
 const reads=countInboxReads();
 await capture(config,{source:'cli',sourceEventId:'new',occurredAt:'2026-10-02T00:00:00Z',text:'新しいメモ'});expect(reads.count).toBe(0);
 expect((await capture(config,{source:'cli',sourceEventId:'ev-3',occurredAt:'2026-10-01T00:00:00Z',text:'再送'})).deduped).toBe(true);expect(reads.count).toBe(1);
});
test('訂正1件の保存とNOWの作り直しで、原文を何度も読み直さない',async()=>{
 const{config}=await workflowSetup(roots);await addProject(config,{id:'garden',title:'菜園'});
 const first=await capture(config,{source:'cli',project:'garden',occurredAt:'2026-10-01T00:00:00Z',text:'最初のメモ'});
 for(let i=1;i<N;i++)await capture(config,{source:'cli',project:'garden',occurredAt:`2026-10-01T${String(i).padStart(2,'0')}:00:00Z`,text:`メモ${i}`});
 await organize(config,new MockLlm(),{limit:N});
 const reads=countInboxReads();await correctInput(config,first.inputId,{source:'cli',occurredAt:'2026-10-02T00:00:00Z',text:'訂正したメモ'});
 expect(reads.count).toBeLessThanOrEqual(3*(N+1));
});
