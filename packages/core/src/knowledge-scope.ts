import {z} from 'zod';
import {Vault,hash,parseMarkdown} from './storage.js';
import {projectIdSchema,projectSchema} from './projects.js';
export const knowledgeIdSchema=z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/);
export const adoptionTargetSchema=z.discriminatedUnion('scope',[
 z.object({scope:z.literal('global')}).strict(),
 z.object({scope:z.literal('project'),projectId:projectIdSchema,projectHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export type AdoptionTarget=z.infer<typeof adoptionTargetSchema>;
export interface KnowledgeRecord{id:string;path:string;raw:string;meta:Record<string,unknown>;text:string;target?:AdoptionTarget}
export function knowledgePath(id:string,target?:AdoptionTarget):string{
 knowledgeIdSchema.parse(id);if(target)adoptionTargetSchema.parse(target);
 return target?.scope==='project'?`10_projects/${target.projectId}/knowledge/${id}.md`:`30_knowledge/${id}.md`;
}
export async function knowledgePaths(vault:Vault):Promise<string[]>{return[...await vault.files('30_knowledge'),...await vault.files('10_projects')].filter(p=>/^30_knowledge\/KNW-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(p)||/^10_projects\/[a-z0-9][a-z0-9-]{1,40}\/knowledge\/KNW-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(p)).sort();}
export function targetFromMeta(meta:Record<string,unknown>):AdoptionTarget|undefined{
 if(meta.scope===undefined)return;
 return adoptionTargetSchema.parse(meta.scope==='project'?{scope:meta.scope,projectId:meta.project_id,projectHash:meta.project_hash}:{scope:meta.scope});
}
export async function readKnowledge(vault:Vault,id:string):Promise<KnowledgeRecord|undefined>{
 knowledgeIdSchema.parse(id);const paths=(await knowledgePaths(vault)).filter(p=>p.endsWith(`/${id}.md`));
 if(paths.length>1)throw new Error('知識IDの保存先が重複しています');if(!paths.length)return;
 const path=paths[0]!,bytes=await vault.readBytes(path,1_048_576);if(bytes===undefined)throw new Error('知識の同期が不足しています');
 const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),{meta,text}=parseMarkdown(raw),target=targetFromMeta(meta);
 if(meta.id!==id||knowledgePath(id,target)!==path)throw new Error('知識ID・採用先と保存先が一致しません');
 return{id,path,raw,meta,text,...(target?{target}:{})};
}
export function sameScope(a:AdoptionTarget|undefined,b:AdoptionTarget|undefined):boolean{return a?.scope===b?.scope&&(a?.scope!=='project'||(b?.scope==='project'&&a.projectId===b.projectId));}
export async function validateAdoptionTarget(vault:Vault,target:AdoptionTarget):Promise<AdoptionTarget>{
 const t=adoptionTargetSchema.parse(target);if(t.scope==='global')return t;
 const bytes=await vault.readBytes(`10_projects/${t.projectId}/project.md`,1_048_576);if(!bytes)throw new Error('採用先プロジェクトが見つかりません');
 const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),project=projectSchema.parse(parseMarkdown(raw).meta);
 if(project.id!==t.projectId||hash(raw)!==t.projectHash)throw new Error('採用先プロジェクトが変更されています。再確認してください');return t;
}
export interface ReviewProject{id:string;title:string;path:string;hash:string}
export async function readProjectCatalog(vault:Vault):Promise<ReviewProject[]>{
 const result:ReviewProject[]=[];for(const path of await vault.files('10_projects')){
  if(!/^10_projects\/[^/]+\/project\.md$/.test(path))continue;const bytes=await vault.readBytes(path,1_048_576);if(!bytes)throw new Error('プロジェクト定義が未同期です');const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),p=projectSchema.parse(parseMarkdown(raw).meta);
  if(path!==`10_projects/${p.id}/project.md`)throw new Error('プロジェクトIDと保存先が一致しません');result.push({id:p.id,title:p.title,path,hash:hash(raw)});
 }return result.sort((a,b)=>a.id.localeCompare(b.id));
}
