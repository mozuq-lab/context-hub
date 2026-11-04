import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup,packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { ingest } from '../src/intake.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test('一覧はNOW未生成のプロジェクトも定義へ案内し端末保存と受領を分ける',async()=>{
 const{config,vault}=await workflowSetup(roots);await addProject(config,{id:'garden',title:'家庭菜園'});const p=await packet(config);await rebuildDashboard(config);const home=await vault.read('HOME.md');expect(home).toContain('家庭菜園');expect(home).toContain('10_projects/garden/project.md');expect(home).toContain('受付待ち');expect(home).toContain(p.requestId);expect(home).toContain('生成時点');
});
test('人が変更したHOMEを保護して新版を退避する',async()=>{
 const{config,vault}=await workflowSetup(roots);await rebuildDashboard(config);const edited=(await vault.read('HOME.md'))!+'\n手動メモ';await vault.write('HOME.md',edited);expect((await rebuildDashboard(config)).conflict).toBeDefined();expect(await vault.read('HOME.md')).toBe(edited);
});
test('受領済み受付の本文が変わればHOMEは旧内容の受領と明示する',async()=>{
 const{config,vault}=await workflowSetup(roots);const p=await packet(config);await ingest(config);await vault.write(p.path,(await vault.read(p.path))!.replace('メモの本文','変わった本文'));await rebuildDashboard(config);expect(await vault.read('HOME.md')).toContain('旧内容の受領');
});
test('HOMEに進行中のプロジェクトの次の一手を最近動いた順に載せ、完了済み・休止中・上限超えを除く',async()=>{
 const{config,vault}=await workflowSetup(roots);
 const{capture}=await import('../src/capture.js'),{organize}=await import('../src/organize.js'),{MockLlm}=await import('../src/llm.js');
 const{readNowItems,setItemResolution}=await import('../src/item-resolutions.js'),{setProjectStatus}=await import('../src/project-status.js'),{hash}=await import('../src/storage.js');
 const summary=(items:string[])=>`## 現在地\n- [確認済み] 進めている\n## 次の一手\n${items.map(i=>`- [確認済み] ${i}`).join('\n')}`;
 for(const[id,title,at,items]of[['hub','集約ツール','2026-10-30T00:00:00Z',['利用者に見せる','[注意]表を直す','配布する','説明を書く','名前を決める']],['side','別のアプリ','2026-11-01T00:00:00Z',['設定画面を作る']],['rest','休止中の計画','2026-11-02T00:00:00Z',['休止中の作業']]]as const){
  await addProject(config,{id,title});
  await capture(config,{source:'file',kind:'work-summary',tool:'codex',project:id,occurredAt:at,receivedAt:at,text:summary([...items])});
 }
 await organize(config,new MockLlm());
 await setProjectStatus(config,{projectId:'rest',status:'paused',expectedHash:hash((await vault.read('10_projects/rest/project.md'))!),source:'cli'});
 const first=(await readNowItems(vault,'hub'))!.items[0]!;
 await setItemResolution(config,{projectId:'hub',itemKey:first.key,action:'resolve',source:'cli'});
 await rebuildDashboard(config,{now:new Date('2026-11-03T00:00:00Z')});
 const home=(await vault.read('HOME.md'))!,start=home.indexOf('## 次の一手（進行中のプロジェクト）'),section=home.slice(start,home.indexOf('\n## ',start+1));
 expect(start).toBeGreaterThan(home.indexOf('## プロジェクト一覧'));
 expect(section).toContain('プロジェクトごとに3件まで');
 expect(section.indexOf('[別のアプリ](10_projects/side/NOW.md)')).toBeLessThan(section.indexOf('[集約ツール](10_projects/hub/NOW.md)'));
 expect(section).toContain('  - 設定画面を作る');
 // 完了と報告した項目は載せず、残りから上限まで載せる。角括弧はリンクにならないよう退避する。
 expect(section).not.toContain('利用者に見せる');
 expect(section).toContain('  - \\[注意\\]表を直す\n  - 配布する\n  - 説明を書く\n  - ほか1件はNOWで確認');
 expect(section).not.toContain('休止中の作業');
 expect(home).toContain('## 休止・完了（1件）');
 // 項目一覧が壊れていてもHOMEは作り、失敗と競合に載せる。
 await vault.write('90_system/now-items/side.json','{');
 await rebuildDashboard(config,{now:new Date('2026-11-03T00:00:00Z')});
 const broken=(await vault.read('HOME.md'))!;
 expect(broken).toContain('[NOW項目の記録が不正です](90_system/now-items/side.json)');
 expect(broken).toContain('  - 配布する');
});
test('進行中のプロジェクトがなければ次の一手の節を出さない',async()=>{
 const{config,vault}=await workflowSetup(roots);await rebuildDashboard(config);
 expect(await vault.read('HOME.md')).not.toContain('## 次の一手');
 await addProject(config,{id:'garden',title:'家庭菜園'});await rebuildDashboard(config);
 expect(await vault.read('HOME.md')).toContain('## 次の一手（進行中のプロジェクト）\n進行中のプロジェクトに次の一手はありません。');
});
