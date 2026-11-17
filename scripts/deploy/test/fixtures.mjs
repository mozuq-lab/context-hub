import {mkdtemp,realpath,mkdir,writeFile,cp,readFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {defaultConfig} from '../../../packages/core/dist/config.js';
import {Vault,markdown,hash} from '../../../packages/core/dist/storage.js';
import {ingest} from '../../../packages/core/dist/intake.js';
import {run} from '../common.mjs';

export const project=resolve(import.meta.dirname,'../../..');
export async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ctx-deploy-flow-'))),repository=join(root,'source checkout'),vault=join(root,'vault'),file=join(root,'deployment.json');
 await mkdir(repository);const hub=defaultConfig(vault,join(root,'state'));await new Vault(hub).init();
 const hubConfigPath=join(root,'hub.json');await writeFile(hubConfigPath,JSON.stringify(hub));
 const config={schema_version:1,hubConfigPath,installDir:join(root,'installation'),previousRuntimePath:repository,openclaw:null,launchd:{syncPlist:null,backupPlist:null,backupVerifyPlist:null},workspacePath:null,preserveAssets:[]};
 await writeFile(file,JSON.stringify(config));
 await mkdir(join(repository,'scripts/deploy'),{recursive:true});await writeFile(join(repository,'package.json'),'{"name":"deployment-fixture","type":"module","private":true}');
 await writeFile(join(repository,'scripts/deploy/manifest.json'),JSON.stringify({schema_version:1,vaultFormat:1,assets:[{id:'vault-agents',scope:'vault',source:'agents.md',target:'AGENTS.md'}]}));
 await writeFile(join(repository,'agents.md'),'# 架空の利用指示 v1\n');await writeFile(join(repository,'code.txt'),'version one\n');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','ContextHub Test');git('config','user.email','test@example.invalid');git('add','.');git('commit','-qm','架空の初版');
 const calls=[];
 async function execute(exe,args,options={}){
  calls.push([exe,...args]);
  if(exe==='npm'){
   if(args[0]==='ci'){
    await mkdir(join(options.cwd,'packages/core'),{recursive:true});await cp(join(project,'packages/core/dist'),join(options.cwd,'packages/core/dist'),{recursive:true});
    for(const name of ['yaml','zod','ulid','commander'])await cp(join(project,'node_modules',name),join(options.cwd,'node_modules',name),{recursive:true});
   }
   return{code:0,stdout:'fixture check passed\n',stderr:''};
  }
  return run(exe,args,options);
 }
 return{root,repository,vault,file,config,hub,git,calls,execute,cleanup:()=>rm(root,{recursive:true,force:true})};
}
export async function configSave(f){await writeFile(f.file,JSON.stringify(f.config));}
export async function intakeFailure(f,id=`REQ-${'a'.repeat(32)}`){
 const path=`Input/${id}.md`,vault=new Vault(f.hub);
 await vault.create(path,markdown({schema_version:1,request_id:id,operation:'correct',source:'fixture',occurred_at:'2026-10-03T10:00:00Z',target_id:`IN-${'0'.repeat(26)}`},'架空の欠損対象への訂正'));
 await utimes(join(f.vault,path),new Date(0),new Date(0));await ingest(f.hub,{limit:1});
 return{requestId:id,paths:{input:join(f.vault,path),pending:join(f.vault,`90_system/intake/pending/${id}.json`),error:join(f.vault,`90_system/intake-errors/${hash(path)}.json`)}};
}
export async function fakeServices(f){
 const serviceState=new Map(),plistValues=new Map(),calls=[];
 const host=join(f.root,'openclaw');await mkdir(host);await writeFile(join(host,'openclaw.mjs'),'// 架空の実行ファイル\n',{mode:0o700});await writeFile(join(host,'package.json'),'{"name":"openclaw","version":"2026.9.9"}');
 const gateway=join(f.root,'gateway.plist'),sync=join(f.root,'sync.plist');
 const gw={Label:'ai.openclaw.gateway',ProgramArguments:['/fake/node','/fake/openclaw/dist/index.js','gateway'],RunAtLoad:true};
 const sy={Label:'com.context-hub.sync',ProgramArguments:['/fake/syncthing','serve'],RunAtLoad:true};
 for(const [p,value]of [[gateway,gw],[sync,sy]]){await writeFile(p,JSON.stringify(value));plistValues.set(p,value);serviceState.set(value.Label,true);}
 f.config.openclaw={executable:join(host,'openclaw.mjs'),configPath:join(f.root,'openclaw.json'),gatewayPlist:gateway,automationId:'test-job'};f.config.launchd.syncPlist=sync;
 const oc={gateway:{port:18789},plugins:{load:{paths:[join(f.repository,'packages/openclaw-plugin')]},entries:{'context-hub':{enabled:true,config:{configPath:f.config.hubConfigPath}}}},channels:{discord:{token:'fake-token-retained'}}};
 await writeFile(f.config.openclaw.configPath,JSON.stringify(oc));await configSave(f);
 let job={id:'test-job',name:'fixture-cycle',enabled:true,schedule:{kind:'every',everyMs:3600000,anchorMs:1234},payload:{kind:'command',argv:['/fake/node',join(f.repository,'packages/core/dist/cli.js'),'cycle','--limit','2'],env:{CONTEXT_HUB_CONFIG:f.config.hubConfigPath},timeoutSeconds:300},state:{lastStatus:'ok'}};
 async function execute(exe,args,options={}){
  calls.push([exe,...args]);
  if(exe==='plutil'){
   if(args.includes('json'))return{code:0,stdout:await readFile(args.at(-1),'utf8'),stderr:''};
   return{code:0,stdout:'',stderr:''};
  }
  if(exe==='launchctl'){
   const label=args[0]==='bootstrap'?JSON.parse(await readFile(args[2],'utf8')).Label:args[1].split('/').at(-1);
   if(args[0]==='print')return serviceState.get(label)?{code:0,stdout:'state = running\npid = 999999999\n',stderr:''}:{code:113,stdout:'',stderr:'Could not find service'};
   serviceState.set(label,args[0]==='bootstrap');return{code:0,stdout:'',stderr:''};
  }
  if(exe===f.config.openclaw.executable){
   if(args[0]==='--version')return{code:0,stdout:'2026.9.9\n',stderr:''};
   if(args[0]==='automations'){
    if(!serviceState.get('ai.openclaw.gateway'))return{code:1,stdout:'',stderr:'Gateway is stopped'};
    if(!['show','disable','enable','edit'].includes(args[1]))return{code:1,stdout:'',stderr:'unsupported fixture command'};
    if(args[1]==='disable')job.enabled=false;if(args[1]==='enable')job.enabled=true;
    if(args[1]==='edit')job.payload.argv=JSON.parse(args[args.indexOf('--command-argv')+1]);
    return{code:0,stdout:JSON.stringify({...job,status:job.enabled?'ok':'disabled'}),stderr:''};
   }
   if(args[0]==='plugins')return{code:0,stdout:JSON.stringify({plugin:{id:'context-hub',status:'loaded',imported:true,source:join(f.config.installDir,'runtime/packages/openclaw-plugin/dist/index.js')}}),stderr:''};
   return{code:0,stdout:'{"valid":true,"ok":true}',stderr:''};
  }
  return f.execute(exe,args,options);
 }
 return{execute,serviceState,calls,ready:async()=>true,getJob:()=>structuredClone(job),setJob:v=>{job=v;}};
}
