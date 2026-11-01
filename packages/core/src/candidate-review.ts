import {readProjectCatalog,type AdoptionTarget,type ReviewProject} from './knowledge-scope.js';
import type { HubConfig } from './types.js';
import {unlink} from 'node:fs/promises';
import {Vault,hash,parseMarkdown} from './storage.js';
import {readCorrectionChains} from './corrections.js';
import {readProjectCandidate,readProjectDecision} from './project-proposals.js';
import {readKnowledgeCandidate,reviewRead,unavailableCandidate} from './knowledge-candidates.js';
import {projectProposalSchema} from './llm.js';
export interface ReviewCandidate {
  id:string; kind:'project'|'knowledge'|'decision'|'preference'|'unknown';
  path:string; title:string; claim:string; rationale:string; inputIds:string[];
  candidateHash:string; status:'pending'|'approved'|'rejected'|'stale'|'unavailable';
  warnings:string[]; reflected:boolean; generatedAt?:string; supersedes?:string;
  projectSuggestions:{projectId:string;title:string;source:'explicit'|'inferred';confidence?:number}[]; suggestedTarget?:AdoptionTarget; retired:boolean; retiredAt?:string;
  adoptedTarget?:AdoptionTarget; decisionId?:string; targetPath?:string; confirmationToken?:string; aliases?:string[]; keywords?:string[];
  dependencies:Record<string,string|null>;
}
export interface ReviewIndex {schema_version:1;generated_at:string;projects:ReviewProject[];items:ReviewCandidate[]}
async function projectReview(config:HubConfig,id:string):Promise<ReviewCandidate>{
 const vault=new Vault(config),path=`90_system/project-candidates/${id}.md`,item=unavailableCandidate(id,path);
 const depend=async(p:string)=>{const raw=await reviewRead(vault,p);item.dependencies[p]=raw===undefined?null:hash(raw);return raw;};
 try{
  const current=await depend(path),decisionPath=`90_system/project-approvals/PAPR-${id.slice(5)}.json`;
  await depend(decisionPath);const decision=await readProjectDecision(vault,id);
  const raw=decision?.candidate_snapshot??current;if(!raw)throw new Error('候補がありません');
  const meta=parseMarkdown(raw).meta;
  const candidate=decision?undefined:await readProjectCandidate(config,id);
  const proposal=decision?projectProposalSchema.parse(meta.proposal):candidate!.proposal;
  Object.assign(item,{kind:'project',aliases:proposal.aliases,keywords:proposal.keywords,title:proposal.title,claim:proposal.title,rationale:proposal.rationale,inputIds:meta.evidence_ids,candidateHash:hash(raw),status:decision?(decision.action==='approve'?'approved':'rejected'):candidate!.status,warnings:[],generatedAt:meta.generated_at,confirmationToken:candidate?.confirmationToken});
  await depend(`90_system/project-confirmations/${id}.json`);
  const chain=(await readCorrectionChains(config)).find(c=>c.root.id===meta.root_input_id);
  if(chain){for(const i of [chain.root,...chain.revisions])await depend(i.path);if(chain.evidenceHash!==meta.evidence_hash)item.warnings.push('根拠に新しい訂正があります。');}
  if(item.status==='stale')item.warnings.push('候補が古いか、確認情報の同期が不足しています。');
  if(decision){
   item.decisionId=decision.id;
   if(current===undefined||hash(current)!==decision.candidate_hash)item.warnings.push('元候補が変更・欠損しています。承認時点の内容を表示しています。');
   if(decision.action==='approve'){
    const id=meta.project_id;item.targetPath=`10_projects/${id}/project.md`;
    const target=await depend(item.targetPath),markerRaw=await depend(`90_system/project-approvals/materialized/${decision.id}.json`);
    if(target&&markerRaw){const marker=JSON.parse(markerRaw);item.reflected=parseMarkdown(target).meta.id===id&&marker.decision_id===decision.id&&marker.decision_hash===hash(JSON.stringify(decision))&&marker.project_id===id;}
    if(!item.reflected)item.warnings.push('承認記録はありますが、プロジェクトへの反映を確認できません。');
   }else item.reflected=true;
  }
  return item;
 }catch{item.status='unavailable';item.warnings.push('候補・根拠・承認記録を確認できません。');return item;}
}
export async function readReviewCandidates(config:HubConfig):Promise<ReviewCandidate[]>{
 const vault=new Vault(config),ids=new Map<string,'knowledge'|'project'>();
 for(const path of await vault.files('90_system/candidates')){const m=/^90_system\/candidates\/(CAN-[0-9A-HJKMNP-TV-Z]{26})\.md$/.exec(path);if(m)ids.set(m[1]!,'knowledge');}
 for(const path of await vault.files('90_system/approvals')){const m=/^90_system\/approvals\/APR-([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);if(m)ids.set(`CAN-${m[1]}`,'knowledge');}
 for(const path of await vault.files('90_system/project-candidates')){const m=/^90_system\/project-candidates\/(PCAN-[0-9A-HJKMNP-TV-Z]{26})\.md$/.exec(path);if(m)ids.set(m[1]!,'project');}
 for(const path of await vault.files('90_system/project-approvals')){const m=/^90_system\/project-approvals\/PAPR-([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);if(m)ids.set(`PCAN-${m[1]}`,'project');}
 const items:ReviewCandidate[]=[];
 for(const[id,kind]of ids)items.push(kind==='project'?await projectReview(config,id):await readKnowledgeCandidate(config,id));
 // 読取途中の別版を混ぜた一覧を操作可能としない。indexの依存は取得値と再照合する。
 for(const item of items){
  try{
   for(const[path,want]of Object.entries(item.dependencies)){
    const raw=await reviewRead(vault,path),actual=raw===undefined?null:hash(raw);
    if(actual!==want)throw new Error('変更');
   }
  }catch{item.status='unavailable';item.reflected=false;item.warnings.push('一覧の取得中に根拠が変更されました。再読込してください。');}
 }
 return items.sort((a,b)=>(b.generatedAt??'').localeCompare(a.generatedAt??'')||a.id.localeCompare(b.id));
}
export async function buildReviewIndex(config:HubConfig):Promise<ReviewIndex>{return{schema_version:1,generated_at:new Date().toISOString(),projects:await readProjectCatalog(new Vault(config)),items:await readReviewCandidates(config)};}

// 端末の1MiB/file上限より小さく分割する。pageは派生物で、rootを最後に置き換える。
export function encodeReviewIndex(index:ReviewIndex):Map<string,string>{
 const files=new Map<string,string>(),encode=(value:unknown)=>JSON.stringify(value)+'\n',max=512*1024;
 const rootPath='90_system/review/index.json',flat=encode(index);
 if(Buffer.byteLength(flat)<=max){files.set(rootPath,flat);return files;}
 const pages:{path:string;hash:string}[]=[];let chunk:ReviewCandidate[]=[];
 const flush=()=>{if(!chunk.length)return;const path=`90_system/review/page-${String(pages.length).padStart(5,'0')}.json`,raw=encode({schema_version:1,items:chunk});files.set(path,raw);pages.push({path,hash:hash(raw)});chunk=[];};
 for(const original of index.items){
  let item=original;
  if(Buffer.byteLength(encode({schema_version:1,items:[item]}))>max)item={...unavailableCandidate(item.id,item.path),warnings:['候補の参照数が端末の上限を超えています。Mac側で確認してください。']};
  if(Buffer.byteLength(encode({schema_version:1,items:[...chunk,item]}))>max)flush();
  chunk.push(item);
 }
 flush();const root=encode({...index,items:[],pages});if(Buffer.byteLength(root)>max)throw new Error('候補一覧の容量が上限を超えています');files.set(rootPath,root);return files;
}
export async function writeReviewIndexLocked(vault:Vault,index:ReviewIndex):Promise<void>{
 const files=encodeReviewIndex(index);for(const[path,raw]of files)await vault.write(path,raw);
 for(const path of await vault.files('90_system/review'))if(/^90_system\/review\/page-\d{5}\.json$/.test(path)&&!files.has(path))await unlink(await vault.path(path));
}
