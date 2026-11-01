import {readRetirement,retirementPath} from './knowledge-retirement.js';
import {adoptionTargetSchema,knowledgePath,readKnowledge,readProjectCatalog} from './knowledge-scope.js';
import {z} from 'zod';
import {Vault,hash,parseMarkdown} from './storage.js';
import {isGeneratedIntact,receiptSchema} from './views.js';
import {readCorrectionChains} from './corrections.js';
import type {HubConfig} from './types.js';
import type {ReviewCandidate} from './candidate-review.js';

export const knowledgeCandidateSchema=z.object({id:z.string().regex(/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/),claim:z.string().min(1).max(1000),kind:z.enum(['knowledge','decision','preference']),rationale:z.string().max(1000),input_ids:z.array(z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/)).max(33),supersedes:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/).optional()});
export const knowledgeDecisionSchema=z.object({schema_version:z.literal(1),id:z.string().regex(/^APR-[0-9A-HJKMNP-TV-Z]{26}$/),candidate_id:z.string().regex(/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/),candidate_hash:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['approve','reject']),actor:z.literal('user'),decided_at:z.string().datetime({offset:true}),snapshot:z.string().max(1_048_576),target:adoptionTargetSchema.optional()}).strict();
export type KnowledgeDecision=z.infer<typeof knowledgeDecisionSchema>;
export async function reviewRead(vault:Vault,path:string):Promise<string|undefined>{
 const bytes=await vault.readBytes(path,1_048_576);
 return bytes===undefined?undefined:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
export async function readKnowledgeDecision(vault:Vault,id:string):Promise<KnowledgeDecision|undefined>{
 const raw=await reviewRead(vault,`90_system/approvals/APR-${id.slice(4)}.json`);if(raw===undefined)return;
 const d=knowledgeDecisionSchema.parse(JSON.parse(raw)),meta=knowledgeCandidateSchema.parse(parseMarkdown(d.snapshot).meta);
 if(d.candidate_id!==id||d.id!==`APR-${id.slice(4)}`||hash(d.snapshot)!==d.candidate_hash||meta.id!==id)throw new Error('承認記録が不正です');
 return d;
}
export function unavailableCandidate(id:string,path:string):ReviewCandidate{
 return{id,path,kind:'unknown',title:'候補の確認が必要です',claim:'',rationale:'',inputIds:[],candidateHash:'',status:'unavailable',warnings:['候補・承認記録の形式や同期状態を確認してください。'],reflected:false,retired:false,projectSuggestions:[],dependencies:{}};
}
export async function readKnowledgeCandidate(config:HubConfig,id:string):Promise<ReviewCandidate>{
 if(!/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/.test(id))throw new Error('候補IDが不正です');
 const vault=new Vault(config),path=`90_system/candidates/${id}.md`,item=unavailableCandidate(id,path);
 const depend=async(p:string)=>{const raw=await reviewRead(vault,p);item.dependencies[p]=raw===undefined?null:hash(raw);return raw;};
 try{
  const current=await depend(path),decisionPath=`90_system/approvals/APR-${id.slice(4)}.json`;
  await depend(decisionPath);const decision=await readKnowledgeDecision(vault,id);
  const raw=decision?.snapshot??current;if(raw===undefined)throw new Error('候補がありません');
  const parsed=parseMarkdown(raw),m=knowledgeCandidateSchema.parse(parsed.meta);
  if(m.id!==id||!isGeneratedIntact(raw))throw new Error('候補の整合性を確認できません');
  const generatedAt=z.string().datetime({offset:true}).optional().parse(parsed.meta.generated_at);
  Object.assign(item,{kind:m.kind,title:m.claim.slice(0,100),claim:m.claim,rationale:m.rationale,inputIds:m.input_ids,candidateHash:hash(raw),status:decision?(decision.action==='approve'?'approved':'rejected'):'pending',warnings:[],...(generatedAt?{generatedAt}:{}),...(m.supersedes?{supersedes:m.supersedes}:{})});
  if(decision){
   item.decisionId=decision.id;
   if(current===undefined||hash(current)!==decision.candidate_hash)item.warnings.push('元候補が変更・欠損しています。承認時点の内容を表示しています。');
   if(decision.action==='approve'){
    item.targetPath=knowledgePath(`KNW-${id.slice(4)}`,decision.target);
    if(decision.target)item.adoptedTarget=decision.target;
    await readKnowledge(vault,`KNW-${id.slice(4)}`);
    await depend(retirementPath(`KNW-${id.slice(4)}`));
    const stopped=await readRetirement(vault,`KNW-${id.slice(4)}`);item.retired=!!stopped;if(stopped)item.retiredAt=stopped.retired_at;
    const target=await depend(item.targetPath);
    if(target!==undefined&&isGeneratedIntact(target)){
     const t=parseMarkdown(target).meta;
     item.reflected=t.id===`KNW-${id.slice(4)}`&&t.approval_id===decision.id&&t.approved_hash===decision.candidate_hash&&t.approved_candidate===id;
    }
    if(!item.reflected)item.warnings.push('承認記録はありますが、知識への反映を確認できません。');
   }else item.reflected=true;
  }else{const existing=await readKnowledge(vault,`KNW-${id.slice(4)}`);
    await depend(retirementPath(`KNW-${id.slice(4)}`));
    const stopped=await readRetirement(vault,`KNW-${id.slice(4)}`);item.retired=!!stopped;if(stopped)item.retiredAt=stopped.retired_at;if(existing)await depend(existing.path);await depend(`30_knowledge/KNW-${id.slice(4)}.md`);}
  const issue=(status:'stale'|'unavailable',message:string)=>{item.warnings.push(message);if(!decision)item.status=status;};
  if(m.supersedes){
   let replacementLinked=false;
   const record=await readKnowledge(vault,m.supersedes);
   const previous=record?await depend(record.path):undefined;
   if(!previous||!isGeneratedIntact(previous))issue('unavailable','置き換え元の知識を確認できません。');
   else{
    const p=parseMarkdown(previous).meta;
    replacementLinked=p.id===m.supersedes&&p.verified===true&&p.superseded_by===`KNW-${id.slice(4)}`;
    if(p.id!==m.supersedes||p.verified!==true)issue('unavailable','置き換え元の承認状態を確認できません。');
    if(p.superseded_by&&p.superseded_by!==`KNW-${id.slice(4)}`)issue('stale','置き換え元には別の後継があります。');
   }
   if(decision?.action==='approve'&&!replacementLinked){item.reflected=false;item.warnings.push('置き換え元への後継登録が未完了です。Miniの回復処理を待ってください。');}
  }
  if(m.input_ids.length){
   try{
    const chains=await readCorrectionChains(config),chain=chains.find(c=>c.root.id===m.input_ids[0]);
    if(!chain){issue('unavailable','根拠の原文または訂正が未同期です。');return item;}
    for(const input of [chain.root,...chain.revisions])await depend(input.path);
    const ids=[chain.root,...chain.revisions].map(i=>i.id);
    if(JSON.stringify(ids)!==JSON.stringify(m.input_ids)){issue('stale','根拠に新しい訂正があります。最新の候補を確認してください。');return item;}
    const receiptRaw=await depend(`90_system/receipts/${chain.latest.id}.json`);
    if(receiptRaw===undefined){issue('unavailable','整理記録が未同期です。');return item;}
    const receipt=receiptSchema.parse(JSON.parse(receiptRaw));
    if(!decision){
     const catalog=await readProjectCatalog(vault),explicit=catalog.find(p=>p.id===chain.root.project);
     const suggestions=explicit?[{projectId:explicit.id,title:explicit.title,source:'explicit' as const}]:(receipt.result?.project_candidates??[]).flatMap(c=>{const p=catalog.find(p=>p.id===c.id);return p?[{projectId:p.id,title:p.title,source:'inferred' as const,confidence:c.confidence}]:[];});
     item.projectSuggestions=suggestions;
     for(const suggestion of suggestions)await depend(catalog.find(p=>p.id===suggestion.projectId)!.path);
     if(suggestions.length===1){const p=catalog.find(p=>p.id===suggestions[0]!.projectId)!;item.suggestedTarget={scope:'project',projectId:p.id,projectHash:p.hash};}
    }
    const claim=receipt.result?.knowledge_candidate;
    const latestRaw=await reviewRead(vault,chain.latest.path);
    if(receipt.input_id!==chain.latest.id||receipt.status!=='organized'||latestRaw===undefined||receipt.input_hash!==hash(latestRaw)||!claim||claim.kind!==m.kind||claim.claim!==m.claim||claim.rationale!==m.rationale||receipt.organized_at!==parsed.meta.generated_at||(chain.revisions.length>0&&(receipt.evidence_hash!==chain.evidenceHash||JSON.stringify(receipt.evidence_ids)!==JSON.stringify(ids)))||(parsed.meta.evidence_hash!==undefined&&parsed.meta.evidence_hash!==chain.evidenceHash)){
     issue('unavailable','候補と根拠の整理記録が一致しません。');
    }
   }catch{issue('unavailable','根拠の原文・訂正・整理記録を確認できません。');}
  }else if(parsed.meta.source!=='human-proposal')issue('unavailable','候補の出典と原文を確認できません。');
  if(!decision&&await readKnowledge(vault,`KNW-${id.slice(4)}`))issue('unavailable','承認記録のない反映先が存在します。');
  return item;
 }catch{item.status='unavailable';item.reflected=false;item.warnings.push('候補・承認記録の形式や同期状態を確認してください。');return item;}
}
