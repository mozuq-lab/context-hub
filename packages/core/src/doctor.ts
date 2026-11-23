import {readPolicies,policyRootProblems} from './policies.js';
import {knowledgePaths,readKnowledge} from './knowledge-scope.js';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Vault, VAULT_DIRS, LOCK_SCOPES, parseMarkdown, lockPath, hash } from './storage.js';
import { parseInput, eventMarker } from './capture.js';
import { readProjects,inspectProjects,describeProjectIssue,mergeIssues,normalizeOutcome,cleanOutcome,PROJECT_OUTCOME_CHARS } from './projects.js';
import { readProjectMerges } from './project-merges.js';
import { readEffectiveInputs } from './effective-inputs.js';
import { listProjectCandidates,readProjectCoverage,recoverProjectApprovalsLocked } from './project-proposals.js';
import { readIntakeReceipts,parseIntakePending,intakeErrorSchema,intakeErrorMessage,intakePaths,isIntakeRefusal,refusalNoticeVisible } from './intake.js';
import { associationSchema,associationViewsComplete,projectRegistryHash } from './associations.js';
import { receiptSchema, autoRegion, isGeneratedIntact } from './views.js';
import { readItemOccurrences, readItemSchedules } from './item-schedules.js';
import { readItemEfforts } from './item-efforts.js';
import { readOrganizeRetries } from './organize-retries.js';
import { readItemSteps } from './item-steps.js';
import { AREA_CHARS, invalidArea } from './areas.js';
import { readProjectAreaChanges } from './project-areas.js';
import { readItemContexts } from './item-contexts.js';
import { readItemWaits } from './item-waits.js';
import { readItemSomedays } from './item-somedays.js';
import { readSomedayReviews } from './someday.js';
import { readWeeklyReviews } from './weekly-review.js';
import { readAskRecords } from './ask.js';
import { readPolicyReviews } from './policy-reviews.js';
import { readItemResolutions } from './item-resolutions.js';
import { readRereads } from './item-rereads.js';
import { readSynthesisRuns } from './synthesis.js';
import { readInsightReactions } from './insight-feedback.js';
import { backupStatus, readBackupChecks } from './backup-check.js';
import { readProjectStatusChanges } from './project-status.js';
import { readProjectCreations } from './project-creations.js';
import { readProjectDefinitionChanges } from './project-definition.js';
import { historyStopped } from './history.js';
import { referencesStopped } from './references.js';
import { readReferenceMarks } from './reference-marks.js';
import { inspectPeople, readPersonChanges, stoppedPeoplePages } from './people.js';
import type { HubConfig, Input } from './types.js';
import { readIdeaLinks } from './idea-links.js';
import { describeFindings, findSecrets, secretSettings } from './secrets.js';
/**
 * secretsは整合性の問題ではないため、issuesに入れず終了コードも変えない。値は含めない。
 * backupはバックアップから復元できるかの確認状況で、これもVaultの整合性ではないためissuesに入れない（確認したことがあるか、バックアップ先を設定したときだけ返す）。
 */
export async function doctor(config: HubConfig): Promise<{issues:string[];notices?:string[];inputs:number;secrets:{input_id:string;path:string;found:string}[];backup?:{restore_point:string|null;restore_point_age_days:number|null;warnings:string[]}}> {
  const vault=new Vault(config), issues:string[]=[], refusals:string[]=[], inputs:Input[]=[];
  for (const dir of VAULT_DIRS) {
    try { if (!(await lstat(await vault.path(dir))).isDirectory()) issues.push(`構造不正: ${dir}`); }
    catch { issues.push(`構造欠損・危険なパス: ${dir}`); }
  }
  try { for(const path of await vault.files('00_inbox')) {
    if(!path.endsWith('.md'))continue;
    try { inputs.push(parseInput(path,(await vault.read(path))!)); }
    catch { issues.push(`不正な入力: ${path}`); }
  }} catch { issues.push('入力の走査に失敗しました'); }
  // 定義が壊れていると、候補・再関連付けの確認は登録簿を読めずに失敗する。その失敗は定義の不正の結果として示す。
  let definitionsBroken = false;
  try { for (const issue of (await inspectProjects(config)).issues) { definitionsBroken = true; issues.push(`プロジェクト定義が不正です: ${describeProjectIssue(issue)}`); } } catch { definitionsBroken = true; issues.push('プロジェクト定義が不正です'); }
  const afterDefinitions = (label: string) => `${label}（プロジェクト定義を直してから再確認してください）`;
  for (const [label, read] of [['状態の切り替え', () => readProjectStatusChanges(vault)], ['プロジェクトの作成', () => readProjectCreations(vault)], ['定義の変更', () => readProjectDefinitionChanges(vault)], ['プロジェクトの統合', () => readProjectMerges(vault)]] as const) {
    try { await read(); } catch { issues.push(`${label}の記録が不正です（経緯から省かれます）`); }
  }
  try { issues.push(...mergeIssues(await readProjects(config))); } catch { /* 定義の不正は上で報告する。 */ }
  // 手で書いた領域が規則に合わなければ、付いていないものとして読む。書き直しを促す。
  try { for (const project of await readProjects(config)) { const raw = await vault.read(`10_projects/${project.id}/project.md`); if (raw !== undefined && invalidArea(parseMarkdown(raw).meta.area)) issues.push(`領域（area）が読めません（1行・${AREA_CHARS}文字以内の名前にしてください。読めるまで領域なしとして扱います）: 10_projects/${project.id}/project.md`); } } catch { /* 不正な定義は上で示す。 */ }
  try { for (const path of (await readProjectAreaChanges(vault)).problems) issues.push(`領域の変更の記録が不正です: ${path}`); } catch { issues.push('領域の変更の記録を走査できません'); }
  // 手で書いた望む結果が上限を超えていても定義は読む（AIへは先頭だけを渡す）。書き直しを促す。
  try { for (const project of await readProjects(config)) { try { normalizeOutcome(project.outcome ?? ''); } catch (error) { issues.push(`${error instanceof Error ? error.message : '望む結果を確認してください'}${cleanOutcome(project.outcome).length > PROJECT_OUTCOME_CHARS ? `（AIへは先頭の${PROJECT_OUTCOME_CHARS}文字だけを渡します）` : ''}: 10_projects/${project.id}/project.md`); } } } catch { /* 定義の不正は上で報告する。 */ }
  try { for (const project of await readProjects(config)) if (await historyStopped(vault, project.id)) issues.push(`経緯の更新が止まっています（手で変更されています）: 10_projects/${project.id}/HISTORY.md`); } catch { /* 定義の不正は上で報告する。 */ }
  try { for (const project of await readProjects(config)) if (await referencesStopped(vault, project.id)) issues.push(`資料の更新が止まっています（手で変更されています）: 10_projects/${project.id}/REFERENCES.md`); } catch { /* 定義の不正は上で報告する。 */ }
  try { const people = await inspectPeople(vault); for (const issue of people.issues) issues.push(`人の定義が不正です: ${issue.path}（${issue.message}）`); for (const path of await stoppedPeoplePages(vault)) issues.push(`人ごとの見返しの更新が止まっています（手で変更されています）: ${path}`); } catch { issues.push('人の定義を走査できません'); }
  try { await readPersonChanges(vault); } catch (error) { issues.push(error instanceof Error && error.message.startsWith('人の定義の変更記録') ? error.message : '人の定義の変更記録を走査できません'); }
  try { for (const path of (await readItemSchedules(vault)).problems) issues.push(`期日・見直す日の記録が不正です: ${path}`); } catch { issues.push('期日・見直す日の記録を走査できません'); }
  try { for (const path of (await readItemEfforts(vault)).problems) issues.push(`手間の目安の記録が不正です: ${path}`); } catch { issues.push('手間の目安の記録を走査できません'); }
  try { for (const path of (await readItemSteps(vault)).problems) issues.push(`手順の記録が不正です: ${path}`); } catch { issues.push('手順の記録を走査できません'); }
  try { for (const path of (await readOrganizeRetries(vault)).problems) issues.push(`整理のやり直しの依頼の記録が不正です: ${path}`); } catch { issues.push('整理のやり直しの依頼の記録を走査できません'); }
  try { for (const path of (await readItemContexts(vault)).problems) issues.push(`場所・道具の札の記録が不正です: ${path}`); } catch { issues.push('場所・道具の札の記録を走査できません'); }
  try { for (const path of (await readItemWaits(vault)).problems) issues.push(`連絡待ちの記録が不正です: ${path}`); } catch { issues.push('連絡待ちの記録を走査できません'); }
  try { for (const path of [...(await readItemSomedays(vault)).problems, ...(await readSomedayReviews(vault)).problems]) issues.push(`「いつかやる」の記録が不正です: ${path}`); } catch { issues.push('「いつかやる」の記録を走査できません'); }
  try { for (const path of (await readReferenceMarks(vault)).problems) issues.push(`資料の記録が不正です: ${path}`); } catch { issues.push('資料の記録を走査できません'); }
  try { for (const path of (await readWeeklyReviews(vault)).problems) issues.push(`週次レビューの記録が不正です: ${path}`); } catch { issues.push('週次レビューの記録を走査できません'); }
  try { for (const path of (await readItemOccurrences(vault)).problems) issues.push(`定例の回の記録が不正です: ${path}`); } catch { issues.push('定例の回の記録を走査できません'); }
  try { for (const path of (await readAskRecords(vault)).problems) issues.push(`記録に聞くの問いと答えの記録が不正です: ${path}`); } catch { issues.push('記録に聞くの問いと答えの記録を走査できません'); }
  try { for (const path of (await readPolicyReviews(vault)).problems) issues.push(`方針の見直しの記録が不正です: ${path}`); } catch { issues.push('方針の見直しの記録を走査できません'); }
  try { await readItemResolutions(vault); } catch (error) { issues.push(error instanceof Error && error.message.startsWith('解決記録') ? error.message : '完了・解決・誤りとして外した記録を走査できません'); }
  try { for (const path of (await readSynthesisRuns(vault)).problems) issues.push(`週次の統合の記録が不正です: ${path}`); } catch { issues.push('週次の統合の記録を走査できません'); }
  try { for (const path of (await readInsightReactions(vault)).problems) issues.push(`今週の気づきへの反応の記録が不正です: ${path}`); } catch { issues.push('今週の気づきへの反応の記録を走査できません'); }
  try { for (const path of (await readRereads(vault)).problems) issues.push(`読み直しの記録が不正です（元の解釈で表示し、次の実行で読み直します）: ${path}`); } catch { issues.push('読み直しの記録を走査できません'); }
  try { await readEffectiveInputs(config); } catch { issues.push(definitionsBroken?afterDefinitions('訂正履歴・有効解釈と根拠を確認できません'):'訂正履歴・有効解釈と根拠が不正です'); }
  // 読めない判断記録は、直す対象が分かるようにパスを示す（読めない間は、プロジェクト案の採用・却下を受け付けない）。
  try { for(const path of (await readProjectCoverage(vault)).unreadable)issues.push(`プロジェクトの判断記録を読めません: ${path}`); } catch { /* 走査できない場合は、次の検査で報告する。 */ }
  try { await listProjectCandidates(config);if(await recoverProjectApprovalsLocked(config,vault,Number.MAX_SAFE_INTEGER,true))issues.push('プロジェクト承認の回復待ちがあります'); } catch { issues.push(definitionsBroken?afterDefinitions('プロジェクト候補・確認・承認記録を確認できません'):'プロジェクト候補・確認・承認記録が不正です'); }
  try {
    const acks=await readIntakeReceipts(config);
    for(const ack of acks){
      const raw=await vault.readBytes(ack.path,config.capture.maxInputChars*4+8192);
      if(raw!==undefined&&hash(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw))!==ack.request_hash)issues.push(`受付ファイルの変更: ${ack.path}`);
      const result=ack.result;
      if('path'in result&&!inputs.some(i=>i.id===result.inputId&&i.path===result.path))issues.push(`受付記録の原文欠損: ${ack.request_id}`);
    }
    for(const path of await vault.files('90_system/intake/pending'))if(path.endsWith('.json')){const{snapshot}=parseIntakePending(path,(await vault.read(path))!,config.capture.maxInputChars);const ack=acks.find(a=>a.request_id===snapshot.request_id);if(ack&&ack.request_hash!==snapshot.request_hash)issues.push(`受付回復と受領記録の不一致: ${path}`);else if(!ack)issues.push(`受付の停止回復待ち: ${snapshot.request_id}`);}
    for(const path of await vault.files('90_system/intake-errors'))if(path.endsWith('.json')){const record=intakeErrorSchema.parse(JSON.parse((await vault.read(path))!));if(record.status!=='conflict'&&acks.some(a=>a.path===record.path))continue;
      // 理由付きの拒否は依頼への答えで、Vaultの異常ではない。異常（終了コード1）にせず、直近だけ注意に示す。
      if(isIntakeRefusal(record)){if(refusalNoticeVisible(record,Date.now()))refusals.push(`断った依頼: ${record.path} / ${intakeErrorMessage(record)}`);continue;}
      issues.push(`受付${record.status==='conflict'?'競合':'失敗'}: ${record.path} / ${intakeErrorMessage(record)}`);}
    for(const path of await intakePaths(vault))if(path.includes('.sync-conflict-'))issues.push(`受付の同期競合コピー: ${path}`);
  }catch{issues.push('受付ファイル・受領・停止回復記録が不正です');}
  try {
    const effective=await readEffectiveInputs(config),registry=projectRegistryHash(await readProjects(config));
    for(const path of await vault.files('90_system/associations'))if(path.endsWith('.json')){
      const record=associationSchema.parse(JSON.parse((await vault.read(path))!));
      if(path!==`90_system/associations/${record.input_id}/${record.evidence_hash}.${record.registry_hash}.json`)issues.push(`再関連付け記録のパス不一致: ${path}`);
      if(record.status==='associated'&&!await associationViewsComplete(vault,record)&&record.registry_hash===registry&&effective.some(e=>e.chain.root.id===record.input_id&&e.chain.evidenceHash===record.evidence_hash))issues.push(`再関連付け表示の回復待ち: ${record.input_id}`);
    }
  }catch{issues.push(definitionsBroken?afterDefinitions('再関連付け記録・表示完了記録を確認できません'):'再関連付け記録・表示完了記録が不正です');}
  const seen=new Set<string>();
  for(const input of inputs) {
    const key=JSON.stringify([input.source,input.source_event_id]);if(seen.has(key))issues.push(`イベント重複: ${input.id}`);seen.add(key);
    try { const marker=await vault.read(eventMarker(input.source,input.source_event_id));if(marker?.trim()!==input.id)issues.push(`イベント記録欠損・不一致: ${input.id}（同イベント再送で欠損を回復）`); }
    catch { issues.push(`イベント記録読み取り失敗: ${input.id}`); }
  }
  try { for(const path of await vault.files('90_system/receipts')) {
    const raw=await vault.read(path);
    if(path.startsWith('90_system/receipts/events/')) {
      const input=inputs.find(i=>i.id===raw?.trim());
      if(!input)issues.push(`孤立イベント記録: ${path}`);
      else if(path!==eventMarker(input.source,input.source_event_id))issues.push(`イベント記録のパス不一致: ${path}`);
    } else if(path.endsWith('.json')) {
      try {
        const value=JSON.parse(raw!);
        if(!inputs.some(i=>i.id===value.input_id))issues.push(`孤立receipt: ${path}`);
        const receipt=receiptSchema.parse(value);
        const pending=path.startsWith('90_system/receipts/pending/');
        const expected=`90_system/receipts/${pending?'pending/':''}${receipt.input_id}.json`;
        if(path!==expected || (pending && (receipt.status!=='organized' || receipt.writes.length!==0)))issues.push(`receiptパス・状態不一致: ${path}`);
        const input=inputs.find(i=>i.id===receipt.input_id);
        if(pending && !receipt.input_hash)issues.push(`journal入力ハッシュ欠損: ${receipt.input_id}`);
        else if(input && receipt.input_hash && receipt.input_hash!==hash((await vault.read(input.path))!))issues.push(`${pending?'journal':'receipt'}入力不一致: ${receipt.input_id}`);
      } catch { issues.push(`receipt形式不正: ${path}`); }
    }
  }} catch {issues.push('receipt走査失敗');}
  try { for(const path of await vault.files('10_projects'))if(path.endsWith('/NOW.md')) {
    try{const{meta,text}=parseMarkdown((await vault.read(path))!);const region=autoRegion(text);if(!region||meta.generated_hash!==`sha256:${hash(region.auto)}`)issues.push(`NOW自動領域の変更・欠損: ${path}`);}catch{issues.push(`NOW形式不正: ${path}`);}
  }}catch{issues.push('NOW走査失敗');}
  for(const dir of ['20_ideas','90_system/candidates','30_knowledge','90_system/project-candidates'])try{
    for(const path of await vault.files(dir))if(path.endsWith('.md')&&!isGeneratedIntact((await vault.read(path))!))issues.push(`生成物の手動変更・形式不正: ${path}`);
  }catch{issues.push(`生成物走査失敗: ${dir}`);}
  try{const paths=await knowledgePaths(vault);for(const path of paths){const id=path.split('/').at(-1)!.slice(0,-3);const record=await readKnowledge(vault,id,paths);if(!record||!isGeneratedIntact(record.raw))issues.push(`知識の整合性不正: ${path}`);}}catch{issues.push('知識の採用先・保存先・ID重複が不正です');}
  // 見つからない作業フォルダーの対応付けは、外付けを外しただけでも起こり、方針の読取も止めないため、異常（issues）ではなく注意に示す。
  const notices=[...await policyRootProblems(config),...refusals];
  try{await readPolicies(config);}catch{issues.push(definitionsBroken?afterDefinitions('方針の同期・集約を確認できません'):'方針manifest・正本・停止記録の同期または集約が未完了です');}
  try{await readIdeaLinks(vault);}catch(error){issues.push(error instanceof Error?error.message:'アイデアの束ねの記録が不正です');}
  try {const home=await vault.read('HOME.md');if(home!==undefined&&!isGeneratedIntact(home))issues.push('HOMEの手動変更・形式不正');}catch{issues.push('HOME読み取り失敗');}
  try { for(const path of await vault.files('90_system/conflicts'))issues.push(`生成物の競合: ${path}`); } catch {issues.push('競合フォルダ走査失敗');}
  try { for (const scope of LOCK_SCOPES) { const lock = await lockPath(config, scope); for(const path of [lock, `${lock}.reap`]) {
    try { await lstat(path); } catch { continue; }
    let alive=false;
    try{const owner=JSON.parse(await readFile(join(path,'owner.json'),'utf8'));if(Number.isSafeInteger(owner.pid)&&owner.pid>0){process.kill(owner.pid,0);alive=true;}}catch{}
    issues.push(`${alive?(scope==='organize'?'整理実行中':'Writer実行中'):'ロック残骸（停止状態を確認）'}: ${path}`);
  }}} catch {issues.push('ロック場所を確認できません');}
  const settings=secretSettings(config);
  const secrets=inputs.map(i=>({input:i,findings:findSecrets(i.text,settings)})).filter(x=>x.findings.length).map(x=>({input_id:x.input.id,path:x.input.path,found:describeFindings(x.findings)}));
  let backup:{restore_point:string|null;restore_point_age_days:number|null;warnings:string[]}|undefined;
  try{
    const checks=await readBackupChecks(vault),status=backupStatus(config,checks.records);
    for(const path of checks.problems)issues.push(`バックアップの確認結果の記録が不正です: ${path}`);
    if(checks.records.length||status.warnings.length)backup={restore_point:status.restorePoint?.archive??null,restore_point_age_days:status.restorePointAgeDays??null,warnings:status.warnings};
  }catch{issues.push('バックアップの確認結果を走査できません');}
  return{issues,...(notices.length?{notices}:{}),inputs:inputs.length,secrets,...(backup?{backup}:{})};
}
