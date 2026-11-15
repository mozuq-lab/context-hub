import {afterEach,expect,test} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../config.mjs';
import {safePath,writeJson,withUpdateLock} from '../common.mjs';

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
