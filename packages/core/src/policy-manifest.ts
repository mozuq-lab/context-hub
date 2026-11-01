import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {Vault,hash,parseMarkdown} from './storage.js';
import {knowledgePaths,readKnowledge,sameScope} from './knowledge-scope.js';
import {readKnowledgeDecision,knowledgeCandidateSchema,reviewRead} from './knowledge-candidates.js';
import {readRetirement,retirementPath} from './knowledge-retirement.js';
import {isGeneratedIntact} from './views.js';
import {projectSchema} from './projects.js';
export interface PolicyEntry{id:string;kind:'decision'|'preference';claim:string;path:string;approvalId:string}
export interface PolicyState{global:PolicyEntry[];projects:Record<string,PolicyEntry[]>;inactiveIds:string[];dependencies:Record<string,string>;inventory:string[]}
export const POLICY_LIMIT=32*1024;
export async function policyInventory(vault:Vault):Promise<string[]>{
 const all=[...await vault.files('30_knowledge'),...await vault.files('10_projects'),...await vault.files('90_system/approvals'),...await vault.files('90_system/knowledge-retirements')];
 return all.filter(p=>p.endsWith('.md')&&(p.startsWith('30_knowledge/')||p.includes('/knowledge/')||p.endsWith('/project.md'))||p.endsWith('.json')&&(p.startsWith('90_system/approvals/')||p.startsWith('90_system/knowledge-retirements/'))).sort();
}
export function policyDocument(entries:PolicyEntry[],scope:string):string{
 return `# ${scope}の有効な方針\n\n本人が採用したdecision/preferenceのみ。端末に揃った同期版です。正本は各知識と承認記録です。\n\n${entries.map(e=>`## ${e.id} (${e.kind})\n\n${e.claim}\n\n正本: ${e.path}\n承認: ${e.approvalId}\n`).join('\n')||'有効な方針はありません。\n'}`;
}
export function assertPolicySize(state:Pick<PolicyState,'global'|'projects'>):void{
 const g=Buffer.byteLength(policyDocument(state.global,'共通'));if(g>POLICY_LIMIT)throw new Error('共通方針が32KiB上限を超えます。適用停止・置換で整理してください');
 for(const[id,entries]of Object.entries(state.projects)){const size=Buffer.byteLength(policyDocument(entries,`プロジェクト ${id}`));if(size>POLICY_LIMIT||size+g>2*POLICY_LIMIT)throw new Error('プロジェクト方針が容量上限を超えます。適用停止・置換で整理してください');}
}
export async function collectPolicyState(vault:Vault):Promise<PolicyState>{
 const inventory=await policyInventory(vault),dependencies:Record<string,string>={},raws=new Map<string,string>();
 for(const path of inventory){const raw=await reviewRead(vault,path);if(raw===undefined)throw new Error('方針の正本が未同期です');dependencies[path]=hash(raw);raws.set(path,raw);}
 const state:PolicyState={global:[],projects:{},inactiveIds:[],dependencies,inventory};
 const paths=await knowledgePaths(vault),known=new Set(paths);
 for(const path of inventory){
  if(path.endsWith('/project.md')){const p=projectSchema.parse(parseMarkdown(raws.get(path)!).meta);if(path!==`10_projects/${p.id}/project.md`)throw new Error('方針のプロジェクト定義が不正です');state.projects[p.id]=[];}
  else if(path.endsWith('.md')&&!known.has(path))throw new Error('知識の保存先が不正です');
 }
 const records=new Map<string,NonNullable<Awaited<ReturnType<typeof readKnowledge>>>>();
 for(const path of paths){const id=path.split('/').at(-1)!.slice(0,-3),k=await readKnowledge(vault,id);if(!k||k.raw!==raws.get(path)||!isGeneratedIntact(k.raw))throw new Error('知識の整合性を確認できません');records.set(id,k);}
 const approved=new Set<string>();
 for(const path of inventory.filter(p=>p.startsWith('90_system/approvals/'))){
  const match=/^90_system\/approvals\/APR-([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);if(!match)throw new Error('承認記録の保存先が不正です');
  const d=await readKnowledgeDecision(vault,`CAN-${match[1]}`);if(!d||!isDeepStrictEqual(JSON.parse(raws.get(path)!),d))throw new Error('承認記録が取得中に変わりました');if(d.action!=='approve')continue;
  const id=`KNW-${match[1]}`,k=records.get(id),m=knowledgeCandidateSchema.parse(parseMarkdown(d.snapshot).meta);
  if(!k||k.meta.verified!==true||k.meta.approval_id!==d.id||k.meta.approved_candidate!==d.candidate_id||k.meta.approved_hash!==d.candidate_hash||k.meta.kind!==m.kind||!isDeepStrictEqual(k.meta.input_ids,m.input_ids)||!isDeepStrictEqual(k.target,d.target)||k.meta.supersedes!==m.supersedes)throw new Error('知識と採用記録の反映が未完了です');
  // claimは不変の承認snapshotから取得し、表示本文の命令を追加採用しない。
  approved.add(id);const stopped=await readRetirement(vault,id);
  if(stopped&&!inventory.includes(retirementPath(id)))throw new Error('停止記録が取得中に追加されました');
  if(k.meta.superseded_by){const next=records.get(String(k.meta.superseded_by));if(!next||next.meta.supersedes!==id||!sameScope(k.target,next.target))throw new Error('方針の置換反映が未完了です');}
  if(k.meta.supersedes){const old=records.get(String(k.meta.supersedes));if(!old||old.meta.superseded_by!==id||!sameScope(k.target,old.target))throw new Error('方針の後継登録が未完了です');}
  if(stopped||k.meta.superseded_by||!k.target){state.inactiveIds.push(id);continue;}
  if(m.kind==='knowledge')continue;
  const entry:PolicyEntry={id,kind:m.kind,claim:m.claim,path:k.path,approvalId:d.id};
  if(k.target.scope==='global')state.global.push(entry);else{if(!state.projects[k.target.projectId])throw new Error('方針の採用先プロジェクトが未同期です');state.projects[k.target.projectId]!.push(entry);}
 }
 for(const id of records.keys())if(!approved.has(id))throw new Error('承認記録のない知識が存在します');
 for(const path of inventory.filter(p=>p.startsWith('90_system/knowledge-retirements/'))){const m=/^90_system\/knowledge-retirements\/KRET-([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);if(!m||!records.has(`KNW-${m[1]}`)||!await readRetirement(vault,`KNW-${m[1]}`))throw new Error('停止記録と知識が未同期です');}
 state.global.sort((a,b)=>a.id.localeCompare(b.id));for(const list of Object.values(state.projects))list.sort((a,b)=>a.id.localeCompare(b.id));state.inactiveIds.sort();assertPolicySize(state);return state;
}
const digest=z.string().regex(/^[a-f0-9]{64}$/),entrySchema=z.object({id:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/),kind:z.enum(['decision','preference']),claim:z.string().min(1).max(1000),path:z.string(),approvalId:z.string().regex(/^APR-[0-9A-HJKMNP-TV-Z]{26}$/)}).strict();
export const policyManifestSchema=z.object({schema_version:z.literal(1),revision:digest,generatedAt:z.string().datetime({offset:true}),global:z.array(entrySchema),projects:z.record(z.string(),z.array(entrySchema)),inactiveIds:z.array(z.string()),dependencies:z.record(z.string(),digest),inventory:z.array(z.string()),projections:z.record(z.string(),digest)}).strict();
export const policyRevision=(state:PolicyState)=>hash(JSON.stringify(state));
export async function assertPolicySnapshot(vault:Vault,state:PolicyState):Promise<void>{
 if(!isDeepStrictEqual(await policyInventory(vault),state.inventory))throw new Error('方針の正本集合が取得中に変わりました');
 for(const[path,want]of Object.entries(state.dependencies)){const raw=await reviewRead(vault,path);if(raw===undefined||hash(raw)!==want)throw new Error('方針の正本が取得中に変わりました');}
 if(!isDeepStrictEqual(await policyInventory(vault),state.inventory))throw new Error('方針の正本集合が取得中に変わりました');
}
