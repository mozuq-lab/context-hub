import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup,packet } from './workflow-fixtures.js';
import { runCycle } from '../src/cycle.js';
import { readInputs } from '../src/capture.js';
import { readProjects } from '../src/projects.js';
import { listProjectCandidates } from '../src/project-proposals.js';
import { MockLlm } from '../src/llm.js';
import { find } from '../src/retrieve.js';
import { listCandidates,approve } from '../src/approvals.js';
import { hash } from '../src/storage.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const proposed={category:'idea' as const,summary:'菜園の計画',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:null,new_project_hint:null,project_proposal:{title:'家庭菜園',aliases:['菜園'],keywords:['栽培'],rationale:'継続的な栽培の計画'}};
test('別端末の入力から訂正と承認を経て出典付き表示へ戻る',async()=>{
 const{config,vault}=await workflowSetup(roots);
 const llm={complete:async(prompt:string,opts:any)=>{const payload=JSON.parse(prompt.split('\n入力データ(JSON):\n')[1]);return payload.operation!=='association'&&payload.source_text.includes('計画をプロジェクト化')?{text:JSON.stringify(proposed),model:'mock'}:new MockLlm().complete(prompt,opts);}};
 await packet(config,{kind:'work-summary',tool:'codex'},'## 現在地\n- [確認済み] 菜園を栽培中');await runCycle(config,llm);const[root]=await readInputs(config),raw=await vault.read(root.path),receipt=await vault.read(`90_system/receipts/${root.id}.json`);
 await packet(config,{operation:'correct',target_id:root.id},'## 現在地\n- [確認済み] 菜園で苗を育成中');await packet(config,{},'菜園の計画をプロジェクト化したい');await runCycle(config,llm);
 const[candidate]=await listProjectCandidates(config);expect(candidate.status).toBe('pending');expect(await readProjects(config)).toHaveLength(0);
 await packet(config,{operation:'project-approve',candidate_id:candidate.candidateId,candidate_hash:candidate.candidateHash,confirmation_token:candidate.confirmationToken,confirmed:true},'');await runCycle(config,llm,{limit:2});
 const[project]=await readProjects(config);expect(project.title).toBe('家庭菜園');expect(await vault.read(`10_projects/${project.id}/NOW.md`)).toContain('苗を育成中');expect(await vault.read('HOME.md')).toContain('家庭菜園');expect(await vault.read(root.path)).toBe(raw);expect(await vault.read(`90_system/receipts/${root.id}.json`)).toBe(receipt);
 const count=(await readInputs(config)).length;const none=await runCycle(config,{complete:async()=>{throw new Error('余分な呼出は禁止');}});expect(none.organize.failed).toBe(0);expect(await readInputs(config)).toHaveLength(count);
});
test('根拠の訂正は承認済み知識を変更せず検索で再確認を促す',async()=>{
 const{config,vault}=await workflowSetup(roots);await packet(config,{},'栽培を始める判断');await runCycle(config,new MockLlm([{...proposed,project_proposal:null,knowledge_candidate:{kind:'decision',claim:'栽培を始める',rationale:'利用者の検討内容'}}]));
 const root=(await readInputs(config))[0],candidateId=`CAN-${root.id.slice(3)}`,candidateRaw=(await vault.read(`90_system/candidates/${candidateId}.md`))!;const decision=await approve(config,candidateId,hash(candidateRaw),{scope:'global'}),path=`30_knowledge/${decision.knowledgeId}.md`,knowledge=await vault.read(path);
 await packet(config,{operation:'correct',target_id:root.id},'栽培開始を延期する');await runCycle(config,new MockLlm());expect(await vault.read(path)).toBe(knowledge);expect(await find(config,'栽培')).toContain('本文は自動改訂されていません');
});
