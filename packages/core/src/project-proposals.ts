import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { Vault, hash, markdown, parseMarkdown } from './storage.js';
import { generatedMarkdown, isGeneratedIntact } from './views.js';
import { readCorrectionChains, type CorrectionChain } from './corrections.js';
import { readProjects, projectSchema, overlappingProject } from './projects.js';
import { inputIdSchema } from './capture.js';
import { projectProposalSchema } from './llm.js';
import { PROPOSAL_GROUP_MAX, groupProposals, relatedProposals } from './project-proposal-groups.js';
import type { HubConfig, ProjectProposal, Receipt } from './types.js';

export interface ProjectCandidate {
 candidateId:string; projectId:string; path:string; rootInputId:string; evidenceHash:string; candidateHash:string; confirmationToken:string; proposal:ProjectProposal; status:'pending'|'approved'|'rejected'|'stale'; generatedAt:string;
 /** 同じ対象を指す確認待ちの案をまとめたとき、まとめられた側の案に付く代表の案のID。 */
 duplicateOf?:string;
 /** 代表の案に付く、まとめた案のID（古い順）。判断済みの案では、同じ判断としてまとめた案のID。 */
 duplicates?:string[];
 /** 代表の案とまとめて判断された案に付く、代表の案のID。 */
 coveredBy?:string;
}
/** coversは、同じ対象の案として同じ判断にまとめる確認待ちの案。本人が表示で確認した内容のハッシュを添える。 */
export interface ProjectDecisionRequest { candidateId:string; expectedHash:string; confirmationToken:string; action:'approve'|'reject'; source:string; sourceEventId:string; confirmed:true; covers?:{candidateId:string;expectedHash:string}[] }
/** 1回の判断でまとめられる案の上限。一覧が1組にまとめる案の上限と同じ。 */
export const PROJECT_COVERS_MAX=PROPOSAL_GROUP_MAX;
export interface ProjectDecisionResult { candidateId:string; projectId:string; decisionId:string; deduped:boolean }
const candidateId = z.string().regex(/^PCAN-[0-9A-HJKMNP-TV-Z]{26}$/), digest=z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema=z.object({ schema_version:z.literal(1),id:candidateId,project_id:z.string().regex(/^project-[0-9a-hjkmnp-tv-z]{26}$/),root_input_id:inputIdSchema,evidence_ids:z.array(inputIdSchema).min(1).max(33),evidence_hash:digest,proposal:projectProposalSchema,generated_at:z.string().datetime({offset:true}),generated_by:z.object({model:z.string(),prompt_version:z.literal(1)}).strict(),verified:z.literal(false),generated_hash:z.string() }).strict();
const confirmationSchema=z.object({schema_version:z.literal(1),candidate_id:candidateId,candidate_hash:digest,confirmation_token:digest}).strict();
const requestSchema=z.object({candidateId,expectedHash:digest,confirmationToken:digest,action:z.enum(['approve','reject']),source:z.string().min(1).max(200),sourceEventId:z.string().min(1).max(1000),confirmed:z.literal(true),covers:z.array(z.object({candidateId,expectedHash:digest}).strict()).max(PROJECT_COVERS_MAX).optional()}).strict();
const decisionSchema=z.object({schema_version:z.literal(1),id:z.string().regex(/^PAPR-[0-9A-HJKMNP-TV-Z]{26}$/),candidate_id:candidateId,candidate_hash:digest,confirmation_hash:digest,action:z.enum(['approve','reject']),source:z.string().min(1).max(200),source_event_id:z.string().min(1).max(1000),decided_at:z.string().datetime({offset:true}),candidate_snapshot:z.string().max(30000),project_text:z.string().max(30000),
 // 代表の案と同じ判断としてまとめた案。この欄のない記録（まとめる前の版の記録を含む）は、その案だけの判断。
 covers:z.array(z.object({candidate_id:candidateId,candidate_hash:digest}).strict()).min(1).max(PROJECT_COVERS_MAX).optional()}).strict();
type Decision=z.infer<typeof decisionSchema>;
const candidatePath=(id:string)=>`90_system/project-candidates/${id}.md`;
const confirmationPath=(id:string)=>`90_system/project-confirmations/${id}.json`;
const decisionPath=(id:string)=>`90_system/project-approvals/PAPR-${id.slice(5)}.json`;
const materializedPath=(record:Decision)=>`90_system/project-approvals/materialized/${record.id}.json`;
const materializedSchema=z.object({schema_version:z.literal(1),decision_id:z.string(),decision_hash:digest,project_id:z.string()}).strict();
function overlaps(proposal:ProjectProposal, projects:Awaited<ReturnType<typeof readProjects>>):boolean {
  return overlappingProject(proposal,projects)!==undefined;
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
 const covered=(record.covers??[]).map(c=>c.candidate_id);
 if(covered.includes(id)||new Set(covered).size!==covered.length)throw new Error('プロジェクト承認記録のまとめた案が不正です');
 return record;
}
async function materialize(vault:Vault,record:Decision):Promise<void>{
 if(record.action==='reject')return;const project=projectSchema.parse(parseMarkdown(record.project_text).meta), path=`10_projects/${project.id}/project.md`;
 const marker=await vault.read(materializedPath(record));
 if(marker!==undefined){const done=materializedSchema.parse(JSON.parse(marker)),current=await vault.read(path);if(done.decision_id!==record.id||done.decision_hash!==hash(JSON.stringify(record))||done.project_id!==project.id||current===undefined||projectSchema.parse(parseMarkdown(current).meta).id!==project.id)throw new Error('実体化済みの定義または承認記録が不正です');await rebuildPolicies(vault);return;}
 if(!await vault.create(path,record.project_text)&&await vault.read(path)!==record.project_text)throw new Error('承認済みプロジェクト定義が競合しています。doctorで確認してください');
 await vault.create(materializedPath(record),JSON.stringify({schema_version:1,decision_id:record.id,decision_hash:hash(JSON.stringify(record)),project_id:project.id})+'\n');
 await rebuildPolicies(vault);
}
// project.mdは方針manifestの正本に含まれる。addProjectと同じく集約し、後続のreadPoliciesを不一致にしない。
// 実体化済みの再送でも行い、記録作成直後に停止した場合の未集約を回復する。
async function rebuildPolicies(vault:Vault):Promise<void>{const {rebuildPoliciesLocked}=await import('./policies.js');await rebuildPoliciesLocked(vault.config,vault);}
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
/** 代表の案とまとめて判断された案の、判断の内容。 */
export interface ProjectCoverage { by:string; decisionId:string; action:'approve'|'reject'; candidateHash:string }
export interface ProjectCoverageIndex {
 /** 代表の案とまとめて判断された案（キーはまとめられた案のID）。 */
 covered:Map<string,ProjectCoverage>;
 /** 読めない判断記録があるか。その記録がどの案をまとめて判断したかは確かめられない。 */
 unreadable:boolean;
}
/** 読めない判断記録があるときに、判断前の案へ付ける注意。 */
export const UNREADABLE_DECISION_WARNING='読めない判断記録があるため、判断済みの案かどうかを確認できません。Macでdoctorを実行して確認してください。';
/**
 * 判断記録から、代表の案とまとめて判断された案を集める。
 * 読めない判断記録があれば、その記録の案だけでなく、まとめて判断済みかもしれない案も確認待ちへ戻さない（unreadable）。
 */
export async function readProjectCoverage(vault:Vault):Promise<ProjectCoverageIndex>{
 const covered=new Map<string,ProjectCoverage>();let unreadable=false;
 for(const path of await vault.files('90_system/project-approvals')){
  const match=/^90_system\/project-approvals\/PAPR-([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);if(!match)continue;
  let record:Decision|undefined;try{record=await readDecision(vault,`PCAN-${match[1]}`);}catch{unreadable=true;continue;}
  for(const c of record?.covers??[])if(!covered.has(c.candidate_id))covered.set(c.candidate_id,{by:record!.candidate_id,decisionId:record!.id,action:record!.action,candidateHash:c.candidate_hash});
 }
 return{covered,unreadable};
}
/** 確認待ちの案のうち同じ対象を指すものをまとめ、代表の案（duplicates）とまとめられた案（duplicateOf）に印を付ける。 */
export function markProposalGroups(items:ProjectCandidate[]):ProjectCandidate[]{
 const byId=new Map(items.map(c=>[c.candidateId,c]));
 for(const group of groupProposals(items.filter(c=>c.status==='pending').map(c=>({id:c.candidateId,proposal:c.proposal,generatedAt:c.generatedAt})))){
  if(!group.duplicates.length)continue;
  byId.get(group.representative.id)!.duplicates=group.duplicates.map(d=>d.id);
  for(const d of group.duplicates)byId.get(d.id)!.duplicateOf=group.representative.id;
 }
 return items;
}
export async function listProjectCandidates(config:HubConfig):Promise<ProjectCandidate[]>{
 const vault=new Vault(config),items:ProjectCandidate[]=[],coverage=await readProjectCoverage(vault);
 for(const path of await vault.files('90_system/project-candidates')){
  if(!/^90_system\/project-candidates\/PCAN-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(path))continue;
  items.push(await readProjectCandidate(config,path.split('/').at(-1)!.slice(0,-3),coverage));
 }return markProposalGroups(items);
}
/** coverageは、まとめて判断された案の一覧。何件も続けて読むときは、readProjectCoverageの結果を渡して判断記録の読み直しを避ける。 */
export async function readProjectCandidate(config:HubConfig,id:string,coverage?:ProjectCoverageIndex):Promise<ProjectCandidate>{
 candidateId.parse(id);const vault=new Vault(config),chains=await readCorrectionChains(config),projects=await readProjects(config),path=candidatePath(id);
  const raw=(await vault.read(path))!,meta=parseCandidate(path,raw),confirmationRaw=await vault.read(confirmationPath(meta.id));
  const confirmation=confirmationRaw?confirmationSchema.parse(JSON.parse(confirmationRaw)):undefined;
  if(confirmation&&(confirmation.candidate_id!==meta.id||confirmation.candidate_hash!==hash(raw)))throw new Error('候補と確認情報が一致しません');
  const decision=await readDecision(vault,meta.id),chain=chains.find(c=>c.root.id===meta.root_input_id);
  // 自分の判断記録がなくても、代表の案とまとめて判断されていれば、その判断を自分の状態にする。
  const index=decision?undefined:coverage??await readProjectCoverage(vault),covered=index?.covered.get(meta.id);
  // 読めない判断記録がある間は、まとめて判断済みの案かもしれないので、確認待ちには戻さない。
  const stale=!confirmation||!chain||chain.evidenceHash!==meta.evidence_hash||JSON.stringify(meta.evidence_ids)!==JSON.stringify([chain.root,...chain.revisions].map(i=>i.id))||overlaps(meta.proposal,projects)||index?.unreadable===true;
  return{candidateId:meta.id,projectId:meta.project_id,path,rootInputId:meta.root_input_id,evidenceHash:meta.evidence_hash,candidateHash:hash(raw),confirmationToken:confirmation?.confirmation_token??'',proposal:meta.proposal,generatedAt:meta.generated_at,status:decision?decision.action==='approve'?'approved':'rejected':covered?covered.action==='approve'?'approved':'rejected':stale?'stale':'pending',...(covered?{coveredBy:covered.by}:{}),...(decision?.covers?{duplicates:decision.covers.map(c=>c.candidate_id)}:{})};
}
export {readDecision as readProjectDecision};
export async function decideProject(config:HubConfig,request:ProjectDecisionRequest):Promise<ProjectDecisionResult>{
 requestSchema.parse(request);const vault=new Vault(config);
 const covers=(request.covers??[]).map(c=>({candidate_id:c.candidateId,candidate_hash:c.expectedHash}));
 if(covers.some(c=>c.candidate_id===request.candidateId)||new Set(covers.map(c=>c.candidate_id)).size!==covers.length)throw new Error('まとめて判断する案の指定が重複しています');
 return vault.withLock(async()=>{
  const previous=await readDecision(vault,request.candidateId);
  // まとめる案は、並びが違っても同じ組み合わせなら同じ判断として扱う。
  const sameCovers=(recorded:typeof covers)=>recorded.length===covers.length&&recorded.every(r=>covers.some(c=>c.candidate_id===r.candidate_id&&c.candidate_hash===r.candidate_hash));
  if(previous){if(previous.action!==request.action||previous.candidate_hash!==request.expectedHash||previous.confirmation_hash!==hash(request.confirmationToken)||!sameCovers(previous.covers??[]))throw new Error('この候補には異なる承認・却下記録があります');await materialize(vault,previous);const meta=parseCandidate(candidatePath(request.candidateId),previous.candidate_snapshot);return{candidateId:request.candidateId,projectId:meta.project_id,decisionId:previous.id,deduped:true};}
  const coverage=await readProjectCoverage(vault);
  // 読めない判断記録がある間は、この案がまとめて判断済みかどうかを確かめられない。
  if(coverage.unreadable)throw new Error('読めない判断記録があるため、プロジェクト案の判断を受け付けられません。doctorで確認してください');
  const candidate=await readProjectCandidate(config,request.candidateId,coverage);
  if(!candidate||candidate.status!=='pending')throw new Error('候補が古いか確認情報が不足しています。同期後に最新候補を確認してください');
  if(candidate.candidateHash!==request.expectedHash||candidate.confirmationToken!==request.confirmationToken)throw new Error('表示した候補と承認の確認情報が一致しません');
  const raw=(await vault.read(candidate.path))!;
  if(hash(raw)!==request.expectedHash)throw new Error('候補の内容が変更されました');
  // まとめられるのは、いまも確認待ちで、この案と同じ対象を指し、本人が確認したときから内容が変わっていない案だけ。
  // 添えられた案だけを読む。ほかの候補が読めなくても、この判断を止めない。
  for(const c of covers){
   let other:ProjectCandidate|undefined;try{other=await readProjectCandidate(config,c.candidate_id,coverage);}catch{/* 読めない案はまとめられない。 */}
   if(other?.status!=='pending'||other.candidateHash!==c.candidate_hash||!relatedProposals(candidate.proposal,other.proposal))throw new Error('まとめて判断する案が古いか、同じ対象の案ではありません。同期後に最新の一覧を確認してください');
  }
  const definition={id:candidate.projectId,title:candidate.proposal.title,aliases:candidate.proposal.aliases,keywords:candidate.proposal.keywords,status:'active'};
  const record=decisionSchema.parse({schema_version:1,id:`PAPR-${candidate.candidateId.slice(5)}`,candidate_id:candidate.candidateId,candidate_hash:candidate.candidateHash,confirmation_hash:hash(request.confirmationToken),action:request.action,source:request.source,source_event_id:request.sourceEventId,decided_at:new Date().toISOString(),candidate_snapshot:raw,...(covers.length?{covers}:{}),project_text:markdown(definition,`# ${definition.title}\n\n利用者がプロジェクト候補を明示承認した定義です。\n\n理由: ${candidate.proposal.rationale}\n候補: [${candidate.candidateId}](../../${candidate.path})\n根拠ID: ${candidate.rootInputId}\n`)});
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
