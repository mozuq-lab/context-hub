import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unlink,chmod} from 'node:fs/promises';
import {loadConfig} from './config.mjs';
import {sha,exists,readJson,readBytes,fileHash,treeHash,writeJson,atomicWrite,privateDir,durableRename,withUpdateLock,checked,run,archiveHash,safePath} from './common.mjs';
import {releaseAt,releaseName,coreDoctor} from './prepare.mjs';
import {inspectServices,stopServices,haltServices,resumeServices,verifyServices,jobHash} from './services.mjs';

async function matches(path,expected){if(await fileHash(path)!==expected)throw new Error('確認後に管理対象が変更されています。planを作り直してください');}
function failureOf(error,phase){
 const name=error?.name??'Error',code=typeof error?.code==='string'?error.code:undefined;
 const message=name==='SyntaxError'?'JSONの形式を確認してください':code?'ファイル・外部コマンドの権限と状態を確認してください':String(error?.message??'処理に失敗しました');
 return{phase,name,message,...(code?{code}:{})};
}
async function core(root,c){
 const storage=await import(pathToFileURL(join(root,'packages/core/dist/storage.js')).href),cfg=await import(pathToFileURL(join(root,'packages/core/dist/config.js')).href);
 const config=await cfg.loadConfig(c.hubConfigPath);return{vault:new storage.Vault(config),storage};
}
export async function applyPlan(planPath,confirmation,deps={}){
 planPath=resolve(planPath);await safePath(planPath,{owned:true});const planHash=await fileHash(planPath);
 if(!confirmation||confirmation!==planHash)throw new Error('表示されたplanのSHA-256による確認が必要です');
 const p=await readJson(planPath);if(p?.schema_version!==1||typeof p.planId!=='string'||!Array.isArray(p.changes)||!Array.isArray(p.controlChanges)||!Array.isArray(p.assets))throw new Error('planの形式が不正です');
 const c=await loadConfig(p.configFile,p.repository),folder=dirname(planPath),runtime=join(c.installDir,'runtime'),candidate=join(folder,'candidate'),previous=join(folder,'previous-runtime'),statePath=join(c.installDir,'deployment-state.json');
 if(planPath!==join(c.installDir,'updates',p.planId,'plan.json')||p.candidate!==candidate)throw new Error('planと運用先の対応が不正です');
 await matches(c.file,p.configHash);await matches(c.hubConfigPath,p.hubConfigHash);
 for(const a of [...p.assets,...p.changes]){
  const m=p.manifest.assets.find(v=>v.id===a.id),root=a.scope==='vault'?c.vaultPath:c.workspacePath;
  if(!m||!root||m.source!==a.source||m.target!==a.relative||m.scope!==a.scope||a.path!==join(root,m.target)||c.preserveAssets.includes(a.id))throw new Error('配布物とplanの対応が不正です');
 }
 const allowedControls=[c.openclaw?.configPath,c.launchd.backupPlist,c.launchd.backupVerifyPlist].filter(Boolean);
 for(const a of p.controlChanges){if(!allowedControls.includes(a.path)||!/^after-\d+\.data$/.test(a.afterFile))throw new Error('設定変更の対象が不正です');await matches(join(folder,a.afterFile),a.afterHash);}
 for(const a of p.snapshot.agents){const expected=a.role==='gateway'?c.openclaw?.gatewayPlist:c.launchd[a.role];if(a.path!==expected)throw new Error('サービス制御の対象が不正です');}
 return withUpdateLock(c.installDir,p.planId,async()=>{
  let state=await readJson(statePath);
  if(state?.planId===p.planId&&state.phase==='completed'){
   const rel=await releaseAt(runtime);if(rel?.commit!==p.commit||await treeHash(runtime)!==(state.runtimeTreeHash??p.candidateHash))throw new Error('完了後に運用コードが変更されています');
   for(const a of [...p.assets,...p.controlChanges])await matches(a.path,a.afterHash);
   return{commit:p.commit,unchanged:true};
  }
  const resuming=state?.planId===p.planId&&!['completed','rolled-back'].includes(state.phase);
  if(state&&(!['ready','stopping','stopped','swapping','old-moved','installed','files-written','verified','starting','restoring','rollback-starting','completed','rolled-back','recovery-required'].includes(state.phase)||state.schema_version!==1))throw new Error('更新記録の形式を確認してください');
  if(state&&!['completed','rolled-back'].includes(state.phase)&&!resuming)throw new Error('別の未完了更新があります');
  if(resuming&&(state.planHash!==planHash||state.writersResumed||state.phase==='recovery-required'))throw new Error('Writer再開後または不明な状態のため、自動再開できません。statusと復旧記録を確認してください');
  if(!resuming){
   const git=await checked(deps.run??run,'git',['-C',p.repository,'status','--porcelain','--untracked-files=normal']);const head=await checked(deps.run??run,'git',['-C',p.repository,'rev-parse','HEAD']);
   if(git.stdout.trim()||head.stdout.trim()!==p.commit)throw new Error('確認後に取得元が変更されています');
   const current=await releaseAt(runtime);if(JSON.stringify(current??null)!==JSON.stringify(p.previous)||current&&await treeHash(runtime)!==current.treeHash)throw new Error('確認後に運用コードが変更されています');
   await validateTargets(false);
   const s=await inspectServices(c,current?runtime:c.previousRuntimePath??p.repository,deps);
   if(s.agents.some((a,i)=>a.loaded!==p.snapshot.agents[i]?.loaded||a.hash!==p.snapshot.agents[i]?.hash)||Boolean(s.job)!==Boolean(p.snapshot.job)||s.job&&jobHash(s.job)!==jobHash(p.snapshot.job))throw new Error('確認後にサービス設定・状態が変更されています');
   await coreDoctor(candidate,c,{...deps,logFile:join(folder,'doctor-apply-before.log')},p.doctor??{issues:0});
   state={schema_version:1,planId:p.planId,planHash,phase:'ready',writersResumed:false,hadRuntime:Boolean(current),backedUp:false};
   if(current?.commit===p.commit&&!p.changes.length&&!p.controlChanges.length){
    await writeJson(join(runtime,releaseName),{...current,assets:p.assets,preserved:p.preserved});state.runtimeTreeHash=current.treeHash;state.phase='completed';await writeJson(statePath,state);return{commit:p.commit,unchanged:true};
   }
  }else{await validateTargets(true);await coreDoctor(await exists(candidate)?candidate:runtime,c,{...deps,logFile:join(folder,'doctor-apply-before.log')},p.doctor??{issues:0});}
  const phase=async name=>{state.phase=name;await writeJson(statePath,state);await deps.onProgress?.({phase:name});};
  async function validateTargets(partial){
   for(const a of [...p.changes,...p.controlChanges]){const h=await fileHash(a.path);if(h!==a.beforeHash&&!(partial&&h===a.afterHash))throw new Error('確認後に配布物・設定が変更されています');}
   for(const a of p.assets.filter(a=>!p.changes.some(v=>v.id===a.id)))await matches(a.path,a.afterHash);
   for(const a of p.snapshot.agents.filter(a=>!p.controlChanges.some(x=>x.path===a.path)))await matches(a.path,a.hash);
   if(c.openclaw&&!p.controlChanges.some(a=>a.path===c.openclaw.configPath))await matches(c.openclaw.configPath,p.snapshot.openclawHash);
   const codeRoot=await exists(candidate)?candidate:runtime;if(await treeHash(codeRoot)!==p.candidateHash)throw new Error('確認後に候補コードが変更されています');
   for(const a of p.assets)await matches(join(codeRoot,a.source),a.afterHash);
   if(partial&&p.previous){const old=await exists(previous)?previous:await exists(candidate)?runtime:null;if(old&&await treeHash(old)!==p.previous.treeHash)throw new Error('中断中に旧運用コードが変更されています');}
  }
  async function restore(){
   await phase('restoring');
   const codeRoot=await exists(candidate)?candidate:runtime,{vault}=await core(codeRoot,c);
   await vault.withLock(()=>vault.withLock(async()=>{
    for(const [i,a]of [...p.changes,...p.controlChanges].entries()){
     const h=await fileHash(a.path);if(h===a.beforeHash)continue;if(h!==a.afterHash)throw new Error('復旧対象に別の変更があります');
     const bytes=a.beforeHash===null?undefined:await readBytes(join(folder,'backup',`${i}.before`));if(a.beforeHash!==null&&(bytes===undefined||sha(bytes)!==a.beforeHash))throw new Error('復旧ファイルが欠損しているかhashが一致しません');
     if(a.scope==='vault'){if(bytes===undefined)await vault.remove(a.relative);else await vault.write(a.relative,bytes.toString('utf8'));}
     else if(bytes===undefined)await unlink(a.path);else await atomicWrite(a.path,bytes);
    }
    if(await exists(runtime)&&!await exists(candidate)){if(await treeHash(runtime)!==p.candidateHash)throw new Error('復旧する運用コードが一致しません');await durableRename(runtime,candidate);}
    if(state.hadRuntime&&await exists(previous)&&!await exists(runtime))await durableRename(previous,runtime);
   }),'organize');
   // 旧版への復旧でも、最初の起動より前に再開意図を残す。
   if(p.snapshot.agents.some(a=>a.loaded))state.writersResumed=true;
   await phase('rollback-starting');
   await resumeServices(c,p.snapshot,deps,{rollback:true});await phase('rolled-back');
  }
  try{
   await phase('stopping');await stopServices(c,p.snapshot,{...deps,jobPaused:state.jobPaused,onJobPaused:async()=>{state.jobPaused=true;await writeJson(statePath,state);}});await phase('stopped');
   const codeRoot=await exists(candidate)?candidate:runtime,{vault}=await core(codeRoot,c);
   await vault.withLock(()=>vault.withLock(async()=>{
    await validateTargets(resuming);
    await privateDir(join(folder,'backup'));
    if(!state.backedUp){
     for(const [i,a]of [...p.changes,...p.controlChanges].entries()){const b=await readBytes(a.path);if((b===undefined?null:sha(b))!==a.beforeHash)throw new Error('バックアップ前に管理対象が変更されています');if(b!==undefined)await atomicWrite(join(folder,'backup',`${i}.before`),b);}
     const settings=[['deployment.json',c.file],['hub-config.json',c.hubConfigPath],...(c.openclaw?[['openclaw.json',c.openclaw.configPath]]:[]),...p.snapshot.agents.map(a=>[`${a.role}.plist`,a.path])],index=[];
     for(const [name,path]of settings){const b=await readBytes(path);if(b===undefined)throw new Error('設定のバックアップ元がありません');await atomicWrite(join(folder,'backup',name),b);index.push({path,file:name,hash:sha(b)});}
     await writeJson(join(folder,'backup/settings-index.json'),index);await writeJson(join(folder,'backup/services.json'),p.snapshot);
     const archive=join(folder,'backup/vault.tar.gz'),temp=`${archive}.tmp`;
     await checked(deps.run??run,'tar',['--exclude=.ctx-tmp-*','--exclude=*.tmp','-czf',temp,'-C',c.vaultPath,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'},timeout:600000,capture:false});
     await checked(deps.run??run,'tar',['-tzf',temp],{timeout:600000,capture:false});await chmod(temp,0o600);await durableRename(temp,archive);state.archiveHash=await archiveHash(archive);state.backedUp=true;
    }else if(await archiveHash(join(folder,'backup/vault.tar.gz'))!==state.archiveHash)throw new Error('バックアップのhashが一致しません');
    await phase('swapping');
    if(state.hadRuntime&&!await exists(previous))await durableRename(runtime,previous);
    await phase('old-moved');
    if(await exists(candidate)){
     await writeJson(join(candidate,releaseName),{schema_version:1,commit:p.commit,vaultFormat:p.manifest.vaultFormat,treeHash:p.candidateHash,assets:p.assets,preserved:p.preserved});
     await durableRename(candidate,runtime);
    }
    await phase('installed');
    for(const a of p.changes){const h=await fileHash(a.path);if(h!==a.beforeHash&&!(resuming&&h===a.afterHash))throw new Error('書き込み前に配布物が変更されています');const text=(await readBytes(join(runtime,a.source))).toString('utf8');if(a.scope==='vault')await vault.write(a.relative,text);else await atomicWrite(a.path,text);}
    for(const a of p.controlChanges){const h=await fileHash(a.path);if(h!==a.beforeHash&&!(resuming&&h===a.afterHash))throw new Error('書き込み前に設定が変更されています');await atomicWrite(a.path,await readBytes(join(folder,a.afterFile)));}
    await phase('files-written');
   }),'organize');
   await coreDoctor(runtime,c,{...deps,logFile:join(folder,'doctor-after.log')},p.doctor??{issues:0});
   await phase('verified');
   if(p.snapshot.agents.some(a=>a.loaded)){state.writersResumed=true;await phase('starting');}
   await resumeServices(c,p.snapshot,deps,{gatewayOnly:true});await verifyServices(c,p.snapshot,deps);await resumeServices(c,p.snapshot,deps);
   await phase('completed');return{commit:p.commit,unchanged:false,backup:join(folder,'backup/vault.tar.gz')};
  }catch(e){
   state.failure=failureOf(e,state.phase);let restored=false;
   if(!state.writersResumed){
    try{await restore();restored=true;}
    catch(recoveryError){state.recoveryFailure=failureOf(recoveryError,state.phase);}
   }
   if(!restored){
    state.stopResults=await haltServices(c,p.snapshot,deps);
    state.phase='recovery-required';await writeJson(statePath,state);
   }
   throw e;
  }
 },{resume:true});
}
