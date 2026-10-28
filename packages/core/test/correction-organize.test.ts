import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { addProject } from '../src/projects.js';
import { context, find, resume } from '../src/retrieve.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'ctx-revision-'));roots.push(root);const config=defaultConfig(join(root,'vault'),join(root,'state'));const vault=new Vault(config);await vault.init();await addProject(config,{id:'hub',title:'Hub'});return{config,vault};}
const base={source:'other-mac',project:'hub',kind:'work-summary' as const,tool:'codex'};
test('古い作業要約への訂正で後日の現在地を巻き戻さない',async()=>{
 const{config,vault}=await setup();
 const old=await capture(config,{...base,occurredAt:'2026-10-01T10:00:00Z',text:'## 現在地\n- [確認済み] 旧状態'});
 await capture(config,{...base,occurredAt:'2026-10-02T10:00:00Z',text:'## 現在地\n- [確認済み] 新状態'});
 await organize(config,new MockLlm());const raw=await vault.read(`90_system/receipts/${old.inputId}.json`);
 const revision=await correctInput(config,old.inputId,{source:'quickadd',occurredAt:'2026-10-03T10:00:00Z',text:'## 現在地\n- [確認済み] 訂正した旧状態'});
 await organize(config,new MockLlm());
 const now=await resume(config,'hub');expect(now.split('# 次の一手')[0]).toContain('新状態');expect(now.split('# 次の一手')[0]).not.toContain('訂正した旧状態');
 expect(now).toContain('訂正した旧状態');expect(now).toContain(old.inputId);expect(now).toContain(revision.inputId);
 expect(await vault.read(`90_system/receipts/${old.inputId}.json`)).toBe(raw);
 const receipt=JSON.parse((await vault.read(`90_system/receipts/${revision.inputId}.json`))!);expect(receipt).toMatchObject({root_input_id:old.inputId,evidence_ids:[old.inputId,revision.inputId],status:'organized'});
});
test('訂正整理が失敗したら旧解釈と未反映の注意を併記する',async()=>{
 const{config,vault}=await setup();const original=await capture(config,{...base,occurredAt:'2026-10-01T10:00:00Z',text:'## 現在地\n- [確認済み] 旧解釈'});await organize(config,new MockLlm());
 const revision=await correctInput(config,original.inputId,{source:'quickadd',occurredAt:'2026-10-03T10:00:00Z',text:'旧解釈を訂正したい'});
 expect(await vault.read('10_projects/hub/NOW.md')).toContain('訂正未反映');
 expect(await context(config,'hub')).toContain('訂正未反映');
 expect((await organize(config,new MockLlm([new Error('失敗')]))).failed).toBe(1);
 expect(await vault.read('10_projects/hub/NOW.md')).toContain('訂正未反映');expect(await context(config,'hub')).toContain('旧解釈');expect(await find(config,'旧解釈')).toContain(revision.inputId);
});
test('モデル応答中の根拠変更は記録の確定を拒否する',async()=>{
 const{config,vault}=await setup();const original=await capture(config,{...base,occurredAt:'2026-10-01T10:00:00Z',text:'原文'});await organize(config,new MockLlm());const revision=await correctInput(config,original.inputId,{source:'quickadd',occurredAt:'2026-10-03T10:00:00Z',text:'訂正'});
 const llm={complete:async(prompt:string,opts:any)=>{const result=await new MockLlm().complete(prompt,opts);await vault.write(original.path,(await vault.read(original.path))!.replace('原文','改変'));return result;}};
 await expect(organize(config,llm)).rejects.toThrow();expect(await vault.read(`90_system/receipts/${revision.inputId}.json`)).toBeUndefined();
});
test('アイデアの分類取消は原文と生成ノートを残して訂正へ案内する',async()=>{
 const{config,vault}=await setup();const original=await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'アイデア 面白そう'});await organize(config,new MockLlm());
 const revision=await correctInput(config,original.inputId,{source:'quickadd',occurredAt:'2026-10-03T10:00:00Z',text:'分類を訂正、参考 https://example.com'});await organize(config,new MockLlm());
 const note=await vault.read(`20_ideas/IDEA-${original.inputId.slice(3)}.md`);expect(note).toContain('分類取消');expect(note).toContain(revision.inputId);expect(await vault.read(original.path)).toContain('アイデア 面白そう');
});
