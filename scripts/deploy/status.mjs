import {resolve,join} from 'node:path';
import {loadConfig} from './config.mjs';
import {readJson,fileHash,treeHash,exists} from './common.mjs';
import {releaseAt} from './prepare.mjs';

export async function deploymentStatus(configFile,{repository=resolve(import.meta.dirname,'../..')}={}){
 const c=await loadConfig(configFile,repository),runtime=join(c.installDir,'runtime'),release=await releaseAt(runtime),state=await readJson(join(c.installDir,'deployment-state.json')),drift=[];
 if(release){if(await treeHash(runtime)!==release.treeHash)drift.push('runtime');for(const a of release.assets)if(await fileHash(a.path)!==a.afterHash)drift.push(a.id);}
 return{commit:release?.commit??null,drift,preserved:release?.preserved??[],pending:state&&!['completed','rolled-back'].includes(state.phase)?{planId:state.planId,phase:state.phase,writersResumed:state.writersResumed,plan:join(c.installDir,'updates',state.planId,'plan.json')}:null,lock:await exists(join(c.installDir,'.deploy.lock'))};
}
