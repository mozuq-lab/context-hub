import {join,dirname} from 'node:path';
import {realpath,readFile} from 'node:fs/promises';
import {run,checked,readJson,fileHash,sha,atomicWrite} from './common.mjs';

export const jobHash=job=>{const v=structuredClone(job);delete v.state;delete v.status;delete v.updatedAtMs;return sha(JSON.stringify(v));};
const environment=c=>({...process.env,OPENCLAW_CONFIG_PATH:c.openclaw.configPath,OPENCLAW_CONFIG_READONLY:'1'});
async function command(c,args,deps={}){const r=await checked(deps.run??run,c.openclaw.executable,args,{env:environment(c),logFile:deps.logFile});return r.stdout;}
async function job(c,deps){const v=JSON.parse(await command(c,['automations','show',c.openclaw.automationId,'--json'],deps));return v.job??v;}
async function native(args,deps={}){return(deps.run??run)('launchctl',args);}
async function loaded(label,deps){
 const r=await native(['print',`gui/${process.getuid()}/${label}`],deps);
 if(r.code!==0){if(/Could not find.*service|No such process/i.test(r.stderr+r.stdout))return{loaded:false,running:false};throw new Error('LaunchAgentの状態を取得できません');}
 const state=/^\s*state = (.+)$/m.exec(r.stdout)?.[1],pid=Number(/^\s*pid = (\d+)$/m.exec(r.stdout)?.[1]);return{loaded:true,running:state==='running',pid:pid||null};
}
export async function inspectServices(c,fromRoot,deps={}){
 if((c.openclaw||Object.values(c.launchd).some(Boolean))&&(deps.platform??process.platform)!=='darwin')throw new Error('サービス制御はmacOSだけに対応しています');
 const snapshot={agents:[],job:null,version:null};
 if(c.openclaw){
  const version=await command(c,['--version'],deps);if(!/\b2026\.9\.9\b/.test(version))throw new Error('サービス操作が未対応のOpenClaw版です');snapshot.version='2026.9.9';
 }
 const files=[...(c.openclaw?[['gateway',c.openclaw.gatewayPlist]]:[]),...Object.entries(c.launchd).filter(([,p])=>p)];
 const labels=new Set();
 for(const[role,path]of files){
  const r=await checked(deps.run??run,'plutil',['-convert','json','-o','-',path]),value=JSON.parse(r.stdout);
  if(typeof value.Label!=='string'||!/^[a-zA-Z0-9_.-]+$/.test(value.Label)||!Array.isArray(value.ProgramArguments)||labels.has(value.Label))throw new Error('LaunchAgentのLabel・引数を確認してください');
  labels.add(value.Label);
  if(role==='gateway'&&(!value.ProgramArguments.includes('gateway')||!value.ProgramArguments.some(s=>typeof s==='string'&&/openclaw\/(?:dist\/index\.js|openclaw\.mjs)$/.test(s))))throw new Error('GatewayのLaunchAgentが既知の構成ではありません');
  const state=await loaded(value.Label,deps);if((role==='gateway'||role==='syncPlist')&&state.loaded&&!state.running)throw new Error('常駐サービスが安定していません。停止状態を確認してください');
  snapshot.agents.push({role,path,label:value.Label,value,hash:await fileHash(path),...state});
 }
 if(c.openclaw){
  const original=await readJson(c.openclaw.configPath),entry=original?.plugins?.entries?.['context-hub'];
  if(entry?.enabled!==true||entry.config?.configPath!==c.hubConfigPath||original.plugins.load?.paths?.filter(p=>p===join(fromRoot,'packages/openclaw-plugin')).length!==1)throw new Error('OpenClawの既存plugin参照とHub設定が一致しません');
  snapshot.openclawHash=await fileHash(c.openclaw.configPath);
  if(c.openclaw.automationId){
   if(!snapshot.agents.find(a=>a.role==='gateway')?.running)throw new Error('automationを扱うときはGatewayの稼働中に開始してください');
   const j=await job(c,deps),p=j.payload;
   if(j.id!==c.openclaw.automationId||p?.kind!=='command'||!Array.isArray(p.argv)||p.argv[1]!==join(fromRoot,'packages/core/dist/cli.js')||p.argv[2]!=='cycle'||p.env?.CONTEXT_HUB_CONFIG!==c.hubConfigPath)throw new Error('既存automationの実行内容を確認してください');
   if(j.state?.runningAtMs)throw new Error('対象のautomationが実行中です');snapshot.job=j;
  }
 }
 return snapshot;
}
export async function hostPackage(c){
 let dir=dirname(await realpath(c.openclaw.executable));
 while(dirname(dir)!==dir){const p=await readJson(join(dir,'package.json'));if(p?.name==='openclaw')return dir;dir=dirname(dir);}
 throw new Error('OpenClawのパッケージを特定できません。実行ファイルの指定を確認してください');
}
export async function serviceChanges(c,s,fromRoot,folder,deps={}){
 const changes=[];const runtime=join(c.installDir,'runtime');
 async function add(path,after,fields){
  const beforeHash=await fileHash(path),afterHash=sha(after);if(beforeHash===afterHash)return;
  const afterFile=`after-${changes.length}.data`;await atomicWrite(join(folder,afterFile),after);
  changes.push({scope:'control',path,beforeHash,afterHash,afterFile,fields});
 }
 if(c.openclaw){
  const v=await readJson(c.openclaw.configPath),paths=v.plugins.load.paths;
  paths[paths.indexOf(join(fromRoot,'packages/openclaw-plugin'))]=join(runtime,'packages/openclaw-plugin');
  await add(c.openclaw.configPath,Buffer.from(JSON.stringify(v,null,2)+'\n'),['plugins.load.paths']);
 }
 for(const a of s.agents){
  if(!['backupPlist','backupVerifyPlist'].includes(a.role))continue;
  const old=join(fromRoot,a.role==='backupPlist'?'scripts/vault-backup.sh':'packages/core/dist/cli.js');
  if(a.value.ProgramArguments.filter(p=>p===old).length!==1)throw new Error('バックアップの既存コード参照が一致しません');
  if(a.role==='backupVerifyPlist'&&(!a.value.ProgramArguments.includes(c.hubConfigPath)||!a.value.ProgramArguments.includes('verify')))throw new Error('backup-verifyの設定を確認してください');
  const v=structuredClone(a.value);v.ProgramArguments=v.ProgramArguments.map(p=>p===old?join(runtime,a.role==='backupPlist'?'scripts/vault-backup.sh':'packages/core/dist/cli.js'):p);
  if(old===v.ProgramArguments[a.value.ProgramArguments.indexOf(old)])continue;
  const temp=join(folder,'plist-conversion.json');await atomicWrite(temp,JSON.stringify(v));await checked(deps.run??run,'plutil',['-convert','xml1',temp]);
  await add(a.path,await readFile(temp),['ProgramArguments']);
 }
 if(s.job){s.updatedArgv=[...s.job.payload.argv];s.updatedArgv[1]=join(runtime,'packages/core/dist/cli.js');}
 return changes;
}
const pause=()=>new Promise(r=>setTimeout(r,250));
async function setLoaded(a,want,deps){
 const s=await loaded(a.label,deps);if(s.loaded===want)return;
 await checked(deps.run??run,'launchctl',want?['bootstrap',`gui/${process.getuid()}`,a.path]:['bootout',`gui/${process.getuid()}/${a.label}`]);
 if(!want&&s.pid){
  const end=Date.now()+25000;
  for(;;){try{process.kill(s.pid,0);}catch(e){if(e.code==='ESRCH')break;throw new Error('サービスのPIDを確認できません');}if(Date.now()>end)throw new Error('サービスの終了を確認できません');await pause();}
 }
}
async function waitReady(c,deps){
 const end=Date.now()+45000;let ready=false;
 while(Date.now()<end){
  try{
   if(deps.ready)ready=await deps.ready();
   else{const cfg=await readJson(c.openclaw.configPath),port=cfg.gateway?.port??18789;const r=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(3000)});ready=r.ok;await r.body?.cancel();}
  }catch{ready=false;}
  if(ready)return;await pause();
 }
 throw new Error('Gatewayの起動確認が時間内に完了しませんでした');
}
async function checkedJob(c,s,deps){
 const current=await job(c,deps),variants=[];
 for(const enabled of [s.job.enabled,false])for(const argv of [s.job.payload.argv,s.updatedArgv??s.job.payload.argv]){const v=structuredClone(s.job);v.enabled=enabled;v.payload.argv=argv;variants.push(jobHash(v));}
 if(current.state?.runningAtMs||!variants.includes(jobHash(current)))throw new Error('automationが実行中か、確認後に変更されています');return current;
}
export async function stopServices(c,s,deps={}){
 if(s.job){
  const gateway=s.agents.find(a=>a.role==='gateway'),active=await loaded(gateway.label,deps);
  if(!active.running&&!deps.jobPaused)throw new Error('ジョブの休止を確認できません。復旧記録を確認してください');
  if(active.running){const j=await checkedJob(c,s,deps);if(j.enabled)await command(c,['automations','disable',c.openclaw.automationId,'--json'],deps);
   if(s.updatedArgv&&JSON.stringify(j.payload.argv)!==JSON.stringify(s.updatedArgv))await command(c,['automations','edit',c.openclaw.automationId,'--command-argv',JSON.stringify(s.updatedArgv),'--json'],deps);
   const paused=await checkedJob(c,s,deps);if(paused.enabled)throw new Error('ジョブの休止を確認できません');
   await deps.onJobPaused?.();
  }
 }
 for(const a of s.agents.filter(a=>a.role!=='gateway'))await setLoaded(a,false,deps);
 for(const a of s.agents.filter(a=>a.role==='gateway'))await setLoaded(a,false,deps);
 for(const a of s.agents)if((await loaded(a.label,deps)).loaded)throw new Error('サービスの停止を確認できません');
}
export async function resumeServices(c,s,deps={},options={}){
 for(const a of s.agents.filter(a=>a.role==='gateway'))await setLoaded(a,a.loaded,deps);
 if(s.agents.some(a=>a.role==='gateway'&&a.running))await waitReady(c,deps);
 if(options.gatewayOnly)return;
 for(const a of s.agents.filter(a=>a.role!=='gateway'))await setLoaded(a,a.loaded,deps);
 if(s.job){
  const current=await checkedJob(c,s,deps),argv=options.rollback?s.job.payload.argv:s.updatedArgv??s.job.payload.argv;
  if(JSON.stringify(current.payload.argv)!==JSON.stringify(argv))await command(c,['automations','edit',c.openclaw.automationId,'--command-argv',JSON.stringify(argv),'--json'],deps);
  if(current.enabled!==s.job.enabled)await command(c,['automations',s.job.enabled?'enable':'disable',c.openclaw.automationId,'--json'],deps);
 }
}
export async function verifyServices(c,s,deps={}){
 if(!c.openclaw)return;
 const validation=JSON.parse(await command(c,['config','validate','--json'],deps));if(validation.valid!==true)throw new Error('OpenClaw設定を検証できません');
 if(!s.agents.find(a=>a.role==='gateway')?.running)return;
 await waitReady(c,deps);
 await command(c,['gateway','health','--json'],deps);
 const v=JSON.parse(await command(c,['plugins','inspect','context-hub','--runtime','--json'],deps)),p=v.plugin;
 if(p?.imported!==true||p?.source!==join(c.installDir,'runtime/packages/openclaw-plugin/dist/index.js'))throw new Error('新版pluginの登録を確認できません');
}
