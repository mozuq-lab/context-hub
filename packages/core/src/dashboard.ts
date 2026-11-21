import { clipText, listText } from './markdown-text.js';
import {rebuildPoliciesLocked,readPolicies} from './policies.js';
import {modifiedKnowledgeWarning} from './policy-manifest.js';
import { readGitDraftRecords,readGitCollectProblems } from './git-drafts.js';
import { readNowItems,readItemResolutions,activeResolutions } from './item-resolutions.js';
import { effectiveSchedules,readItemOccurrences,readItemSchedules,repeatLabel,scheduleBucket,scheduleBucketLabels,scheduleLabel,todayIn } from './item-schedules.js';
import { readAskRecords } from './ask.js';
import { Vault,hash,parseMarkdown } from './storage.js';
import { lifecycleOf,projectStatusLabels } from './project-status.js';
import { decodeIntake } from './intake-format.js';
import { readProjects,inspectProjects,projectIssueFields,mergeTargets,mergeIssues } from './projects.js';
import {buildReviewIndex,writeReviewIndexLocked,type ReviewCandidate} from './candidate-review.js';
import { readEffectiveInputs,correctionNotice } from './effective-inputs.js';
import { readReceipts,generatedMarkdown,writeGeneratedLocked,dateLabel,lastEvidenceAt } from './views.js';
import { intakePaths,readIntakeReceipts,intakeErrorSchema,intakeErrorMessage,writeIntakeFeaturesLocked } from './intake.js';
import { listConflicts } from './conflicts.js';
import { historyStopped,historyPath } from './history.js';
import { referencesStopped,referencesPath,unassignedReferenceSection } from './references.js';
import type { HubConfig, Input } from './types.js';
import { describeFindings, findSecrets, secretSettings, writePrivacyPatternsLocked } from './secrets.js';
import { rebuildIdeaIndexLocked, ideaSection } from './idea-links.js';
import { rebuildUnassignedActionsLocked, unassignedActionsSection } from './unassigned-actions.js';
import { insightsNotices, insightsSection, rebuildInsightsLocked } from './insights.js';
import { isDeepStrictEqual } from 'node:util';
import { readExclusionOverlays, rereadResolutionIds } from './item-rereads.js';
import { backupHomeLine, backupStatus, readBackupChecks } from './backup-check.js';
import { writeCalendarLocked, type CalendarItem } from './calendar.js';
import { POLICY_REVIEW_ROWS, policyReviewDays, policyReviewItems } from './policy-reviews.js';
// HTMLコメントの開始はNOWと同じく無害化し、以降の行が隠れないようにする。
const plain=listText;
const clip=(s:string,n=120)=>clipText(s,n);
const DAY=86_400_000;
/** HOMEの「次の一手」に載せる、プロジェクトごとの上限。全件は各NOWとアプリで確認する。 */
const NEXT_PER_PROJECT=3;
/** HOMEの「受領と整理状況」に並べる、通常の状態（受領済み・整理済み）の行の上限。全件はアプリの受付状況で確認する。 */
const STATUS_ROWS=5;
/** 通常の状態（受領済み・整理済み）の行は新しい順にSTATUS_ROWS件までにし、残りを件数の1行にまとめる。並びは元の順を保つ。 */
function recentRoutine(rows:{row:string;routine:boolean;at:number}[],label:string):string[]{
 const keep=new Set(rows.map((r,i)=>({r,i})).filter(x=>x.r.routine).sort((a,b)=>b.r.at-a.r.at||b.i-a.i).slice(0,STATUS_ROWS).map(x=>x.i));
 const shown=rows.filter((r,i)=>!r.routine||keep.has(i)).map(r=>r.row),omitted=rows.length-shown.length;
 return omitted?[...shown,`- ほかに${label}${omitted}件（古い順に省略しています）`]:shown;
}
/** HOMEに載せる、秘密情報らしい文字列を含むメモの上限。新しい順に載せる。 */
const SECRET_ROWS=10;
export function secretInputRows(config:HubConfig,inputs:Input[]):string{
 const settings=secretSettings(config);if(!settings.enabled)return'';
 const found=inputs.map(i=>({input:i,findings:findSecrets(i.text,settings)})).filter(x=>x.findings.length)
  .sort((a,b)=>Date.parse(b.input.received_at)-Date.parse(a.input.received_at)||b.input.id.localeCompare(a.input.id));
 if(!found.length)return'';
 const rows=found.slice(0,SECRET_ROWS).map(x=>`- [${x.input.id}](${x.input.path}): ${plain(describeFindings(x.findings))}（${dateLabel(x.input.received_at,config.timezone)}受信）`);
 return `\n\n## 秘密情報らしい文字列を含むメモ（${found.length}件）\nAPIキー・トークン・パスワードなどに見える文字列です。整理用のモデルと別AI向けのcontextへは伏せ字にして渡しています。原文は書き換えないため、同期先の端末とバックアップには残ります。本当に秘密の値なら、発行元で無効化・再発行してください。値はここに表示しません。${found.length>SECRET_ROWS?`新しい${SECRET_ROWS}件を載せます。全件は\`ctx doctor\`で確認できます。`:''}\n${rows.join('\n')}`;
}
export function daysSince(iso:string,now:Date):number{return Math.max(0,Math.floor((now.getTime()-Date.parse(iso))/DAY));}
export async function rebuildDashboard(config:HubConfig,options:{now?:Date}={}):Promise<{path:string;conflict?:string}>{
 const vault=new Vault(config);return vault.withLock(()=>rebuildDashboardLocked(config,vault,options));
}
/** Writerロックを持つ呼び出し元から使う。競合の片付けで、HOMEを作り直すときにも使う。 */
export async function rebuildDashboardLocked(config:HubConfig,vault:Vault,options:{now?:Date}={}):Promise<{path:string;conflict?:string}>{
 const clock=options.now??new Date();
 // アプリが「選んで深掘り」で同じ追加規則を当てられるよう、設定の伏せ字の規則を同期するファイルへ書く（内容が変わったときだけ）。
 await writePrivacyPatternsLocked(config,vault);
 // 端末が、この本体の受け付ける依頼と欄を知るための一覧（内容が変わったときだけ書く）。
 await writeIntakeFeaturesLocked(config,vault);
 {
  // 不正なプロジェクト定義があると一覧・方針・候補を組み立てられない。どのファイルのどの項目かをHOMEに示して止める。
  const definitionIssues=(await inspectProjects(config)).issues;
  if(definitionIssues.length){
   const text=`# ContextHub\n\n生成時点: ${clock.toISOString()}\n\n## プロジェクト定義の不正（${definitionIssues.length}件）\n次のプロジェクト定義を読めないため、整理・HOMEの一覧・方針の更新を止めています。端末からのメモは受け付けて記録し、失われません（プロジェクトへの関連付けは定義を直すまで待ちます）。括弧内の項目を直してから、次のcycleを待つか \`ctx doctor\` で確認してください。\n${definitionIssues.map(i=>`- [${plain(i.path)}](<${i.path}>): ${plain(projectIssueFields(i))}`).join('\n')}\n\n名前（title）は1〜200文字、別名（aliases）とキーワード（keywords）は1件100文字までの文字列を50件まで、状態（status）は文字列で書きます。\n`;
   return writeGeneratedLocked(vault,'HOME.md',generatedMarkdown({schema_version:1,generated_by:{model:'deterministic-writer',prompt_version:1},generated_at:clock.toISOString(),verified:false},text));
  }
  const modifiedKnowledge=await rebuildPoliciesLocked(config,vault);
  const projects=await readProjects(config),review=await buildReviewIndex(config,{now:clock}),effective=await readEffectiveInputs(config),receipts=await readReceipts(config),acks=await readIntakeReceipts(config);
  await writeReviewIndexLocked(vault,review);
  // 同じ対象を指す確認待ちのプロジェクト案は、代表の1件にまとめて数える。
  const candidates=review.items,pending=candidates.filter(c=>c.status==='pending'&&!c.duplicateOf),attention=candidates.filter(c=>c.status==='stale'||c.status==='unavailable'),history=candidates.filter(c=>c.status==='approved'||c.status==='rejected');
  const labels={project:'プロジェクト案',knowledge:'知識',decision:'判断・方針',preference:'好み',unknown:'要確認'};
  const titleOf=(id:string)=>plain(candidates.find(c=>c.id===id)?.title??id);
  // 代表の案には根拠のメモの件数（まとめた案の数＋1）とまとめた案の名前を、まとめて判断された案には代表の案の名前を添える。
  const groupNote=(c:ReviewCandidate)=>c.status==='pending'&&c.duplicates?.length?`（根拠のメモ${c.duplicates.length+1}件。まとめた案: ${c.duplicates.map(titleOf).join('、')}）`:'';
  const coveredNote=(c:ReviewCandidate)=>c.coveredBy?`（「${titleOf(c.coveredBy)}」とまとめて判断）`:'';
  const reviewRows=(items:ReviewCandidate[])=>items.map(c=>`- [${plain(c.title)}](${c.path}) — ${labels[c.kind]}${groupNote(c)} / ${c.status==='approved'?(c.reflected?'承認済み・反映済み':'承認済み・反映待ち'):c.status==='rejected'?'却下済み':c.status==='pending'?'未承認':'要確認'}${coveredNote(c)} / ${plain(c.rationale)}${c.adoptedTarget?' / '+(c.adoptedTarget.scope==='global'?'共通':`project:${c.adoptedTarget.projectId}`):''}${c.retired?' / 適用停止'+(c.retiredAt?' '+c.retiredAt:''):''}${c.warnings.length?' / '+plain(c.warnings.join(' ')):''}`).join('\n')||'該当する候補はありません。';
  const listed:{row:string;at:number;group:'active'|'stale'|'inactive'|'merged'}[]=[];
  // 本人が統合したプロジェクト。入力・完了報告・日付は統合先のものとして読み替えているので、一覧では統合先を示すだけにする。
  const mergedInto=mergeTargets(projects);
  const nextGroups:{at:number;id:string;rows:string[]}[]=[],nextProblems:string[]=[],nextUnread:string[]=[];
  // 本人が付けた期日・見直す日。期日が7日以内の項目はプロジェクトをまたいで前に出し、見直す日が先の項目はたたむ。
  const today=todayIn(config.timezone,clock),schedules=await readItemSchedules(vault),resolutionRecords=schedules.records.length?await readItemResolutions(vault):[];
  const dated:{bucket:'overdue'|'today'|'week';due:string;id:string;row:string}[]=[],orphaned:string[]=[];let resting=0;
  // カレンダーに書き出す、進行中のプロジェクトの日付付きの項目（HOMEの「次の一手」と同じ範囲）。
  const calendarItems:CalendarItem[]=[];
  for(const project of projects){
   const now=`10_projects/${project.id}/NOW.md`,target=await vault.read(now)!==undefined?now:`10_projects/${project.id}/project.md`;
   const mergeTarget=projects.find(p=>p.id===mergedInto.get(project.id));
   if(mergeTarget){
    // 統合元のプロジェクト限定の方針は統合先へ移さない。残っていれば件数を示し、必要なものを統合先で採用し直せるようにする。
    let policies=0;try{policies=(await readPolicies(config,project.id)).project.length;}catch{/* 方針の不整合は別に示す。 */}
    const targetNow=`10_projects/${mergeTarget.id}/NOW.md`,targetPath=await vault.read(targetNow)!==undefined?targetNow:`10_projects/${mergeTarget.id}/project.md`;
    listed.push({row:`- [${plain(project.title)}](10_projects/${project.id}/project.md) — ${project.id} / 統合先: [${plain(mergeTarget.title)}](${targetPath})（${mergeTarget.id}）${policies?` / このプロジェクト限定の方針 ${policies}件は統合先に適用されません（[POLICY.md](10_projects/${project.id}/POLICY.md)。必要なものは統合先で採用し直してください）`:''}`,at:Number.NEGATIVE_INFINITY,group:'merged'});
    continue;
   }
   const lifecycle=lifecycleOf(project),last=await lastEvidenceAt(vault,project.id),at=last?Date.parse(last):Number.NEGATIVE_INFINITY;
   const stale=lifecycle==='active'&&last!==undefined&&clock.getTime()-at>config.retrieve.staleDays*DAY;
   const label=projectStatusLabels[lifecycle]+(project.status===lifecycle?'':`（${plain(project.status)}）`);
   const evidence=last?` / 最終根拠: ${dateLabel(last,config.timezone)}（${daysSince(last,clock)}日前）`:'';
   listed.push({row:`- [${plain(project.title)}](${target}) — ${project.id} / ${label}${evidence}${target===now?'':' / NOW未生成・根拠未登録'}`,at,group:lifecycle!=='active'?'inactive':stale?'stale':'active'});
   // 進行中のプロジェクトの、本人が完了と報告していない次の一手。NOWと同時に書かれる項目一覧から読む。
   if(lifecycle==='active'&&target===now)try{
    const list=await readNowItems(vault,project.id);
    // 旧版のNOWには項目一覧がない。次のcycleで作り直すまで「次の一手なし」と誤解させないよう分けて示す。
    if(!list){nextUnread.push(project.title);continue;}
    const front=new Set<string>(),{byKey:scheduled,orphaned:loose}=effectiveSchedules(schedules.records,project.id,list.items,activeResolutions(resolutionRecords,project.id));
    for(const i of list.items){
     const schedule=i.resolution===null?scheduled.get(i.key):undefined;if(!schedule)continue;
     calendarItems.push({projectId:project.id,projectTitle:project.title,itemKey:i.key,section:i.section,text:i.label+i.text,due:schedule.due,reviewAfter:schedule.review_after,scheduledAt:schedule.created_at});
     const {bucket,hidden}=scheduleBucket(schedule,today);
     if(hidden){resting++;front.add(i.key);}
     else if(bucket==='overdue'||bucket==='today'||bucket==='week'){front.add(i.key);dated.push({bucket,due:schedule.due!,id:project.id,row:`- 期日 ${schedule.due}${schedule.repeat?`（${repeatLabel(schedule.repeat)}）`:''} — [${plain(project.title)}](${now}) ${i.section==='next'?'次の一手: ':i.label?'':'未解決: '}${clip(i.label+i.text)}${schedule.review_after?`（見直す日 ${schedule.review_after}）`:''}`});}
    }
    // NOWから外れ、同じ本文の項目もない日付は黙って移さず、付け直しを促す（同じ本文の項目には引き継ぐ）。
    for(const s of loose)orphaned.push(`- [${plain(project.title)}](${now}): ${clip(s.text)}（${scheduleLabel(s)}） / key ${s.item_key}`);
    const items=list.items.filter(i=>i.section==='next'&&i.resolution===null&&!front.has(i.key));
    const later=(key:string)=>{const s=scheduled.get(key);return s?`（${scheduleLabel(s)}）`:'';};
    if(items.length)nextGroups.push({at,id:project.id,rows:[`- [${plain(project.title)}](${now})${stale?'（停滞）':''}`,...items.slice(0,NEXT_PER_PROJECT).map(i=>`  - ${clip(i.label+i.text)}${later(i.key)}${i.hints?.length?'（片付いたかも・要確認）':''}`),...(items.length>NEXT_PER_PROJECT?[`  - ほか${items.length-NEXT_PER_PROJECT}件はNOWで確認`]:[])]});
   }catch{nextUnread.push(project.title);nextProblems.push(`- [NOW項目の記録が不正です](90_system/now-items/${project.id}.json)`);}
  }
  // 進行中は最近動いた順、停滞は長く止まっている順に並べる。
  const group=(name:'active'|'stale'|'inactive'|'merged')=>listed.filter(x=>x.group===name).sort((a,b)=>name==='stale'?a.at-b.at:b.at-a.at).map(x=>x.row);
  const rows=group('active'),staleRows=group('stale'),inactiveRows=group('inactive'),mergedRows=group('merged');
  // 最近動いたプロジェクトから順に並べる。
  const nextRows=nextGroups.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)).flatMap(g=>g.rows);
  // 日付を使っていない間は、これまでと同じ見出し・本文にする。
  const order={overdue:0,today:1,week:2} as const,datedRows=dated.sort((a,b)=>order[a.bucket]-order[b.bucket]||a.due.localeCompare(b.due)||a.id.localeCompare(b.id));
  const usesDates=dated.length>0||resting>0||orphaned.length>0;
  const datedPart=!usesDates?'':`期日・見直す日は本人が付けたものです。アプリの次の一手から付けるか、\`ctx item schedule\`を使ってください。\n${(['overdue','today','week'] as const).map(b=>{const r=datedRows.filter(x=>x.bucket===b);return r.length?`\n### ${scheduleBucketLabels[b]}（${r.length}件）\n${r.map(x=>x.row).join('\n')}\n`:'';}).join('')}\n### プロジェクトごと\n`;
  const restingPart=`${resting?`\n\n見直す日まで休ませている項目: ${resting}件（各NOWとアプリで確認できます）`:''}${orphaned.length?`\n\n日付を付け直す項目（本文が変わったかNOWから外れたため、日付を移していません。${orphaned.length}件。新しい項目に付け直し、この日付は\`ctx item schedule <project> <key> --clear\`で外してください）:\n${orphaned.join('\n')}`:''}`;
  const nextSection=!listed.some(x=>x.group==='active'||x.group==='stale')?'':`## 次の一手（進行中のプロジェクト）\n${datedPart}${nextRows.length?`プロジェクトごとに${NEXT_PER_PROJECT}件まで載せます。終わった項目はアプリで完了を報告するか、\`ctx item list\`でキーを確認して\`ctx item resolve\`を使ってください。\n${nextRows.join('\n')}`:nextUnread.length?'':usesDates?'ほかに期日のない次の一手はありません。':'進行中のプロジェクトに次の一手はありません。'}${nextUnread.length?`${nextRows.length?'\n':''}NOW項目の記録を読めないプロジェクト: ${nextUnread.map(plain).join('、')}（cycleを実行するか、失敗と競合を確認してください）`:''}${restingPart}`;
  const projectSections=`## プロジェクト一覧\n${rows.join('\n')||(listed.length?'進行中で最近動いたプロジェクトはありません。':'プロジェクトはまだありません。')}${staleRows.length?`\n\n## 停滞しているプロジェクト（${staleRows.length}件）\n最終根拠から${config.retrieve.staleDays}日を超えて新しい入力がない進行中のプロジェクトです。再開するか、休止・完了にするかを判断してください。\n${staleRows.join('\n')}`:''}${inactiveRows.length?`\n\n## 休止・完了（${inactiveRows.length}件）\n${inactiveRows.join('\n')}`:''}${mergedRows.length?`\n\n## 統合済み（${mergedRows.length}件）\n本人が別のプロジェクトへまとめたプロジェクトです。統合元の入力・完了報告・日付は統合先のものとして読み替えており、原文と記録は動かしていません。取り消すにはアプリのプロジェクト画面か\`ctx project unmerge\`を使います。\n${mergedRows.join('\n')}`:''}`;
  // 本人が設定したリポジトリのコミットから作った下書きのうち、未確認のもの。
  const draftRecords=await readGitDraftRecords(config),drafts=draftRecords.drafts.filter(d=>d.status==='pending'),gitProblems=await readGitCollectProblems(vault);
  const draftSection=drafts.length?`\n\n## 作業記録の下書き（${drafts.length}件）\nコミット履歴から作った下書きです。アプリで本文を確認・編集して入力にするか、見送ってください。CLIでは\`ctx git use\`／\`ctx git dismiss\`を使います。\n${drafts.map(d=>`- ${plain(projects.find(p=>p.id===d.project_id)?.title??d.project_id)} / ${plain(d.repo)}: コミット${d.commits.length}件 — [${d.id}](${d.path}) / hash ${d.hash}`).join('\n')}`:'';
  const reviewRaw=await vault.read('REVIEW.md');let reviewDays=config.retrieve.digestDays;
  if(reviewRaw!==undefined)try{const d=parseMarkdown(reviewRaw).meta.period_days;if(typeof d==='number'&&Number.isSafeInteger(d)&&d>0)reviewDays=d;}catch{/* 解析できないふりかえりは設定の日数で案内する。 */}
  const reviewLink=reviewRaw!==undefined?`\n直近${reviewDays}日のふりかえり: [REVIEW.md](REVIEW.md)`:'';
  // 受領と整理状況は、対応が要るもの（受付待ち・内容変更・整理待ち・整理失敗）を全件、受領済み・整理済みは新しい順にSTATUS_ROWS件まで並べ、残りは件数で示す。
  const statuses:string[]=[],acksByPath=new Map(acks.map(a=>[a.path,a])),receiptsById=new Map(receipts.map(r=>[r.input_id,r]));
  const intakeRows:{row:string;routine:boolean;at:number}[]=[];
  for(const path of await intakePaths(vault)){
   const ack=acksByPath.get(path);let changed=false;
   if(ack)try{const bytes=await vault.readBytes(path,config.capture.maxInputChars*4+8192);changed=!bytes||hash(decodeIntake(bytes))!==ack.request_hash;}catch{changed=true;}
   intakeRows.push({row:`- [${plain(path.slice(6,-3))}](${path}): ${ack?changed?'内容変更・旧内容の受領（現在のファイルは未受理）':'Mac mini受領済み':'受付待ち（同期と受付の完了は未確認）'}${ack&&'inputId'in ack.result?' / ['+ack.result.inputId+']('+ack.result.path+')':''}`,routine:!!ack&&!changed,at:ack?Date.parse(ack.received_at):0});
  }
  statuses.push(...recentRoutine(intakeRows,'Mac mini受領済み'));
  // 本人が直接追加した行動はモデルで整理しないため、整理待ちに数えない。
  const inputRows=effective.map(unit=>{const latest=receiptsById.get(unit.chain.latest.id),action=unit.chain.root.kind==='action';return{row:`- [${unit.chain.root.id}](${unit.chain.root.path}): ${action?'本人が追加した行動（整理しません）':latest?.status==='organized'?'整理済み':latest?.status==='failed'?'整理失敗':'整理待ち'}${unit.chain.revisions.length?' / '+correctionNotice(unit):''}`,routine:action||latest?.status==='organized',at:Date.parse(unit.chain.root.received_at)};});
  statuses.push(...recentRoutine(inputRows,'整理済み'));
  // 件数は1行にまとめて先に示す。行の一覧は対応が要るものと直近の分だけにし、全件はアプリの受付状況に任せる。
  const waitingIntake=intakeRows.filter(r=>!r.routine).length,failedInputs=effective.filter(u=>receiptsById.get(u.chain.latest.id)?.status==='failed').length,waitingInputs=inputRows.filter(r=>!r.routine).length-failedInputs;
  const statusSummary=intakeRows.length||inputRows.length?`受付ファイル ${intakeRows.length}件（受付待ち・内容変更 ${waitingIntake}件） / 入力 ${inputRows.length}件（整理待ち ${waitingInputs}件・整理失敗 ${failedInputs}件）。受領済み・整理済みは新しい${STATUS_ROWS}件ずつを並べます。全件はアプリの「受付状況」で確認できます。\n`:'';
  // どのプロジェクトにも結び付いていないメモから出たタスクの分類とAIの提案。アプリが読む一覧も同時に書く（内容が変わったときだけ）。
  const unassignedActions=unassignedActionsSection(config,await rebuildUnassignedActionsLocked(config,vault,effective,clock));
  // 週次の統合の結果（今週の気づき）。設定で有効にしたときだけ出す。記録を読めなくてもHOMEは作り、「失敗と競合」に示す。
  let insightsText='',insightsLines:string[]=[];
  try{const built=await rebuildInsightsLocked(config,vault,effective,clock);insightsText=insightsSection(config,built.insights,clock);insightsLines=insightsNotices(config,built,clock);}
  catch{if(config.synthesis.enabled)insightsLines=['- 週次の統合の記録を読めません（`ctx doctor`で確認してください）'];}
  // 今週の気づきと、行動につながる欄（次の一手）を、プロジェクトの一覧より前に置く。
  const lead=[insightsText,nextSection,unassignedActions].filter(Boolean).map(x=>x+'\n\n').join('');
  // 秘密情報らしい文字列を含むメモ。原文は変えずモデルへ渡す前に伏せているが、同期先の端末には原文のまま残る。
  const secretRows=secretInputRows(config,effective.flatMap(u=>[u.chain.root,...u.chain.revisions]));
  // 似ているアイデアの索引。束ねの記録が壊れていてもHOMEは作り、壊れた記録を示す。
  let ideaText='',ideaProblem:string|undefined;
  try{ideaText=ideaSection(await rebuildIdeaIndexLocked(config,vault,clock));}catch(error){ideaProblem=error instanceof Error?error.message:String(error);}
  const errors:string[]=[];
  if(ideaProblem)errors.push(`- ${plain(ideaProblem)}（似ているアイデアの一覧を更新できません。\`ctx doctor\`で確認してください）`);
  for(const path of await vault.files('90_system/intake-errors'))if(path.endsWith('.json')){try{const e=intakeErrorSchema.parse(JSON.parse((await vault.read(path))!));if(e.status==='error'&&acks.some(a=>a.path===e.path))continue;errors.push(`- [${plain(e.path)}](${e.path}): ${e.status==='conflict'?'競合':'受付失敗'} / ${plain(intakeErrorMessage(e))} / 記録: [詳細](${path})`);}catch{errors.push(`- 受付エラー記録不正: ${plain(path)}`);}}
  // 退避は対象ごとにまとめる。NOWは手で変えた時点から更新が止まっているので、そのことと戻し方を示す。
  for(const g of await listConflicts(config)){
   const count=g.files.length>1?`、退避${g.files.length}件`:'';
   if(g.kind==='now')errors.push(`- [NOWの更新が止まっています](${g.latest}): ${plain(g.title??g.projectId??g.target)} — NOW.mdの自動領域が手で変更されています（${g.stoppedAt?dateLabel(g.stoppedAt,config.timezone)+'の生成から':''}更新なし${count}）。アプリの「生成版に戻す」か\`ctx conflict resolve\`で戻せます。手で変えた行はメモとして残ります`);
   else errors.push(`- [生成物の競合](${g.latest}): ${plain(g.target)}${count?` / ${count.slice(1)}`:''}${g.resolvable?' — `ctx conflict resolve`で作り直せます':''}`);
  }
  if(modifiedKnowledge.length)errors.push(`- ${plain(modifiedKnowledgeWarning(modifiedKnowledge))}`);
  for(const issue of mergeIssues(projects))errors.push(`- ${plain(issue)}（project.mdのmerged_intoを直すか外してください）`);
  for(const path of draftRecords.problems)errors.push(`- [作業記録の下書きの記録が不正です](${path})`);
  errors.push(...nextProblems);
  errors.push(...insightsLines);
  for(const project of projects)if(await historyStopped(vault,project.id))errors.push(`- [経緯の更新が止まっています](${historyPath(project.id)}): ${plain(project.title)} — HISTORY.mdが手で変更されています。経緯は根拠から作り直す派生物なので、ファイルを消すと次のcycleで作り直します`);
  for(const project of projects)if(await referencesStopped(vault,project.id))errors.push(`- [資料の更新が止まっています](${referencesPath(project.id)}): ${plain(project.title)} — REFERENCES.mdが手で変更されています。資料は整理結果から作り直す派生物なので、ファイルを消すと次のcycleで作り直します`);
  for(const path of schedules.problems)errors.push(`- [期日・見直す日の記録が不正です](${path})`);
  for(const path of (await readItemOccurrences(vault)).problems)errors.push(`- [定例の回の記録が不正です](${path})`);
  for(const path of (await readAskRecords(vault)).problems)errors.push(`- [記録に聞くの問いと答えの記録が不正です](${path})`);
  // 期日のカレンダー用ファイル。書けなくてもHOMEは作り、「失敗と競合」に示す。
  // NOW項目を読めないプロジェクトがある間は、予定が一時的に消えないよう前回のファイルを残す。
  if(!config.calendar?.enabled||!nextUnread.length)try{await writeCalendarLocked(config,vault,calendarItems);}catch{errors.push('- 期日のカレンダー用ファイル（90_system/calendar/contexthub.ics）を書き出せませんでした（`ctx doctor`で確認してください）');}
  // 採用から（または前回「まだ有効」と確かめてから）日数が過ぎた方針。古い順に数件だけ出し、止めるかどうかは本人が決める。
  let policyReviewSection='';
  try{
   const {items,problems}=await policyReviewItems(config,vault,{now:clock,inputs:effective.map(u=>u.chain.root)}),due=items.filter(i=>i.due);
   for(const path of problems)errors.push(`- [方針の見直しの記録が不正です](${path})`);
   if(due.length){
    const kindLabel={decision:'判断・方針',preference:'好み'} as const,titleOf=(id:string)=>plain(projects.find(p=>p.id===id)?.title??id);
    const rows=due.slice(0,POLICY_REVIEW_ROWS).map(i=>`- [${clip(i.claim,80)}](${i.path}) — ${kindLabel[i.kind]} / ${i.projectId===null?'共通':titleOf(i.projectId)} / 採用 ${dateLabel(i.approvedAt,config.timezone).slice(0,10)}${i.confirmedAt?`・前回確かめた日 ${dateLabel(i.confirmedAt,config.timezone).slice(0,10)}`:''}（${i.days}日前）${i.newInputs?` / その後このプロジェクトを指定したメモ・作業要約 ${i.newInputs}件`:''} / ${i.knowledgeId} / hash ${i.hash}`);
    policyReviewSection=`\n\n## 見直す方針（${due.length}件）\n採用してから（または前回「まだ有効」と確かめてから）${policyReviewDays(config)}日を過ぎた方針です。AIへ渡し続けてよいかを確かめてください。日数が過ぎても方針は止めません。\n${rows.join('\n')}${due.length>POLICY_REVIEW_ROWS?`\n- ほか${due.length-POLICY_REVIEW_ROWS}件（\`ctx policy review\`で確認できます）`:''}\n\n続けるならアプリの採用履歴の「まだ有効」か\`ctx policy keep <ID> --hash <hash> --confirm\`、止めるなら適用停止、書き直すなら置き換える候補を\`ctx propose --supersedes <ID>\`で作ってください。`;
   }
  }catch{errors.push('- 方針の見直しの状態を読めません（`ctx policy review`で確認してください）');}
  // バックアップから復元できるかの確認結果。バックアップ先を設定していないか、確認したことがない間は何も出さない。
  let backupLine='';
  try{
   const checks=await readBackupChecks(vault),status=backupStatus(config,checks.records,clock);
   backupLine=backupHomeLine(config,status,clock);
   for(const w of status.warnings)errors.push(`- バックアップ: ${w}`);
   for(const path of checks.problems)errors.push(`- [バックアップの確認結果の記録が不正です](${path})`);
  }catch{errors.push('- バックアップの確認結果を読めません');}
  // 本人が誤りとして外した項目のメモの読み直しに失敗したもの。外した項目は外れたままで、読み直しだけを再試行できる。
  try{
   const overlays=await readExclusionOverlays(vault);
   for(const unit of effective){const r=overlays.rereads.get(unit.chain.root.id);if(r?.status==='failed'&&unit.receipt&&r.receipt_organized_at===unit.receipt.organized_at&&isDeepStrictEqual(r.resolution_ids,rereadResolutionIds(overlays,unit.chain.root,unit.receipt.organized_at)))errors.push(`- [誤りとして外した項目のメモを読み直せませんでした](${unit.chain.root.path}): ${unit.chain.root.id} — 外した項目はNOWから外れたままです。${r.attempts<config.organize.maxAttempts?`\`ctx cycle --retry-failed\`で読み直しを再試行します（${r.attempts}回失敗）`:`再試行の上限（${r.attempts}回）に達しました。メモを訂正するか、項目を未解決に戻してから外し直すと、もう一度読み直します`}`);}
   for(const path of overlays.problems)errors.push(`- [読み直しの記録が不正です](${path})`);
  }catch{errors.push('- 完了・解決・誤りとして外した記録を読めません（`ctx doctor`で確認してください）');}
  for(const p of gitProblems)errors.push(`- 作業記録の下書き（${plain(p.projectId)} / ${plain(p.repo)}）: ${plain(p.error)}`);
  const text=`# ContextHub\n\n生成時点: ${clock.toISOString()}\n同期された時点の表示です。端末保存・Mac mini受領・整理完了はそれぞれ別の状態です。${reviewLink}${backupLine}\n\n${lead}${projectSections}${draftSection}\n\n## 確認待ち（${pending.length}件）\n${reviewRows(pending)}\n\n候補を開いて内容・理由・出典を確認し、QuickAddの承認／却下を実行してください。保留は閉じるだけです。AI候補は未承認です。${policyReviewSection}\n\n## 要確認（${attention.length}件）\n${reviewRows(attention)}\n\n## 有効方針\n[共通方針](POLICY.md)。各プロジェクトのPOLICY.mdに対象方針を掲載します。参考知識は必要時に検索します。\n\n## 判断履歴\n${reviewRows(history)}${ideaText}${unassignedReferenceSection(config,effective)}${secretRows}\n\n## 受領と整理状況\n${statusSummary}${statuses.join('\n')||'入力はありません。'}\n\n## 失敗と競合\n${errors.join('\n')||'記録された失敗・競合はありません。'}\n\n正式知識は根拠が訂正されても自動変更しません。根拠の訂正履歴と承認内容を確認してください。\n`;
  return writeGeneratedLocked(vault,'HOME.md',generatedMarkdown({schema_version:1,generated_by:{model:'deterministic-writer',prompt_version:1},generated_at:clock.toISOString(),verified:false},text));
 }
}
