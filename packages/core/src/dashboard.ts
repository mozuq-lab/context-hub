import { Vault,hash } from './storage.js';
import { decodeIntake } from './intake-format.js';
import { readProjects } from './projects.js';
import { listProjectCandidates } from './project-proposals.js';
import { readEffectiveInputs,correctionNotice } from './effective-inputs.js';
import { readReceipts,generatedMarkdown,writeGeneratedLocked } from './views.js';
import { intakePaths,readIntakeReceipts,intakeErrorSchema,intakeErrorMessage } from './intake.js';
import type { HubConfig } from './types.js';
const plain=(s:string)=>s.replace(/[\r\n|]/g,' ').replaceAll('[','\\[').replaceAll(']','\\]');
export async function rebuildDashboard(config:HubConfig):Promise<{path:string;conflict?:string}>{
 const vault=new Vault(config);return vault.withLock(async()=>{
  const projects=await readProjects(config),candidates=await listProjectCandidates(config),effective=await readEffectiveInputs(config),receipts=await readReceipts(config),acks=await readIntakeReceipts(config);
  const rows:string[]=[];
  for(const project of projects){const now=`10_projects/${project.id}/NOW.md`,target=await vault.read(now)!==undefined?now:`10_projects/${project.id}/project.md`;rows.push(`- [${plain(project.title)}](${target}) — ${project.id} / ${plain(project.status)}${target===now?'':' / NOW未生成・根拠未登録'}`);}
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
  const text=`# ContextHub\n\n生成時点: ${new Date().toISOString()}\n同期された時点の表示です。端末保存・Mac mini受領・整理完了はそれぞれ別の状態です。\n\n## プロジェクト一覧\n${rows.join('\n')||'プロジェクトはまだありません。'}\n\n## プロジェクト候補\n${candidates.map(c=>`- [${plain(c.proposal.title)}](${c.path}): ${c.status} / ${plain(c.proposal.rationale)}`).join('\n')||'候補はありません。'}\n\n## 受領と整理状況\n${statuses.join('\n')||'入力はありません。'}\n\n## 失敗と競合\n${errors.join('\n')||'記録された失敗・競合はありません。'}\n\n正式知識は根拠が訂正されても自動変更しません。根拠の訂正履歴と承認内容を確認してください。\n`;
  return writeGeneratedLocked(vault,'HOME.md',generatedMarkdown({schema_version:1,generated_by:{model:'deterministic-writer',prompt_version:1},generated_at:new Date().toISOString(),verified:false},text));
 });
}
