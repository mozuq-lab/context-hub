import { afterEach, expect, test } from 'vitest';
import { readFile,rm,mkdir,utimes } from 'node:fs/promises';
import {existsSync} from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parse } from 'yaml';
import { workflowSetup } from './workflow-fixtures.js';
import { Vault } from '../src/storage.js';
import { parseIntake } from '../src/intake-format.js';
import {rebuildDashboard} from '../src/dashboard.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { ingest } from '../src/intake.js';
import { readProjects } from '../src/projects.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function ui(config:any,body='日本語\r\n"引用"',confirm=true){
 const vault=new Vault(config),notices:string[]=[],confirmations:string[]=[];const module={exports:{} as any};
 const script=await readFile('examples/quickadd/context-hub.js','utf8');runInNewContext(script,{module,crypto:webcrypto,TextEncoder,Uint8Array,Date,JSON,Error,console});
 const params={app:{vault:{getAbstractFileByPath:(path:string)=>existsSync(join(config.vaultPath,path))?{path}:null,createFolder:async(path:string)=>mkdir(join(config.vaultPath,path),{recursive:true}),create:async(path:string,text:string)=>{if(!await vault.create(path,text))throw new Error('競合');await utimes(join(config.vaultPath,path),new Date(0),new Date(0));return{path};},read:async(file:{path:string})=>{const raw=await vault.read(file.path);if(raw===undefined)throw new Error('未同期');return raw;},getMarkdownFiles:async()=>{const files=[];for(const dir of ['00_inbox','90_system/project-candidates'])for(const path of await vault.files(dir))if(path.endsWith('.md'))files.push({path});return files;}}},quickAddApi:{wideInputPrompt:async()=>body,suggester:async(_labels:string[],values:any[])=>values[0],yesNoPrompt:async(_title:string,text:string)=>{confirmations.push(text);return confirm;}},obsidian:{parseYaml:parse,Notice:class{constructor(text:string){notices.push(text);}}}};
 return{actions:module.exports,params,notices,confirmations};
}
test('モバイル相当のAPIで作った入力をcoreが受理する',async()=>{
 const{config,vault}=await workflowSetup(roots);const{actions,params,notices}=await ui(config);await actions.captureMemo(params);const[submitted]=await vault.files('Input');expect(parseIntake(submitted,(await vault.read(submitted))!,8000)).toMatchObject({kind:'memo',text:'日本語\r\n"引用"'});expect(notices.join(' ')).toContain('同期・処理待ち');
});
test('確認取消と同期不足では承認ファイルを作らない',async()=>{
 const{config,vault}=await workflowSetup(roots);await capture(config,{source:'cli',occurredAt:'2026-10-03T10:00:00Z',text:'菜園のアイデア'});
 await organize(config,new MockLlm([{category:'idea',summary:'菜園',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:null,new_project_hint:null,project_proposal:{title:'家庭菜園',aliases:['菜園'],keywords:['栽培'],rationale:'長く続ける計画'}}]));
 await rebuildDashboard(config);const first=await ui(config,'',false);await first.actions.approveProject(first.params);expect(first.confirmations.join(' ')).toContain('長く続ける計画');expect(await vault.files('Input')).toHaveLength(0);
 for(const path of await vault.files('90_system/project-confirmations'))await rm(join(config.vaultPath,path));const second=await ui(config,'',true);await expect(second.actions.approveProject(second.params)).rejects.toThrow();expect(await vault.files('Input')).toHaveLength(0);expect(second.notices.join(' ')).not.toContain('保存しました');
});
test('QuickAddで人が確認した候補が同期受付を通して定義になる',async()=>{
 const{config,vault}=await workflowSetup(roots);await capture(config,{source:'cli',occurredAt:'2026-10-03T10:00:00Z',text:'菜園のアイデア'});await organize(config,new MockLlm([{category:'idea',summary:'菜園',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:null,new_project_hint:null,project_proposal:{title:'家庭菜園',aliases:['菜園'],keywords:['栽培'],rationale:'長く続ける計画'}}]));
 await rebuildDashboard(config);const{actions,params}=await ui(config,'',true);await actions.approveProject(params);expect((await ingest(config)).accepted).toBe(1);expect(await readProjects(config)).toMatchObject([{title:'家庭菜園'}]);expect(await vault.files('Input')).toHaveLength(1);
});
test('保存失敗を成功と通知しない',async()=>{
 const{config,vault}=await workflowSetup(roots);const{actions,params,notices}=await ui(config);params.app.vault.create=async()=>{throw new Error('保存不可');};await expect(actions.captureMemo(params)).rejects.toThrow('保存不可');expect(await vault.files('Input')).toHaveLength(0);expect(notices.join(' ')).not.toContain('端末に保存しました');
});
