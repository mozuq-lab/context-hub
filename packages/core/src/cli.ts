#!/usr/bin/env node
import {readPolicies,formatPolicies,rebuildPoliciesLocked,resolvePolicyProject,policyProjectFor} from './policies.js';
import {retireKnowledge} from './knowledge-retirement.js';
import {keepPolicy,policyReviewItems,policyReviewDays} from './policy-reviews.js';
import {readInputs} from './capture.js';
import { Command, Option } from 'commander';
import { open } from 'node:fs/promises';
import { loadConfig, type ConfigOverrides } from './config.js';
import { capture } from './capture.js';
import { correctInput } from './corrections.js';
import { listProjectCandidates,decideProject } from './project-proposals.js';
import { ingest, writeIntakeFeaturesLocked } from './intake.js';
import { runCycle } from './cycle.js';
import { rebuildDashboard } from './dashboard.js';
import { rebuildDigest } from './digest.js';
import { rebuildReferences } from './references.js';
import { setProjectStatus,projectStatuses,lifecycleOf } from './project-status.js';
import { setProjectDefinition,editDefinition,normalizeDefinition,definitionErrorMessage } from './project-definition.js';
import { mergeProjects,unmergeProject,readProjectMerges } from './project-merges.js';
import { readProjectCatalog } from './knowledge-scope.js';
import { setItemResolution,readNowItems,readItemResolutions,activeResolutions,exclusionReasons,exclusionReasonLabels,itemKey,UNASSIGNED_SCOPE } from './item-resolutions.js';
import { ACTION_TEXT_CHARS } from './actions.js';
import { moveAction } from './action-moves.js';
import { setItemEffort,readItemEfforts,itemEfforts,itemEffortLabels,type ItemEffort } from './item-efforts.js';
import { setItemSteps,readItemSteps,stepsLabel,ITEM_STEPS_MIN,ITEM_STEPS_MAX } from './item-steps.js';
import { setItemContexts,readItemContexts,CONTEXT_TAGS_MAX,CONTEXT_TAG_CHARS } from './item-contexts.js';
import { setItemWait,readItemWaits,effectiveWaits,WAIT_WHO_CHARS,type ItemWaiting } from './item-waits.js';
import { setItemSomeday,readItemSomedays,effectiveSomedays,type ItemSomeday } from './item-somedays.js';
import { buildSomedayList,setSomedayReview,somedayStale,readSomedayReviews,SOMEDAY_REVIEW_DAYS,type SomedayReviewAction } from './someday.js';
import { buildWeeklyReview,daysSinceWeeklyReview,setWeeklyReview,WEEKLY_REVIEW_INTERVAL_DAYS } from './weekly-review.js';
import { setItemSchedule,readItemSchedules,activeSchedules,effectiveSchedules,completeOccurrence,readItemOccurrences,repeatLabel,todayIn,REPEAT_EVERY_MAX,type RepeatRule } from './item-schedules.js';
import { rebuildHistories } from './history.js';
import { dismissResolutionHint } from './resolution-hints.js';
import { collectGitDrafts,readGitDrafts,useGitDraft,dismissGitDraft } from './git-drafts.js';
import { Vault, unlockVault, LOCK_SCOPES, hash, releaseLocksOnSignal } from './storage.js';
import { addProject, readProjects, resolveProject } from './projects.js';
import { find, findKinds, recent, pending, resume, context, bundle, bundleMaxIds, type FindKind } from './retrieve.js';
import { doctor } from './doctor.js';
import { setPerson,inspectPeople,buildPerson,rebuildPeople } from './people.js';
import { userFacingError } from './error-message.js';
import { writePrivacyPatternsLocked } from './secrets.js';
import { verifyBackup,readBackupChecks,backupStatus } from './backup-check.js';
import { rebuildIdeaIndexLocked,setIdeaLink } from './idea-links.js';
import { listConflicts,resolveConflict } from './conflicts.js';
import { organize } from './organize.js';
import { setProjectArea } from './project-areas.js';
import { AREA_CHARS } from './areas.js';
import { requestOrganizeRetry } from './organize-retries.js';
import { readReceipts } from './views.js';
import { previewSynthesis,runSynthesis,synthesisLlmConfig } from './synthesis.js';
import { MockLlm } from './llm.js';
import { answerQuestion,askSourcesFrom,formatAnswer,selectAskSources } from './ask.js';
import { readEffectiveInputs } from './effective-inputs.js';
import { OpenClawInferLlm } from './infer.js';
import { listCandidates, approve, reject, propose } from './approvals.js';
import type { HubConfig } from './types.js';

const program = new Command().name('ctx').description('Markdownを正本とする個人用AI Context Hub').version('0.1.0')
  .option('--config <path>', '設定ファイル').option('--vault <path>', '明示的な保存先').option('--state <path>', 'Vault外のローカル状態');
const output = (value: unknown): void => { process.stdout.write(typeof value === 'string' ? value.replace(/\n?$/, '\n') : JSON.stringify(value,null,2)+'\n'); };
async function config(overrides:ConfigOverrides={}): Promise<HubConfig> {
  const opts=program.opts();
  return loadConfig(opts.config,{...(opts.vault?{vaultPath:opts.vault}:{}),...(opts.state?{statePath:opts.state}:{}),...overrides});
}
function positive(value:string): number { const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new Error('正の整数を指定してください');return n; }
/** CLIで書く望む結果。引数の中の「\\n」を改行として読み、「\\\\」は「\\」1つとして読む（「C:\\\\new」のように書ける）。 */
const outcomeArg=(value:string)=>value.replace(/\\([\\n])/g,(_,c:string)=>c==='n'?'\n':'\\');
async function inputText(text:string|undefined, file:string|undefined,max:number):Promise<string> {
  if(text!==undefined&&file)throw new Error('本文と --file は同時に指定できません');
  if(text!==undefined)return text;
  const stream=file? (await open(file,'r')).createReadStream():process.stdin;
  if(!file&&process.stdin.isTTY)throw new Error('本文、--file、または標準入力が必要です');
  const chunks:Buffer[]=[];let size=0;
  try { for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>max*4)throw new Error('入力が文字数上限を超えています');chunks.push(bytes);} }
  finally{if(file)stream.destroy();}
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error('文字コードがUTF-8ではありません。変換してから取り込んでください'); }
}
program.command('init').description('保存先を初期化（既存ノートは保持）').action(async()=>{const c=await config();const vault=new Vault(c);await vault.init();await vault.withLock(async()=>{await rebuildPoliciesLocked(c,vault);await writePrivacyPatternsLocked(c,vault);await writeIntakeFeaturesLocked(c,vault);});output({vaultPath:c.vaultPath,initialized:true});});
program.command('add [text]').description('原文を保存').option('--file <path>','Markdown/テキストファイル')
  .option('--event-id <id>','再送判定用ID').option('--source <name>','出典名').option('--occurred-at <iso>','タイムゾーン付き発生日時').option('--happened-on <date>','後から記録する出来事の日付（YYYY-MM-DD。記録した日から設定のcapture.maxBackdateDays日前まで）')
  .addOption(new Option('--kind <kind>','入力の種別').choices(['memo','work-summary']).default('memo'))
  .option('--project <id>','人が指定する既存プロジェクト').option('--tool <name>','作業したAI/ツール').option('--session <reference>','元セッションの参照先')
  .option('--continues <input-id>','続きとして書く前のメモの入力ID（--projectを省くと、前のメモで指定したプロジェクトを引き継ぐ）')
  .action(async(text,opts)=>{const c=await config();const body=await inputText(text,opts.file,c.capture.maxInputChars);output(await capture(c,{text:body,source:opts.source??(opts.file?'file':text!==undefined?'cli':'stdin'),sourceEventId:opts.eventId,occurredAt:opts.occurredAt??new Date().toISOString(),kind:opts.kind,project:opts.project,tool:opts.tool,meta:opts.session?{session:opts.session}:undefined,happenedOn:opts.happenedOn,...(opts.continues!==undefined?{continues:opts.continues}:{})}));});
const project=program.command('project').description('人によるプロジェクト管理');
program.command('correct <id> [text]').description('元原文を保持して最新入力を訂正').option('--file <path>','訂正文ファイル').option('--event-id <id>','再送判定ID').option('--source <name>','出典名','cli-correction')
  .action(async(id,text,opts)=>{const c=await config();output(await correctInput(c,id,{text:await inputText(text,opts.file,c.capture.maxInputChars),source:opts.source,sourceEventId:opts.eventId,occurredAt:new Date().toISOString()}));});
project.command('add <id>').requiredOption('--title <text>','プロジェクト名').option('--aliases <csv>','別名、カンマ区切り').option('--keywords <csv>','検索語、カンマ区切り').option('--outcome <text>','望む結果（何をもって完了か。改行は\\nで書けます）')
  .action(async(id,opts)=>output(await addProject(await config(),{id,title:opts.title,aliases:opts.aliases?.split(',')??[],keywords:opts.keywords?.split(',')??[],...(opts.outcome!==undefined?{outcome:outcomeArg(opts.outcome)}:{})})));
project.command('list').description('定義・状態・確認用ハッシュを一覧').action(async()=>{const c=await config();const projects=await readProjects(c),catalog=await readProjectCatalog(new Vault(c));output(projects.map(p=>({...p,lifecycle:lifecycleOf(p),hash:catalog.find(x=>x.id===p.id)?.hash})));});
project.command('status <id>').description('本人の判断でプロジェクトを進行中・休止・完了に切り替える').addOption(new Option('--set <status>','新しい状態').choices([...projectStatuses]).makeOptionMandatory()).requiredOption('--hash <sha256>','project listで確認したproject.mdのハッシュ').requiredOption('--confirm','定義を確認した本人による変更').action(async(id,opts)=>{const c=await config();// 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
const result=await setProjectStatus(c,{projectId:id,status:opts.set,expectedHash:opts.hash,source:'cli',sourceEventId:`cli:${id}:${opts.hash}:${opts.set}`});await rebuildDashboard(c);output(result);});
project.command('area <id>').description('本人の判断でプロジェクトに領域（責任範囲。例: 仕事・家）を付ける・外す。HOMEと週次レビューで領域ごとにまとめて見る。AIは付けず、帰属の推定にも使わない').option('--set <area>',`領域（${AREA_CHARS}文字以内）`).option('--clear','領域を外す').requiredOption('--hash <sha256>','project listで確認したproject.mdのハッシュ').requiredOption('--confirm','定義を確認した本人による変更').action(async(id,opts)=>{if((opts.set===undefined)===(opts.clear!==true))throw new Error('--setか--clearのどちらかを指定してください');const c=await config(),area=opts.clear?null:String(opts.set).normalize('NFC');
// 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
const result=await setProjectArea(c,{projectId:id,area,expectedHash:opts.hash,source:'cli',sourceEventId:`cli:${id}:${opts.hash}:area:${area??''}`});await rebuildDashboard(c);output(result);});
const collect=(value:string,previous:string[])=>[...previous,value];
project.command('edit <id>').description('本人の確認でプロジェクトの名前・別名・キーワード・望む結果を書き換える（帰属未確定のメモは次のcycleで再関連付けの対象になる）')
  .option('--title <text>','新しい名前').option('--outcome <text>','新しい望む結果（何をもって完了か。改行は\\nで書けます）').option('--clear-outcome','望む結果を外す').option('--add-alias <text>','追加する別名（複数指定可）',collect,[]).option('--remove-alias <text>','削除する別名（複数指定可）',collect,[])
  .option('--add-keyword <text>','追加するキーワード（複数指定可）',collect,[]).option('--remove-keyword <text>','削除するキーワード（複数指定可）',collect,[])
  .requiredOption('--hash <sha256>','project listで確認したproject.mdのハッシュ').requiredOption('--confirm','定義を確認した本人による変更')
  .action(async(id,opts)=>{const c=await config(),current=(await readProjects(c)).find(p=>p.id===id);if(!current)throw new Error('プロジェクトが見つかりません');
   if(opts.outcome!==undefined&&opts.clearOutcome)throw new Error('--outcomeと--clear-outcomeは同時に指定できません');
   const outcome=opts.clearOutcome?'':opts.outcome!==undefined?outcomeArg(opts.outcome):undefined;
   const edited=editDefinition({title:current.title,aliases:current.aliases,keywords:current.keywords,...(current.outcome!==undefined?{outcome:current.outcome}:{})},{title:opts.title,addAliases:opts.addAlias,removeAliases:opts.removeAlias,addKeywords:opts.addKeyword,removeKeywords:opts.removeKeyword,...(outcome!==undefined?{outcome}:{})});
   // 望む結果を指定しないときは送らない（手で書いた望む結果を正規化で書き換えない）。
   if(outcome===undefined)delete edited.outcome;
   let next;try{next=normalizeDefinition(edited);}catch(error){throw new Error(definitionErrorMessage(error));}
   // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
   const result=await setProjectDefinition(c,{projectId:id,expectedHash:opts.hash,...next,source:'cli',sourceEventId:`cli:${id}:${opts.hash}:${hash(JSON.stringify(next))}`});await rebuildDashboard(c);output({...result,definition:next});});
// 同じ引数での再実行（途中で止まった操作の回復）には、最後の記録と同じ受付IDを使う。
// 取り消した後にもう一度統合するときは定義が同じhashへ戻るため、最後の記録のIDを含めて別の操作にする。
async function mergeEventId(c:HubConfig,action:'merge'|'unmerge',from:string,into:string,fromHash:string,intoHash:string):Promise<string>{
 const last=(await readProjectMerges(new Vault(c))).filter(m=>m.from_id===from).at(-1);
 if(last&&last.source==='cli'&&last.source_event_id&&last.action===action&&last.into_id===into&&last.from_before_hash===fromHash&&last.into_before_hash===intoHash)return last.source_event_id;
 return `cli:${action}:${hash(JSON.stringify([from,into,fromHash,intoHash,last?.id??'none']))}`;
}
project.command('merge <from>').description('同じものを指すプロジェクトを、本人の確認で統合先へまとめる（統合元の入力・完了報告・日付は統合先のものとして読み替える。原文と記録は動かさない）')
  .requiredOption('--into <id>','統合先のプロジェクト').requiredOption('--hash <sha256>','project listで確認した統合元のproject.mdのハッシュ').requiredOption('--into-hash <sha256>','project listで確認した統合先のproject.mdのハッシュ').requiredOption('--confirm','2つの定義を確認した本人による統合')
  // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
  .action(async(id,opts)=>{const c=await config();const result=await mergeProjects(c,{fromId:id,intoId:opts.into,fromHash:opts.hash,intoHash:opts.intoHash,source:'cli',sourceEventId:await mergeEventId(c,'merge',id,opts.into,opts.hash,opts.intoHash)});await rebuildDashboard(c);output(result);});
project.command('unmerge <from>').description('統合を取り消し、統合元を統合前の状態へ戻す（統合で統合先へ足した別名・キーワードのうち残っているものを外す）')
  .requiredOption('--hash <sha256>','project listで確認した統合元のproject.mdのハッシュ').requiredOption('--into-hash <sha256>','project listで確認した統合先のproject.mdのハッシュ').requiredOption('--confirm','2つの定義を確認した本人による取り消し')
  .action(async(id,opts)=>{const c=await config(),from=(await readProjects(c)).find(p=>p.id===id);if(!from)throw new Error('プロジェクトが見つかりません');
   // 統合先は定義から読む。取り消しの途中で止まった後の再実行では定義から消えているので、最後の統合の記録から求める。
   const into=from.merged_into??(await readProjectMerges(new Vault(c))).filter(m=>m.from_id===id).at(-1)?.into_id;if(!into)throw new Error('このプロジェクトは統合されていません');
   const result=await unmergeProject(c,{fromId:id,intoId:into,fromHash:opts.hash,intoHash:opts.intoHash,source:'cli',sourceEventId:await mergeEventId(c,'unmerge',id,into,opts.hash,opts.intoHash)});await rebuildDashboard(c);output(result);});
project.command('candidates').action(async()=>output(await listProjectCandidates(await config())));
for(const action of ['approve','reject'] as const){const command=project.command(`${action} <id>`).requiredOption('--hash <sha256>','確認した候補のハッシュ').requiredOption('--token <token>','候補の確認トークン').requiredOption('--confirm','候補詳細を読んだ人の明示確認');
 // 採用するときは、望む結果を本人が書き添えられる（AIの案には含めない）。
 if(action==='approve')command.option('--outcome <text>','作るプロジェクトの望む結果（改行は\\nで書けます）');
 command.action(async(id,opts)=>output(await decideProject(await config(),{candidateId:id,expectedHash:opts.hash,confirmationToken:opts.token,confirmed:opts.confirm,action,source:'cli',sourceEventId:`cli:${id}:${action}`,...(opts.outcome!==undefined?{outcome:outcomeArg(opts.outcome)}:{})})));}
const item=program.command('item').description('NOWの次の一手・未解決を、本人の確認で完了・解決にする、誤りとして外す、または未解決へ戻す');
item.command('list <project>').description('直近に生成したNOWの項目とキーを表示').action(async id=>{const items=await readNowItems(new Vault(await config()),id);if(!items)throw new Error('NOW項目の記録がありません。cycleを実行してください');output(items.items.map(i=>({key:i.key,section:i.section,text:`${i.label}${i.text}`,input_id:i.input_id,resolved:i.resolution&&i.resolution.action!=='exclude'?i.resolution.id:null,...(i.resolution?.action==='exclude'?{excluded:{id:i.resolution.id,reason:i.resolution.reason,note:i.resolution.note??null}}:{}),due:i.schedule?.due??null,review_after:i.schedule?.review_after??null,repeat:i.schedule?.repeat?repeatLabel(i.schedule.repeat):null,effort:i.effort??null,contexts:i.contexts??[],steps:i.steps?{items:i.steps.items,done:i.steps.done,current:stepsLabel(i.steps)}:null,waiting:i.waiting?{since:i.waiting.since,who:i.waiting.who??null}:null,someday:i.someday?{since:i.someday.since,reviewed:i.someday.reviewed}:null,...(i.hints?.length?{maybe_done:i.hints.map(h=>({input_id:h.input_id,quote:h.quote}))}:{}),...(i.action?{added_by_person:true,...(i.action.from?{from:i.action.from}:{})}:{})})));});
for(const action of ['resolve','reopen'] as const)item.command(`${action} <project> <key>`).description(action==='resolve'?'項目を完了・解決にする':'解決済み、または誤りとして外した項目を未解決へ戻す').requiredOption('--confirm','項目を確認した本人による報告').action(async(id,key,_opts)=>{const c=await config(),vault=new Vault(c);
// 直前の記録を含めて受付IDにする。直前がCLIの同じ操作なら同じ受付IDで再送し、記録後の停止から回復する。
const last=(await readItemResolutions(vault)).filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.action===action&&last.source_event_id?last.source_event_id:`cli:${key}:${action}:${last?.id??'none'}`;const result=await setItemResolution(c,{projectId:id,itemKey:key,action,source:'cli',sourceEventId:event});await rebuildDashboard(c);output(result);});
item.command('exclude <project> <key>').description(`AIの読み違いなどの誤りとして項目を外す（完了・解決とは数えない）。理由: ${exclusionReasons.map(r=>`${r}=${exclusionReasonLabels[r]}`).join('、')}。読み違いと、AIが推定した帰属への「別のプロジェクトの話」は、次のcycleで元のメモを読み直す`).addOption(new Option('--reason <reason>','外す理由').choices([...exclusionReasons]).makeOptionMandatory()).option('--note <text>','一言（200文字以内・1行。次からの整理でAIへ渡す）').requiredOption('--confirm','項目を確認した本人による報告').action(async(id,key,opts)=>{const c=await config(),vault=new Vault(c);
// 完了報告と同じく、直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const last=(await readItemResolutions(vault)).filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.action==='exclude'&&last.reason===opts.reason&&last.note===opts.note&&last.source_event_id?last.source_event_id:`cli:${key}:exclude:${last?.id??'none'}`;const result=await setItemResolution(c,{projectId:id,itemKey:key,action:'exclude',reason:opts.reason,note:opts.note,source:'cli',sourceEventId:event});await rebuildDashboard(c);output(result);});
// 本人が決めた行動を、モデルを通さずにNOWの次の一手へ載せる。AIが読み取った行を行動にするときは、元の行を--from-key（キー付きの項目）か--fromと--from-text（提案）で示す。
item.command('add <project> [text]').description(`本人が決めた行動を次の一手に追加する（1行・${ACTION_TEXT_CHARS}文字以内。モデルを使わない）。projectを${UNASSIGNED_SCOPE}にすると、プロジェクト未定の次の一手に追加する。AIが読み取った行を行動にするときは元の行を指定し、textを省くと元の本文のまま追加する`)
  .option('--from-key <key>','行動にするNOWの項目のキー（item listで確認）').option('--from <input-id>','行動にする提案の根拠の入力ID').option('--from-text <text>','行動にする提案の本文（ラベルを除く）')
  .addOption(new Option('--effort <effort>','一緒に付ける手間の目安').choices([...itemEfforts])).option('--context <tag>',`一緒に付ける場所・道具の札（1つずつ指定。繰り返して複数可・${CONTEXT_TAGS_MAX}個まで。同じ受付IDの再送では最初の札のまま）`,(v:string,p:string[]|undefined)=>[...(p??[]),v])
  .option('--event-id <id>','再送判定用ID（付けると、途中で止まった追加を同じIDで再送しても重複しない）').requiredOption('--confirm','文面を確認した本人による追加').action(async(id,text,opts)=>{const c=await config(),vault=new Vault(c);
  if(opts.fromKey!==undefined&&(opts.from!==undefined||opts.fromText!==undefined))throw new Error('--from-keyと--from・--from-textは同時に指定できません');
  if((opts.from===undefined)!==(opts.fromText===undefined))throw new Error('--fromと--from-textは組で指定してください');
  let from:{input_id:string;text:string;key?:string}|undefined=opts.from!==undefined?{input_id:opts.from,text:opts.fromText}:undefined;
  if(opts.fromKey!==undefined){const found=(await readNowItems(vault,id))?.items.find(i=>i.key===opts.fromKey);if(!found)throw new Error('NOWに該当する項目がありません。item listで確認してください');if(found.action)throw new Error('この項目は既に本人が追加した行動です');if(found.section!=='next')throw new Error('行動にできるのは次の一手の項目です（未解決は行動にできません）');if(found.resolution)throw new Error('この項目は既に完了・解決か、誤りとして外しています');from={input_id:found.input_id,text:found.text,key:found.key};}
  const body=text??from?.text;if(body===undefined)throw new Error('行動の文面を指定してください');
  // プロジェクト未定の置き場を指定したときは、プロジェクトを付けずに保存する（項目キーは置き場のもの）。
  const unassigned=id===UNASSIGNED_SCOPE;
  const result=await capture(c,{text:body,kind:'action',project:unassigned?undefined:id,source:'cli',sourceEventId:opts.eventId,occurredAt:new Date().toISOString(),...(from?{meta:{action_from_input:from.input_id,action_from_text:from.text,...(from.key?{action_from_key:from.key}:{})}}:{}),...(opts.effort!==undefined?{effort:opts.effort as ItemEffort}:{}),...(opts.context!==undefined?{contexts:opts.context as string[]}:{})});
  // 同じ受付IDの再送で、別の内容の入力が記録されていれば項目キーを示さない（--event-idを付けて再送すると重複しない）。
  const saved=(await readInputs(c)).find(i=>i.id===result.inputId);if(saved?.kind!=='action'||saved.text!==body||saved.project!==(unassigned?undefined:id))throw new Error('同じ受付IDで別の内容が記録されています。--event-idを確認してください');
  const key=itemKey(id,'next',result.inputId,body);await rebuildDashboard(c);output({...result,projectId:id,itemKey:key});});
// 本人が追加した行動を、別のプロジェクト・プロジェクト未定へ移す。期日・手間の目安などの記録は移した先の行動へ写り、元の行動は元の一覧から外れる。
item.command('move <project> <key> <to>').description(`本人が追加した行動を別の置き場へ移す（projectとtoはプロジェクトのIDか${UNASSIGNED_SCOPE}）。期日・見直す日・繰り返し・手間の目安・連絡待ち・「いつかやる」は移した先の行動に引き継ぐ。戻すときは、移した先の行動をもう一度移す`)
  .option('--event-id <id>','再送判定用ID（付けると、途中で止まった移動を同じIDで再送しても重複しない）').requiredOption('--confirm','行動と移す先を確認した本人による移動').action(async(id,key,to,opts)=>{const c=await config();
  const result=await moveAction(c,{from:id,itemKey:key,to,source:'cli',sourceEventId:opts.eventId,occurredAt:new Date().toISOString()});await rebuildDashboard(c);output(result);});
item.command('dismiss-hint <project> <key> <input-id>').description('「片付いたかも」が違うとき、そのメモからの候補を見送る（項目は未解決のまま）').requiredOption('--confirm','候補と引用を確認した本人による見送り').action(async(id,key,inputId,_opts)=>{const c=await config();const result=await dismissResolutionHint(c,{projectId:id,itemKey:key,inputId,source:'cli',sourceEventId:`cli:${key}:${inputId}:dismiss-hint`});await rebuildDashboard(c);output(result);});
/** 定例の繰り返しの指定。daily・weekly・monthly、またはN日・N週・Nか月ごと（例: 14d・2w・3m）。noneで外す。 */
function parseRepeat(value:string):RepeatRule|null{
 if(value==='none')return null;
 const named:Record<string,RepeatRule>={daily:{unit:'day',every:1},weekly:{unit:'week',every:1},monthly:{unit:'month',every:1}};
 if(named[value])return named[value]!;
 const m=/^(\d{1,2})([dwm])$/.exec(value),every=m?Number(m[1]):0;
 if(!m||every<1||every>REPEAT_EVERY_MAX)throw new Error(`繰り返しはdaily・weekly・monthly・none、または1〜${REPEAT_EVERY_MAX}の数とd・w・m（例: 14d・2w・3m）で指定してください`);
 return {unit:m[2]==='d'?'day':m[2]==='w'?'week':'month',every};
}
item.command('schedule <project> <key>').description('項目に期日・次に見直す日・繰り返しを付ける（noneで外す。指定しなかったものは今のものを保つ）').option('--due <date>','期日（YYYY-MM-DD、またはnone）').option('--review <date>','次に見直す日（YYYY-MM-DD、またはnone）。この日まではHOMEの一覧でたたむ').option('--repeat <rule>','定例の繰り返し（daily・weekly・monthly・14d・2w・3mなど、またはnone）。期日が必要').option('--clear','期日・見直す日・繰り返しをすべて外す').requiredOption('--confirm','項目を確認した本人による操作').action(async(id,key,opts)=>{
if(opts.clear&&(opts.due!==undefined||opts.review!==undefined||opts.repeat!==undefined))throw new Error('--clearと--due・--review・--repeatは同時に指定できません');
if(!opts.clear&&opts.due===undefined&&opts.review===undefined&&opts.repeat===undefined)throw new Error('--due・--review・--repeat・--clearのいずれかを指定してください');
const rule=opts.repeat===undefined?undefined:parseRepeat(opts.repeat);
const c=await config(),vault=new Vault(c),records=(await readItemSchedules(vault)).records,list=(await readNowItems(vault,id))?.items??[];
// 指定しなかった欄は、項目に今効いている日付（文面を直す前・引き継いだ記録を含む）から保つ。NOWから外れた記録はその記録から。
const current=(list.some(i=>i.key===key)?effectiveSchedules(records,id,list,activeResolutions(await readItemResolutions(vault),id)).byKey.get(key):undefined)??activeSchedules(records,id).get(key);
const pick=(value:string|undefined,kept:string|null)=>value===undefined?kept:value==='none'?null:value;
const due=opts.clear?null:pick(opts.due,current?.due??null),reviewAfter=opts.clear?null:pick(opts.review,current?.review_after??null);
// 直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const tag=rule===undefined?'keep':rule===null?'none':`${rule.every}${rule.unit}`;
const last=records.filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.due===due&&last.review_after===reviewAfter&&last.source_event_id?.endsWith(`:${tag}`)?last.source_event_id:`cli:${key}:schedule:${due??'-'}:${reviewAfter??'-'}:${last?.id??'none'}:${tag}`;
const result=await setItemSchedule(c,{projectId:id,itemKey:key,due,reviewAfter,...(opts.clear?{repeat:null}:rule!==undefined?{repeat:rule}:{}),source:'cli',sourceEventId:event});await rebuildDashboard(c);const saved=(await readItemSchedules(vault)).records.find(r=>r.id===result.scheduleId);output({...result,due,review_after:reviewAfter,repeat:saved?.repeat?repeatLabel(saved.repeat):null});});
item.command('effort <project> <key>').description(`項目に手間の目安を付ける（${itemEfforts.map(e=>`${e}=${itemEffortLabels[e]}`).join('、')}。noneで外す）。空いた時間に合う項目を選ぶ手掛かりにする。AIは推測しない`).addOption(new Option('--set <effort>','手間の目安').choices([...itemEfforts,'none']).makeOptionMandatory()).requiredOption('--confirm','項目を確認した本人による操作').action(async(id,key,opts)=>{const c=await config(),vault=new Vault(c);const effort=opts.set==='none'?null:opts.set as ItemEffort;
// 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const last=(await readItemEfforts(vault)).records.filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.effort===effort&&last.source_event_id?last.source_event_id:`cli:${key}:effort:${effort??'none'}:${last?.id??'none'}`;
const result=await setItemEffort(c,{projectId:id,itemKey:key,effort,source:'cli',sourceEventId:event});await rebuildDashboard(c);output({...result,effort});});
item.command('contexts <project> <key> [tags...]').description(`項目の場所・道具の札（例: 家・外出先・PC・電話）を、指定した札の全体に置き換える（${CONTEXT_TAGS_MAX}個まで・1つ${CONTEXT_TAG_CHARS}文字以内）。今いる場所や手元の道具でできる項目を選ぶ手掛かりにする。AIは付けない`).option('--clear','札をすべて外す').requiredOption('--confirm','項目を確認した本人による操作').action(async(id,key,tags:string[],opts)=>{
if(opts.clear&&tags.length)throw new Error('--clearと札は同時に指定できません');
if(!opts.clear&&!tags.length)throw new Error('札か--clearを指定してください');
const c=await config(),vault=new Vault(c),contexts=opts.clear?null:tags;
// 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const same=(a:string[]|null)=>a===null?contexts===null:contexts!==null&&a.join('\n')===contexts.join('\n');
const last=(await readItemContexts(vault)).records.filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&same(last.contexts)&&last.source_event_id?last.source_event_id:`cli:${key}:contexts:${last?.id??'none'}:${contexts===null?'none':hash(contexts.join('\n')).slice(0,16)}`;
const result=await setItemContexts(c,{projectId:id,itemKey:key,contexts,source:'cli',sourceEventId:event});await rebuildDashboard(c);output({...result,contexts:contexts??[]});});
item.command('steps <project> <key> [steps...]').description(`大きな次の一手を手順（${ITEM_STEPS_MIN}〜${ITEM_STEPS_MAX}個・1つ${ACTION_TEXT_CHARS}文字以内）に分ける。手順を指定すると全体を置き換えて最初からにし、--nextで今の手順を終えて次へ進め、--backで1つ戻す。NOW・HOMEには今の1歩だけが出る。AIは手順を作らない`).option('--next','今の手順を終えて次へ進める').option('--back','終えた手順を1つ戻す').option('--clear','手順を外す').requiredOption('--confirm','項目を確認した本人による操作').action(async(id,key,steps:string[],opts)=>{
const modes=[steps.length>0,opts.next===true,opts.back===true,opts.clear===true].filter(Boolean).length;if(modes!==1)throw new Error('手順・--next・--back・--clearのどれか1つを指定してください');
const c=await config(),vault=new Vault(c),items=(await readNowItems(vault,id))?.items??[],current=items.find(i=>i.key===key)?.steps;
let value:{items:string[];done:number}|null;
if(opts.clear)value=null;
else if(steps.length)value={items:steps.map(s=>s.trim()),done:0};
else{if(!current)throw new Error('この項目には手順がありません。先に手順を指定してください');const done=current.done+(opts.next?1:-1);if(done<0)throw new Error('まだ手順を1つも終えていません');if(done>current.items.length)throw new Error('手順はすべて終えています。項目を完了にするか、手順を付け直してください');value={items:current.items,done};}
// 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const last=(await readItemSteps(vault)).records.filter(r=>r.project_id===id&&r.item_key===key).at(-1),same=JSON.stringify(last?.steps??null)===JSON.stringify(value);
const event=last&&last.source==='cli'&&same&&last.source_event_id?last.source_event_id:`cli:${key}:steps:${last?.id??'none'}:${hash(JSON.stringify(value)).slice(0,16)}`;
const result=await setItemSteps(c,{projectId:id,itemKey:key,steps:value,source:'cli',sourceEventId:event});await rebuildDashboard(c);output({...result,steps:value,current:value?stepsLabel(value):null});});
item.command('wait <project> <key>').description(`項目に「連絡待ち」の印を付ける（人に頼んだこと・返事を待っていること）。印を付けた項目はHOMEの「次の一手」から外れ、「連絡待ち」にまとまる。見直す日（schedule --review）が来ると「次の一手」の先頭に確認として出る。AIは付けない`).option('--who <name>',`待っている相手（任意・${WAIT_WHO_CHARS}文字以内。HOMEとアプリにだけ示し、NOWとモデルへ渡す資料には載せない）`).option('--no-who','相手を外す').option('--since <date>','頼んだ日（YYYY-MM-DD。既定は、印が付いていれば今の頼んだ日、なければ今日）').option('--clear','印を外して元の欄へ戻す').requiredOption('--confirm','項目を確認した本人による操作').action(async(id,key,opts)=>{
if(opts.clear&&(opts.who!==undefined||opts.since!==undefined))throw new Error('--clearと--who・--sinceは同時に指定できません');
const c=await config(),vault=new Vault(c),records=(await readItemWaits(vault)).records;
// 既に印が付いている項目では、省いた相手・頼んだ日は今の印のままにする（相手だけ変えても待った日数を数え直さない）。
const list=(await readNowItems(vault,id))?.items??[],current=list.some(i=>i.key===key)?effectiveWaits(records,id,list,activeResolutions(await readItemResolutions(vault),id)).get(key):undefined;
const who=opts.who===false?undefined:opts.who!==undefined?String(opts.who):current?.who;
const waiting:ItemWaiting|null=opts.clear?null:{...(who!==undefined?{who}:{}),since:opts.since??current?.since??todayIn(c.timezone)};
// 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する（受付IDには相手の名前ではなく、内容の短いハッシュを入れる）。
const tag=waiting?hash(JSON.stringify(waiting)).slice(0,16):'none';
const last=records.filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.source_event_id?.startsWith(`cli:${key}:wait:${tag}:`)?last.source_event_id:`cli:${key}:wait:${tag}:${last?.id??'none'}`;
const result=await setItemWait(c,{projectId:id,itemKey:key,waiting,source:'cli',sourceEventId:event});await rebuildDashboard(c);output({...result,waiting});});
item.command('someday <project> <key>').description(`項目を「いつかやる」へ移す（今はやらないが残しておく）。移した項目はHOMEの「次の一手」の一覧・件数・期日の欄から外れ、「いつかやる」の一覧で${SOMEDAY_REVIEW_DAYS}日ごとに見直す。AIは移さない`).option('--keep','見直したが今は始めない（そのまま）。移した日は変えず、見直した日を今日にする').option('--clear','元の欄へ戻す（始める）').requiredOption('--confirm','項目を確認した本人による操作').action(async(id,key,opts)=>{
if(opts.keep&&opts.clear)throw new Error('--keepと--clearは同時に指定できません');
const c=await config(),vault=new Vault(c),records=(await readItemSomedays(vault)).records,today=todayIn(c.timezone);
const list=(await readNowItems(vault,id))?.items??[],current=list.some(i=>i.key===key)?effectiveSomedays(records,id,list,activeResolutions(await readItemResolutions(vault),id)).get(key):undefined;
if(opts.keep&&!current)throw new Error('この項目は「いつかやる」にありません。item listで確かめてください');
const someday:ItemSomeday|null=opts.clear?null:opts.keep?{since:current!.since,reviewed:today}:{since:today};
// 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const tag=someday?`${someday.since}:${someday.reviewed??someday.since}`:'none';
const last=records.filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.source_event_id?.startsWith(`cli:${key}:someday:${tag}:`)?last.source_event_id:`cli:${key}:someday:${tag}:${last?.id??'none'}`;
const result=await setItemSomeday(c,{projectId:id,itemKey:key,someday,source:'cli',sourceEventId:event});await rebuildDashboard(c);output({...result,someday});});
for(const action of ['done','skip'] as const)item.command(`${action}-round <project> <key>`).description(action==='done'?'定例の項目の今回を完了にし、期日を次の回へ進める（項目は残る）':'定例の項目の今回だけを見送り、期日を次の回へ進める').requiredOption('--confirm','項目と期日を確認した本人による報告').action(async(id,key)=>{const c=await config(),vault=new Vault(c),list=(await readNowItems(vault,id))?.items??[];
// 今の回はNOWではなく日付の記録から決める（次の回の記録を作った後、NOWの再生成の前に停止しても、記録どおりの回を示す）。
const current=list.find(i=>i.key===key)?effectiveSchedules((await readItemSchedules(vault)).records,id,list,activeResolutions(await readItemResolutions(vault),id)).byKey.get(key):undefined;
if(!current?.due||!current.repeat)throw new Error('この項目には繰り返しが付いていません。item listで確かめてください');
// 直前の回の記録がCLIの同じ回・同じ操作で、次の回の日付をまだ作れていなければ（記録後の停止）、同じ受付IDで再送して続きを作る。
const due=current.due,last=(await readItemOccurrences(vault)).records.filter(o=>o.project_id===id&&o.item_key===key).at(-1);
const resume=last&&last.source==='cli'&&last.due===due&&last.action===action&&last.source_event_id&&(await vault.read(`90_system/item-schedules/${last.schedule_id}.json`))===undefined;
const event=resume?last.source_event_id!:`cli:${key}:round:${due}:${action}:${last?.id??'none'}`;
const result=await completeOccurrence(c,{projectId:id,itemKey:key,action,due,source:'cli',sourceEventId:event});await rebuildDashboard(c);output(result);});
program.command('history [project]').description('プロジェクトの経緯HISTORY.mdを根拠と処理記録から作り直す（省略時は全プロジェクト）').action(async id=>output(await rebuildHistories(await config(),id?{projectId:id}:{})));
program.command('references [project]').description('プロジェクトの資料REFERENCES.md（AIが参考資料に分類したメモとURLの一覧）を整理結果から作り直す（省略時は全プロジェクト）').action(async id=>output(await rebuildReferences(await config(),id?{projectId:id}:{})));
const git=program.command('git').description('設定したローカルリポジトリのコミット履歴から作業記録の下書きを作る（既定は無効）');
git.command('collect').description('下書きを作ってHOMEを更新').action(async()=>{const c=await config();if(!c.git.enabled)throw new Error('設定のgit.enabledが無効です');const result=await collectGitDrafts(c);await rebuildDashboard(c);output(result);if(result.errors.length)process.exitCode=1;});
git.command('drafts').description('下書きの一覧').option('--all','入力済み・見送り済みも表示').action(async opts=>output((await readGitDrafts(await config())).filter(d=>opts.all||d.status==='pending').map(d=>({id:d.id,hash:d.hash,status:d.status,project:d.project_id,repo:d.repo,commits:d.commits.length,text:d.text,inputId:d.inputId??null}))));
git.command('use <id>').description('下書きの本文をそのまま入力にする').requiredOption('--hash <sha256>','git draftsで確認したハッシュ').addOption(new Option('--kind <kind>','入力の種類').choices(['memo','work-summary']).default('memo')).requiredOption('--confirm','本文を確認した本人による保存').action(async(id,opts)=>{const c=await config();const result=await useGitDraft(c,{draftId:id,expectedHash:opts.hash,kind:opts.kind,source:'cli'});await rebuildDashboard(c);output(result);});
git.command('dismiss <id>').description('下書きを見送る').requiredOption('--hash <sha256>','git draftsで確認したハッシュ').requiredOption('--confirm','本文を確認した本人による見送り').action(async(id,opts)=>{const c=await config();const result=await dismissGitDraft(c,{draftId:id,expectedHash:opts.hash,source:'cli',sourceEventId:`cli:${id}:dismiss`});await rebuildDashboard(c);output(result);});
const person=program.command('person').description('人ごとの見返し: 本人が登録した人の名前・呼び名が出てくる記録と未完了の項目を40_people/に集める（AIは使わない）');
// 変更は保存済みなので、一覧を作り直せなくても失敗にしない（次のcycleで作り直す）。
const peopleChanged=async(c:HubConfig)=>{try{await rebuildPeople(c);await rebuildDashboard(c);}catch(error){process.stderr.write(`警告: 変更は保存しましたが、一覧を作り直せませんでした（次のcycleで作り直します）: ${userFacingError(error)}\n`);}};
person.command('add <id>').description('人を登録する（IDは英小文字・数字・ハイフン）').requiredOption('--name <text>','名前').option('--aliases <csv>','呼び名、カンマ区切り')
  .action(async(id,opts)=>{const c=await config();const result=await setPerson(c,{personId:id,action:'add',name:opts.name,aliases:opts.aliases?.split(',')??[],source:'cli'});await peopleChanged(c);output(result);});
person.command('list').description('登録した人と確認用ハッシュを一覧').action(async()=>{const c=await config(),{people,issues,hashes}=await inspectPeople(new Vault(c));output({people:people.map(p=>({...p,hash:hashes.get(p.id)})),issues});});
person.command('show <id>').description('人ごとの見返しの本文を表示（書き込まない）').action(async id=>output(await buildPerson(await config(),id)));
person.command('edit <id>').description('本人の確認で名前・呼び名を書き換える')
  .option('--name <text>','新しい名前').option('--add-alias <text>','追加する呼び名（複数指定可）',collect,[]).option('--remove-alias <text>','削除する呼び名（複数指定可）',collect,[])
  .requiredOption('--hash <sha256>','person listで確認したperson.mdのハッシュ').requiredOption('--confirm','定義を確認した本人による変更')
  .action(async(id,opts)=>{const c=await config(),current=(await inspectPeople(new Vault(c))).people.find(p=>p.id===id);if(!current)throw new Error('人が見つかりません');
   const key=(s:string)=>s.normalize('NFKC').toLocaleLowerCase().trim(),removing=new Set((opts.removeAlias as string[]).map(key)),missing=(opts.removeAlias as string[]).filter(r=>!current.aliases.some(a=>key(a)===key(r)));
   if(missing.length)throw new Error(`削除する呼び名が定義にありません: ${missing.join('、')}`);
   // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
   const name=opts.name??current.name,aliases=[...current.aliases.filter(a=>!removing.has(key(a))),...opts.addAlias];
   const result=await setPerson(c,{personId:id,action:'edit',name,aliases,expectedHash:opts.hash,source:'cli',sourceEventId:`cli:${id}:${opts.hash}:edit:${hash(JSON.stringify([name,aliases]))}`});await peopleChanged(c);output(result);});
person.command('remove <id>').description('人の登録を外す（記録は消さず、手で変えていないSUMMARY.mdを消す）')
  .requiredOption('--hash <sha256>','person listで確認したperson.mdのハッシュ').requiredOption('--confirm','定義を確認した本人による変更')
  .action(async(id,opts)=>{const c=await config();const result=await setPerson(c,{personId:id,action:'remove',expectedHash:opts.hash,source:'cli',sourceEventId:`cli:${id}:${opts.hash}:remove`});await peopleChanged(c);output(result);});
const idea=program.command('idea').description('似ているアイデアを確認し、本人の判断で束ねる・別の話にする（AIは使わない）');
const ideaIndex=async()=>{const c=await config(),vault=new Vault(c);return vault.withLock(()=>rebuildIdeaIndexLocked(c,vault));};
idea.command('similar').description('未確認の似ているアイデアの組と、束ねるときに指定するハッシュ').action(async()=>{const index=await ideaIndex();output({total:index.total_candidates,candidates:index.candidates.map(x=>({ideas:x.ideas,score:x.score,hashes:x.hashes,summaries:x.ideas.map(id=>index.summaries[id]??'')}))});});
idea.command('groups').description('束ねたアイデアの一覧（先頭が代表）。linksは直接束ねた組で、束から外すにはこの組をseparateする').action(async()=>{const index=await ideaIndex();output(index.groups.map(g=>({representative:g.representative,ideas:g.ideas.map(id=>({id,summary:index.summaries[id]??''})),links:g.links})));});
idea.command('link <a> <b>').description('2件のアイデアを同じ話として束ねる').requiredOption('--hash-a <sha256>','idea similarで確認した1件目のハッシュ').requiredOption('--hash-b <sha256>','idea similarで確認した2件目のハッシュ').requiredOption('--confirm','内容を確認した本人による判断').action(async(a,b,opts)=>{const c=await config();const result=await setIdeaLink(c,{ideas:[a,b],hashes:[opts.hashA,opts.hashB],action:'link',source:'cli'});await rebuildDashboard(c);output(result);});
idea.command('separate <a> <b>').description('2件のアイデアを別の話として候補から外す（直接束ねた組なら束から外す）').requiredOption('--confirm','内容を確認した本人による判断').action(async(a,b)=>{const c=await config();const result=await setIdeaLink(c,{ideas:[a,b],action:'separate',source:'cli'});await rebuildDashboard(c);output(result);});
const someday=program.command('someday').description(`「いつかやる」の一覧（移した項目・休止中のプロジェクト・置いたアイデア）を見直す。最後に見直した日の古い順に並び、${SOMEDAY_REVIEW_DAYS}日以上見直していないものに印が付く。AIは置きも始めもしない`);
someday.command('list').description('「いつかやる」の一覧（最後に見直した日の古い順）').action(async()=>{const c=await config(),today=todayIn(c.timezone),list=await buildSomedayList(c,new Vault(c));output(list.entries.map(e=>({...e,stale:somedayStale(e,today)})));});
// 直前の記録を含めて受付IDにする。直前がCLIの同じ判断なら同じ受付IDで再送し、記録後の停止から回復する。
const somedayReview=async(target:'idea'|'project',id:string,action:SomedayReviewAction)=>{const c=await config(),vault=new Vault(c),on=todayIn(c.timezone),last=(await readSomedayReviews(vault)).records.filter(r=>r.target===target&&r.target_id===id).at(-1);
const event=last&&last.source==='cli'&&last.action===action&&last.on===on&&last.source_event_id?last.source_event_id:`cli:someday:${target}:${id}:${action}:${on}:${last?.id??'none'}`;
const result=await setSomedayReview(c,{target,targetId:id,action,on,source:'cli',sourceEventId:event});await rebuildDashboard(c);output(result);};
someday.command('idea <idea-id> <action>').description('アイデアを「いつかやる」に置く（add）・見直したが今は始めない（keep）・始めたので外す（start。プロジェクトか行動は別に作る）・やめて外す（drop）。アイデアのファイルは書き換えない').requiredOption('--confirm','アイデアを確認した本人による判断').action(async(id,action)=>{if(!['add','keep','start','drop'].includes(action))throw new Error('actionはadd・keep・start・dropのどれかです');await somedayReview('idea',id,action);});
someday.command('keep-project <project>').description('休止中のプロジェクトを見直し、今は再開しない（そのまま）と記録する。再開・完了はproject statusで切り替える').requiredOption('--confirm','プロジェクトを確認した本人による判断').action(async id=>somedayReview('project',id,'keep'));
const weekly=program.command('weekly-review').description(`週次レビュー: 確認待ち・プロジェクト未定の行動・進行中のプロジェクト・停滞・連絡待ち・期日・いつかやるを順に点検する。${WEEKLY_REVIEW_INTERVAL_DAYS}日以上見直していなければHOMEで促す。見直した記録は本人の報告だけで作る`);
weekly.command('show').description('点検の一覧（モデルを使わずに作る。アプリとREVIEW.mdの「週次レビューの点検」と同じ）').action(async()=>{const c=await config(),list=await buildWeeklyReview(c,new Vault(c));output({...list,days_since_last_review:daysSinceWeeklyReview(list,todayIn(c.timezone))});});
weekly.command('done').description('週次レビューを終えた（見直した）と記録し、HOMEとふりかえりを作り直す。同じ日の記録が既にあれば増やさない').option('--on <date>','見直した日（YYYY-MM-DD。既定は今日）').requiredOption('--confirm','点検を終えた本人による報告')
  .action(async opts=>{const c=await config(),on=opts.on??todayIn(c.timezone);const result=await setWeeklyReview(c,{on,source:'cli',sourceEventId:`cli:weekly-review:${on}`});await rebuildDigest(c);await rebuildDashboard(c);output(result);});
const conflict=program.command('conflict').description('生成物の競合（手で書き換えたNOW・HOME・REVIEW）を確認し、生成版へ戻す');
conflict.command('list').description('対象ごとの退避・手で変えた行・確認用ハッシュを表示').action(async()=>output(await listConflicts(await config())));
conflict.command('resolve <target>').description('手で変えた行をメモとして残し、最新の入力から作り直して退避を片付ける（例: 10_projects/<id>/NOW.md）').requiredOption('--hash <sha256>','conflict listで確認した対象のハッシュ').option('--no-memo','NOWの手で変えた行をメモとして保存しない（置き換えた全文は記録に残る）').requiredOption('--confirm','差分を確認した本人による操作').action(async(target,opts)=>{const c=await config();const result=await resolveConflict(c,{target,expectedHash:opts.hash,source:'cli',sourceEventId:`cli:conflict:${target}:${opts.hash}`,saveManualAsMemo:opts.memo});await rebuildDashboard(c);output(result);});
program.command('organize').description('未処理入力を整理').option('--limit <n>','処理上限',positive).option('--dry-run','対象一覧のみ。モデル/書き込みなし').option('--retry-failed','失敗分を再処理').option('--id <id>','指定入力を処理').option('--quiet-empty','0件時にNO_REPLYを返す')
  .addOption(new Option('--thinking <level>','推論の思考水準。設定organize.llm.thinkingを上書き').choices(['off','minimal','low','medium','high']))
  .action(async opts=>{const c=await config(opts.thinking?{organize:{llm:{thinking:opts.thinking}}}:{});const llm=c.organize.llm.provider==='mock'?new MockLlm():new OpenClawInferLlm(c.organize.llm);const result=await organize(c,llm,{limit:opts.limit,dryRun:opts.dryRun,retryFailed:opts.retryFailed,id:opts.id});output(opts.quietEmpty&&result.processed===0&&result.failed===0?'NO_REPLY':result);if(result.failed>0)process.exitCode=1;});
program.command('find [query]').description('原文・アイデア・知識・NOWを検索。絞り込み条件があれば検索語は省略可').option('--project <id>','このプロジェクトに帰属・関連する記録だけ（AI推定は区別して表示）')
  .option('--kind <kinds>',`種類、カンマ区切り（${findKinds.join(', ')}）`).option('--since <date>','この日付（YYYY-MM-DD、JST）または日時以降').option('--until <date>','この日付（YYYY-MM-DD、JST）または日時以前')
  .addOption(new Option('--sort <order>','並び順。検索語がなければnewest').choices(['relevance','newest'])).option('--limit <n>','表示件数（1〜200、既定50）',positive).option('--offset <n>','先頭から飛ばす件数',(v:string)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw new Error('開始位置は0以上の整数にしてください');return n;})
  .action(async(query,opts)=>output(await find(await config(),query??'',{project:opts.project,kinds:opts.kind?.split(',').map((k:string)=>k.trim()).filter(Boolean) as FindKind[]|undefined,since:opts.since,until:opts.until,sort:opts.sort,limit:opts.limit,offset:opts.offset,pagingHint:true})));
program.command('ask <question...>').description('記録だけを根拠に、問いへ引用付きで答える（AI生成・未検証。引用は記録と一致するものだけを残す）。整理と同じモデルを1回呼ぶ').option('--project <id>','このプロジェクトに帰属・関連する記録から答える').option('--dry-run','根拠の候補として渡す記録だけを表示。モデルは呼ばない').option('--json','JSONで出力')
  .action(async(words:string[],opts)=>{const c=await config(),question=words.join(' ');
  if(opts.dryRun){let project=opts.project as string|undefined;if(project!==undefined){const projects=await readProjects(c);if(!projects.some(p=>p.id===project))throw new Error('プロジェクトが見つかりません');project=resolveProject(projects,project);}
   const chosen=selectAskSources(question,askSourcesFrom(await readEffectiveInputs(c),c),{project,limit:c.ask.maxSources});output(chosen.length?chosen.map(s=>`- ${s.ref} ${s.inputId} | ${s.occurredAt} | ${s.text.slice(0,80).replace(/\r?\n/g,' ')}`).join('\n'):'問いに近い記録が見つかりません');return;}
  if(!c.ask.enabled)throw new Error('記録に聞くは無効です。設定のask.enabledをtrueにしてください');
  const llm=c.organize.llm.provider==='mock'?new MockLlm():new OpenClawInferLlm(c.organize.llm),answer=await answerQuestion(c,llm,question,opts.project?{project:opts.project}:{});
  if(opts.json){output({question,...answer});}else{const paths=new Map((await readEffectiveInputs(c)).flatMap(u=>[u.chain.root,...u.chain.revisions].map(i=>[i.id,i.path] as [string,string])));output(formatAnswer(question,answer,paths));}
  if(answer.status==='failed')process.exitCode=1;});
program.command('retry-organize <input-id>').description('整理（AIの読み取り）に失敗したメモ1件のやり直しを頼み、次の整理（cycle）で1回だけ試す。organize --retry-failedと違い、選んだ1件だけを対象にし、organize.maxAttemptsには縛られない').requiredOption('--confirm','失敗したメモを確認した本人による依頼').action(async(id)=>{const c=await config();const receipt=(await readReceipts(c)).find(r=>r.input_id===id);const result=await requestOrganizeRetry(c,{inputId:id,attempts:receipt?.attempts??1,source:'cli'});await rebuildDashboard(c);output(result);});
program.command('ingest').description('同期受付ファイルを正式保存').option('--limit <n>','受付操作の上限',positive).option('--dry-run','書き込みなし').action(async opts=>{const result=await ingest(await config(),{limit:opts.limit,dryRun:opts.dryRun});output(result);if(result.rejected)process.exitCode=1;});
program.command('digest').description('直近の期間のふりかえりREVIEW.mdを生成').option('--days <n>','集計日数（既定は設定のretrieve.digestDays）',positive).action(async opts=>output(await rebuildDigest(await config(),opts.days?{days:opts.days}:{})));
program.command('dashboard').description('プロジェクト一覧と処理状況のHOMEを生成').action(async()=>output(await rebuildDashboard(await config())));
/** 週次の統合に使うモデル。接続先は整理と同じで、思考の深さと出力の上限は統合用の設定を使う。 */
const synthesisClient=(c:HubConfig)=>c.organize.llm.provider==='mock'?new MockLlm():new OpenClawInferLlm(synthesisLlmConfig(c));
program.command('synthesize').description('週次の統合を実行（たまったメモをまとめて読み直し、気づきをふりかえりとHOMEへ出す）。設定のsynthesis.enabledが必要').option('--force','間隔・新しい入力の有無にかかわらず実行').option('--dry-run','渡す件数と送る量だけを表示。モデル/書き込みなし')
  .addOption(new Option('--thinking <level>','思考の深さ。設定synthesis.thinkingを上書き').choices(['off','minimal','low','medium','high']))
  .action(async opts=>{const c=await config(opts.thinking?{synthesis:{thinking:opts.thinking}}:{});if(opts.dryRun){output(await previewSynthesis(c,{force:opts.force===true}));return;}if(!c.synthesis.enabled)throw new Error('週次の統合は無効です。設定のsynthesis.enabledをtrueにしてから実行してください');const result=await runSynthesis(c,synthesisClient(c),{force:opts.force===true});if(result.ran){await rebuildDigest(c);await rebuildDashboard(c);}output(result);if(result.ran&&result.status==='failed')process.exitCode=1;});
program.command('cycle').description('受付・整理・再関連付け・HOME生成').option('--limit <n>','整理と回復の合計上限',positive).option('--dry-run','書き込みとモデル呼び出しなし').option('--retry-failed','失敗分を再試行').option('--quiet-empty','新規処理と失敗がない場合NO_REPLY').addOption(new Option('--thinking <level>','思考水準').choices(['off','minimal','low','medium','high'])).action(async opts=>{const c=await config(opts.thinking?{organize:{llm:{thinking:opts.thinking}}}:{});const llm=c.organize.llm.provider==='mock'?new MockLlm():new OpenClawInferLlm(c.organize.llm);const result=await runCycle(c,llm,{limit:opts.limit,dryRun:opts.dryRun,retryFailed:opts.retryFailed},{synthesisLlm:synthesisClient(c)});const synthesized=result.synthesis!==undefined&&('error'in result.synthesis||result.synthesis.ran),synthesisFailed=result.synthesis!==undefined&&('error'in result.synthesis||(result.synthesis.ran&&result.synthesis.status==='failed'));output(opts.quietEmpty&&!result.intake.accepted&&!result.intake.rejected&&!result.organize.processed&&!result.organize.failed&&!result.intake.conflicts.length&&!result.dashboard?.conflict&&!result.digest?.conflict&&!result.git?.created.length&&!synthesized?'NO_REPLY':result);if(result.intake.rejected||result.organize.failed||synthesisFailed)process.exitCode=1;});
program.command('recent').option('--n <n>','表示件数',positive,10).action(async opts=>output(await recent(await config(),opts.n)));
program.command('pending').action(async()=>output(await pending(await config())));
program.command('resume <project>').action(async id=>output(await resume(await config(),id)));
program.command('context <project>').option('--max-chars <n>','最大文字数',positive).action(async(id,opts)=>output(await context(await config(),id,opts.maxChars)));
program.command('bundle <ids...>').description(`選んだ記録（IN・IDEA・KNWのID、NOWはプロジェクトID。最大${bundleMaxIds}件）を、出典・訂正の注意・方針付きの1つの資料にする`).option('--max-chars <n>','最大文字数',positive).action(async(ids,opts)=>output(await bundle(await config(),ids,opts.maxChars)));
program.command('policies').description('同期版の有効方針を読取専用で取得').option('--project <id>','ContextHubプロジェクト').option('--cwd <path>','対応付ける作業フォルダー').option('--json','JSON出力').action(async opts=>{const c=await config(),id=opts.project?await policyProjectFor(c,opts.project):(opts.cwd?await resolvePolicyProject(c,opts.cwd):undefined),b=await readPolicies(c,id);output(opts.json?b:formatPolicies(b));});
const policy=program.command('policy').description('採用した方針（判断・好み）を、本人が定期的に見直す');
policy.command('review').description('有効な方針と、採用（または前回「まだ有効」と確かめて）からの日数。見直す時期の方針が先頭').option('--all','見直す時期でない方針も表示').action(async opts=>{const c=await config(),vault=new Vault(c);const {items,problems}=await policyReviewItems(c,vault,{inputs:await readInputs(c)});output({review_days:policyReviewDays(c),policies:items.filter(i=>opts.all||i.due).map(i=>({id:i.knowledgeId,hash:i.hash,kind:i.kind,scope:i.projectId??'global',claim:i.claim,approved_at:i.approvedAt,confirmed_at:i.confirmedAt??null,days:i.days,due:i.due,...(i.newInputs!==undefined?{new_inputs:i.newInputs}:{})})),problems});});
policy.command('keep <id>').description('方針がまだ有効だと確かめた記録を残す（見直しの日数をここから数え直す）。止めるときは retire を使う').requiredOption('--hash <sha256>','policy reviewで確認した方針のハッシュ').requiredOption('--confirm','方針を確認した本人による操作').action(async(id,opts)=>{const c=await config();const result=await keepPolicy(c,{knowledgeId:id,expectedHash:opts.hash,source:'cli'});await rebuildDashboard(c);output(result);});
program.command('retire <id>').requiredOption('--hash <sha256>','確認した正式知識のハッシュ').requiredOption('--confirm','本人による適用停止').action(async(id,opts)=>output(await retireKnowledge(await config(),id,opts.hash)));
program.command('candidates').action(async()=>output(await listCandidates(await config())));
program.command('approve <id>').requiredOption('--hash <sha256>','候補一覧で確認した内容ハッシュ').requiredOption('--scope <scope>','global または project').option('--project <id>','採用先ContextHubプロジェクト').option('--project-hash <sha256>','確認したproject.mdのハッシュ').action(async(id,opts)=>output(await approve(await config(),id,opts.hash,opts.scope==='project'?{scope:'project',projectId:opts.project,projectHash:opts.projectHash}:{scope:opts.scope})));
program.command('reject <id>').requiredOption('--hash <sha256>','候補一覧で確認した内容ハッシュ').action(async(id,opts)=>output(await reject(await config(),id,opts.hash)));
program.command('propose <claim>').addOption(new Option('--kind <kind>','候補の種別').choices(['knowledge','decision','preference']).default('knowledge')).option('--rationale <text>','根拠','人による候補作成').option('--supersedes <id>','置き換えるKNW-ID')
  .action(async(claim,opts)=>output(await propose(await config(),{claim,kind:opts.kind,rationale:opts.rationale,supersedes:opts.supersedes})));
const backup=program.command('backup').description('バックアップから復元できるかを確かめる（元のVaultは読むだけで、書き換えない）');
backup.command('verify').description('最新（または指定）のアーカイブをVault外の一時フォルダーへ展開して確かめ、結果を記録してHOMEを更新').option('--archive <path>','確かめるアーカイブ（省略時は設定のbackup.dirでいちばん新しいもの）').option('--work-dir <path>','展開先の親フォルダー（省略時はOSの一時フォルダー。Vaultと同期フォルダーの外にする）').option('--keep','確認後も展開先を残す（中身を自分で確かめるとき）').action(async opts=>{const c=await config();const result=await verifyBackup(c,{archive:opts.archive,workDir:opts.workDir,keep:opts.keep});await rebuildDashboard(c);output(result);if(result.check.status!=='ok')process.exitCode=1;});
backup.command('status').description('最後の確認結果と、確かめた復元点').action(async()=>{const c=await config(),checks=await readBackupChecks(new Vault(c)),status=backupStatus(c,checks.records);output({restore_point:status.restorePoint?{archive:status.restorePoint.archive,created_at:status.restorePoint.archive_created_at,age_days:status.restorePointAgeDays,checked_at:status.restorePoint.checked_at}:null,latest:status.latest??null,warnings:status.warnings,problems:checks.problems});});
program.command('doctor').description('Vaultと処理記録を検査').option('--unlock','全Writer・整理の停止後、死亡PIDのロック残骸のみ回収').action(async opts=>{const c=await config();if(opts.unlock)for(const scope of LOCK_SCOPES){try{await unlockVault(c,scope);}catch(error){/* 稼働中・判断不能なロックは回収せず、下のdoctorの検査結果で報告する。 */process.stderr.write(`警告: ${scope==='organize'?'整理':'Writer'}ロックを回収しませんでした: ${userFacingError(error)}\n`);process.exitCode=1;}}const result=await doctor(c);output(result);if(result.issues.length)process.exitCode=1;});
// Ctrl+Cやサービス停止で終了しても、ロックの残骸で後続のWriterを止めない。
releaseLocksOnSignal();
try { await program.parseAsync(); }
catch (error) {
  // パス・本文・外部プロセスのstderrを例外から転記しない。
  process.stderr.write(`エラー: ${userFacingError(error)}\n`);process.exitCode=1;
}
