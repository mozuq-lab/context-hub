import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/config.js';
import { Vault } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { addProject, readProjects } from '../src/projects.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { resume, context } from '../src/retrieve.js';
import { projectRegistryHash } from '../src/associations.js';
import { correctInput } from '../src/corrections.js';
import { doctor } from '../src/doctor.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'ctx-assoc-'));roots.push(root);const config=defaultConfig(join(root,'vault'),join(root,'state'));const vault=new Vault(config);await vault.init();return{config,vault};}
test('新しい定義で未所属メモを関連付け同じ組を再呼び出ししない',async()=>{
 const{config,vault}=await setup();const saved=await capture(config,{source:'quickadd',kind:'work-summary',occurredAt:'2026-10-01T10:00:00Z',text:'## 現在地\n- [確認済み] 菜園を栽培中'});await organize(config,new MockLlm());const raw=await vault.read(`90_system/receipts/${saved.inputId}.json`);
 await addProject(config,{id:'garden',title:'家庭菜園',keywords:['菜園']});
 await organize(config,new MockLlm());expect(await vault.read(`90_system/receipts/${saved.inputId}.json`)).toBe(raw);expect(await vault.files('90_system/associations')).toHaveLength(1);
 expect(await resume(config,'garden')).toContain('菜園を栽培中');expect(await context(config,'garden')).toContain(saved.inputId);
 const forbidden={complete:async()=>{throw new Error('再呼出は禁止');}};expect((await organize(config,forbidden)).failed).toBe(0);expect(await vault.files('90_system/associations')).toHaveLength(1);
 await addProject(config,{id:'other',title:'その他'});const projects=await readProjects(config);expect(projectRegistryHash(projects)).toBe(projectRegistryHash(projects.slice().reverse()));
});
test('明示指定を動かさず新規整理と再関連付けで件数枠を共有する',async()=>{
 const{config,vault}=await setup();config.organize.maxItemsPerRun=1;await addProject(config,{id:'fixed',title:'固定'});
 const explicit=await capture(config,{source:'cli',project:'fixed',occurredAt:'2026-10-01T10:00:00Z',text:'菜園の情報'});await organize(config,new MockLlm());
 await capture(config,{source:'cli',occurredAt:'2026-10-02T10:00:00Z',text:'菜園の別情報'});await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});
 const latest=await capture(config,{source:'cli',occurredAt:'2026-10-03T10:00:00Z',text:'新規メモ'});const run=await organize(config,new MockLlm());expect(run.inputIds).toContain(latest.inputId);expect(await vault.files('90_system/associations')).toHaveLength(0);
 await organize(config,new MockLlm());const files=await vault.files('90_system/associations');expect(files.some(p=>p.includes(explicit.inputId))).toBe(false);
});
test('dry-runは再関連付けも書かずモデルを呼ばない',async()=>{
 const{config,vault}=await setup();await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'菜園の情報'});await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});
 await organize(config,{complete:async()=>{throw new Error('禁止');}},{dryRun:true});expect(await vault.files('90_system/associations')).toHaveLength(0);
});
test('再関連付けされた入力の未処理訂正でも旧解釈と注意を残す',async()=>{
 const{config,vault}=await setup();const saved=await capture(config,{source:'cli',kind:'work-summary',occurredAt:'2026-10-01T10:00:00Z',text:'## 現在地\n- [確認済み] 菜園を栽培中'});await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});await organize(config,new MockLlm());await correctInput(config,saved.inputId,{source:'quickadd',occurredAt:'2026-10-03T10:00:00Z',text:'栽培の報告を訂正する'});const now=await vault.read('10_projects/garden/NOW.md');expect(now).toContain('栽培中');expect(now).toContain('訂正未反映');expect(await context(config,'garden')).toContain(saved.inputId);
});
test('再関連付けの失敗は明示再試行と上限で扱う',async()=>{
 const{config,vault}=await setup();config.organize.maxAttempts=2;await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'菜園'});await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});const failure={complete:async()=>{throw new Error('障害');}};
 expect((await organize(config,failure)).failed).toBe(1);expect((await organize(config,failure)).failed).toBe(0);expect((await organize(config,failure,{retryFailed:true})).failed).toBe(1);expect((await organize(config,failure,{retryFailed:true})).failed).toBe(0);const[path]=await vault.files('90_system/associations');expect(JSON.parse((await vault.read(path))!).attempts).toBe(2);
});
test('再関連付けされた入力の訂正成功で旧NOWの情報を取り消す',async()=>{
 const{config,vault}=await setup();const saved=await capture(config,{source:'cli',kind:'work-summary',occurredAt:'2026-10-01T10:00:00Z',text:'## 現在地\n- [確認済み] 菜園を栽培中'});
 await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});await organize(config,new MockLlm());
 await correctInput(config,saved.inputId,{source:'quickadd',occurredAt:'2026-10-03T10:00:00Z',text:'別件の報告だったため取り消す'});
 await organize(config,new MockLlm());const now=await vault.read('10_projects/garden/NOW.md');expect(now).not.toContain('栽培中');expect(now).not.toContain('訂正未反映');expect(now).toContain('根拠となる入力がありません');
});
test('定義更新後の再関連付けで外れた旧NOWも再生成する',async()=>{
 const{config,vault}=await setup();await capture(config,{source:'cli',kind:'work-summary',occurredAt:'2026-10-01T10:00:00Z',text:'## 現在地\n- [確認済み] 菜園を栽培中'});
 await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});await organize(config,new MockLlm());expect(await vault.read('10_projects/garden/NOW.md')).toContain('栽培中');
 await addProject(config,{id:'other',title:'別件'});await organize(config,{complete:async()=>({text:JSON.stringify({project_candidates:[]}),model:'mock'})});
 expect(await vault.read('10_projects/garden/NOW.md')).not.toContain('栽培中');
});
test('再関連付け記録後のNOW書き込み失敗をモデルなしで回復する',async()=>{
 const{config,vault}=await setup();await capture(config,{source:'cli',kind:'work-summary',occurredAt:'2026-10-01T10:00:00Z',text:'## 現在地\n- [確認済み] 菜園を栽培中'});await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});
 const write=Vault.prototype.write;vi.spyOn(Vault.prototype,'write').mockImplementation(async function(this:Vault,path,text){if(path==='10_projects/garden/NOW.md')throw new Error('一時的な書き込み失敗');return write.call(this,path,text);});
 await expect(organize(config,new MockLlm())).rejects.toThrow('書き込み失敗');expect(await vault.files('90_system/associations')).toHaveLength(1);vi.restoreAllMocks();expect((await doctor(config)).issues.join(' ')).toContain('表示の回復待ち');
 const forbidden={complete:vi.fn(async()=>{throw new Error('モデル再呼出は禁止');})};const recovered=await organize(config,forbidden,{limit:1});expect(recovered.processed).toBe(1);expect(forbidden.complete).not.toHaveBeenCalled();expect(await vault.read('10_projects/garden/NOW.md')).toContain('栽培中');expect((await organize(config,forbidden)).processed).toBe(0);
});
test('ID指定の再関連付けは対象だけを処理しdry-runと成功後はモデルを呼ばない',async()=>{
 const{config,vault}=await setup();const target=await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'菜園の情報'}),other=await capture(config,{source:'cli',occurredAt:'2026-10-02T10:00:00Z',text:'菜園の別の情報'});
 await organize(config,new MockLlm());const originalReceipt=await vault.read(`90_system/receipts/${target.inputId}.json`);await addProject(config,{id:'garden',title:'菜園'});
 const forbidden={complete:async()=>{throw new Error('モデル呼出は禁止');}};
 const preview=await organize(config,forbidden,{id:target.inputId,dryRun:true,limit:1});expect(preview.inputIds).toEqual([target.inputId]);expect(await vault.files('90_system/associations')).toHaveLength(0);
 const result=await organize(config,new MockLlm(),{id:target.inputId,limit:1});expect(result.processed).toBe(1);expect(result.failed).toBe(0);expect(result.inputIds).toEqual([target.inputId]);
 const records=await vault.files('90_system/associations');expect(records).toHaveLength(1);expect(records[0]).toContain(target.inputId);expect(records[0]).not.toContain(other.inputId);expect(await vault.read(`90_system/receipts/${target.inputId}.json`)).toBe(originalReceipt);
 expect((await organize(config,forbidden,{id:target.inputId})).processed).toBe(0);
});
test.each(['元ID','最新訂正ID'])('%s指定でも訂正済みの有効解釈を再関連付けする',async(targetKind)=>{
 const{config,vault}=await setup();const original=await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'菜園の情報'});await organize(config,new MockLlm());
 const corrected=await correctInput(config,original.inputId,{source:'quickadd',occurredAt:'2026-10-02T10:00:00Z',text:'菜園の情報を訂正する'});await organize(config,new MockLlm());await addProject(config,{id:'garden',title:'菜園'});
 const result=await organize(config,new MockLlm(),{id:targetKind==='元ID'?original.inputId:corrected.inputId,limit:1});expect(result.reassociated).toBe(1);expect(result.inputIds).toEqual([original.inputId]);
 const[path]=await vault.files('90_system/associations');expect(JSON.parse((await vault.read(path))!).input_id).toBe(original.inputId);expect(await context(config,'garden')).toContain(corrected.inputId);
});
