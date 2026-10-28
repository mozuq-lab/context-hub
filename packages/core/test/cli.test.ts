import {afterEach,expect,test} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
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
