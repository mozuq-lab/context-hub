import {readJson,safePath,canonicalPath,overlaps,within} from './common.mjs';
import {resolve,isAbsolute,join} from 'node:path';
import {homedir} from 'node:os';

function keys(v,allowed,required=allowed){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k)))throw new Error('設定のキー・明示したサービスを確認してください');
}
function path(v){if(typeof v!=='string'||!isAbsolute(v)||v.includes('\0'))throw new Error('設定のパスは絶対パスで明示してください');return resolve(v);}
const optionalPath=v=>v===null?null:path(v);
const expand=v=>v==='~'?homedir():v?.startsWith('~/')?join(homedir(),v.slice(2)):v;
export async function loadConfig(file,repository){
 file=path(file);repository=path(repository);await safePath(file,{owned:true});const c=await readJson(file);
 keys(c,['schema_version','hubConfigPath','installDir','previousRuntimePath','openclaw','launchd','workspacePath','preserveAssets'],['schema_version','hubConfigPath','installDir','openclaw','launchd']);
 if(c.schema_version!==1)throw new Error('設定の形式が未対応です');
 const config={...c,file,repository,hubConfigPath:path(c.hubConfigPath),installDir:path(c.installDir),previousRuntimePath:optionalPath(c.previousRuntimePath??null),workspacePath:optionalPath(c.workspacePath??null),preserveAssets:c.preserveAssets??[]};
 if(!Array.isArray(config.preserveAssets)||config.preserveAssets.some(v=>typeof v!=='string')||new Set(config.preserveAssets).size!==config.preserveAssets.length)throw new Error('設定のpreserveAssetsを確認してください');
 keys(c.launchd,['syncPlist','backupPlist','backupVerifyPlist']);config.launchd=Object.fromEntries(Object.entries(c.launchd).map(([k,v])=>[k,optionalPath(v)]));
 if(c.openclaw!==null){
  keys(c.openclaw,['executable','configPath','gatewayPlist','automationId']);
  if(c.openclaw.automationId!==null&&(typeof c.openclaw.automationId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(c.openclaw.automationId)))throw new Error('設定のautomationIdを確認してください');
  config.openclaw={...c.openclaw,executable:path(c.openclaw.executable),configPath:path(c.openclaw.configPath),gatewayPlist:path(c.openclaw.gatewayPlist)};
 }
 const hub=await readJson(config.hubConfigPath);if(!hub||typeof hub.vaultPath!=='string')throw new Error('Hub設定にvaultPathが必要です');
 config.vaultPath=path(expand(hub.vaultPath));config.statePath=path(expand(hub.statePath??join(homedir(),'Library/Application Support/context-hub')));
 const codeRoots=[repository,config.previousRuntimePath].filter(Boolean);
 const controls=[file,config.hubConfigPath,...Object.values(config.launchd).filter(Boolean),...(c.openclaw?[config.openclaw.configPath,config.openclaw.gatewayPlist]:[])];
 const loggingDir=path(expand(hub.logging?.dir??join(config.statePath,'logs'))),updateRoots=[join(config.installDir,'runtime'),join(config.installDir,'updates')];
 const paths=[...codeRoots,...controls,config.installDir,config.vaultPath,config.workspacePath,config.statePath,loggingDir,...updateRoots].filter(Boolean);
 const physical=new Map(await Promise.all([...new Set(paths)].map(async p=>[p,await canonicalPath(p)])));
 const contains=(root,p)=>within(physical.get(root),physical.get(p)),collides=(a,b)=>overlaps(physical.get(a),physical.get(b));
 if(codeRoots.some(p=>collides(config.installDir,p)||collides(config.vaultPath,p))||collides(config.installDir,config.vaultPath)||config.workspacePath&&[...codeRoots,config.vaultPath,config.installDir].some(p=>collides(p,config.workspacePath)))throw new Error('運用先・workspace・Vaultは現在と旧checkoutの外へ分離してください');
 if(new Set(controls.map(p=>physical.get(p))).size!==controls.length)throw new Error('設定の管理対象パスが重なっています');
 if([config.statePath,loggingDir].some(p=>updateRoots.some(root=>contains(root,p))))throw new Error('Hubの状態・ログはruntimeと更新領域の外へ置いてください');
 for(const p of controls){if([config.vaultPath,config.installDir,...codeRoots,...(config.workspacePath?[config.workspacePath]:[])].some(root=>contains(root,p)))throw new Error('設定・制御ファイルはVault・workspace・取得元・運用先の外へ置いてください');await safePath(p,{owned:true});}
 for(const p of [config.installDir,config.vaultPath,config.workspacePath,config.previousRuntimePath].filter(Boolean))await safePath(p,{owned:true});
 return config;
}
