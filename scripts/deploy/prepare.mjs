import {join,resolve,dirname,isAbsolute} from 'node:path';
import {mkdir,rm,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {loadConfig} from './config.mjs';
import {sha,readJson,readBytes,fileHash,safePath,exists,privateDir,treeHash,writeJson,run,checked,within} from './common.mjs';
import {inspectServices,serviceChanges,hostPackage} from './services.mjs';

export const releaseName='.context-hub-release.json';
export async function releaseAt(root){
 const value=await readJson(join(root,releaseName));
 if(await exists(root)&&(!value||value.schema_version!==1||!/^[a-f0-9]{40,64}$/.test(value.commit??'')||!Array.isArray(value.assets)||typeof value.treeHash!=='string'))throw new Error('未知の既存runtimeへは上書きできません');return value;
}
function relativePath(v){if(typeof v!=='string'||!v||isAbsolute(v)||v.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'))throw new Error('配布manifestの相対パスが不正です');return v;}
export async function coreDoctor(root,c,deps={}){
 const r=await checked(deps.run??run,process.execPath,[join(root,'packages/core/dist/cli.js'),'--config',c.hubConfigPath,'doctor'],{env:{...process.env,CONTEXT_HUB_CONFIG:c.hubConfigPath},logFile:deps.logFile});
 const d=JSON.parse(r.stdout);if(!Array.isArray(d.issues)||d.issues.length)throw new Error('Vaultのdoctorに問題があります');return{issues:0,inputs:d.inputs};
}
export async function preparePlan(configFile,{repository=resolve(import.meta.dirname,'../..'),...deps}={}){
 const c=await loadConfig(configFile,repository),execute=deps.run??run;
 const git=async args=>(await checked(execute,'git',['-C',repository,...args])).stdout.trim();
 if(await git(['status','--porcelain','--untracked-files=normal']))throw new Error('未コミット変更のないcleanなcheckoutを使用してください');
 const commit=await git(['rev-parse','HEAD']),runtime=join(c.installDir,'runtime'),previous=await releaseAt(runtime),state=await readJson(join(c.installDir,'deployment-state.json'));
 if(state&&!['completed','rolled-back'].includes(state.phase))throw new Error('未完了の更新があります。statusと同じplanを確認してください');
 if(previous){
  if(await treeHash(runtime)!==previous.treeHash)throw new Error('運用コードに独自変更があります');
  await checked(execute,'git',['-C',repository,'merge-base','--is-ancestor',previous.commit,commit]).catch(()=>{throw new Error('旧commitの祖先関係を確認できません。Git履歴・更新方向を確認してください');});
 }
 const fromRoot=previous?runtime:c.previousRuntimePath??repository;
 if(c.openclaw&&!previous&&!c.previousRuntimePath)throw new Error('初回移行のpreviousRuntimePathを明示してください');
 const snapshot=await inspectServices(c,fromRoot,deps);
 await privateDir(join(c.installDir,'updates'));const planId=randomUUID(),folder=join(c.installDir,'updates',planId),candidate=join(folder,'candidate');
 await privateDir(folder);await mkdir(candidate,{mode:0o700});
 const archive=join(folder,'source.tar');await checked(execute,'git',['-C',repository,'archive','--format=tar','--output',archive,commit]);await checked(execute,'tar',['-xf',archive,'-C',candidate]);
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!(/^(CONTEXT_HUB_|OPENCLAW_|OPENAI_|ANTHROPIC_)/.test(k))));
 const checks=[['ci'],['run','check'],['test','--','--maxWorkers=2'],['run','build'],['run','demo']];
 if(c.openclaw)checks.push(['run','check:sdk','--workspace=@context-hub/openclaw-plugin','--',await hostPackage(c)]);
 for(const [i,args]of checks.entries())await checked(execute,'npm',args,{cwd:candidate,env,timeout:600000,logFile:join(folder,`check-${i}.log`)});
 await rm(join(candidate,'.demo'),{recursive:true,force:true});
 const manifest=await readJson(join(candidate,'scripts/deploy/manifest.json'));
 if(manifest?.schema_version!==1||manifest.vaultFormat!==1||!Array.isArray(manifest.assets)||previous&&previous.vaultFormat!==manifest.vaultFormat)throw new Error('Vault互換形式・配布manifestが未対応です');
 const ids=new Set(),targets=new Set(),assets=[],preserved=[],changes=[];
 for(const a of manifest.assets){
  if(typeof a.id!=='string'||!/^[a-z0-9-]+$/.test(a.id)||ids.has(a.id)||!['vault','workspace'].includes(a.scope))throw new Error('配布manifestのID・対象が不正です');ids.add(a.id);
  relativePath(a.source);relativePath(a.target);const root=a.scope==='vault'?c.vaultPath:c.workspacePath;if(!root)continue;
  const allowed=a.scope==='vault'?/^(AGENTS\.md|CLAUDE\.md|_ContextHub\/(scripts|templates|docs)\/.+|\.claude\/skills\/[^/]+\/SKILL\.md)$/:/^(AGENTS\.md|skills\/[^/]+\/SKILL\.md)$/;
  if(!allowed.test(a.target))throw new Error('原文・生成物などへの配布先は許可されていません');
  const path=join(root,a.target),key=path.normalize('NFC').toLowerCase();if(targets.has(key))throw new Error('配布先が重複しています');targets.add(key);await safePath(path);
  const content=await readBytes(join(candidate,a.source));if(content===undefined)throw new Error('配布元のファイルがありません');const afterHash=sha(content),beforeHash=await fileHash(path);
  if(c.preserveAssets.includes(a.id)){preserved.push(a.id);continue;}
  const old=previous?.assets.find(v=>v.id===a.id&&v.path===path);
  if(beforeHash!==null&&beforeHash!==afterHash&&beforeHash!==old?.afterHash)throw new Error(`配布物に独自変更があります: ${a.id}。保持指定または手動での統合を確認してください`);
  const record={id:a.id,scope:a.scope,relative:a.target,source:a.source,path,afterHash};assets.push(record);
  if(beforeHash!==afterHash)changes.push({...record,beforeHash});
 }
 if(c.preserveAssets.some(id=>!ids.has(id)))throw new Error('preserveAssetsに未知の配布IDがあります');
 const controlChanges=await serviceChanges(c,snapshot,fromRoot,folder,deps),doctor=await coreDoctor(candidate,c,{...deps,logFile:join(folder,'doctor-before.log')}),candidateHash=await treeHash(candidate);
 const plan={schema_version:1,planId,commit,repository,configFile:c.file,configHash:await fileHash(c.file),hubConfigHash:await fileHash(c.hubConfigPath),candidate,candidateHash,previous:previous??null,manifest,assets,preserved,changes,controlChanges,snapshot,doctor};
 const planPath=join(folder,'plan.json');await writeJson(planPath,plan);const planHash=await fileHash(planPath);
 return{planPath,planHash,summary:{commit,initialAdoption:!previous,checks:checks.map(v=>`npm ${v.join(' ')}`),changes:[...changes.map(a=>a.path),...controlChanges.map(a=>a.path)],preserved,services:snapshot.agents.map(a=>({role:a.role,loaded:a.loaded})),note:!previous?'既存版不明・初回の基準登録':null}};
}
