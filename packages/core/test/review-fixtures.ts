import {workflowSetup} from './workflow-fixtures.js';
import {capture} from '../src/capture.js';
import {organize} from '../src/organize.js';
import {MockLlm} from '../src/llm.js';
import {hash} from '../src/storage.js';
import type {OrganizeResult} from '../src/types.js';
export async function aiCandidate(roots:string[],project=false){
 const{config,vault}=await workflowSetup(roots);
 const input=await capture(config,{source:'cli',occurredAt:'2026-11-01T01:00:00Z',text:'正本はMarkdownとする'});
 const result:OrganizeResult={category:'decision-candidate',summary:'保存方針',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:{kind:'decision',claim:'正本はMarkdownとする',rationale:'復旧しやすい'},new_project_hint:null,...(project?{project_proposal:{title:'個人ノート管理',aliases:[],keywords:['記録'],rationale:'継続的に改善する'}}:{})};
 await organize(config,new MockLlm([result]));
 const id=`CAN-${input.inputId.slice(3)}`,path=`90_system/candidates/${id}.md`;
 return{config,vault,input,id,path,hash:hash((await vault.read(path))!)};
}
export async function scopedAiCandidate(roots:string[],explicitProject?:string,inferredProjects:string[]=[]){
 const{addProject}=await import('../src/projects.js'),{config,vault}=await workflowSetup(roots);
 for(const id of new Set([...(explicitProject?[explicitProject]:[]),...inferredProjects]))await addProject(config,{id,title:`対象 ${id}`});
 const input=await capture(config,{source:'cli',occurredAt:'2026-11-01T01:00:00Z',project:explicitProject,text:'対象の方針'});
 const result:OrganizeResult={category:'decision-candidate',summary:'対象の方針',project_candidates:inferredProjects.map(id=>({id,confidence:0.8})),next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:{kind:'decision',claim:'記録を残す',rationale:'復旧できる'},new_project_hint:null};
 await organize(config,new MockLlm([result]));const id=`CAN-${input.inputId.slice(3)}`,path=`90_system/candidates/${id}.md`;
 return{config,vault,input,id,path,hash:hash((await vault.read(path))!)};
}
