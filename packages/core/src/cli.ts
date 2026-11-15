#!/usr/bin/env node
import {readPolicies,formatPolicies,rebuildPoliciesLocked,resolvePolicyProject,policyProjectFor} from './policies.js';
import {retireKnowledge} from './knowledge-retirement.js';
import { Command, Option } from 'commander';
import { open } from 'node:fs/promises';
import { loadConfig, type ConfigOverrides } from './config.js';
import { capture } from './capture.js';
import { correctInput } from './corrections.js';
import { listProjectCandidates,decideProject } from './project-proposals.js';
import { ingest } from './intake.js';
import { runCycle } from './cycle.js';
import { rebuildDashboard } from './dashboard.js';
import { rebuildDigest } from './digest.js';
import { rebuildReferences } from './references.js';
import { setProjectStatus,projectStatuses,lifecycleOf } from './project-status.js';
import { setProjectDefinition,editDefinition,normalizeDefinition,definitionLimitMessage } from './project-definition.js';
import { mergeProjects,unmergeProject,readProjectMerges } from './project-merges.js';
import { readProjectCatalog } from './knowledge-scope.js';
import { setItemResolution,readNowItems,readItemResolutions,exclusionReasons,exclusionReasonLabels } from './item-resolutions.js';
import { setItemSchedule,readItemSchedules,activeSchedules } from './item-schedules.js';
import { rebuildHistories } from './history.js';
import { dismissResolutionHint } from './resolution-hints.js';
import { collectGitDrafts,readGitDrafts,useGitDraft,dismissGitDraft } from './git-drafts.js';
import { Vault, unlockVault, LOCK_SCOPES, hash, releaseLocksOnSignal } from './storage.js';
import { addProject, readProjects } from './projects.js';
import { find, findKinds, recent, pending, resume, context, bundle, bundleMaxIds, type FindKind } from './retrieve.js';
import { doctor } from './doctor.js';
import { verifyBackup,readBackupChecks,backupStatus } from './backup-check.js';
import { rebuildIdeaIndexLocked,setIdeaLink } from './idea-links.js';
import { listConflicts,resolveConflict } from './conflicts.js';
import { organize } from './organize.js';
import { MockLlm } from './llm.js';
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
program.command('init').description('保存先を初期化（既存ノートは保持）').action(async()=>{const c=await config();const vault=new Vault(c);await vault.init();await vault.withLock(()=>rebuildPoliciesLocked(c,vault));output({vaultPath:c.vaultPath,initialized:true});});
program.command('add [text]').description('原文を保存').option('--file <path>','Markdown/テキストファイル')
  .option('--event-id <id>','再送判定用ID').option('--source <name>','出典名').option('--occurred-at <iso>','タイムゾーン付き発生日時')
  .addOption(new Option('--kind <kind>','入力の種別').choices(['memo','work-summary']).default('memo'))
  .option('--project <id>','人が指定する既存プロジェクト').option('--tool <name>','作業したAI/ツール').option('--session <reference>','元セッションの参照先')
  .action(async(text,opts)=>{const c=await config();const body=await inputText(text,opts.file,c.capture.maxInputChars);output(await capture(c,{text:body,source:opts.source??(opts.file?'file':text!==undefined?'cli':'stdin'),sourceEventId:opts.eventId,occurredAt:opts.occurredAt??new Date().toISOString(),kind:opts.kind,project:opts.project,tool:opts.tool,meta:opts.session?{session:opts.session}:undefined}));});
const project=program.command('project').description('人によるプロジェクト管理');
program.command('correct <id> [text]').description('元原文を保持して最新入力を訂正').option('--file <path>','訂正文ファイル').option('--event-id <id>','再送判定ID').option('--source <name>','出典名','cli-correction')
  .action(async(id,text,opts)=>{const c=await config();output(await correctInput(c,id,{text:await inputText(text,opts.file,c.capture.maxInputChars),source:opts.source,sourceEventId:opts.eventId,occurredAt:new Date().toISOString()}));});
project.command('add <id>').requiredOption('--title <text>','プロジェクト名').option('--aliases <csv>','別名、カンマ区切り').option('--keywords <csv>','検索語、カンマ区切り')
  .action(async(id,opts)=>output(await addProject(await config(),{id,title:opts.title,aliases:opts.aliases?.split(',')??[],keywords:opts.keywords?.split(',')??[]})));
project.command('list').description('定義・状態・確認用ハッシュを一覧').action(async()=>{const c=await config();const projects=await readProjects(c),catalog=await readProjectCatalog(new Vault(c));output(projects.map(p=>({...p,lifecycle:lifecycleOf(p),hash:catalog.find(x=>x.id===p.id)?.hash})));});
project.command('status <id>').description('本人の判断でプロジェクトを進行中・休止・完了に切り替える').addOption(new Option('--set <status>','新しい状態').choices([...projectStatuses]).makeOptionMandatory()).requiredOption('--hash <sha256>','project listで確認したproject.mdのハッシュ').requiredOption('--confirm','定義を確認した本人による変更').action(async(id,opts)=>{const c=await config();// 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
const result=await setProjectStatus(c,{projectId:id,status:opts.set,expectedHash:opts.hash,source:'cli',sourceEventId:`cli:${id}:${opts.hash}:${opts.set}`});await rebuildDashboard(c);output(result);});
const collect=(value:string,previous:string[])=>[...previous,value];
project.command('edit <id>').description('本人の確認でプロジェクトの名前・別名・キーワードを書き換える（帰属未確定のメモは次のcycleで再関連付けの対象になる）')
  .option('--title <text>','新しい名前').option('--add-alias <text>','追加する別名（複数指定可）',collect,[]).option('--remove-alias <text>','削除する別名（複数指定可）',collect,[])
  .option('--add-keyword <text>','追加するキーワード（複数指定可）',collect,[]).option('--remove-keyword <text>','削除するキーワード（複数指定可）',collect,[])
  .requiredOption('--hash <sha256>','project listで確認したproject.mdのハッシュ').requiredOption('--confirm','定義を確認した本人による変更')
  .action(async(id,opts)=>{const c=await config(),current=(await readProjects(c)).find(p=>p.id===id);if(!current)throw new Error('プロジェクトが見つかりません');
   const edited=editDefinition(current,{title:opts.title,addAliases:opts.addAlias,removeAliases:opts.removeAlias,addKeywords:opts.addKeyword,removeKeywords:opts.removeKeyword});
   let next;try{next=normalizeDefinition(edited);}catch{throw new Error(definitionLimitMessage);}
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
for(const action of ['approve','reject'] as const)project.command(`${action} <id>`).requiredOption('--hash <sha256>','確認した候補のハッシュ').requiredOption('--token <token>','候補の確認トークン').requiredOption('--confirm','候補詳細を読んだ人の明示確認').action(async(id,opts)=>output(await decideProject(await config(),{candidateId:id,expectedHash:opts.hash,confirmationToken:opts.token,confirmed:opts.confirm,action,source:'cli',sourceEventId:`cli:${id}:${action}`})));
const item=program.command('item').description('NOWの次の一手・未解決を、本人の確認で完了・解決にする、誤りとして外す、または未解決へ戻す');
item.command('list <project>').description('直近に生成したNOWの項目とキーを表示').action(async id=>{const items=await readNowItems(new Vault(await config()),id);if(!items)throw new Error('NOW項目の記録がありません。cycleを実行してください');output(items.items.map(i=>({key:i.key,section:i.section,text:`${i.label}${i.text}`,input_id:i.input_id,resolved:i.resolution&&i.resolution.action!=='exclude'?i.resolution.id:null,...(i.resolution?.action==='exclude'?{excluded:{id:i.resolution.id,reason:i.resolution.reason,note:i.resolution.note??null}}:{}),due:i.schedule?.due??null,review_after:i.schedule?.review_after??null,...(i.hints?.length?{maybe_done:i.hints.map(h=>({input_id:h.input_id,quote:h.quote}))}:{})})));});
for(const action of ['resolve','reopen'] as const)item.command(`${action} <project> <key>`).description(action==='resolve'?'項目を完了・解決にする':'解決済み、または誤りとして外した項目を未解決へ戻す').requiredOption('--confirm','項目を確認した本人による報告').action(async(id,key,_opts)=>{const c=await config(),vault=new Vault(c);
// 直前の記録を含めて受付IDにする。直前がCLIの同じ操作なら同じ受付IDで再送し、記録後の停止から回復する。
const last=(await readItemResolutions(vault)).filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.action===action&&last.source_event_id?last.source_event_id:`cli:${key}:${action}:${last?.id??'none'}`;const result=await setItemResolution(c,{projectId:id,itemKey:key,action,source:'cli',sourceEventId:event});await rebuildDashboard(c);output(result);});
item.command('exclude <project> <key>').description(`AIの読み違いなどの誤りとして項目を外す（完了・解決とは数えない）。理由: ${exclusionReasons.map(r=>`${r}=${exclusionReasonLabels[r]}`).join('、')}。読み違いと、AIが推定した帰属への「別のプロジェクトの話」は、次のcycleで元のメモを読み直す`).addOption(new Option('--reason <reason>','外す理由').choices([...exclusionReasons]).makeOptionMandatory()).option('--note <text>','一言（200文字以内・1行。次からの整理でAIへ渡す）').requiredOption('--confirm','項目を確認した本人による報告').action(async(id,key,opts)=>{const c=await config(),vault=new Vault(c);
// 完了報告と同じく、直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const last=(await readItemResolutions(vault)).filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.action==='exclude'&&last.reason===opts.reason&&last.note===opts.note&&last.source_event_id?last.source_event_id:`cli:${key}:exclude:${last?.id??'none'}`;const result=await setItemResolution(c,{projectId:id,itemKey:key,action:'exclude',reason:opts.reason,note:opts.note,source:'cli',sourceEventId:event});await rebuildDashboard(c);output(result);});
item.command('dismiss-hint <project> <key> <input-id>').description('「片付いたかも」が違うとき、そのメモからの候補を見送る（項目は未解決のまま）').requiredOption('--confirm','候補と引用を確認した本人による見送り').action(async(id,key,inputId,_opts)=>{const c=await config();const result=await dismissResolutionHint(c,{projectId:id,itemKey:key,inputId,source:'cli',sourceEventId:`cli:${key}:${inputId}:dismiss-hint`});await rebuildDashboard(c);output(result);});
item.command('schedule <project> <key>').description('項目に期日・次に見直す日を付ける（noneで外す。指定しなかった方は今の日付を保つ）').option('--due <date>','期日（YYYY-MM-DD、またはnone）').option('--review <date>','次に見直す日（YYYY-MM-DD、またはnone）。この日まではHOMEの一覧でたたむ').option('--clear','期日と見直す日を両方外す').requiredOption('--confirm','項目を確認した本人による操作').action(async(id,key,opts)=>{
if(opts.clear&&(opts.due!==undefined||opts.review!==undefined))throw new Error('--clearと--due・--reviewは同時に指定できません');
if(!opts.clear&&opts.due===undefined&&opts.review===undefined)throw new Error('--due・--review・--clearのいずれかを指定してください');
const c=await config(),vault=new Vault(c),records=(await readItemSchedules(vault)).records,current=activeSchedules(records,id).get(key);
const pick=(value:string|undefined,kept:string|null)=>value===undefined?kept:value==='none'?null:value;
const due=opts.clear?null:pick(opts.due,current?.due??null),reviewAfter=opts.clear?null:pick(opts.review,current?.review_after??null);
// 直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
const last=records.filter(r=>r.project_id===id&&r.item_key===key).at(-1);const event=last&&last.source==='cli'&&last.due===due&&last.review_after===reviewAfter&&last.source_event_id?last.source_event_id:`cli:${key}:schedule:${due??'-'}:${reviewAfter??'-'}:${last?.id??'none'}`;
const result=await setItemSchedule(c,{projectId:id,itemKey:key,due,reviewAfter,source:'cli',sourceEventId:event});await rebuildDashboard(c);output({...result,due,review_after:reviewAfter});});
program.command('history [project]').description('プロジェクトの経緯HISTORY.mdを根拠と処理記録から作り直す（省略時は全プロジェクト）').action(async id=>output(await rebuildHistories(await config(),id?{projectId:id}:{})));
program.command('references [project]').description('プロジェクトの資料REFERENCES.md（AIが参考資料に分類したメモとURLの一覧）を整理結果から作り直す（省略時は全プロジェクト）').action(async id=>output(await rebuildReferences(await config(),id?{projectId:id}:{})));
const git=program.command('git').description('設定したローカルリポジトリのコミット履歴から作業記録の下書きを作る（既定は無効）');
git.command('collect').description('下書きを作ってHOMEを更新').action(async()=>{const c=await config();if(!c.git.enabled)throw new Error('設定のgit.enabledが無効です');const result=await collectGitDrafts(c);await rebuildDashboard(c);output(result);if(result.errors.length)process.exitCode=1;});
git.command('drafts').description('下書きの一覧').option('--all','入力済み・見送り済みも表示').action(async opts=>output((await readGitDrafts(await config())).filter(d=>opts.all||d.status==='pending').map(d=>({id:d.id,hash:d.hash,status:d.status,project:d.project_id,repo:d.repo,commits:d.commits.length,text:d.text,inputId:d.inputId??null}))));
git.command('use <id>').description('下書きの本文をそのまま入力にする').requiredOption('--hash <sha256>','git draftsで確認したハッシュ').addOption(new Option('--kind <kind>','入力の種類').choices(['memo','work-summary']).default('memo')).requiredOption('--confirm','本文を確認した本人による保存').action(async(id,opts)=>{const c=await config();const result=await useGitDraft(c,{draftId:id,expectedHash:opts.hash,kind:opts.kind,source:'cli'});await rebuildDashboard(c);output(result);});
git.command('dismiss <id>').description('下書きを見送る').requiredOption('--hash <sha256>','git draftsで確認したハッシュ').requiredOption('--confirm','本文を確認した本人による見送り').action(async(id,opts)=>{const c=await config();const result=await dismissGitDraft(c,{draftId:id,expectedHash:opts.hash,source:'cli',sourceEventId:`cli:${id}:dismiss`});await rebuildDashboard(c);output(result);});
const idea=program.command('idea').description('似ているアイデアを確認し、本人の判断で束ねる・別の話にする（AIは使わない）');
const ideaIndex=async()=>{const c=await config(),vault=new Vault(c);return vault.withLock(()=>rebuildIdeaIndexLocked(c,vault));};
idea.command('similar').description('未確認の似ているアイデアの組と、束ねるときに指定するハッシュ').action(async()=>{const index=await ideaIndex();output({total:index.total_candidates,candidates:index.candidates.map(x=>({ideas:x.ideas,score:x.score,hashes:x.hashes,summaries:x.ideas.map(id=>index.summaries[id]??'')}))});});
idea.command('groups').description('束ねたアイデアの一覧（先頭が代表）。linksは直接束ねた組で、束から外すにはこの組をseparateする').action(async()=>{const index=await ideaIndex();output(index.groups.map(g=>({representative:g.representative,ideas:g.ideas.map(id=>({id,summary:index.summaries[id]??''})),links:g.links})));});
idea.command('link <a> <b>').description('2件のアイデアを同じ話として束ねる').requiredOption('--hash-a <sha256>','idea similarで確認した1件目のハッシュ').requiredOption('--hash-b <sha256>','idea similarで確認した2件目のハッシュ').requiredOption('--confirm','内容を確認した本人による判断').action(async(a,b,opts)=>{const c=await config();const result=await setIdeaLink(c,{ideas:[a,b],hashes:[opts.hashA,opts.hashB],action:'link',source:'cli'});await rebuildDashboard(c);output(result);});
idea.command('separate <a> <b>').description('2件のアイデアを別の話として候補から外す（直接束ねた組なら束から外す）').requiredOption('--confirm','内容を確認した本人による判断').action(async(a,b)=>{const c=await config();const result=await setIdeaLink(c,{ideas:[a,b],action:'separate',source:'cli'});await rebuildDashboard(c);output(result);});
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
program.command('ingest').description('同期受付ファイルを正式保存').option('--limit <n>','受付操作の上限',positive).option('--dry-run','書き込みなし').action(async opts=>{const result=await ingest(await config(),{limit:opts.limit,dryRun:opts.dryRun});output(result);if(result.rejected)process.exitCode=1;});
program.command('digest').description('直近の期間のふりかえりREVIEW.mdを生成').option('--days <n>','集計日数（既定は設定のretrieve.digestDays）',positive).action(async opts=>output(await rebuildDigest(await config(),opts.days?{days:opts.days}:{})));
program.command('dashboard').description('プロジェクト一覧と処理状況のHOMEを生成').action(async()=>output(await rebuildDashboard(await config())));
program.command('cycle').description('受付・整理・再関連付け・HOME生成').option('--limit <n>','整理と回復の合計上限',positive).option('--dry-run','書き込みとモデル呼び出しなし').option('--retry-failed','失敗分を再試行').option('--quiet-empty','新規処理と失敗がない場合NO_REPLY').addOption(new Option('--thinking <level>','思考水準').choices(['off','minimal','low','medium','high'])).action(async opts=>{const c=await config(opts.thinking?{organize:{llm:{thinking:opts.thinking}}}:{});const llm=c.organize.llm.provider==='mock'?new MockLlm():new OpenClawInferLlm(c.organize.llm);const result=await runCycle(c,llm,{limit:opts.limit,dryRun:opts.dryRun,retryFailed:opts.retryFailed});output(opts.quietEmpty&&!result.intake.accepted&&!result.intake.rejected&&!result.organize.processed&&!result.organize.failed&&!result.intake.conflicts.length&&!result.dashboard?.conflict&&!result.digest?.conflict&&!result.git?.created.length?'NO_REPLY':result);if(result.intake.rejected||result.organize.failed)process.exitCode=1;});
program.command('recent').option('--n <n>','表示件数',positive,10).action(async opts=>output(await recent(await config(),opts.n)));
program.command('pending').action(async()=>output(await pending(await config())));
program.command('resume <project>').action(async id=>output(await resume(await config(),id)));
program.command('context <project>').option('--max-chars <n>','最大文字数',positive).action(async(id,opts)=>output(await context(await config(),id,opts.maxChars)));
program.command('bundle <ids...>').description(`選んだ記録（IN・IDEA・KNWのID、NOWはプロジェクトID。最大${bundleMaxIds}件）を、出典・訂正の注意・方針付きの1つの資料にする`).option('--max-chars <n>','最大文字数',positive).action(async(ids,opts)=>output(await bundle(await config(),ids,opts.maxChars)));
program.command('policies').description('同期版の有効方針を読取専用で取得').option('--project <id>','ContextHubプロジェクト').option('--cwd <path>','対応付ける作業フォルダー').option('--json','JSON出力').action(async opts=>{const c=await config(),id=opts.project?await policyProjectFor(c,opts.project):(opts.cwd?await resolvePolicyProject(c,opts.cwd):undefined),b=await readPolicies(c,id);output(opts.json?b:formatPolicies(b));});
program.command('retire <id>').requiredOption('--hash <sha256>','確認した正式知識のハッシュ').requiredOption('--confirm','本人による適用停止').action(async(id,opts)=>output(await retireKnowledge(await config(),id,opts.hash)));
program.command('candidates').action(async()=>output(await listCandidates(await config())));
program.command('approve <id>').requiredOption('--hash <sha256>','候補一覧で確認した内容ハッシュ').requiredOption('--scope <scope>','global または project').option('--project <id>','採用先ContextHubプロジェクト').option('--project-hash <sha256>','確認したproject.mdのハッシュ').action(async(id,opts)=>output(await approve(await config(),id,opts.hash,opts.scope==='project'?{scope:'project',projectId:opts.project,projectHash:opts.projectHash}:{scope:opts.scope})));
program.command('reject <id>').requiredOption('--hash <sha256>','候補一覧で確認した内容ハッシュ').action(async(id,opts)=>output(await reject(await config(),id,opts.hash)));
program.command('propose <claim>').addOption(new Option('--kind <kind>','候補の種別').choices(['knowledge','decision','preference']).default('knowledge')).option('--rationale <text>','根拠','人による候補作成').option('--supersedes <id>','置き換えるKNW-ID')
  .action(async(claim,opts)=>output(await propose(await config(),{claim,kind:opts.kind,rationale:opts.rationale,supersedes:opts.supersedes})));
const backup=program.command('backup').description('バックアップから復元できるかを確かめる（元のVaultは読むだけで、書き換えない）');
backup.command('verify').description('最新（または指定）のアーカイブをVault外の一時フォルダーへ展開して確かめ、結果を記録してHOMEを更新').option('--archive <path>','確かめるアーカイブ（省略時は設定のbackup.dirでいちばん新しいもの）').option('--work-dir <path>','展開先の親フォルダー（省略時はOSの一時フォルダー。Vaultと同期フォルダーの外にする）').option('--keep','確認後も展開先を残す（中身を自分で確かめるとき）').action(async opts=>{const c=await config();const result=await verifyBackup(c,{archive:opts.archive,workDir:opts.workDir,keep:opts.keep});await rebuildDashboard(c);output(result);if(result.check.status!=='ok')process.exitCode=1;});
backup.command('status').description('最後の確認結果と、確かめた復元点').action(async()=>{const c=await config(),checks=await readBackupChecks(new Vault(c)),status=backupStatus(c,checks.records);output({restore_point:status.restorePoint?{archive:status.restorePoint.archive,created_at:status.restorePoint.archive_created_at,age_days:status.restorePointAgeDays,checked_at:status.restorePoint.checked_at}:null,latest:status.latest??null,warnings:status.warnings,problems:checks.problems});});
program.command('doctor').description('Vaultと処理記録を検査').option('--unlock','全Writer・整理の停止後、死亡PIDのロック残骸のみ回収').action(async opts=>{const c=await config();if(opts.unlock)for(const scope of LOCK_SCOPES){try{await unlockVault(c,scope);}catch(error){/* 稼働中・判断不能なロックは回収せず、下のdoctorの検査結果で報告する。 */process.stderr.write(`警告: ${scope==='organize'?'整理':'Writer'}ロックを回収しませんでした: ${error instanceof Error&&/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(error.message)&&!error.message.includes('\n')?error.message:'理由を確認できません'}\n`);process.exitCode=1;}}const result=await doctor(c);output(result);if(result.issues.length)process.exitCode=1;});
// Ctrl+Cやサービス停止で終了しても、ロックの残骸で後続のWriterを止めない。
releaseLocksOnSignal();
try { await program.parseAsync(); }
catch (error) {
  // パス・本文・外部プロセスのstderrを例外から転記しない。
  const message=error instanceof Error?error.message:'';
  const safe=/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(message)&&!message.includes('\n')?message:'処理に失敗しました。設定・引数とctx doctorを確認してください';
  process.stderr.write(`エラー: ${safe}\n`);process.exitCode=1;
}
