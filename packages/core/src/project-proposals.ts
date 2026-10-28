import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { Vault, hash, markdown, parseMarkdown } from './storage.js';
import { generatedMarkdown, isGeneratedIntact } from './views.js';
import { readCorrectionChains, type CorrectionChain } from './corrections.js';
import { readProjects, projectSchema } from './projects.js';
import { inputIdSchema } from './capture.js';
import { projectProposalSchema } from './llm.js';
import type { HubConfig, ProjectProposal, Receipt } from './types.js';

export interface ProjectCandidate { candidateId:string; projectId:string; path:string; rootInputId:string; evidenceHash:string; candidateHash:string; confirmationToken:string; proposal:ProjectProposal; status:'pending'|'approved'|'rejected'|'stale' }
export interface ProjectDecisionRequest { candidateId:string; expectedHash:string; confirmationToken:string; action:'approve'|'reject'; source:string; sourceEventId:string; confirmed:true }
export interface ProjectDecisionResult { candidateId:string; projectId:string; decisionId:string; deduped:boolean }
const candidateId = z.string().regex(/^PCAN-[0-9A-HJKMNP-TV-Z]{26}$/), digest=z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema=z.object({ schema_version:z.literal(1),id:candidateId,project_id:z.string().regex(/^project-[0-9a-hjkmnp-tv-z]{26}$/),root_input_id:inputIdSchema,evidence_ids:z.array(inputIdSchema).min(1).max(33),evidence_hash:digest,proposal:projectProposalSchema,generated_at:z.string().datetime({offset:true}),generated_by:z.object({model:z.string(),prompt_version:z.literal(1)}).strict(),verified:z.literal(false),generated_hash:z.string() }).strict();
const confirmationSchema=z.object({schema_version:z.literal(1),candidate_id:candidateId,candidate_hash:digest,confirmation_token:digest}).strict();
const requestSchema=z.object({candidateId,expectedHash:digest,confirmationToken:digest,action:z.enum(['approve','reject']),source:z.string().min(1).max(200),sourceEventId:z.string().min(1).max(1000),confirmed:z.literal(true)}).strict();
const decisionSchema=z.object({schema_version:z.literal(1),id:z.string().regex(/^PAPR-[0-9A-HJKMNP-TV-Z]{26}$/),candidate_id:candidateId,candidate_hash:digest,confirmation_hash:digest,action:z.enum(['approve','reject']),source:z.string().min(1).max(200),source_event_id:z.string().min(1).max(1000),decided_at:z.string().datetime({offset:true}),candidate_snapshot:z.string().max(30000),project_text:z.string().max(30000)}).strict();
type Decision=z.infer<typeof decisionSchema>;
const candidatePath=(id:string)=>`90_system/project-candidates/${id}.md`;
const confirmationPath=(id:string)=>`90_system/project-confirmations/${id}.json`;
const decisionPath=(id:string)=>`90_system/project-approvals/PAPR-${id.slice(5)}.json`;
const materializedPath=(record:Decision)=>`90_system/project-approvals/materialized/${record.id}.json`;
const materializedSchema=z.object({schema_version:z.literal(1),decision_id:z.string(),decision_hash:digest,project_id:z.string()}).strict();
const normalize=(s:string)=>s.normalize('NFKC').trim().toLocaleLowerCase();
function overlaps(proposal:ProjectProposal, projects:Awaited<ReturnType<typeof readProjects>>):boolean {
  const names=new Set([proposal.title,...proposal.aliases].map(normalize).filter(Boolean));
  return projects.some(p=>[p.id,p.title,...p.aliases].some(s=>names.has(normalize(s))));
}
function parseCandidate(path:string,raw:string){
 if(!isGeneratedIntact(raw))throw new Error('プロジェクト候補の内容が変更されています');
 const candidate=candidateSchema.parse(parseMarkdown(raw).meta);
 if(path!==candidatePath(candidate.id))throw new Error('候補IDとパスが一致しません');return candidate;
}
async function readDecision(vault:Vault,id:string):Promise<Decision|undefined>{
 const raw=await vault.read(decisionPath(id));if(raw===undefined)return undefined;
 const record=decisionSchema.parse(JSON.parse(raw));const snapshot=parseCandidate(candidatePath(id),record.candidate_snapshot);
 const project=projectSchema.parse(parseMarkdown(record.project_text).meta);
 if(record.candidate_id!==id||record.id!==`PAPR-${id.slice(5)}`||record.candidate_hash!==hash(record.candidate_snapshot)||project.id!==snapshot.project_id||project.title!==snapshot.proposal.title||JSON.stringify(project.aliases)!==JSON.stringify(snapshot.proposal.aliases)||JSON.stringify(project.keywords)!==JSON.stringify(snapshot.proposal.keywords))throw new Error('プロジェクト承認記録の根拠が不正です');
 return record;
}
async function materialize(vault:Vault,record:Decision):Promise<void>{
 if(record.action==='reject')return;const project=projectSchema.parse(parseMarkdown(record.project_text).meta), path=`10_projects/${project.id}/project.md`;
 const marker=await vault.read(materializedPath(record));
 if(marker!==undefined){const done=materializedSchema.parse(JSON.parse(marker)),current=await vault.read(path);if(done.decision_id!==record.id||done.decision_hash!==hash(JSON.stringify(record))||done.project_id!==project.id||current===undefined||projectSchema.parse(parseMarkdown(current).meta).id!==project.id)throw new Error('実体化済みの定義または承認記録が不正です');return;}
 if(!await vault.create(path,record.project_text)&&await vault.read(path)!==record.project_text)throw new Error('承認済みプロジェクト定義が競合しています。doctorで確認してください');
 await vault.create(materializedPath(record),JSON.stringify({schema_version:1,decision_id:record.id,decision_hash:hash(JSON.stringify(record)),project_id:project.id})+'\n');
}
export async function saveProjectCandidateLocked(config:HubConfig,vault:Vault,chain:CorrectionChain,receipt:Receipt):Promise<string|undefined>{
 const proposal=receipt.result?.project_proposal;if(!proposal)return undefined;
 const id=`PCAN-${chain.latest.id.slice(3)}`,path=candidatePath(id);
 if(overlaps(proposal,await readProjects(config))&&await vault.read(path)===undefined)return undefined;
 const meta={schema_version:1,id,project_id:`project-${chain.latest.id.slice(3).toLowerCase()}`,root_input_id:chain.root.id,evidence_ids:[chain.root,...chain.revisions].map(i=>i.id),evidence_hash:chain.evidenceHash,proposal,generated_at:receipt.organized_at,generated_by:{model:receipt.llm.model,prompt_version:1},verified:false};
 const raw=generatedMarkdown(meta,`# 新規プロジェクト候補（AI生成・未検証）\n\n名前: ${proposal.title}\n別名: ${proposal.aliases.join('、')||'なし'}\n検索語: ${proposal.keywords.join('、')||'なし'}\n理由: ${proposal.rationale}\n\n根拠:\n${[chain.root,...chain.revisions].map(i=>`- [${i.id}](../../${i.path}) / ${i.source} / ${i.origin} / ${i.occurred_at}`).join('\n')}\n\n定義は人の明示承認後に作成されます。\n`);
 if(!await vault.create(path,raw)&&await vault.read(path)!==raw)throw new Error('プロジェクト候補が競合しています');
 const existing=await vault.read(confirmationPath(id));
 if(existing!==undefined){const confirmation=confirmationSchema.parse(JSON.parse(existing));if(confirmation.candidate_id!==id||confirmation.candidate_hash!==hash(raw))throw new Error('候補の確認情報が一致しません');}
 else if(!await vault.create(confirmationPath(id),JSON.stringify({schema_version:1,candidate_id:id,candidate_hash:hash(raw),confirmation_token:randomBytes(32).toString('hex')})+'\n'))throw new Error('候補確認情報が競合しています');
 return path;
}
export async function listProjectCandidates(config:HubConfig):Promise<ProjectCandidate[]>{
 const vault=new Vault(config),chains=await readCorrectionChains(config),projects=await readProjects(config),items:ProjectCandidate[]=[];
 for(const path of await vault.files('90_system/project-candidates')){
  if(!/^90_system\/project-candidates\/PCAN-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(path))continue;
  const raw=(await vault.read(path))!,meta=parseCandidate(path,raw),confirmationRaw=await vault.read(confirmationPath(meta.id));
  const confirmation=confirmationRaw?confirmationSchema.parse(JSON.parse(confirmationRaw)):undefined;
  if(confirmation&&(confirmation.candidate_id!==meta.id||confirmation.candidate_hash!==hash(raw)))throw new Error('候補と確認情報が一致しません');
  const decision=await readDecision(vault,meta.id),chain=chains.find(c=>c.root.id===meta.root_input_id);
  const stale=!confirmation||!chain||chain.evidenceHash!==meta.evidence_hash||JSON.stringify(meta.evidence_ids)!==JSON.stringify([chain.root,...chain.revisions].map(i=>i.id))||overlaps(meta.proposal,projects);
  items.push({candidateId:meta.id,projectId:meta.project_id,path,rootInputId:meta.root_input_id,evidenceHash:meta.evidence_hash,candidateHash:hash(raw),confirmationToken:confirmation?.confirmation_token??'',proposal:meta.proposal,status:decision?decision.action==='approve'?'approved':'rejected':stale?'stale':'pending'});
 }return items;
}
export async function decideProject(config:HubConfig,request:ProjectDecisionRequest):Promise<ProjectDecisionResult>{
 requestSchema.parse(request);const vault=new Vault(config);
 return vault.withLock(async()=>{
  const previous=await readDecision(vault,request.candidateId);
  if(previous){if(previous.action!==request.action||previous.candidate_hash!==request.expectedHash||previous.confirmation_hash!==hash(request.confirmationToken))throw new Error('この候補には異なる承認・却下記録があります');await materialize(vault,previous);const meta=parseCandidate(candidatePath(request.candidateId),previous.candidate_snapshot);return{candidateId:request.candidateId,projectId:meta.project_id,decisionId:previous.id,deduped:true};}
  const candidate=(await listProjectCandidates(config)).find(c=>c.candidateId===request.candidateId);
  if(!candidate||candidate.status!=='pending')throw new Error('候補が古いか確認情報が不足しています。同期後に最新候補を確認してください');
  if(candidate.candidateHash!==request.expectedHash||candidate.confirmationToken!==request.confirmationToken)throw new Error('表示した候補と承認の確認情報が一致しません');
  const raw=(await vault.read(candidate.path))!;
  if(hash(raw)!==request.expectedHash)throw new Error('候補の内容が変更されました');
  const definition={id:candidate.projectId,title:candidate.proposal.title,aliases:candidate.proposal.aliases,keywords:candidate.proposal.keywords,status:'active'};
  const record=decisionSchema.parse({schema_version:1,id:`PAPR-${candidate.candidateId.slice(5)}`,candidate_id:candidate.candidateId,candidate_hash:candidate.candidateHash,confirmation_hash:hash(request.confirmationToken),action:request.action,source:request.source,source_event_id:request.sourceEventId,decided_at:new Date().toISOString(),candidate_snapshot:raw,project_text:markdown(definition,`# ${definition.title}\n\n利用者がプロジェクト候補を明示承認した定義です。\n\n理由: ${candidate.proposal.rationale}\n候補: [${candidate.candidateId}](../../${candidate.path})\n根拠ID: ${candidate.rootInputId}\n`)});
  if(!await vault.create(decisionPath(candidate.candidateId),JSON.stringify(record,null,2)+'\n'))throw new Error('プロジェクト承認記録が競合しました');
  await materialize(vault,record);return{candidateId:candidate.candidateId,projectId:candidate.projectId,decisionId:record.id,deduped:false};
 });
}
export async function recoverProjectApprovalsLocked(config:HubConfig,vault:Vault,limit:number,dryRun=false):Promise<number>{
 let recovered=0;
 for(const path of await vault.files('90_system/project-approvals')){
  const match=/^90_system\/project-approvals\/PAPR-([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);if(!match)continue;
  const record=(await readDecision(vault,`PCAN-${match[1]}`))!;if(record.action==='reject')continue;
  const project=projectSchema.parse(parseMarkdown(record.project_text).meta),existing=await vault.read(`10_projects/${project.id}/project.md`);
  const marker=await vault.read(materializedPath(record));
  if(marker!==undefined){const done=materializedSchema.parse(JSON.parse(marker));if(done.decision_id!==record.id||done.decision_hash!==hash(JSON.stringify(record))||done.project_id!==project.id||existing===undefined||projectSchema.parse(parseMarkdown(existing).meta).id!==project.id)throw new Error('実体化済みの定義または承認記録が不正です');continue;}
  if(existing!==undefined&&existing!==record.project_text)throw new Error('承認済みプロジェクト定義が競合しています');
  if(recovered>=limit)break;if(!dryRun)await materialize(vault,record);recovered++;
 }return recovered;
}
