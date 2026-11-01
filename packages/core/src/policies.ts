import {realpath,lstat} from 'node:fs/promises';
import {relative,isAbsolute,dirname,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {Vault,hash} from './storage.js';
import {projectIdSchema} from './projects.js';
import {reviewRead} from './knowledge-candidates.js';
import {collectPolicyState,policyDocument,policyManifestSchema,policyRevision,assertPolicySnapshot,assertPolicySize,type PolicyEntry} from './policy-manifest.js';
import type {HubConfig} from './types.js';
import type {AdoptionTarget} from './knowledge-scope.js';
export type {PolicyEntry} from './policy-manifest.js';
export interface PolicyBundle{schema_version:1;revision:string;generatedAt:string;projectId?:string;global:PolicyEntry[];project:PolicyEntry[];inactiveIds:string[];warnings:string[]}
const manifestPath='90_system/policies/index.json';
export async function rebuildPoliciesLocked(_config:HubConfig,vault:Vault):Promise<void>{
 const state=await collectPolicyState(vault),projections:Record<string,string>={},documents=new Map<string,string>([['POLICY.md',policyDocument(state.global,'共通')]]);
 for(const[id,list]of Object.entries(state.projects))documents.set(`10_projects/${id}/POLICY.md`,policyDocument(list,`プロジェクト ${id}`));
 await assertPolicySnapshot(vault,state);
 for(const[path,raw]of documents){await vault.write(path,raw);projections[path]=hash(raw);}
 const manifest={schema_version:1,revision:policyRevision(state),generatedAt:new Date().toISOString(),...state,projections},raw=JSON.stringify(manifest)+'\n';
 if(Buffer.byteLength(raw)>1_048_576)throw new Error('方針manifestの容量が上限を超えています');
 await assertPolicySnapshot(vault,state);await vault.write(manifestPath,raw);
}
export async function readPolicies(config:HubConfig,projectId?:string):Promise<PolicyBundle>{
 if(projectId!==undefined)projectIdSchema.parse(projectId);const vault=new Vault(config),raw=await reviewRead(vault,manifestPath);
 if(raw===undefined)throw new Error('方針は未初期化・未同期です。Miniで集約し同期してください');
 const m=policyManifestSchema.parse(JSON.parse(raw)),state=await collectPolicyState(vault);
 if(policyRevision(state)!==m.revision||!isDeepStrictEqual(state,{global:m.global,projects:m.projects,inactiveIds:m.inactiveIds,dependencies:m.dependencies,inventory:m.inventory}))throw new Error('方針の正本とmanifestが一致しません。同期または集約の回復が必要です');
 const docs:Record<string,string>={'POLICY.md':hash(policyDocument(state.global,'共通'))};for(const[id,list]of Object.entries(state.projects))docs[`10_projects/${id}/POLICY.md`]=hash(policyDocument(list,`プロジェクト ${id}`));
 if(!isDeepStrictEqual(docs,m.projections))throw new Error('方針の集約情報が不正です');
 for(const[path,want]of Object.entries(docs)){const doc=await reviewRead(vault,path);if(doc===undefined||hash(doc)!==want)throw new Error('方針の集約が未同期・変更されています');}
 await assertPolicySnapshot(vault,state);
 if(await reviewRead(vault,manifestPath)!==raw)throw new Error('方針の版が取得中に変わりました');
 if(projectId&&!Object.hasOwn(state.projects,projectId))throw new Error('対象プロジェクトの方針が未同期・未登録です');
 return{schema_version:1,revision:m.revision,generatedAt:m.generatedAt,...(projectId?{projectId}:{}),global:state.global,project:projectId?state.projects[projectId]!:[],inactiveIds:state.inactiveIds,warnings:projectId?[]:['作業フォルダーはContextHubプロジェクトに未対応付けです。共通方針のみ適用します。']};
}
export function formatPolicies(bundle:PolicyBundle):string{
 return `# 本人が過去に採用した継続的な方針\n\n端末に揃った同期版: ${bundle.revision}\n生成: ${bundle.generatedAt}\n対象: ${bundle.projectId??'共通のみ'}\nこの版の有効IDだけを適用し、以前の版にのみ存在するIDは適用しません。\n上位指示と本人の今回の依頼を尊重してください。方針同士の矛盾で判断が変わる場合は該当内容を示して確認してください。採用は任意の実行・承認権限を与えません。\n${bundle.warnings.join('\n')}\n\n${policyDocument(bundle.global,'共通')}\n${bundle.projectId?policyDocument(bundle.project,`プロジェクト ${bundle.projectId}`):''}`;
}
export async function assertAdoptionCapacity(vault:Vault,entry:{id:string;kind:'knowledge'|'decision'|'preference';claim:string;path:string;target:AdoptionTarget;supersedes?:string}):Promise<void>{
 const state=await collectPolicyState(vault);if(entry.kind==='knowledge')return;
 if(entry.supersedes){state.global=state.global.filter(e=>e.id!==entry.supersedes);for(const[id,list]of Object.entries(state.projects))state.projects[id]=list.filter(e=>e.id!==entry.supersedes);}
 const next:PolicyEntry={id:entry.id,kind:entry.kind,claim:entry.claim,path:entry.path,approvalId:`APR-${entry.id.slice(4)}`};
 if(entry.target.scope==='global')state.global.push(next);else{const list=state.projects[entry.target.projectId];if(!list)throw new Error('採用先が未登録です');list.push(next);}assertPolicySize(state);
}
export async function resolvePolicyProject(config:HubConfig,cwd:string):Promise<string|undefined>{
 if(!isAbsolute(cwd))throw new Error('作業フォルダーは絶対パスで指定してください');const actual=await realpath(cwd),roots=new Map<string,string>();
 for(const item of config.policy.projectRoots){const root=await realpath(item.path),old=roots.get(root);if(old!==undefined&&old!==item.projectId)throw new Error('作業フォルダーのプロジェクト対応が重複しています');roots.set(root,item.projectId);}
 const match=[...roots].filter(([root])=>{const rel=relative(root,actual);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../'));}).sort((a,b)=>b[0].length-a[0].length)[0];
 if(!match)return;const[root,projectId]=match;
 // 明示したルートより内側に別repo/worktreeがあれば、親projectの対応を継承しない。
 for(let cursor=actual;cursor!==root;cursor=dirname(cursor)){
  try{await lstat(join(cursor,'.git'));return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 return projectId;
}
