import {readPolicies} from './policies.js';
import {knowledgePaths,readKnowledge} from './knowledge-scope.js';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Vault, VAULT_DIRS, LOCK_SCOPES, parseMarkdown, lockPath, hash } from './storage.js';
import { parseInput, eventMarker } from './capture.js';
import { readProjects } from './projects.js';
import { readEffectiveInputs } from './effective-inputs.js';
import { listProjectCandidates,recoverProjectApprovalsLocked } from './project-proposals.js';
import { readIntakeReceipts,parseIntakePending,intakeErrorSchema,intakeErrorMessage,intakePaths } from './intake.js';
import { associationSchema,associationViewsComplete,projectRegistryHash } from './associations.js';
import { receiptSchema, autoRegion, isGeneratedIntact } from './views.js';
import type { HubConfig, Input } from './types.js';
export async function doctor(config: HubConfig): Promise<{issues:string[];inputs:number}> {
  const vault=new Vault(config), issues:string[]=[], inputs:Input[]=[];
  for (const dir of VAULT_DIRS) {
    try { if (!(await lstat(await vault.path(dir))).isDirectory()) issues.push(`構造不正: ${dir}`); }
    catch { issues.push(`構造欠損・危険なパス: ${dir}`); }
  }
  try { for(const path of await vault.files('00_inbox')) {
    if(!path.endsWith('.md'))continue;
    try { inputs.push(parseInput(path,(await vault.read(path))!)); }
    catch { issues.push(`不正な入力: ${path}`); }
  }} catch { issues.push('入力の走査に失敗しました'); }
  try { await readProjects(config); } catch { issues.push('プロジェクト定義が不正です'); }
  try { await readEffectiveInputs(config); } catch { issues.push('訂正履歴・有効解釈と根拠が不正です'); }
  try { await listProjectCandidates(config);if(await recoverProjectApprovalsLocked(config,vault,Number.MAX_SAFE_INTEGER,true))issues.push('プロジェクト承認の回復待ちがあります'); } catch { issues.push('プロジェクト候補・確認・承認記録が不正です'); }
  try {
    const acks=await readIntakeReceipts(config);
    for(const ack of acks){
      const raw=await vault.readBytes(ack.path,config.capture.maxInputChars*4+8192);
      if(raw!==undefined&&hash(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw))!==ack.request_hash)issues.push(`受付ファイルの変更: ${ack.path}`);
      const result=ack.result;
      if('inputId'in result&&!inputs.some(i=>i.id===result.inputId&&i.path===result.path))issues.push(`受付記録の原文欠損: ${ack.request_id}`);
    }
    for(const path of await vault.files('90_system/intake/pending'))if(path.endsWith('.json')){const{snapshot}=parseIntakePending(path,(await vault.read(path))!,config.capture.maxInputChars);const ack=acks.find(a=>a.request_id===snapshot.request_id);if(ack&&ack.request_hash!==snapshot.request_hash)issues.push(`受付回復と受領記録の不一致: ${path}`);else if(!ack)issues.push(`受付の停止回復待ち: ${snapshot.request_id}`);}
    for(const path of await vault.files('90_system/intake-errors'))if(path.endsWith('.json')){const record=intakeErrorSchema.parse(JSON.parse((await vault.read(path))!));if(record.status==='conflict'||!acks.some(a=>a.path===record.path))issues.push(`受付${record.status==='conflict'?'競合':'失敗'}: ${record.path} / ${intakeErrorMessage(record)}`);}
    for(const path of await intakePaths(vault))if(path.includes('.sync-conflict-'))issues.push(`受付の同期競合コピー: ${path}`);
  }catch{issues.push('受付ファイル・受領・停止回復記録が不正です');}
  try {
    const effective=await readEffectiveInputs(config),registry=projectRegistryHash(await readProjects(config));
    for(const path of await vault.files('90_system/associations'))if(path.endsWith('.json')){
      const record=associationSchema.parse(JSON.parse((await vault.read(path))!));
      if(path!==`90_system/associations/${record.input_id}/${record.evidence_hash}.${record.registry_hash}.json`)issues.push(`再関連付け記録のパス不一致: ${path}`);
      if(record.status==='associated'&&!await associationViewsComplete(vault,record)&&record.registry_hash===registry&&effective.some(e=>e.chain.root.id===record.input_id&&e.chain.evidenceHash===record.evidence_hash))issues.push(`再関連付け表示の回復待ち: ${record.input_id}`);
    }
  }catch{issues.push('再関連付け記録・表示完了記録が不正です');}
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
  try{for(const path of await knowledgePaths(vault)){const id=path.split('/').at(-1)!.slice(0,-3);const record=await readKnowledge(vault,id);if(!record||!isGeneratedIntact(record.raw))issues.push(`知識の整合性不正: ${path}`);}}catch{issues.push('知識の採用先・保存先・ID重複が不正です');}
  try{await readPolicies(config);}catch{issues.push('方針manifest・正本・停止記録の同期または集約が未完了です');}
  try {const home=await vault.read('HOME.md');if(home!==undefined&&!isGeneratedIntact(home))issues.push('HOMEの手動変更・形式不正');}catch{issues.push('HOME読み取り失敗');}
  try { for(const path of await vault.files('90_system/conflicts'))issues.push(`生成物の競合: ${path}`); } catch {issues.push('競合フォルダ走査失敗');}
  try { for (const scope of LOCK_SCOPES) { const lock = await lockPath(config, scope); for(const path of [lock, `${lock}.reap`]) {
    try { await lstat(path); } catch { continue; }
    let alive=false;
    try{const owner=JSON.parse(await readFile(join(path,'owner.json'),'utf8'));if(Number.isSafeInteger(owner.pid)&&owner.pid>0){process.kill(owner.pid,0);alive=true;}}catch{}
    issues.push(`${alive?(scope==='organize'?'整理実行中':'Writer実行中'):'ロック残骸（停止状態を確認）'}: ${path}`);
  }}} catch {issues.push('ロック場所を確認できません');}
  return{issues,inputs:inputs.length};
}
