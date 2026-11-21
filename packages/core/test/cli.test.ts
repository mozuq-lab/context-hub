import {afterEach,expect,test} from 'vitest';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {defaultConfig} from '../src/config.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'ctx-cli-'));roots.push(root);const config=join(root,'config.json');await writeFile(config,JSON.stringify(defaultConfig(join(root,'vault'),join(root,'state'))));return{root,config};}
function cli(config:string,args:string[],stdin=''):Promise<{code:number|null,out:string,err:string}>{return new Promise((done,reject)=>{const p=spawn(process.execPath,[resolve('packages/core/dist/cli.js'),'--config',config,...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,CONTEXT_HUB_CONFIG:config}});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>done({code,out,err}));p.stdin.end(stdin);});}
test('CLIでstdin原文保存・再送・検索・0件整理・doctorまでモデルなしで実行',async()=>{
 const{root,config}=await setup();expect((await cli(config,['init'])).code).toBe(0);
 const text='日本語メモ\nhttps://example.com/\n';
 const saved=await cli(config,['add','--event-id','same','--occurred-at','2026-09-14T00:00:00Z'],text);expect(saved.code).toBe(0);const id=JSON.parse(saved.out).inputId;expect(id).toMatch(/^IN-/);
 const file=(await readdir(join(root,'vault/00_inbox')))[0];expect(await readFile(join(root,'vault/00_inbox',file),'utf8')).toContain(text);
 expect(JSON.parse((await cli(config,['add','--event-id','same'],text)).out).inputId).toBe(id);
 expect((await cli(config,['find','日本語'])).out).toContain(id);
 const organized=await cli(config,['organize']);expect(organized.code).toBe(0);expect(JSON.parse(organized.out).processed).toBe(1);
 expect((await cli(config,['organize','--quiet-empty'])).out.trim()).toBe('NO_REPLY');
 expect((await cli(config,['doctor'])).code).toBe(0);
},15000);
test('不正CLI入力で保存成功を返さず、候補承認にhashを要求',async()=>{
 const{config}=await setup();await cli(config,['init']);const failed=await cli(config,['add'],'  ');expect(failed.code).not.toBe(0);expect(failed.out).not.toContain('inputId');
 const approve=await cli(config,['approve','CAN-01K5ABCDEFGHJKMNPQRSTVWXYZ']);expect(approve.code).not.toBe(0);expect(approve.err).toContain('hash');
});
test('UTF-16ファイルを文字化けのまま成功保存しない',async()=>{
 const{root,config}=await setup();await cli(config,['init']);const file=join(root,'utf16.txt');await writeFile(file,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('日本語の要約','utf16le')]));
 const result=await cli(config,['add','--file',file]);expect(result.code).not.toBe(0);expect(result.out).not.toContain('inputId');expect(await readdir(join(root,'vault/00_inbox'))).toHaveLength(0);
});
test('organize --thinking は推論CLIへ渡り、報告されたモデルをreceiptに記録する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ctx-cli-'));roots.push(root);const config=join(root,'config.json');const executable=join(root,'infer fixture');const argvFile=join(root,'argv.json');
 const result={category:'idea',summary:'試すと面白そう',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:null,new_project_hint:null};
 await writeFile(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)));process.stdout.write(JSON.stringify({ok:true,capability:'model.run',transport:'gateway',provider:'openai',model:'gpt-6-astra',attempts:[],outputs:[{text:${JSON.stringify(JSON.stringify(result))}}]}));\n`,{mode:0o700});
 const base=defaultConfig(join(root,'vault'),join(root,'state'));await writeFile(config,JSON.stringify({...base,organize:{...base.organize,llm:{...base.organize.llm,provider:'openclaw-infer',executable,agent:'hub'}}}));
 expect((await cli(config,['init'])).code).toBe(0);const saved=await cli(config,['add'],'いつか試すと面白そう');const id=JSON.parse(saved.out).inputId;
 expect((await cli(config,['organize','--thinking','bogus'])).code).not.toBe(0);
 const organized=await cli(config,['organize','--thinking','low','--id',id]);expect(organized.code).toBe(0);expect(JSON.parse(organized.out).processed).toBe(1);
 const argv=JSON.parse(await readFile(argvFile,'utf8'));expect(argv.slice(0,3)).toEqual(['infer','model','run']);expect(argv).toContain('--gateway');expect(argv.slice(-4)).toEqual(['--agent','hub','--thinking','low']);expect(argv).not.toContain('--model');
 const receipt=JSON.parse(await readFile(join(root,'vault/90_system/receipts',`${id}.json`),'utf8'));expect(receipt.llm).toEqual({provider:'openclaw-infer',model:'openai/gpt-6-astra',prompt_version:1});
},15000);
test('CLIで次の一手を完了にするとHOMEの次の一手からも外れる',async()=>{
 const{root,config}=await setup();await cli(config,['init']);
 expect((await cli(config,['project','add','hub','--title','集約ツール'])).code).toBe(0);
 expect((await cli(config,['add','--kind','work-summary','--project','hub','--tool','codex','--occurred-at','2026-10-30T00:00:00Z'],'## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n')).code).toBe(0);
 expect((await cli(config,['cycle'])).code).toBe(0);
 const home=()=>readFile(join(root,'vault/HOME.md'),'utf8');
 expect(await home()).toContain('  - 利用者に見せる');
 const items=JSON.parse((await cli(config,['item','list','hub'])).out) as {key:string;text:string}[];
 const resolved=await cli(config,['item','resolve','hub',items.find(i=>i.text==='利用者に見せる')!.key,'--confirm']);expect(resolved.code).toBe(0);
 expect(await home()).not.toContain('  - 利用者に見せる');
 expect(await home()).toContain('  - 名前を決める');
},15000);
test('CLIで期日を付けると保たれ、片方だけ変えられ、--clearで外せる。経緯も作り直せる',async()=>{
 const{root,config}=await setup();await cli(config,['init']);
 await cli(config,['project','add','hub','--title','集約ツール']);
 await cli(config,['add','--kind','work-summary','--project','hub','--tool','codex','--occurred-at','2026-10-30T00:00:00Z'],'## 次の一手\n- [確認済み] 利用者に見せる\n');
 expect((await cli(config,['cycle'])).code).toBe(0);
 const key=(JSON.parse((await cli(config,['item','list','hub'])).out) as {key:string}[])[0]!.key;
 expect((await cli(config,['item','schedule','hub',key])).code).not.toBe(0);
 expect((await cli(config,['item','schedule','hub',key,'--confirm'])).code).not.toBe(0);
 expect((await cli(config,['item','schedule','hub',key,'--due','2026-02-30','--confirm'])).code).not.toBe(0);
 expect(JSON.parse((await cli(config,['item','schedule','hub',key,'--due','2099-12-01','--confirm'])).out)).toMatchObject({due:'2099-12-01',review_after:null});
 expect(JSON.parse((await cli(config,['item','schedule','hub',key,'--review','2099-11-01','--confirm'])).out)).toMatchObject({due:'2099-12-01',review_after:'2099-11-01'});
 expect(JSON.parse((await cli(config,['item','list','hub'])).out)[0]).toMatchObject({due:'2099-12-01',review_after:'2099-11-01'});
 expect(JSON.parse((await cli(config,['item','schedule','hub',key,'--due','none','--confirm'])).out)).toMatchObject({due:null,review_after:'2099-11-01'});
 expect(await readFile(join(root,'vault/HOME.md'),'utf8')).toContain('見直す日まで休ませている項目: 1件');
 expect(JSON.parse((await cli(config,['item','schedule','hub',key,'--clear','--confirm'])).out)).toMatchObject({due:null,review_after:null});
 expect((await cli(config,['item','schedule','hub',key,'--clear','--due','2099-12-01','--confirm'])).code).not.toBe(0);
 const history=await cli(config,['history','hub']);expect(history.code).toBe(0);expect(JSON.parse(history.out)).toEqual([{projectId:'hub',path:'10_projects/hub/HISTORY.md',written:false}]);
 expect(await readFile(join(root,'vault/10_projects/hub/HISTORY.md'),'utf8')).toContain('# 集約ツールの経緯');
},20000);
test('CLIで項目を誤りとして外すと、完了とは別の欄へ移り、未解決へ戻せる',async()=>{
 const{root,config}=await setup();await cli(config,['init']);
 expect((await cli(config,['project','add','hub','--title','集約ツール'])).code).toBe(0);
 expect((await cli(config,['add','--kind','work-summary','--project','hub','--tool','codex','--occurred-at','2026-10-30T00:00:00Z'],'## 次の一手\n- [確認済み] 利用者に見せる\n- [確認済み] 名前を決める\n')).code).toBe(0);
 expect((await cli(config,['cycle'])).code).toBe(0);
 type Item={key:string;text:string;resolved:unknown;excluded?:{reason:string;note?:string}};
 const list=async()=>JSON.parse((await cli(config,['item','list','hub'])).out) as Item[];
 const key=(await list()).find(i=>i.text==='利用者に見せる')!.key;
 // 理由のない依頼と、知らない理由は記録しない。
 expect((await cli(config,['item','exclude','hub',key,'--confirm'])).code).not.toBe(0);
 expect((await cli(config,['item','exclude','hub',key,'--reason','unknown','--confirm'])).code).not.toBe(0);
 const excluded=await cli(config,['item','exclude','hub',key,'--reason','outdated','--note','先月で終わった話','--confirm']);expect(excluded.code).toBe(0);
 const now=()=>readFile(join(root,'vault/10_projects/hub/NOW.md'),'utf8');
 expect(await now()).toContain('# 誤りとして外した項目（本人報告）');expect(await now()).toContain('理由: もう古い（先月で終わった話）');
 expect(await readFile(join(root,'vault/HOME.md'),'utf8')).not.toContain('  - 利用者に見せる');
 const item=(await list()).find(i=>i.key===key)!;expect(item.resolved).toBeNull();expect(item.excluded).toMatchObject({reason:'outdated',note:'先月で終わった話'});
 expect((await cli(config,['item','reopen','hub',key,'--confirm'])).code).toBe(0);
 expect(await now()).not.toContain('# 誤りとして外した項目（本人報告）');expect((await list()).find(i=>i.key===key)!.excluded).toBeUndefined();
},20000);
test('CLIでバックアップを確かめると結果を記録し、復元できないときは失敗で終わる',async()=>{
 const{root,config}=await setup();const backups=join(root,'backups');await mkdir(backups);
 const settings=JSON.parse(await readFile(config,'utf8'));settings.backup={dir:backups,verifyMaxAgeDays:7};await writeFile(config,JSON.stringify(settings));
 await cli(config,['init']);expect((await cli(config,['add','--occurred-at','2026-10-30T00:00:00Z'],'バックアップを確かめるメモ\n')).code).toBe(0);
 // バックアップがまだない間は、確かめられないことを失敗として返す。
 const none=await cli(config,['backup','verify']);expect(none.code).not.toBe(0);
 // 実際のバックアップと同じく、名前の日時（日本時間）と作った時刻をそろえる。
 const stamp=(hoursAgo:number)=>{const local=new Date(Date.now()+(9-hoursAgo)*3_600_000).toISOString();return `vault-${local.slice(0,10).replaceAll('-','')}-${local.slice(11,19).replaceAll(':','')}.tar.gz`;};
 const name=stamp(1),archive=join(backups,name);
 expect(spawnSync('tar',['-czf',archive,'-C',join(root,'vault'),'.']).status).toBe(0);
 const verified=await cli(config,['backup','verify']);expect(verified.code).toBe(0);
 const result=JSON.parse(verified.out) as {check:{status:string;archive:string;restored:{inputs:number}}};
 expect(result.check).toMatchObject({status:'ok',archive:name,restored:{inputs:1}});
 expect(await readFile(join(root,'vault/HOME.md'),'utf8')).toContain('最後に確かめた復元点: ');
 const status=JSON.parse((await cli(config,['backup','status'])).out) as {restore_point:{archive:string}|null;warnings:string[]};
 expect(status.restore_point?.archive).toBe(name);expect(status.warnings).toEqual([]);
 // 途中で切れたアーカイブは復元できないと記録し、終了コードで知らせる。確かめた復元点は残す。
 const broken=join(backups,stamp(0));await writeFile(broken,(await readFile(archive)).subarray(0,200));
 const failed=await cli(config,['backup','verify']);expect(failed.code).toBe(1);expect(JSON.parse(failed.out).check.status).toBe('failed');
 expect(JSON.parse((await cli(config,['backup','status'])).out).restore_point.archive).toBe(name);
},30000);
test('CLIで本人の行動を次の一手に追加し、作業要約の次の一手を行動にできる',async()=>{
 const{root,config}=await setup();await cli(config,['init']);
 expect((await cli(config,['project','add','hub','--title','集約ツール'])).code).toBe(0);
 expect((await cli(config,['item','add','hub','請求書を送る'])).code).not.toBe(0);
 const added=await cli(config,['item','add','hub','請求書を送る','--confirm']);expect(added.code).toBe(0);
 expect(JSON.parse(added.out)).toMatchObject({deduped:false,projectId:'hub'});
 expect(await readFile(join(root,'vault/HOME.md'),'utf8')).toContain('  - 本人が追加: 請求書を送る');
 expect((await cli(config,['add','--kind','work-summary','--project','hub','--tool','codex','--occurred-at','2026-10-30T00:00:00Z'],'## 次の一手\n- [確認済み] 利用者に見せる\n')).code).toBe(0);
 expect((await cli(config,['cycle'])).code).toBe(0);
 let items=JSON.parse((await cli(config,['item','list','hub'])).out) as {key:string;text:string;added_by_person?:boolean;from?:unknown}[];
 expect(items.map(i=>[i.text,i.added_by_person??false])).toEqual([['本人が追加: 請求書を送る',true],['利用者に見せる',false]]);
 const ai=items.find(i=>i.text==='利用者に見せる')!;
 expect((await cli(config,['item','add','hub','--from-key',ai.key,'--confirm'])).code).toBe(0);
 items=JSON.parse((await cli(config,['item','list','hub'])).out);
 expect(items.map(i=>i.text)).toEqual(['本人が追加: 請求書を送る','本人が追加: 利用者に見せる']);
 expect(items[1]!.from).toMatchObject({text:'利用者に見せる',key:ai.key});
 expect((await cli(config,['item','add','hub','x','--from','IN-01M7WSZTS5GZJ4A16AYVW0T46Z','--confirm'])).code).not.toBe(0);
 // 未解決の項目は行動にできない。同じ受付IDの再送は重複せず、別の内容なら断る。
 expect((await cli(config,['add','--kind','work-summary','--project','hub','--tool','codex','--occurred-at','2026-10-31T00:00:00Z'],'## 未解決\n- 認証をどうするか\n')).code).toBe(0);
 expect((await cli(config,['cycle'])).code).toBe(0);
 const open=(JSON.parse((await cli(config,['item','list','hub'])).out) as {key:string;section:string}[]).find(i=>i.section==='open')!;
 const refused=await cli(config,['item','add','hub','--from-key',open.key,'--confirm']);expect(refused.code).not.toBe(0);expect(refused.err).toContain('未解決は行動にできません');
 const first=JSON.parse((await cli(config,['item','add','hub','見積もりを取る','--event-id','e1','--confirm'])).out);
 const again=JSON.parse((await cli(config,['item','add','hub','見積もりを取る','--event-id','e1','--confirm'])).out);
 expect(again).toMatchObject({inputId:first.inputId,deduped:true,itemKey:first.itemKey});
 expect((await cli(config,['item','add','hub','別の文面','--event-id','e1','--confirm'])).code).not.toBe(0);
},20000);
test('CLIで人を登録・変更・外し、変更と外すには確認したハッシュを求める',async()=>{
 const{root,config}=await setup();await cli(config,['init']);
 await cli(config,['add','--occurred-at','2026-11-10T00:00:00Z'],'田中さんと話した');await cli(config,['organize']);
 const added=await cli(config,['person','add','tanaka','--name','田中さん','--aliases','田中,Tanaka']);expect(added.code).toBe(0);expect(JSON.parse(added.out)).toMatchObject({personId:'tanaka',action:'add'});
 expect(await readFile(join(root,'vault/40_people/tanaka/SUMMARY.md'),'utf8')).toContain('田中さんと話した');
 expect((await cli(config,['person','show','tanaka'])).out).toContain('記録 1件');
 const listed=JSON.parse((await cli(config,['person','list'])).out);expect(listed.people[0]).toMatchObject({id:'tanaka',aliases:['田中','Tanaka']});
 expect((await cli(config,['person','edit','tanaka','--remove-alias','Tanaka','--confirm'])).code).not.toBe(0);
 expect((await cli(config,['person','edit','tanaka','--remove-alias','Tanaka','--hash',listed.people[0].hash,'--confirm'])).code).toBe(0);
 // 呼び名が多くても変更できる（受付IDの長さの上限を超えない）。
 const many=Array.from({length:20},(_,i)=>`呼び名${'あ'.repeat(20)}${i}`);
 const hash1=JSON.parse((await cli(config,['person','list'])).out).people[0].hash;
 expect((await cli(config,['person','edit','tanaka',...many.flatMap(a=>['--add-alias',a]),'--remove-alias','田中','--hash',hash1,'--confirm'])).code).toBe(0);
 expect(JSON.parse((await cli(config,['person','list'])).out).people[0].aliases).toHaveLength(20);
 const hash2=JSON.parse((await cli(config,['person','list'])).out).people[0].hash;
 expect((await cli(config,['person','remove','tanaka','--hash',hash2,'--confirm'])).code).toBe(0);
 expect(JSON.parse((await cli(config,['person','list'])).out).people).toEqual([]);
 expect(await readdir(join(root,'vault/40_people/tanaka')).catch(()=>[])).toEqual([]);
},20000);
