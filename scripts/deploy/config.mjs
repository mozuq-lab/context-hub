import {readJson,safePath,overlaps,within} from './common.mjs';
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
 if(overlaps(config.installDir,repository)||overlaps(config.installDir,config.vaultPath)||config.workspacePath&&overlaps(config.installDir,config.workspacePath))throw new Error('運用先はVault・取得元・workspaceの外へ分離してください');
 const controls=[file,config.hubConfigPath,...Object.values(config.launchd).filter(Boolean),...(c.openclaw?[config.openclaw.configPath,config.openclaw.gatewayPlist]:[])];
 if(new Set(controls).size!==controls.length)throw new Error('設定の管理対象パスが重なっています');
 for(const p of controls){if(within(config.vaultPath,p)||within(repository,p)||within(config.installDir,p))throw new Error('設定・制御ファイルはVault・取得元・運用先の外へ置いてください');await safePath(p,{owned:true});}
 for(const p of [config.installDir,config.vaultPath,config.workspacePath,config.previousRuntimePath].filter(Boolean))await safePath(p,{owned:true});
 return config;
}
