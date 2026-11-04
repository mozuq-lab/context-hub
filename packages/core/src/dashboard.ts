import {rebuildPoliciesLocked} from './policies.js';
import { readGitDraftRecords,readGitCollectProblems } from './git-drafts.js';
import { readNowItems } from './item-resolutions.js';
import { Vault,hash,parseMarkdown } from './storage.js';
import { lifecycleOf,projectStatusLabels } from './project-status.js';
import { decodeIntake } from './intake-format.js';
import { readProjects } from './projects.js';
import {buildReviewIndex,writeReviewIndexLocked,type ReviewCandidate} from './candidate-review.js';
import { readEffectiveInputs,correctionNotice } from './effective-inputs.js';
import { readReceipts,generatedMarkdown,writeGeneratedLocked,dateLabel } from './views.js';
import { intakePaths,readIntakeReceipts,intakeErrorSchema,intakeErrorMessage } from './intake.js';
import type { HubConfig } from './types.js';
// HTMLコメントの開始はNOWと同じく無害化し、以降の行が隠れないようにする。
const plain=(s:string)=>s.replace(/[\r\n|]/g,' ').replaceAll('[','\\[').replaceAll(']','\\]').replaceAll('<!--','&lt;!--');
const clip=(s:string,n=120)=>{const a=Array.from(plain(s));return a.length>n?a.slice(0,n).join('')+'…':a.join('');};
const DAY=86_400_000;
/** HOMEの「次の一手」に載せる、プロジェクトごとの上限。全件は各NOWとアプリで確認する。 */
const NEXT_PER_PROJECT=3;
/** NOW.mdの最終根拠日時。未生成・解析不能なら未定。 */
export async function lastEvidenceAt(vault:Vault,projectId:string):Promise<string|undefined>{
 const raw=await vault.read(`10_projects/${projectId}/NOW.md`);if(raw===undefined)return undefined;
 try{const value=parseMarkdown(raw).meta.last_evidence_at;return typeof value==='string'&&Number.isFinite(Date.parse(value))?value:undefined;}catch{return undefined;}
}
export function daysSince(iso:string,now:Date):number{return Math.max(0,Math.floor((now.getTime()-Date.parse(iso))/DAY));}
export async function rebuildDashboard(config:HubConfig,options:{now?:Date}={}):Promise<{path:string;conflict?:string}>{
 const clock=options.now??new Date();
 const vault=new Vault(config);return vault.withLock(async()=>{
  await rebuildPoliciesLocked(config,vault);
  const projects=await readProjects(config),review=await buildReviewIndex(config),effective=await readEffectiveInputs(config),receipts=await readReceipts(config),acks=await readIntakeReceipts(config);
  await writeReviewIndexLocked(vault,review);
  const candidates=review.items,pending=candidates.filter(c=>c.status==='pending'),attention=candidates.filter(c=>c.status==='stale'||c.status==='unavailable'),history=candidates.filter(c=>c.status==='approved'||c.status==='rejected');
  const labels={project:'プロジェクト案',knowledge:'知識',decision:'判断・方針',preference:'好み',unknown:'要確認'};
  const reviewRows=(items:ReviewCandidate[])=>items.map(c=>`- [${plain(c.title)}](${c.path}) — ${labels[c.kind]} / ${c.status==='approved'?(c.reflected?'承認済み・反映済み':'承認済み・反映待ち'):c.status==='rejected'?'却下済み':c.status==='pending'?'未承認':'要確認'} / ${plain(c.rationale)}${c.adoptedTarget?' / '+(c.adoptedTarget.scope==='global'?'共通':`project:${c.adoptedTarget.projectId}`):''}${c.retired?' / 適用停止'+(c.retiredAt?' '+c.retiredAt:''):''}${c.warnings.length?' / '+plain(c.warnings.join(' ')):''}`).join('\n')||'該当する候補はありません。';
  const listed:{row:string;at:number;group:'active'|'stale'|'inactive'}[]=[];
  const nextGroups:{at:number;id:string;rows:string[]}[]=[],nextProblems:string[]=[],nextUnread:string[]=[];
  for(const project of projects){
   const now=`10_projects/${project.id}/NOW.md`,target=await vault.read(now)!==undefined?now:`10_projects/${project.id}/project.md`;
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
    const items=list.items.filter(i=>i.section==='next'&&i.resolution===null);
    if(items.length)nextGroups.push({at,id:project.id,rows:[`- [${plain(project.title)}](${now})${stale?'（停滞）':''}`,...items.slice(0,NEXT_PER_PROJECT).map(i=>`  - ${clip(i.label+i.text)}`),...(items.length>NEXT_PER_PROJECT?[`  - ほか${items.length-NEXT_PER_PROJECT}件はNOWで確認`]:[])]});
   }catch{nextUnread.push(project.title);nextProblems.push(`- [NOW項目の記録が不正です](90_system/now-items/${project.id}.json)`);}
  }
  // 進行中は最近動いた順、停滞は長く止まっている順に並べる。
  const group=(name:'active'|'stale'|'inactive')=>listed.filter(x=>x.group===name).sort((a,b)=>name==='stale'?a.at-b.at:b.at-a.at).map(x=>x.row);
  const rows=group('active'),staleRows=group('stale'),inactiveRows=group('inactive');
  // 最近動いたプロジェクトから順に並べる。
  const nextRows=nextGroups.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)).flatMap(g=>g.rows);
  const nextSection=!listed.some(x=>x.group!=='inactive')?'':`\n\n## 次の一手（進行中のプロジェクト）\n${nextRows.length?`プロジェクトごとに${NEXT_PER_PROJECT}件まで載せます。終わった項目はアプリで完了を報告するか、\`ctx item list\`でキーを確認して\`ctx item resolve\`を使ってください。\n${nextRows.join('\n')}`:nextUnread.length?'':'進行中のプロジェクトに次の一手はありません。'}${nextUnread.length?`${nextRows.length?'\n':''}NOW項目の記録を読めないプロジェクト: ${nextUnread.map(plain).join('、')}（cycleを実行するか、失敗と競合を確認してください）`:''}`;
  const projectSections=`## プロジェクト一覧\n${rows.join('\n')||(listed.length?'進行中で最近動いたプロジェクトはありません。':'プロジェクトはまだありません。')}${nextSection}${staleRows.length?`\n\n## 停滞しているプロジェクト（${staleRows.length}件）\n最終根拠から${config.retrieve.staleDays}日を超えて新しい入力がない進行中のプロジェクトです。再開するか、休止・完了にするかを判断してください。\n${staleRows.join('\n')}`:''}${inactiveRows.length?`\n\n## 休止・完了（${inactiveRows.length}件）\n${inactiveRows.join('\n')}`:''}`;
  // 本人が設定したリポジトリのコミットから作った下書きのうち、未確認のもの。
  const draftRecords=await readGitDraftRecords(config),drafts=draftRecords.drafts.filter(d=>d.status==='pending'),gitProblems=await readGitCollectProblems(vault);
  const draftSection=drafts.length?`\n\n## 作業記録の下書き（${drafts.length}件）\nコミット履歴から作った下書きです。アプリで本文を確認・編集して入力にするか、見送ってください。CLIでは\`ctx git use\`／\`ctx git dismiss\`を使います。\n${drafts.map(d=>`- ${plain(projects.find(p=>p.id===d.project_id)?.title??d.project_id)} / ${plain(d.repo)}: コミット${d.commits.length}件 — [${d.id}](${d.path}) / hash ${d.hash}`).join('\n')}`:'';
  const reviewRaw=await vault.read('REVIEW.md');let reviewDays=config.retrieve.digestDays;
  if(reviewRaw!==undefined)try{const d=parseMarkdown(reviewRaw).meta.period_days;if(typeof d==='number'&&Number.isSafeInteger(d)&&d>0)reviewDays=d;}catch{/* 解析できないふりかえりは設定の日数で案内する。 */}
  const reviewLink=reviewRaw!==undefined?`\n直近${reviewDays}日のふりかえり: [REVIEW.md](REVIEW.md)`:'';
  const statuses:string[]=[];
  for(const path of await intakePaths(vault)){
   const ack=acks.find(a=>a.path===path);let changed=false;
   if(ack)try{const bytes=await vault.readBytes(path,config.capture.maxInputChars*4+8192);changed=!bytes||hash(decodeIntake(bytes))!==ack.request_hash;}catch{changed=true;}
   statuses.push(`- [${plain(path.slice(6,-3))}](${path}): ${ack?changed?'内容変更・旧内容の受領（現在のファイルは未受理）':'Mac mini受領済み':'受付待ち（同期と受付の完了は未確認）'}${ack&&'inputId'in ack.result?' / ['+ack.result.inputId+']('+ack.result.path+')':''}`);
  }
  for(const unit of effective){const latest=receipts.find(r=>r.input_id===unit.chain.latest.id);statuses.push(`- [${unit.chain.root.id}](${unit.chain.root.path}): ${latest?.status==='organized'?'整理済み':latest?.status==='failed'?'整理失敗':'整理待ち'}${unit.chain.revisions.length?' / '+correctionNotice(unit):''}`);}
  const errors:string[]=[];
  for(const path of await vault.files('90_system/intake-errors'))if(path.endsWith('.json')){try{const e=intakeErrorSchema.parse(JSON.parse((await vault.read(path))!));if(e.status==='error'&&acks.some(a=>a.path===e.path))continue;errors.push(`- [${plain(e.path)}](${e.path}): ${e.status==='conflict'?'競合':'受付失敗'} / ${plain(intakeErrorMessage(e))} / 記録: [詳細](${path})`);}catch{errors.push(`- 受付エラー記録不正: ${plain(path)}`);}}
  for(const path of await vault.files('90_system/conflicts'))errors.push(`- [生成物の競合](${path})`);
  for(const path of draftRecords.problems)errors.push(`- [作業記録の下書きの記録が不正です](${path})`);
  errors.push(...nextProblems);
  for(const p of gitProblems)errors.push(`- 作業記録の下書き（${plain(p.projectId)} / ${plain(p.repo)}）: ${plain(p.error)}`);
  const text=`# ContextHub\n\n生成時点: ${clock.toISOString()}\n同期された時点の表示です。端末保存・Mac mini受領・整理完了はそれぞれ別の状態です。${reviewLink}\n\n${projectSections}${draftSection}\n\n## 確認待ち（${pending.length}件）\n${reviewRows(pending)}\n\n候補を開いて内容・理由・出典を確認し、QuickAddの承認／却下を実行してください。保留は閉じるだけです。AI候補は未承認です。\n\n## 要確認（${attention.length}件）\n${reviewRows(attention)}\n\n## 有効方針\n[共通方針](POLICY.md)。各プロジェクトのPOLICY.mdに対象方針を掲載します。参考知識は必要時に検索します。\n\n## 判断履歴\n${reviewRows(history)}\n\n## 受領と整理状況\n${statuses.join('\n')||'入力はありません。'}\n\n## 失敗と競合\n${errors.join('\n')||'記録された失敗・競合はありません。'}\n\n正式知識は根拠が訂正されても自動変更しません。根拠の訂正履歴と承認内容を確認してください。\n`;
  return writeGeneratedLocked(vault,'HOME.md',generatedMarkdown({schema_version:1,generated_by:{model:'deterministic-writer',prompt_version:1},generated_at:clock.toISOString(),verified:false},text));
 });
}
