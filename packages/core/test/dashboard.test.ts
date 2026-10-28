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
