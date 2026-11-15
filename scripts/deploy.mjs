#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {preparePlan} from './deploy/prepare.mjs';
import {applyPlan} from './deploy/apply.mjs';
import {deploymentStatus} from './deploy/status.mjs';

const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
export async function main(args=process.argv.slice(2)){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{config:{type:'string'},plan:{type:'string'},confirm:{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.help)return 'ContextHubの共通更新: plan / apply / status\n\nplan --config <deployment.json>\napply --plan <plan.json> --confirm <SHA-256>\nstatus --config <deployment.json>\n';
 if(Number(process.versions.node.split('.')[0])<24)throw new Error('Node 24以上が必要です');
 if(positionals.length!==1||!['plan','apply','status'].includes(positionals[0]))throw new Error('操作はplan・apply・statusのいずれか1つを指定してください');
 const op=positionals[0];
 if(op==='apply'){
  if(!values.plan||!values.confirm||values.config)throw new Error('applyにはplanとSHA-256による確認が必要です');
  return applyPlan(resolve(values.plan),values.confirm,{onProgress:s=>process.stderr.write(JSON.stringify({phase:s.phase})+'\n')});
 }
 if(!values.config||values.plan||values.confirm)throw new Error('引数に--configを明示してください');
 if(op==='status'){const result=await deploymentStatus(resolve(values.config));if(result.drift.length||result.pending)process.exitCode=1;return result;}
 const p=await preparePlan(resolve(values.config));return{...p.summary,planPath:p.planPath,planHash:p.planHash,applyCommand:`npm run deploy -- apply --plan ${quote(p.planPath)} --confirm ${quote(p.planHash)}`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const r=await main();process.stdout.write(typeof r==='string'?r:JSON.stringify(r,null,2)+'\n');}
 catch(e){const error=e instanceof SyntaxError?'JSON設定または検査結果の形式を確認してください':e.code?'ファイルの存在・権限、コマンドの引数を確認してください':e.message;process.stderr.write(JSON.stringify({error})+'\n');process.exitCode=1;}
}
