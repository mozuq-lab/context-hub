import {afterEach,expect,test} from 'vitest';
import {readFile,rm,mkdir,utimes} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {parse} from 'yaml';
import {aiCandidate} from './review-fixtures.js';
import {rebuildDashboard} from '../src/dashboard.js';
import {parseIntake} from '../src/intake-format.js';
import {ingest} from '../src/intake.js';
import {correctInput} from '../src/corrections.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function ui(f:Awaited<ReturnType<typeof aiCandidate>>,confirm=true,onConfirm=async()=>{}){
 const notices:string[]=[],details:string[]=[],module={exports:{} as any};runInNewContext(await readFile('examples/quickadd/context-hub.js','utf8'),{module,crypto:webcrypto,TextEncoder,Uint8Array,Date,JSON,Error});
 const params={app:{vault:{getAbstractFileByPath:(path:string)=>existsSync(join(f.config.vaultPath,path))?{path}:null,createFolder:async(path:string)=>mkdir(join(f.config.vaultPath,path),{recursive:true}),create:async(path:string,raw:string)=>{await f.vault.create(path,raw);await utimes(join(f.config.vaultPath,path),new Date(0),new Date(0));},read:async(file:{path:string})=>f.vault.read(file.path),getMarkdownFiles:async()=>{const paths=await f.vault.files('00_inbox');return paths.map(path=>({path}));}}},quickAddApi:{suggester:async(_labels:string[],values:any[])=>values[0],yesNoPrompt:async(_title:string,text:string)=>{details.push(text);await onConfirm();return confirm;}},obsidian:{parseYaml:parse,Notice:class{constructor(text:string){notices.push(text);}}}};
 return{actions:module.exports,params,notices,details};
}
test('候補と理由と原文を確認して空本文の採用依頼だけを保存する',async()=>{
 const f=await aiCandidate(roots);await rebuildDashboard(f.config);const u=await ui(f);await u.actions.approveKnowledge(u.params);
 expect(u.details.join('\n')).toContain('復旧しやすい');expect(u.details.join('\n')).toContain('正本はMarkdownとする');expect(u.details.join('\n')).toContain(f.input.inputId);
 const[path]=await f.vault.files('Input');expect(parseIntake(path,(await f.vault.read(path))!,8000)).toMatchObject({operation:'knowledge-approve',candidate_id:f.id,text:''});expect(await f.vault.files('30_knowledge')).toHaveLength(0);
 expect((await ingest(f.config)).accepted).toBe(1);expect(u.notices.join(' ')).toContain('同期・処理待ち');
});
test('取消では依頼を作らない',async()=>{const f=await aiCandidate(roots);await rebuildDashboard(f.config);const u=await ui(f,false);await u.actions.rejectKnowledge(u.params);expect(await f.vault.files('Input')).toHaveLength(0);});
test.each(['missing','changed','correction','during-confirmation'])('同期不足・訂正・確認中更新を拒否する: %s',async mode=>{
 const f=await aiCandidate(roots);await rebuildDashboard(f.config);
 const change=async()=>{await f.vault.write(f.path,(await f.vault.read(f.path))!+'変更');};
 if(mode==='missing')await rm(await f.vault.path(f.input.path));
 if(mode==='changed')await change();
 if(mode==='correction')await correctInput(f.config,f.input.inputId,{source:'cli',occurredAt:'2026-11-01T03:00:00Z',text:'変更'});
 const u=await ui(f,true,mode==='during-confirmation'?change:async()=>{});await expect(u.actions.approveKnowledge(u.params)).rejects.toThrow();expect(await f.vault.files('Input')).toHaveLength(0);expect(u.notices.join(' ')).not.toContain('保存しました');
});
test('明示されたprojectを引き継いで依頼に採用先hashを含める',async()=>{const{scopedAiCandidate}=await import('./review-fixtures.js'),f=await scopedAiCandidate(roots,'one');await rebuildDashboard(f.config);const u=await ui(f);await u.actions.approveKnowledge(u.params);expect(u.details.join(' ')).toContain('元メモで指定');const[path]=await f.vault.files('Input');expect(parseIntake(path,(await f.vault.read(path))!,8000)).toMatchObject({scope:'project',project_id:'one'});expect((await ingest(f.config)).accepted).toBe(1);expect(await f.vault.files('10_projects/one/knowledge')).toHaveLength(1);});
test('確認中にproject定義が変われば依頼を書かず、却下は採用先を選ばない',async()=>{const{scopedAiCandidate}=await import('./review-fixtures.js'),f=await scopedAiCandidate(roots,'one');await rebuildDashboard(f.config);const u=await ui(f,true,async()=>{await f.vault.write('10_projects/one/project.md',(await f.vault.read('10_projects/one/project.md'))!+'変更');});await expect(u.actions.approveKnowledge(u.params)).rejects.toThrow();expect(await f.vault.files('Input')).toHaveLength(0);await rebuildDashboard(f.config);const no=await ui(f);let selections=0;no.params.quickAddApi.suggester=async(_labels,values)=>{selections++;return values[0];};await no.actions.rejectKnowledge(no.params);expect(selections).toBe(1);});
test('全体共通は本人の採用先選択を要求し保留では依頼を作らない',async()=>{const f=await aiCandidate(roots);await rebuildDashboard(f.config);const u=await ui(f);let count=0;u.params.quickAddApi.suggester=async(_labels,values)=>++count===1?values[0]:null;await u.actions.approveKnowledge(u.params);expect(count).toBe(2);expect(await f.vault.files('Input')).toHaveLength(0);});
test('採用履歴から停止REQを送り取消と同期不足では書かない',async()=>{const f=await aiCandidate(roots),{approve}=await import('../src/approvals.js');await approve(f.config,f.id,f.hash,{scope:'global'});await rebuildDashboard(f.config);const cancelled=await ui(f,false);await cancelled.actions.retireKnowledge(cancelled.params);expect(await f.vault.files('Input')).toHaveLength(0);const u=await ui(f);await u.actions.retireKnowledge(u.params);const[path]=await f.vault.files('Input');expect(parseIntake(path,(await f.vault.read(path))!,8000).operation).toBe('knowledge-retire');expect((await ingest(f.config)).accepted).toBe(1);});
