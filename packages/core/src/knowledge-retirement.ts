import {z} from 'zod';
import {Vault,hash,parseMarkdown} from './storage.js';
import {isGeneratedIntact} from './views.js';
import {readKnowledge,knowledgeIdSchema} from './knowledge-scope.js';
import {readKnowledgeDecision,reviewRead} from './knowledge-candidates.js';
import type {HubConfig} from './types.js';
export const retirementSchema=z.object({schema_version:z.literal(1),id:z.string().regex(/^KRET-[0-9A-HJKMNP-TV-Z]{26}$/),knowledge_id:knowledgeIdSchema,knowledge_hash:z.string().regex(/^[a-f0-9]{64}$/),snapshot:z.string().max(1_048_576),actor:z.literal('user'),retired_at:z.string().datetime({offset:true})}).strict();
export const retirementPath=(id:string)=>`90_system/knowledge-retirements/KRET-${knowledgeIdSchema.parse(id).slice(4)}.json`;
export async function readRetirement(vault:Vault,id:string){
 const raw=await reviewRead(vault,retirementPath(id));if(raw===undefined)return;
 const r=retirementSchema.parse(JSON.parse(raw)),meta=parseMarkdown(r.snapshot).meta;
 if(r.id!==`KRET-${id.slice(4)}`||r.knowledge_id!==id||hash(r.snapshot)!==r.knowledge_hash||meta.id!==id||meta.verified!==true||!isGeneratedIntact(r.snapshot))throw new Error('適用停止記録が不正です');
 const d=await readKnowledgeDecision(vault,`CAN-${id.slice(4)}`);if(!d||d.action!=='approve'||meta.approval_id!==d.id||meta.approved_hash!==d.candidate_hash)throw new Error('適用停止の採用記録が一致しません');return r;
}
export async function retireKnowledge(config:HubConfig,id:string,expectedHash:string):Promise<{knowledgeId:string;retirementId:string;deduped:boolean}>{
 knowledgeIdSchema.parse(id);if(!/^[a-f0-9]{64}$/.test(expectedHash))throw new Error('知識のSHA-256ハッシュが必要です');
 const vault=new Vault(config);return vault.withLock(async()=>{
  let record=await readRetirement(vault,id);const deduped=record!==undefined;
  if(record&&record.knowledge_hash!==expectedHash)throw new Error('この知識には異なる適用停止が記録済みです');
  if(!record){const k=await readKnowledge(vault,id);if(!k||hash(k.raw)!==expectedHash||!isGeneratedIntact(k.raw))throw new Error('停止対象の知識が変更・欠損しています');
   const d=await readKnowledgeDecision(vault,`CAN-${id.slice(4)}`);if(!d||d.action!=='approve'||k.meta.approval_id!==d.id||k.meta.approved_hash!==d.candidate_hash)throw new Error('停止対象の採用記録が不正です');
   record={schema_version:1,id:`KRET-${id.slice(4)}`,knowledge_id:id,knowledge_hash:expectedHash,snapshot:k.raw,actor:'user',retired_at:new Date().toISOString()};
   if(!await vault.create(retirementPath(id),JSON.stringify(record,null,2)+'\n'))throw new Error('適用停止記録が競合しました');
  }
  const {rebuildPoliciesLocked}=await import('./policies.js');await rebuildPoliciesLocked(config,vault);
  return{knowledgeId:id,retirementId:record.id,deduped};
 });
}
