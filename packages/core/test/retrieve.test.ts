import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault, markdown } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { addProject } from '../src/projects.js';
import { find, recent, pending, resume, context } from '../src/retrieve.js';
import { doctor } from '../src/doctor.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'ctx-retrieve-'));roots.push(root);const config=defaultConfig(join(root,'vault'),join(root,'state'));const vault=new Vault(config);await vault.init();await addProject(config,{id:'context-hub',title:'Context Hub'});return{config,vault};}
test('NFKC検索結果に入力ID・出典・日時を含め、該当なしを明示',async()=>{
 const{config}=await setup();const a=await capture(config,{source:'stdin',sourceEventId:'a',occurredAt:'2026-09-14T00:00:00Z',text:'ＡＩ 同期の検討\nhttps://example.com'});
 const output=await find(config,'AI 同期'); expect(output).toContain(a.inputId);expect(output).toContain('stdin');expect(output).toContain('2026-09-14');expect(output).toContain('00_inbox/');expect(await find(config,'zzzz')).toContain('見つかりません');
});
test('最近と未整理一覧から操作を保存せず取得する',async()=>{
 const{config}=await setup();await capture(config,{source:'cli',sourceEventId:'a',occurredAt:'2026-09-13T00:00:00Z',text:'旧い'});const b=await capture(config,{source:'cli',sourceEventId:'b',occurredAt:'2026-09-14T00:00:00Z',text:'最新'});
 expect(await recent(config,1)).toContain(b.inputId);expect(await recent(config,1)).not.toContain('旧い');expect(await pending(config)).toContain('未整理');
});
test('resumeはプロジェクト未生成を不明とし、contextは対象外のメモを出さない',async()=>{
 const{config}=await setup();expect(await resume(config,'context-hub')).toContain('不明');
 const saved=await capture(config,{source:'cli',occurredAt:'2026-09-14T00:00:00Z',text:'対象の長文'.repeat(300),project:'context-hub'});
 await capture(config,{source:'cli',occurredAt:'2026-09-14T00:00:00Z',text:'無関係な非公開メモ'});
 const output=await context(config,'context-hub',600);expect(output.length).toBeLessThanOrEqual(600);expect(output).toContain(saved.inputId);expect(output).not.toContain('無関係な非公開メモ');expect(output).toContain('2026-09-14');expect(await resume(config,'unknown')).toContain('見つかりません');
});
test('生成NOWの出典を表示し自動領域の外の手動メモを再開に混ぜない',async()=>{
 const{config,vault}=await setup();await vault.write('10_projects/context-hub/NOW.md',markdown({project:'context-hub',generated_at:'2026-09-14T00:00:00Z',last_evidence_at:'2026-09-13T00:00:00Z',input_ids:['IN-01K5ABCDEFGHJKMNPQRSTVWXYZ']},'秘密の手動メモ\n<!-- ctx:auto:start -->\n# 現在地\n不明\n<!-- ctx:auto:end -->'));
 const output=await resume(config,'context-hub');expect(output).toContain('2026-09-13');expect(output).not.toContain('秘密の手動メモ');
});
test('doctorは孤立receipt・欠損markerを報告し勝手に修復しない',async()=>{
 const{config,vault}=await setup();const saved=await capture(config,{source:'cli',sourceEventId:'a',occurredAt:'2026-09-14T00:00:00Z',text:'正常'});
 expect((await doctor(config)).issues).toEqual([]);
 for(const p of await vault.files('90_system/receipts/events'))await rm(join(config.vaultPath,p));
 await vault.write('90_system/receipts/IN-01K5ABCDEFGHJKMNPQRSTVWXYZ.json',JSON.stringify({input_id:'IN-01K5ABCDEFGHJKMNPQRSTVWXYZ',status:'failed'}));
 const report=await doctor(config);expect(report.issues.join(' ')).toContain(saved.inputId);expect(report.issues.join(' ')).toContain('孤立');expect(await vault.files('90_system/receipts/events')).toHaveLength(0);
});
test('壊れたorganized receiptを正常・処理済みとして隠さない',async()=>{
 const{config,vault}=await setup();const saved=await capture(config,{source:'cli',sourceEventId:'broken',occurredAt:'2026-09-14T00:00:00Z',text:'消してはいけない入力'});
 await vault.write(`90_system/receipts/${saved.inputId}.json`,JSON.stringify({input_id:saved.inputId,status:'organized'}));
 expect((await doctor(config)).issues.join(' ')).toContain('receipt');expect(await pending(config)).toContain(saved.inputId);expect(await pending(config)).toContain('不正');
});
test('NOWのマーカー欠損と自動本文の手動変更をdoctorが検出',async()=>{
 const{config,vault}=await setup();await vault.write('10_projects/context-hub/NOW.md',markdown({project:'context-hub',generated_hash:'sha256:invalid'},'# 手動で壊れたNOW'));
 expect((await doctor(config)).issues.join(' ')).toContain('NOW');
});
test('原文1件が壊れてもdoctorは正常な別入力を孤立扱いしない',async()=>{
 const{config,vault}=await setup();const good=await capture(config,{source:'cli',sourceEventId:'good',occurredAt:'2026-09-14T00:00:00Z',text:'正常'});const bad=await capture(config,{source:'cli',sourceEventId:'bad',occurredAt:'2026-09-14T00:00:00Z',text:'壊す対象'});
 await vault.write(bad.path,'壊れたfrontmatter');const report=await doctor(config);expect(report.inputs).toBe(1);expect(report.issues.join(' ')).not.toContain(good.inputId);
});
test('doctorはjournalと現在の入力原文の不一致を報告',async()=>{
 const{config,vault}=await setup();const saved=await capture(config,{source:'cli',sourceEventId:'journal',occurredAt:'2026-09-14T00:00:00Z',text:'現在の原文'});
 await vault.write(`90_system/receipts/pending/${saved.inputId}.json`,JSON.stringify({schema_version:1,input_id:saved.inputId,input_hash:'a'.repeat(64),status:'organized',attempts:1,organized_at:'2026-09-14T00:00:00Z',llm:{provider:'mock',model:'mock',prompt_version:1},result:{category:'unclassified',summary:'古い原文',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:null,new_project_hint:null},writes:[],error:null}));
 const report=await doctor(config);expect(report.issues.join(' ')).toContain('journal入力不一致');expect(report.issues.join(' ')).toContain(saved.inputId);
});
