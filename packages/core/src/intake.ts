import {retireKnowledge} from './knowledge-retirement.js';
import {adoptionTargetSchema} from './knowledge-scope.js';
import { z } from 'zod';
import { readdir,lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Vault,hash } from './storage.js';
import { capture,readInputs,inputIdSchema } from './capture.js';
import { correctInput,CorrectionTargetError } from './corrections.js';
import {approve,reject} from './approvals.js';
import { decideProject } from './project-proposals.js';
import { parseIntake,decodeIntake,requestIdSchema,type IntakeRequest } from './intake-format.js';
import type { HubConfig } from './types.js';
export interface IntakeRunResult { accepted:number; rejected:number; deferred:number; deduped:number; conflicts:string[]; requestIds:string[]; dryRun:boolean }
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const operations=z.enum(['capture','correct','project-approve','project-reject','knowledge-approve','knowledge-reject','knowledge-retire']);
export const intakeReceiptSchema=z.object({schema_version:z.literal(1),request_id:requestIdSchema,request_hash:digest,path:z.string(),operation:operations,status:z.literal('accepted'),received_at:z.string().datetime({offset:true}),result:z.union([z.object({knowledgeId:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/),retirementId:z.string().regex(/^KRET-[0-9A-HJKMNP-TV-Z]{26}$/),deduped:z.boolean()}).strict(),z.object({inputId:inputIdSchema,path:z.string(),receivedAt:z.string(),deduped:z.boolean()}).strict(),z.object({candidateId:z.string().regex(/^PCAN-[0-9A-HJKMNP-TV-Z]{26}$/),projectId:z.string().regex(/^project-[0-9a-hjkmnp-tv-z]{26}$/),decisionId:z.string().regex(/^PAPR-[0-9A-HJKMNP-TV-Z]{26}$/),deduped:z.boolean()}).strict(),z.object({candidateId:z.string().regex(/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/),approvalId:z.string().regex(/^APR-[0-9A-HJKMNP-TV-Z]{26}$/),knowledgeId:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/).optional(),adoptedTarget:adoptionTargetSchema.optional(),deduped:z.boolean()}).strict()])}).strict().refine(r=>{if(r.operation==='capture'||r.operation==='correct')return 'inputId'in r.result;if(r.operation==='project-approve'||r.operation==='project-reject')return 'decisionId'in r.result;if(r.operation==='knowledge-retire')return 'retirementId'in r.result;return 'approvalId'in r.result&&(r.operation==='knowledge-approve'?'knowledgeId'in r.result:!('knowledgeId'in r.result));});
const pendingSchema=z.object({schema_version:z.literal(1),request_id:requestIdSchema,request_hash:digest,path:z.string(),raw:z.string()}).strict();
const intakeReasonSchema=z.discriminatedUnion('code',[
 z.object({code:z.literal('stale-correction-target'),latest_input_id:inputIdSchema}).strict(),
 z.object({code:z.literal('missing-correction-target')}).strict(),
]);
export const intakeErrorSchema=z.object({schema_version:z.literal(1),path:z.string(),file_hash:z.string(),status:z.enum(['error','conflict']),code:z.string(),updated_at:z.string().datetime({offset:true}),reason:intakeReasonSchema.optional()}).strict();
export function intakeErrorMessage(record:z.infer<typeof intakeErrorSchema>):string{
 if(record.reason?.code==='stale-correction-target')return `訂正対象が古くなっています。同期して最新ID ${record.reason.latest_input_id} を対象に新しい訂正を送ってください。`;
 if(record.reason?.code==='missing-correction-target')return '訂正対象がありません。同期して対象IDを確認し、新しい訂正を送ってください。';
 return record.code;
}
const ackPath=(id:string)=>`90_system/intake/${id}.json`,pendingPath=(id:string)=>`90_system/intake/pending/${id}.json`;
export async function intakePaths(vault:Vault):Promise<string[]>{
 let entries;try{entries=await readdir(await vault.path('Input'),{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
 return entries.filter(e=>!e.name.startsWith('.')&&!e.name.endsWith('.tmp')).map(e=>`Input/${e.name}`).sort();
}
export async function readIntakeReceipts(config:HubConfig){const vault=new Vault(config),result:z.infer<typeof intakeReceiptSchema>[]=[];for(const path of await vault.files('90_system/intake'))if(/^90_system\/intake\/REQ-[A-Za-z0-9]{32}\.json$/.test(path)){const receipt=intakeReceiptSchema.parse(JSON.parse((await vault.read(path))!));if(path!==ackPath(receipt.request_id)||receipt.path!==`Input/${receipt.request_id}.md`)throw new Error('受付記録とパスが一致しません');result.push(receipt);}return result;}
export function parseIntakePending(path:string,raw:string,max:number){const snapshot=pendingSchema.parse(JSON.parse(raw));const packet=parseIntake(snapshot.path,snapshot.raw,max);if(path!==pendingPath(packet.request_id)||snapshot.request_id!==packet.request_id||snapshot.request_hash!==hash(snapshot.raw))throw new Error('受付の停止回復記録が一致しません');return{snapshot,packet};}
export async function ingest(config:HubConfig,options:{limit?:number;dryRun?:boolean}={}):Promise<IntakeRunResult>{
 z.object({limit:z.number().int().min(1).optional(),dryRun:z.boolean().optional()}).strict().parse(options);
 const vault=new Vault(config),outcome:IntakeRunResult={accepted:0,rejected:0,deferred:0,deduped:0,conflicts:[],requestIds:[],dryRun:options.dryRun===true},maxBytes=config.capture.maxInputChars*4+8192;
 const work=new Map<string,{packet:IntakeRequest;raw:string;path:string;recovery:boolean}>();
 const problem=async(path:string,fileHash:string,status:'error'|'conflict',code:string,retried=false,reason?:z.infer<typeof intakeReasonSchema>)=>{
  if(status==='conflict')outcome.conflicts.push(path);
  const target=`90_system/intake-errors/${hash(path)}.json`,previous=await vault.read(target);
  const same=previous&&(()=>{try{const p=intakeErrorSchema.parse(JSON.parse(previous));return p.file_hash===fileHash&&p.code===code&&p.status===status&&isDeepStrictEqual(p.reason,reason);}catch{return false;}})();
  if(same){outcome.deduped++;if(!retried)return;}else outcome.rejected++;
  if(!options.dryRun)await vault.withLock(()=>vault.write(target,JSON.stringify({schema_version:1,path,file_hash:fileHash,status,code,updated_at:new Date().toISOString(),...(reason?{reason}:{})},null,2)+'\n'));
 };
 for(const path of await intakePaths(vault)){
  if(path.includes('.sync-conflict-')){await problem(path,'sync-conflict','conflict','同期の競合コピーです。通常受付から除外しました');continue;}
  let raw:string|undefined;
  try{
   const info=await lstat(await vault.path(path));if(!info.isFile())throw new Error('invalid-file');
   if(!/^Input\/REQ-[A-Za-z0-9]{32}\.md$/.test(path))throw new Error('invalid-path');
   if(Date.now()-info.mtimeMs<2000){outcome.deferred++;continue;}
   const bytes=await vault.readBytes(path,maxBytes);if(!bytes){outcome.deferred++;continue;}raw=decodeIntake(bytes);
   const packet=parseIntake(path,raw,config.capture.maxInputChars),again=await vault.readBytes(path,maxBytes);
   if(!again||hash(decodeIntake(again))!==hash(raw)){outcome.deferred++;continue;}
   work.set(packet.request_id,{packet,raw,path,recovery:false});
  }catch{await problem(path,raw===undefined?'unreadable':hash(raw),'error','受付形式・容量・UTF-8・パスを確認してください');}
 }
 for(const path of await vault.files('90_system/intake/pending')){
  if(!/^90_system\/intake\/pending\/REQ-[A-Za-z0-9]{32}\.json$/.test(path))continue;
  try{const{snapshot,packet}=parseIntakePending(path,(await vault.read(path))!,config.capture.maxInputChars);if(!work.has(packet.request_id)){
   const current=await vault.readBytes(snapshot.path,maxBytes);if(current!==undefined){const raw=decodeIntake(current);if(hash(raw)!==snapshot.request_hash){await problem(snapshot.path,hash(raw),'conflict','同じ受付IDの内容が変更されています');continue;}}
   work.set(packet.request_id,{packet,raw:snapshot.raw,path:snapshot.path,recovery:true});
  }}catch{await problem(path,'invalid-pending','error','受付の停止回復記録が不正です。doctorで確認してください');}
 }
 const ordered=[];
 for(const item of work.values()){
  const raw=await vault.read(`90_system/intake-errors/${hash(item.path)}.json`);let failedAt:number|undefined;
  if(raw)try{const error=intakeErrorSchema.parse(JSON.parse(raw));if(error.file_hash===hash(item.raw)&&error.status==='error')failedAt=Date.parse(error.updated_at);}catch{ /* 不正な記録は通常受付で検証・報告する。 */ }
  ordered.push({...item,failedAt});
 }
 // 未試行を先に受け付け、失敗の再試行は古い試行から順に回す。
 ordered.sort((a,b)=>Number(a.failedAt!==undefined)-Number(b.failedAt!==undefined)||(a.failedAt!==undefined&&b.failedAt!==undefined?a.failedAt-b.failedAt:0)||Number(a.recovery)-Number(b.recovery)||a.path.localeCompare(b.path));
 let attempts=0;
 for(const item of ordered){
  const {packet,raw,path}=item,id=packet.request_id,requestHash=hash(raw);
  let attempted=false;
  try{
   const claim=async()=>{
    const existing=await vault.read(ackPath(id));if(existing){const ack=intakeReceiptSchema.parse(JSON.parse(existing));if(ack.request_id!==id||ack.path!==path||ack.operation!==packet.operation||ack.request_hash!==requestHash)throw new Error('conflict');return'done';}
    const old=await vault.read(pendingPath(id));if(old){const{snapshot}=parseIntakePending(pendingPath(id),old,config.capture.maxInputChars);if(snapshot.request_hash!==requestHash)throw new Error('conflict');}
    else if(!options.dryRun&&attempts<(options.limit??config.organize.maxItemsPerRun))await vault.create(pendingPath(id),JSON.stringify({schema_version:1,request_id:id,request_hash:requestHash,path,raw})+'\n');return'pending';
   };
   const claimed=await (options.dryRun?claim():vault.withLock(claim));
   if(claimed==='done'){outcome.deduped++;continue;}
   if(attempts>=(options.limit??config.organize.maxItemsPerRun)){outcome.deferred++;continue;}attempts++;attempted=true;outcome.requestIds.push(id);
   if(options.dryRun)continue;
   let result:z.infer<typeof intakeReceiptSchema>['result'];
   if(packet.operation==='capture'){
    result=await capture(config,{source:packet.source,sourceEventId:id,text:packet.text,kind:packet.kind,occurredAt:packet.occurred_at,project:packet.project,tool:packet.tool,meta:packet.meta});
    const inputId=result.inputId,saved=(await readInputs(config)).find(i=>i.id===inputId);
    if(!saved||saved.text!==packet.text||saved.kind!==packet.kind||saved.occurred_at!==packet.occurred_at||saved.project!==packet.project||saved.tool!==packet.tool||!isDeepStrictEqual(saved.meta,packet.meta))throw new Error('event-conflict');
   }else if(packet.operation==='correct')result=await correctInput(config,packet.target_id,{source:packet.source,sourceEventId:id,text:packet.text,occurredAt:packet.occurred_at});
   else if(packet.operation==='knowledge-retire')result=await retireKnowledge(config,packet.target_id,packet.target_hash);
   else if(packet.operation==='knowledge-approve')result=await approve(config,packet.candidate_id,packet.candidate_hash,packet.scope==='global'?{scope:'global'}:{scope:'project',projectId:packet.project_id,projectHash:packet.project_hash});
   else if(packet.operation==='knowledge-reject')result=await reject(config,packet.candidate_id,packet.candidate_hash);
   else if('confirmation_token'in packet)result=await decideProject(config,{candidateId:packet.candidate_id,expectedHash:packet.candidate_hash,confirmationToken:packet.confirmation_token,confirmed:packet.confirmed,action:packet.operation==='project-approve'?'approve':'reject',source:packet.source,sourceEventId:id});
   else throw new Error('受付操作が不正です');
   const accepted=await vault.withLock(async()=>{
    const receipt={schema_version:1,request_id:id,request_hash:requestHash,path,operation:packet.operation,status:'accepted',received_at:new Date().toISOString(),result};
    if(await vault.create(ackPath(id),JSON.stringify(receipt,null,2)+'\n'))return true;
    const existing=intakeReceiptSchema.parse(JSON.parse((await vault.read(ackPath(id)))!));if(existing.request_hash!==requestHash)throw new Error('conflict');return false;
   });
   if(accepted)outcome.accepted++;else outcome.deduped++;
  }catch(error){const conflict=error instanceof Error&&(error.message==='conflict'||error.message==='event-conflict');await problem(path,requestHash,conflict?'conflict':'error',conflict?'同じ受付IDの内容またはイベントが一致しません':'受付操作が未完了です。対象・確認情報・停止回復をdoctorで確認してください',attempted,error instanceof CorrectionTargetError?error.reason:undefined);}
 }
 return outcome;
}
