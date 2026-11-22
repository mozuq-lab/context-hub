import {retireKnowledge} from './knowledge-retirement.js';
import {adoptionTargetSchema} from './knowledge-scope.js';
import { z } from 'zod';
import { readdir,lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Vault,hash,LockTimeoutError } from './storage.js';
import { capture,parseInput,inputIdSchema } from './capture.js';
import { correctInput,CorrectionTargetError } from './corrections.js';
import {approve,reject} from './approvals.js';
import { decideProject } from './project-proposals.js';
import { setProjectStatus,projectStatusSchema } from './project-status.js';
import { setProjectDefinition } from './project-definition.js';
import { setItemResolution,itemActionSchema,itemScopeSchema,UNASSIGNED_SCOPE,ItemTargetError,itemTargetMessage } from './item-resolutions.js';
import { setItemSchedule,scheduleIdSchema,completeOccurrence,occurrenceActionSchema,occurrenceIdSchema,OccurrenceError,occurrenceMessage,scheduleDateSchema } from './item-schedules.js';
import { dismissResolutionHint,hintDismissalIdSchema } from './resolution-hints.js';
import { dismissGitDraft } from './git-drafts.js';
import { createProject,ProjectCreateError,newProjectIdSchema,projectCreationIdSchema } from './project-creations.js';
import { resolveConflict,ConflictResolveError,resolvableTargetSchema,conflictResolutionIdSchema } from './conflicts.js';
import { projectIdSchema,ProjectMergedError } from './projects.js';
import { mergeProjects,unmergeProject,ProjectMergeError,projectMergeIdSchema,projectMergeActions,projectMergeReasonMessage } from './project-merges.js';
import { setIdeaLink,IdeaLinkError,ideaLinkIdSchema,ideaLinkActionSchema } from './idea-links.js';
import { parseIntake,decodeIntake,requestIdSchema,type IntakeRequest } from './intake-format.js';
import { setInsightReaction,InsightReactionError } from './insights.js';
import { insightItemKeySchema,insightReactionIdSchema,insightReactionValueSchema,insightRunIdSchema } from './insight-feedback.js';
import { setPerson,PersonDefinitionError,personReasonMessage,personIdSchema,personChangeIdSchema,personActions } from './people.js';
import { requestAnswer,askIdSchema,AskError,askReasonMessage,ASK_QUESTION_CHARS } from './ask.js';
import { setClientPreferences,parsePreferencesPayload,preferenceGroups,PreferencesError,preferencesMessage } from './client-preferences.js';
import { DEFAULT_MAX_BACKDATE_DAYS,HappenedOnError,happenedOnMessage,effectiveHappenedOn } from './happened.js';
import { keepPolicy,PolicyReviewError,policyReviewMessage,policyReviewIdSchema } from './policy-reviews.js';
import type { HubConfig } from './types.js';
export interface IntakeRunResult { accepted:number; rejected:number; deferred:number; deduped:number; conflicts:string[]; requestIds:string[]; dryRun:boolean }
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const operations=z.enum(['capture','correct','project-approve','project-reject','knowledge-approve','knowledge-reject','knowledge-retire','project-status','project-definition','item-resolution','item-hint-dismiss','item-schedule','item-occurrence','git-draft-dismiss','project-create','conflict-resolve','idea-link','project-merge','project-unmerge','insight-reaction','ask','client-preferences','policy-keep','person-definition']);
export const intakeReceiptSchema=z.object({schema_version:z.literal(1),request_id:requestIdSchema,request_hash:digest,path:z.string(),operation:operations,status:z.literal('accepted'),received_at:z.string().datetime({offset:true}),result:z.union([z.object({personId:personIdSchema,action:z.enum(personActions),changeId:personChangeIdSchema,deduped:z.boolean()}).strict(),z.object({knowledgeId:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/),reviewId:policyReviewIdSchema,deduped:z.boolean()}).strict(),z.object({askId:askIdSchema,deduped:z.boolean()}).strict(),z.object({applied:z.array(z.enum(preferenceGroups)),deduped:z.boolean()}).strict(),z.object({reactionId:insightReactionIdSchema,runId:insightRunIdSchema,itemKey:insightItemKeySchema,reaction:insightReactionValueSchema,deduped:z.boolean()}).strict(),z.object({fromId:projectIdSchema,intoId:projectIdSchema,action:z.enum(projectMergeActions),mergeId:projectMergeIdSchema,aliases:z.array(z.string()),keywords:z.array(z.string()),deduped:z.boolean()}).strict(),z.object({linkId:ideaLinkIdSchema,action:ideaLinkActionSchema,deduped:z.boolean()}).strict(),z.object({projectId:projectIdSchema,changeId:z.string().regex(/^PDEF-[0-9A-HJKMNP-TV-Z]{26}$/),deduped:z.boolean(),changed:z.array(z.enum(['title','aliases','keywords']))}).strict(),z.object({projectId:newProjectIdSchema,creationId:projectCreationIdSchema,firstMemoInputId:inputIdSchema.optional(),deduped:z.boolean()}).strict(),z.object({target:resolvableTargetSchema,conflictResolutionId:conflictResolutionIdSchema,memoInputId:inputIdSchema.optional(),archived:z.number().int().min(0),deduped:z.boolean()}).strict(),z.object({draftId:z.string().regex(/^GDR-[0-9A-HJKMNP-TV-Z]{26}$/),dismissed:z.literal(true),deduped:z.boolean()}).strict(),z.object({projectId:projectIdSchema,itemKey:digest,scheduleId:scheduleIdSchema,deduped:z.boolean()}).strict(),z.object({projectId:projectIdSchema,itemKey:digest,action:occurrenceActionSchema,occurrenceId:occurrenceIdSchema,nextDue:scheduleDateSchema,deduped:z.boolean()}).strict(),z.object({projectId:projectIdSchema,itemKey:digest,hintInputId:inputIdSchema,dismissalId:hintDismissalIdSchema,deduped:z.boolean()}).strict(),z.object({projectId:itemScopeSchema,itemKey:digest,action:itemActionSchema,resolutionId:z.string().regex(/^RES-[0-9A-HJKMNP-TV-Z]{26}$/),deduped:z.boolean()}).strict(),z.object({projectId:projectIdSchema,status:projectStatusSchema,changeId:z.string().regex(/^PST-[0-9A-HJKMNP-TV-Z]{26}$/),deduped:z.boolean()}).strict(),z.object({knowledgeId:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/),retirementId:z.string().regex(/^KRET-[0-9A-HJKMNP-TV-Z]{26}$/),deduped:z.boolean()}).strict(),z.object({inputId:inputIdSchema,path:z.string(),receivedAt:z.string(),deduped:z.boolean()}).strict(),z.object({candidateId:z.string().regex(/^PCAN-[0-9A-HJKMNP-TV-Z]{26}$/),projectId:z.string().regex(/^project-[0-9a-hjkmnp-tv-z]{26}$/),decisionId:z.string().regex(/^PAPR-[0-9A-HJKMNP-TV-Z]{26}$/),deduped:z.boolean()}).strict(),z.object({candidateId:z.string().regex(/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/),approvalId:z.string().regex(/^APR-[0-9A-HJKMNP-TV-Z]{26}$/),knowledgeId:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/).optional(),adoptedTarget:adoptionTargetSchema.optional(),deduped:z.boolean()}).strict()])}).strict().refine(r=>{if(r.operation==='capture'||r.operation==='correct')return 'inputId'in r.result;if(r.operation==='project-approve'||r.operation==='project-reject')return 'decisionId'in r.result;if(r.operation==='knowledge-retire')return 'retirementId'in r.result;if(r.operation==='project-status')return 'status'in r.result;if(r.operation==='project-definition')return 'changed'in r.result;if(r.operation==='item-resolution')return 'resolutionId'in r.result;if(r.operation==='item-hint-dismiss')return 'dismissalId'in r.result;if(r.operation==='item-schedule')return 'scheduleId'in r.result;if(r.operation==='item-occurrence')return 'occurrenceId'in r.result;if(r.operation==='git-draft-dismiss')return 'dismissed'in r.result;if(r.operation==='project-create')return 'creationId'in r.result;if(r.operation==='conflict-resolve')return 'conflictResolutionId'in r.result;if(r.operation==='idea-link')return 'linkId'in r.result;if(r.operation==='insight-reaction')return 'reactionId'in r.result;if(r.operation==='ask')return 'askId'in r.result;if(r.operation==='client-preferences')return 'applied'in r.result;if(r.operation==='policy-keep')return 'reviewId'in r.result;if(r.operation==='person-definition')return 'personId'in r.result;if(r.operation==='project-merge'||r.operation==='project-unmerge')return 'mergeId'in r.result&&r.result.action===(r.operation==='project-merge'?'merge':'unmerge');return 'approvalId'in r.result&&(r.operation==='knowledge-approve'?'knowledgeId'in r.result:!('knowledgeId'in r.result));});
/**
 * 端末が、この本体の受け付ける依頼の種類と、メモの任意の欄を知るための一覧。対応前の本体に送ると拒否される依頼や欄を、
 * 端末が出さずに済むようにする（ファイルがなければ、端末は対応前の本体として扱う）。HOMEの生成のたびに、内容が変わったときだけ書く。
 */
export const INTAKE_FEATURES_PATH='90_system/intake-features.json';
/**
 * 端末が使える依頼の種類と、端末が本体の設定に合わせるための値。max_backdate_daysは出来事の日付をさかのぼれる日数、
 * calendar_titlesは端末からカレンダーへ入れる予定の件名に項目の本文を入れるか（projectなら入れない）。
 * item_schedule_fieldsは期日の依頼に添えられる欄（repeatは定例）。askは「記録に聞く」を本人が設定で有効にしているかと、問いの上限の文字数。
 */
export function intakeFeatures(config:Pick<HubConfig,'capture'|'calendar'|'ask'>){return{schema_version:1 as const,operations:[...operations.options],capture_fields:['happened_on'],capture_kinds:['memo','work-summary','action'],action_scopes:[UNASSIGNED_SCOPE],item_scopes:[UNASSIGNED_SCOPE],review_rejects:['stale'],item_schedule_fields:['repeat'],ask:{enabled:config.ask.enabled,max_question_chars:ASK_QUESTION_CHARS},max_backdate_days:config.capture.maxBackdateDays??DEFAULT_MAX_BACKDATE_DAYS,calendar_titles:config.calendar?.titles??'item'};}
export async function writeIntakeFeaturesLocked(config:Pick<HubConfig,'capture'|'calendar'|'ask'>,vault:Vault):Promise<void>{const raw=JSON.stringify(intakeFeatures(config),null,2)+'\n';if(await vault.read(INTAKE_FEATURES_PATH)!==raw)await vault.write(INTAKE_FEATURES_PATH,raw);}
const pendingSchema=z.object({schema_version:z.literal(1),request_id:requestIdSchema,request_hash:digest,path:z.string(),raw:z.string()}).strict();
const intakeReasonSchema=z.discriminatedUnion('code',[
 z.object({code:z.literal('stale-correction-target'),latest_input_id:inputIdSchema}).strict(),
 z.object({code:z.literal('missing-correction-target')}).strict(),
 z.object({code:z.literal('project-exists')}).strict(),
 z.object({code:z.literal('project-overlap'),project_id:projectIdSchema}).strict(),
 z.object({code:z.literal('conflict-target-changed')}).strict(),
 z.object({code:z.literal('conflict-missing')}).strict(),
 z.object({code:z.literal('idea-missing')}).strict(),
 z.object({code:z.literal('idea-changed')}).strict(),
 z.object({code:z.literal('project-merged'),project_id:projectIdSchema}).strict(),
 z.object({code:z.literal('project-merge-changed')}).strict(),
 z.object({code:z.literal('item-missing')}).strict(),
 z.object({code:z.literal('item-closed'),state:z.enum(['resolved','excluded'])}).strict(),
 z.object({code:z.literal('item-open')}).strict(),
 z.object({code:z.literal('insight-missing')}).strict(),
 z.object({code:z.enum(['person-exists','person-missing','person-changed','person-invalid','person-unchanged'])}).strict(),
 z.object({code:z.literal('person-overlap'),person_id:personIdSchema}).strict(),
 z.object({code:z.literal('occurrence-changed'),due:scheduleDateSchema.nullable()}).strict(),
 z.object({code:z.literal('not-repeating')}).strict(),
 z.object({code:z.literal('occurrence-out-of-range')}).strict(),
 z.object({code:z.literal('ask-disabled')}).strict(),
 z.object({code:z.literal('ask-project-missing')}).strict(),
 z.object({code:z.literal('preferences-secret'),labels:z.array(z.string().max(40)).max(20)}).strict(),
 z.object({code:z.literal('policy-review-refused'),cause:z.enum(['missing','changed','inactive'])}).strict(),
 z.object({code:z.literal('happened-on-invalid'),cause:z.enum(['future','too-old']),max_days:z.number().int().min(1)}).strict(),
 z.object({code:z.literal('project-merge-refused'),cause:z.enum(['missing','same','already-merged','target-merged','has-sources','not-merged','target-mismatch']),project_id:projectIdSchema.optional()}).strict(),
]);
export const intakeErrorSchema=z.object({schema_version:z.literal(1),path:z.string(),file_hash:z.string(),status:z.enum(['error','conflict']),code:z.string(),updated_at:z.string().datetime({offset:true}),reason:intakeReasonSchema.optional()}).strict();
/**
 * 理由付きの拒否。同じ内容で送り直しても結果は同じで、本人がアプリの依頼の結果で確かめれば済む答え（壊れた状態ではない）。
 * 記録は依頼の結果として残すが、HOMEの「失敗と競合」とdoctorでは異常に数えず、拒否から{@link REFUSAL_NOTICE_DAYS}日だけ示す。
 */
export const REFUSAL_NOTICE_DAYS=7;
export function isIntakeRefusal(record:z.infer<typeof intakeErrorSchema>):boolean{return record.status==='error'&&record.reason!==undefined;}
export function refusalNoticeVisible(record:z.infer<typeof intakeErrorSchema>,now:number):boolean{return now-Date.parse(record.updated_at)<REFUSAL_NOTICE_DAYS*86_400_000;}
export function intakeErrorMessage(record:z.infer<typeof intakeErrorSchema>):string{
 if(record.reason?.code==='stale-correction-target')return `訂正対象が古くなっています。同期して最新ID ${record.reason.latest_input_id} を対象に新しい訂正を送ってください。`;
 if(record.reason?.code==='missing-correction-target')return '訂正対象がありません。同期して対象IDを確認し、新しい訂正を送ってください。';
 if(record.reason?.code==='project-exists')return '同じIDのプロジェクトが既にあります。作成し直す場合は新しい依頼を送ってください。';
 if(record.reason?.code==='project-overlap')return `名前か別名が既存のプロジェクト（${record.reason.project_id}）と重なるため作成しませんでした。名前を変えて新しい依頼を送るか、既存のプロジェクトを使ってください。`;
 if(record.reason?.code==='conflict-target-changed')return '確認した後にNOW（または生成物）が変更されています。同期してから差分を確認し直し、新しい依頼を送ってください。';
 if(record.reason?.code==='conflict-missing')return '片付ける競合がありません。既に生成版へ戻っている可能性があります。';
 if(record.reason?.code==='idea-missing')return 'アイデアが見つからないか、分類が取り消されています。同期して似ているアイデアの一覧を確認し直してください。';
 if(record.reason?.code==='idea-changed')return '確認した後にアイデアが作り直されています。同期して最新の内容を確認し、新しい依頼を送ってください。';
 if(record.reason?.code==='project-merged')return `このプロジェクトは${record.reason.project_id}に統合されています。同期してから、統合先で操作し直してください。`;
 if(record.reason?.code==='policy-review-refused')return policyReviewMessage(record.reason);
 if(record.reason?.code==='happened-on-invalid')return happenedOnMessage(record.reason);
 if(record.reason?.code==='insight-missing')return '今週の気づきが見つかりません。同期してから、今週の気づきを確かめ直してください。';
 if(record.reason?.code.startsWith('person-'))return personReasonMessage(record.reason as Parameters<typeof personReasonMessage>[0]);
 if(record.reason?.code==='preferences-secret')return preferencesMessage(record.reason);
 if(record.reason?.code==='occurrence-changed'||record.reason?.code==='not-repeating'||record.reason?.code==='occurrence-out-of-range')return occurrenceMessage(record.reason);
 if(record.reason?.code==='ask-disabled'||record.reason?.code==='ask-project-missing')return askReasonMessage(record.reason);
 if(record.reason?.code==='item-missing'||record.reason?.code==='item-closed'||record.reason?.code==='item-open')return itemTargetMessage(record.reason);
 if(record.reason?.code==='project-merge-changed'||record.reason?.code==='project-merge-refused')return projectMergeReasonMessage(record.reason);
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
  // 理由付きの拒否と競合は同じ内容なら結果も同じため、書き直さない（同期を起こさない）。
  // 理由のない失敗の再試行だけは、再試行の順番を回すためupdated_atを進める。
  if(same){outcome.deduped++;if(!retried||reason||status==='conflict')return;}else outcome.rejected++;
  if(options.dryRun)return;
  try{await vault.withLock(()=>vault.write(target,JSON.stringify({schema_version:1,path,file_hash:fileHash,status,code,updated_at:new Date().toISOString(),...(reason?{reason}:{})},null,2)+'\n'));}
  catch(error){if(!(error instanceof LockTimeoutError))throw error;/* Writerの混雑で記録できない回は、次の受付で記録し直す。 */}
 };
 // 受領記録が今の内容と一致する依頼は受付済み。受領記録は作るだけで消さないため、ロックの外で確かめてよい。
 const acked=async(id:string,path:string,requestHash:string)=>{
  const raw=await vault.read(ackPath(id));if(raw===undefined)return false;
  try{const ack=intakeReceiptSchema.parse(JSON.parse(raw));return ack.request_id===id&&ack.path===path&&ack.request_hash===requestHash;}catch{return false;/* 不正な受領記録は通常の受付で競合として扱う。 */}
 };
 // 理由付きの拒否は同じ内容では結果が変わらず、停止回復も要らない。停止回復記録を残すと「回復待ち」がdoctorに残り続けるため片付ける。
 // 拒否の記録（今の内容への理由付きの拒否）が書けていることを同じロック内で確かめてから消し、依頼の痕跡を失わない。
 const dropPending=async(id:string,path:string,requestHash:string)=>{
  if(options.dryRun||await vault.read(pendingPath(id))===undefined)return;
  try{await vault.withLock(async()=>{
   const old=await vault.read(pendingPath(id)),refusal=await vault.read(`90_system/intake-errors/${hash(path)}.json`);if(old===undefined||refusal===undefined)return;
   try{const error=intakeErrorSchema.parse(JSON.parse(refusal));if(pendingSchema.parse(JSON.parse(old)).request_hash!==requestHash||error.path!==path||error.file_hash!==requestHash||!isIntakeRefusal(error))return;}catch{return;/* 不正な記録はdoctorで示す。 */}
   await vault.remove(pendingPath(id));
  });}
  catch(error){if(!(error instanceof LockTimeoutError))throw error;/* Writerの混雑で片付けられない回は、次の受付で片付ける。 */}
 };
 const done=new Set<string>();
 for(const path of await intakePaths(vault)){
  if(path.includes('.sync-conflict-')){await problem(path,'sync-conflict','conflict','同期の競合コピーです。通常受付から除外しました');continue;}
  let raw:string|undefined;
  try{
   const info=await lstat(await vault.path(path));if(!info.isFile())throw new Error('invalid-file');
   if(!/^Input\/REQ-[A-Za-z0-9]{32}\.md$/.test(path))throw new Error('invalid-path');
   if(Date.now()-info.mtimeMs<2000){outcome.deferred++;continue;}
   const bytes=await vault.readBytes(path,maxBytes);if(!bytes){outcome.deferred++;continue;}raw=decodeIntake(bytes);
   const id=path.slice('Input/'.length,-'.md'.length);if(await acked(id,path,hash(raw))){done.add(id);outcome.deduped++;continue;}
   const packet=parseIntake(path,raw,config.capture.maxInputChars),again=await vault.readBytes(path,maxBytes);
   if(!again||hash(decodeIntake(again))!==hash(raw)){outcome.deferred++;continue;}
   work.set(packet.request_id,{packet,raw,path,recovery:false});
  }catch{await problem(path,raw===undefined?'unreadable':hash(raw),'error','受付形式・容量・UTF-8・パスを確認してください');}
 }
 for(const path of await vault.files('90_system/intake/pending')){
  if(!/^90_system\/intake\/pending\/REQ-[A-Za-z0-9]{32}\.json$/.test(path))continue;
  try{const{snapshot,packet}=parseIntakePending(path,(await vault.read(path))!,config.capture.maxInputChars);
   // 受付が終わった後に残った停止回復記録（受領の直後に停止した場合など）は、受領記録と一致すれば片付ける。
   if(await acked(packet.request_id,snapshot.path,snapshot.request_hash)){
    if(!done.has(packet.request_id)){done.add(packet.request_id);outcome.deduped++;}
    if(!options.dryRun)try{await vault.withLock(async()=>{if(await acked(packet.request_id,snapshot.path,snapshot.request_hash))await vault.remove(path);});}catch(error){if(!(error instanceof LockTimeoutError))throw error;}
    continue;
   }
   if(!work.has(packet.request_id)){
   const current=await vault.readBytes(snapshot.path,maxBytes);if(current!==undefined){const raw=decodeIntake(current);if(hash(raw)!==snapshot.request_hash){await problem(snapshot.path,hash(raw),'conflict','同じ受付IDの内容が変更されています');continue;}}
   work.set(packet.request_id,{packet,raw:snapshot.raw,path:snapshot.path,recovery:true});
  }}catch{await problem(path,'invalid-pending','error','受付の停止回復記録が不正です。doctorで確認してください');}
 }
 const ordered=[];
 for(const item of work.values()){
  const raw=await vault.read(`90_system/intake-errors/${hash(item.path)}.json`);let failedAt:number|undefined;
  let permanent=false;
  if(raw)try{const error=intakeErrorSchema.parse(JSON.parse(raw));if(error.file_hash===hash(item.raw)&&error.status==='error'){failedAt=Date.parse(error.updated_at);permanent=error.reason!==undefined;}}catch{ /* 不正な記録は通常受付で検証・報告する。 */ }
  // 理由付きの拒否（古い訂正対象・既にあるプロジェクトなど）は、同じ内容で再実行しても同じ結果になる。内容が変われば再び受け付ける。
  if(permanent){outcome.deduped++;await dropPending(item.packet.request_id,item.path,hash(item.raw));continue;}
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
    const existing=await vault.read(ackPath(id));if(existing){const ack=intakeReceiptSchema.parse(JSON.parse(existing));if(ack.request_id!==id||ack.path!==path||ack.operation!==packet.operation||ack.request_hash!==requestHash)throw new Error('conflict');if(!options.dryRun)await vault.remove(pendingPath(id));return'done';}
    const old=await vault.read(pendingPath(id));if(old){const{snapshot}=parseIntakePending(pendingPath(id),old,config.capture.maxInputChars);if(snapshot.request_hash!==requestHash)throw new Error('conflict');}
    else if(!options.dryRun&&attempts<(options.limit??config.organize.maxItemsPerRun))await vault.create(pendingPath(id),JSON.stringify({schema_version:1,request_id:id,request_hash:requestHash,path,raw})+'\n');return'pending';
   };
   const claimed=await (options.dryRun?claim():vault.withLock(claim));
   if(claimed==='done'){outcome.deduped++;continue;}
   if(attempts>=(options.limit??config.organize.maxItemsPerRun)){outcome.deferred++;continue;}attempts++;attempted=true;outcome.requestIds.push(id);
   if(options.dryRun)continue;
   let result:z.infer<typeof intakeReceiptSchema>['result'];
   if(packet.operation==='capture'){
    result=await capture(config,{source:packet.source,sourceEventId:id,text:packet.text,kind:packet.kind,occurredAt:packet.occurred_at,project:packet.project,tool:packet.tool,meta:packet.meta,happenedOn:packet.happened_on});
    // 保存された原文1件だけを読み、依頼と一致するかを確かめる。
    const inputId=result.inputId,stored=await vault.read(result.path),saved=stored===undefined?undefined:parseInput(result.path,stored);if(saved&&saved.id!==inputId)throw new Error('event-conflict');
    // 出来事の日付を付けた原文は、occurred_atがその日の正午になり、送った日時はrecorded_atに残る。
    if(!saved||saved.text!==packet.text||saved.kind!==packet.kind||(saved.recorded_at??saved.occurred_at)!==packet.occurred_at||saved.happened_on!==effectiveHappenedOn(packet.happened_on,packet.occurred_at,config.timezone)||saved.project!==packet.project||saved.tool!==packet.tool||!isDeepStrictEqual(saved.meta,packet.meta))throw new Error('event-conflict');
   }else if(packet.operation==='correct')result=await correctInput(config,packet.target_id,{source:packet.source,sourceEventId:id,text:packet.text,occurredAt:packet.occurred_at});
   else if(packet.operation==='knowledge-retire')result=await retireKnowledge(config,packet.target_id,packet.target_hash);
   else if(packet.operation==='knowledge-approve')result=await approve(config,packet.candidate_id,packet.candidate_hash,packet.scope==='global'?{scope:'global'}:{scope:'project',projectId:packet.project_id,projectHash:packet.project_hash});
   else if(packet.operation==='project-status')result=await setProjectStatus(config,{projectId:packet.project_id,status:packet.status,expectedHash:packet.project_hash,source:packet.source,sourceEventId:id});
   else if(packet.operation==='project-definition')result=await setProjectDefinition(config,{projectId:packet.project_id,expectedHash:packet.project_hash,title:packet.title,aliases:packet.aliases,keywords:packet.keywords,source:packet.source,sourceEventId:id});
   else if(packet.operation==='item-resolution')result=await setItemResolution(config,{projectId:packet.project_id,itemKey:packet.item_key,action:packet.action,reason:packet.reason,note:packet.note,source:packet.source,sourceEventId:id});
   else if(packet.operation==='item-schedule')result=await setItemSchedule(config,{projectId:packet.project_id,itemKey:packet.item_key,due:packet.due,reviewAfter:packet.review_after,...(packet.repeat!==undefined?{repeat:packet.repeat}:{}),source:packet.source,sourceEventId:id});
   else if(packet.operation==='item-occurrence')result=await completeOccurrence(config,{projectId:packet.project_id,itemKey:packet.item_key,action:packet.action,due:packet.due,source:packet.source,sourceEventId:id});
   else if(packet.operation==='item-hint-dismiss')result=await dismissResolutionHint(config,{projectId:packet.project_id,itemKey:packet.item_key,inputId:packet.input_id,source:packet.source,sourceEventId:id});
   else if(packet.operation==='git-draft-dismiss')result=await dismissGitDraft(config,{draftId:packet.draft_id,expectedHash:packet.draft_hash,source:packet.source,sourceEventId:id});
   else if(packet.operation==='project-create')result=await createProject(config,{projectId:packet.project_id,title:packet.title,aliases:packet.aliases,keywords:packet.keywords,firstMemo:packet.text,occurredAt:packet.occurred_at,source:packet.source,sourceEventId:id});
   else if(packet.operation==='conflict-resolve')result=await resolveConflict(config,{target:packet.target,expectedHash:packet.target_hash,source:packet.source,sourceEventId:id});
   else if(packet.operation==='idea-link')result=await setIdeaLink(config,{ideas:packet.idea_ids,hashes:packet.idea_hashes,action:packet.action,source:packet.source,sourceEventId:id,decidedAt:packet.occurred_at});
   else if(packet.operation==='insight-reaction')result=await setInsightReaction(config,{runId:packet.run_id,itemKey:packet.item_key,reaction:packet.reaction,source:packet.source,sourceEventId:id,decidedAt:new Date(packet.occurred_at).toISOString()});
   else if(packet.operation==='project-merge'||packet.operation==='project-unmerge')result=await (packet.operation==='project-merge'?mergeProjects:unmergeProject)(config,{fromId:packet.project_id,intoId:packet.into_id,fromHash:packet.project_hash,intoHash:packet.into_hash,source:packet.source,sourceEventId:id});
   else if(packet.operation==='person-definition')result=await setPerson(config,{personId:packet.person_id,action:packet.action,...(packet.name!==undefined?{name:packet.name}:{}),...(packet.aliases!==undefined?{aliases:packet.aliases}:{}),...(packet.person_hash?{expectedHash:packet.person_hash}:{}),source:packet.source,sourceEventId:id});
   else if(packet.operation==='client-preferences')result=await setClientPreferences(config,{payload:parsePreferencesPayload(packet.text),source:packet.source,sourceEventId:id});
   else if(packet.operation==='ask')result=await requestAnswer(config,{question:packet.text,...(packet.project?{project:packet.project}:{}),source:packet.source,sourceEventId:id,askedAt:new Date(packet.occurred_at).toISOString()});
   else if(packet.operation==='policy-keep')result=await keepPolicy(config,{knowledgeId:packet.knowledge_id,expectedHash:packet.knowledge_hash,source:packet.source,sourceEventId:id,reviewedAt:new Date(packet.occurred_at).toISOString()});
   else if(packet.operation==='knowledge-reject')result=await reject(config,packet.candidate_id,packet.candidate_hash);
   else if('confirmation_token'in packet)result=await decideProject(config,{candidateId:packet.candidate_id,expectedHash:packet.candidate_hash,confirmationToken:packet.confirmation_token,confirmed:packet.confirmed,action:packet.operation==='project-approve'?'approve':'reject',source:packet.source,sourceEventId:id,...(packet.cover_ids?{covers:packet.cover_ids.map((candidateId,i)=>({candidateId,expectedHash:packet.cover_hashes![i]!}))}:{})});
   else throw new Error('受付操作が不正です');
   const accepted=await vault.withLock(async()=>{
    const receipt={schema_version:1,request_id:id,request_hash:requestHash,path,operation:packet.operation,status:'accepted',received_at:new Date().toISOString(),result};
    // 受領記録を作った後は停止回復記録が要らないため、同じロック内で片付ける（間で停止しても次の受付で片付ける）。
    if(await vault.create(ackPath(id),JSON.stringify(receipt,null,2)+'\n')){await vault.remove(pendingPath(id));return true;}
    const existing=intakeReceiptSchema.parse(JSON.parse((await vault.read(ackPath(id)))!));if(existing.request_hash!==requestHash)throw new Error('conflict');await vault.remove(pendingPath(id));return false;
   });
   if(accepted)outcome.accepted++;else outcome.deduped++;
  }catch(error){
   // Writerの混雑でロックを取れなかった回は、依頼の誤りではないため記録せず保留にする（停止回復記録があれば次回に続ける）。
   if(error instanceof LockTimeoutError){outcome.deferred++;continue;}
   // NOWの項目の状態による拒否は、codeにも本人向けの文を入れる（理由を知らない版のアプリはcodeをそのまま示すため）。
   const conflict=error instanceof Error&&(error.message==='conflict'||error.message==='event-conflict');
   const reason=error instanceof CorrectionTargetError||error instanceof ProjectCreateError||error instanceof ConflictResolveError||error instanceof IdeaLinkError||error instanceof InsightReactionError||error instanceof HappenedOnError||error instanceof PolicyReviewError||error instanceof ProjectMergeError||error instanceof ProjectMergedError||error instanceof ItemTargetError||error instanceof OccurrenceError||error instanceof PreferencesError||error instanceof AskError||error instanceof PersonDefinitionError?error.reason:undefined;
   await problem(path,requestHash,conflict?'conflict':'error',conflict?'同じ受付IDの内容またはイベントが一致しません':error instanceof ItemTargetError?itemTargetMessage(error.reason):error instanceof PersonDefinitionError?personReasonMessage(error.reason):error instanceof OccurrenceError?occurrenceMessage(error.reason):error instanceof PreferencesError?preferencesMessage(error.reason):error instanceof AskError?askReasonMessage(error.reason):error instanceof HappenedOnError||error instanceof PolicyReviewError?error.message:'受付操作が未完了です。対象・確認情報・停止回復をdoctorで確認してください',attempted,reason);
   // 理由付きの拒否は同じ内容では結果が変わらず、停止回復も要らない。停止回復記録を残すと「回復待ち」がdoctorに残り続けるため片付ける。
   if(reason&&!conflict)await dropPending(id,path,requestHash);
  }
 }
 return outcome;
}
