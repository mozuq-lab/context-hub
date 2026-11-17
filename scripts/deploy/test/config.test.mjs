import {afterEach,expect,test} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink,readFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {loadConfig} from '../config.mjs';
import {safePath,writeJson,withUpdateLock,run} from '../common.mjs';

const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ctx-deploy-config-')));roots.push(root);
 const repository=join(root,'source checkout'),vault=join(root,'vault'),file=join(root,'deployment.json');
 await mkdir(repository);await mkdir(vault);
 const hubConfigPath=join(root,'hub.json');await writeFile(hubConfigPath,JSON.stringify({vaultPath:vault,statePath:join(root,'state')}));
 const config={schema_version:1,hubConfigPath,installDir:join(root,'runtime area'),previousRuntimePath:repository,openclaw:null,launchd:{syncPlist:null,backupPlist:null,backupVerifyPlist:null},workspacePath:null,preserveAssets:[]};
 await writeFile(file,JSON.stringify(config));return{root,repository,vault,file,config};
}
test('空白を含むリポジトリ外の運用先を許可し、サービス未使用を明示できる',async()=>{
 const f=await fixture(),c=await loadConfig(f.file,f.repository);
 expect(c.installDir).toBe(join(f.root,'runtime area'));expect(c.vaultPath).toBe(f.vault);expect(c.openclaw).toBeNull();
});
test.each(['vault','source','legacy'])('workspaceと%sの包含、および旧checkout内の運用先を拒否する',async kind=>{
 const f=await fixture();const legacy=join(f.root,'legacy');await mkdir(legacy);f.config.previousRuntimePath=legacy;
 f.config.workspacePath=join(kind==='vault'?f.vault:kind==='source'?f.repository:legacy,'nested');await writeFile(f.file,JSON.stringify(f.config));
 await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/外|重な|包含/);
 f.config.workspacePath=null;f.config.installDir=join(legacy,'runtime');await writeFile(f.file,JSON.stringify(f.config));await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/外|重な|包含/);
});
test('別の回収処理が持つ排他を無視して死亡ロックを回収しない',async()=>{
 const f=await fixture();await mkdir(f.config.installDir);const lock=join(f.config.installDir,'.deploy.lock'),reaper=join(f.config.installDir,'.deploy.reap');await mkdir(lock);await mkdir(reaper);
 await writeJson(join(lock,'owner.json'),{pid:999999999,token:'old-token',planId:'plan-a'});await writeJson(join(reaper,'owner.json'),{pid:process.pid,token:'active-token'});await writeJson(join(f.config.installDir,'deployment-state.json'),{planId:'plan-a',writersResumed:false});
 let entered=false;await expect(withUpdateLock(f.config.installDir,'plan-a',async()=>{entered=true;},{resume:true})).rejects.toThrow(/ロック|回収|実行/);expect(entered).toBe(false);
 expect(JSON.parse(await readFile(join(reaper,'owner.json'),'utf8')).token).toBe('active-token');
});
test('SIGTERMを無視する子プロセスも期限内に終了させる',async()=>{
 const f=await fixture(),pidFile=join(f.root,'child.pid');let childPid;
 const task=run(process.execPath,['-e',`require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,pidFile],{timeout:150});
 const timeout=new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('deadline exceeded')),2500);t.unref();});
 try{const result=await Promise.race([task,timeout]);expect(result.code).not.toBe(0);}
 finally{try{childPid=Number(await readFile(pidFile,'utf8'));process.kill(childPid,'SIGKILL');}catch{}}
},4000);
test('SIGTERMで終了する期限超過も、通常の終了コード1と区別する',async()=>{
 const r=await run(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(1));process.stdout.write('ready');setInterval(()=>{},1000);"],{timeout:500});
 expect(r.stdout).toBe('ready');expect(r.code).toBe(1);expect(r.signal).toBeNull();expect(r.timedOut).toBe(true);
});
test.each(['vault','source'])('運用先が%s内にある設定を拒否する',async kind=>{
 const f=await fixture();f.config.installDir=join(kind==='vault'?f.vault:f.repository,'runtime');await writeFile(f.file,JSON.stringify(f.config));
 await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/外|重な|包含/);
});
test('未知の設定とサービス未指定を拒否し、誤った対象を推測しない',async()=>{
 const f=await fixture();f.config.launchd.extra='unexpected';await writeFile(f.file,JSON.stringify(f.config));
 await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/設定/);
 delete f.config.launchd.extra;delete f.config.openclaw;await writeFile(f.file,JSON.stringify(f.config));
 await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/明示|設定/);
});
test('symlinkを通る設定ファイルと運用先を拒否する',async()=>{
 const f=await fixture(),link=join(f.root,'link');await symlink(f.vault,link);
 await expect(safePath(join(link,'new.json'))).rejects.toThrow(/symlink/);
 await symlink(f.file,join(f.root,'config-link.json'));await expect(loadConfig(join(f.root,'config-link.json'),f.repository)).rejects.toThrow(/symlink/);
});
test('耐久JSON書き込みが既存内容を置換し、並行した更新ロックを拒否する',async()=>{
 const f=await fixture();await writeJson(join(f.root,'state.json'),{phase:'ready'});expect(JSON.parse(await readFile(join(f.root,'state.json'),'utf8'))).toEqual({phase:'ready'});
 await withUpdateLock(f.config.installDir,'plan-a',async()=>{
  await expect(withUpdateLock(f.config.installDir,'plan-b',async()=>{})).rejects.toThrow(/更新.*実行|ロック/);
 });
 await expect(withUpdateLock(f.config.installDir,'plan-b',async()=>42)).resolves.toBe(42);
});

const caseAlias=p=>join(dirname(p),basename(p).toUpperCase());
async function hasCaseAlias(p){try{return await realpath(caseAlias(p))===await realpath(p);}catch(e){if(e.code==='ENOENT')return false;throw e;}}
test.for([
 ['installDir','vaultPath'],['installDir','repository'],['installDir','previousRuntimePath'],
 ['workspacePath','vaultPath'],['workspacePath','repository'],['workspacePath','previousRuntimePath'],['workspacePath','installDir'],
 ['vaultPath','repository'],['vaultPath','previousRuntimePath'],
])('既存祖先の大小文字aliasでも%sを%s内へ置けない',async([child,parent],ctx)=>{
 const f=await fixture(),paths={...f.config,vaultPath:f.vault,repository:f.repository,previousRuntimePath:join(f.root,'legacy checkout')};
 await mkdir(paths.previousRuntimePath);await mkdir(f.config.installDir);
 if(!await hasCaseAlias(paths[parent]))ctx.skip();
 f.config.previousRuntimePath=paths.previousRuntimePath;
 const nested=join(caseAlias(paths[parent]),'new','nested'),hub={vaultPath:f.vault,statePath:join(f.root,'state')};
 if(child==='vaultPath')hub.vaultPath=nested;else f.config[child]=nested;
 await writeFile(f.config.hubConfigPath,JSON.stringify(hub));await writeFile(f.file,JSON.stringify(f.config));
 await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/外|重な|包含/);
});
test.for(['deployment','hub','syncPlist','backupPlist','backupVerifyPlist','openclawConfig','gatewayPlist'])('Vaultの大小文字alias内の制御ファイル%sを拒否する',async(kind,ctx)=>{
 const f=await fixture();if(!await hasCaseAlias(f.vault))ctx.skip();
 const canonical=join(f.vault,'control.json'),alias=join(caseAlias(f.vault),'control.json');let file=f.file;
 if(kind==='deployment')file=alias;
 else if(kind==='hub'){
  await writeFile(canonical,await readFile(f.config.hubConfigPath));f.config.hubConfigPath=alias;
 }else if(['syncPlist','backupPlist','backupVerifyPlist'].includes(kind))f.config.launchd[kind]=alias;
 else f.config.openclaw={executable:join(f.root,'openclaw'),configPath:kind==='openclawConfig'?alias:join(f.root,'openclaw.json'),gatewayPlist:kind==='gatewayPlist'?alias:join(f.root,'gateway.plist'),automationId:null};
 await writeFile(file,JSON.stringify(f.config));
 await expect(loadConfig(file,f.repository)).rejects.toThrow(/外|重な|包含/);
});
test('大小文字aliasで同じ制御ファイルを二重管理しない',async ctx=>{
 const f=await fixture();if(!await hasCaseAlias(f.config.hubConfigPath))ctx.skip();
 f.config.launchd.syncPlist=caseAlias(f.config.hubConfigPath);await writeFile(f.file,JSON.stringify(f.config));
 await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/重な/);
});
test('filesystem上で別の大小文字ディレクトリは分離した運用先として扱う',async()=>{
 const f=await fixture(),alias=caseAlias(f.vault);
 if(!await hasCaseAlias(f.vault))await mkdir(alias);
 f.config.installDir=join(alias,'installation');await writeFile(f.file,JSON.stringify(f.config));
 if(await hasCaseAlias(f.vault))await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/外|重な|包含/);
 else expect((await loadConfig(f.file,f.repository)).installDir).toBe(join(alias,'installation'));
});
test.each(['statePath','logging.dir'])('%sを入れ替えるruntime・候補・前版の領域へ置けない',async kind=>{
 const f=await fixture();
 for(const target of ['runtime','runtime/state','updates','updates/fixture/candidate/state','updates/fixture/previous-runtime/state']){
  const hub={vaultPath:f.vault,statePath:join(f.root,'state'),logging:{dir:join(f.root,'logs')}};
  if(kind==='statePath')hub.statePath=join(f.config.installDir,target);else hub.logging.dir=join(f.config.installDir,target);
  await writeFile(f.config.hubConfigPath,JSON.stringify(hub));
  await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/状態|ログ|runtime|更新領域/);
 }
});
test('statePath配下の運用先とその外にある状態・ログは許可する',async()=>{
 const f=await fixture(),state=join(f.root,'state');f.config.installDir=join(state,'installation');
 const hub={vaultPath:f.vault,statePath:state,logging:{dir:join(state,'logs')}};
 await writeFile(f.config.hubConfigPath,JSON.stringify(hub));await writeFile(f.file,JSON.stringify(f.config));
 expect((await loadConfig(f.file,f.repository)).installDir).toBe(join(state,'installation'));
 expect(await readFile(f.config.hubConfigPath,'utf8')).toBe(JSON.stringify(hub));
 expect(await readFile(f.file,'utf8')).toBe(JSON.stringify(f.config));
});
test.for(['statePath','logging.dir'])('未作成のruntime・updatesの大小文字alias内にも%sを置けない',async(kind,ctx)=>{
 const f=await fixture();if(!await hasCaseAlias(f.root))ctx.skip();
 for(const target of ['RUNTIME/state','UPDATES/fixture/CANDIDATE/state','UPDATES/fixture/PREVIOUS-RUNTIME/state']){
  const hub={vaultPath:f.vault,statePath:join(f.root,'state'),logging:{dir:join(f.root,'logs')}};
  if(kind==='statePath')hub.statePath=join(f.config.installDir,target);else hub.logging.dir=join(f.config.installDir,target);
  await writeFile(f.config.hubConfigPath,JSON.stringify(hub));
  await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/状態|ログ|runtime|更新領域/);
 }
});
test('未作成の運用先を指す大小文字alias内の制御ファイルもfilesystemに従って分離する',async()=>{
 const f=await fixture();f.config.installDir=join(f.root,'Future Installation');f.config.launchd.syncPlist=join(f.root,'FUTURE INSTALLATION','sync.plist');
 await writeFile(f.file,JSON.stringify(f.config));
 if(await hasCaseAlias(f.root))await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/外|重な|包含/);
 else expect((await loadConfig(f.file,f.repository)).launchd.syncPlist).toBe(f.config.launchd.syncPlist);
});
test('未作成の制御ファイルの大小文字aliasもfilesystemに従って重複判定する',async()=>{
 const f=await fixture();f.config.launchd.syncPlist=join(f.root,'Future.plist');f.config.launchd.backupPlist=join(f.root,'FUTURE.plist');
 await writeFile(f.file,JSON.stringify(f.config));
 if(await hasCaseAlias(f.root))await expect(loadConfig(f.file,f.repository)).rejects.toThrow(/重な/);
 else expect((await loadConfig(f.file,f.repository)).launchd.backupPlist).toBe(f.config.launchd.backupPlist);
});
