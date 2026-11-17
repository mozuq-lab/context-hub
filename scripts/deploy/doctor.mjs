import {join} from 'node:path';
import {run,readBytes,sha} from './common.mjs';

const requestOf=issue=>/^受付の停止回復待ち: (REQ-[A-Za-z0-9]{32})$/.exec(issue)?.[1]??/^受付失敗: Input\/(REQ-[A-Za-z0-9]{32})\.md \/ .+$/.exec(issue)?.[1];
async function intakeState(c,requestId,issues){
 const input=`Input/${requestId}.md`,[inputBytes,pendingBytes,errorBytes]=await Promise.all([input,`90_system/intake/pending/${requestId}.json`,`90_system/intake-errors/${sha(input)}.json`].map(p=>readBytes(join(c.vaultPath,p))));
 let pending,error;try{pending=pendingBytes===undefined?undefined:JSON.parse(pendingBytes.toString('utf8'));error=errorBytes===undefined?undefined:JSON.parse(errorBytes.toString('utf8'));}catch{throw new Error('doctor診断と受付記録の形式が一致しません');}
 const inputHash=inputBytes===undefined?null:sha(inputBytes);
 if(issues.includes(`受付の停止回復待ち: ${requestId}`)&&pending===undefined)throw new Error('doctor診断と停止回復記録の配置が一致しません');
 if(pending!==undefined&&(!pending||pending.schema_version!==1||pending.request_id!==requestId||pending.path!==input||typeof pending.raw!=='string'||pending.request_hash!==sha(pending.raw)||inputHash!==null&&inputHash!==pending.request_hash))throw new Error('doctor診断と受付ファイル・停止回復の内容が一致しません');
 if(issues.some(v=>v.startsWith(`受付失敗: ${input} / `))&&(!error||error.path!==input||error.status!=='error'))throw new Error('doctor診断と受付失敗記録の配置が一致しません');
 const requestHash=pending?.request_hash??inputHash;
 if(error!==undefined&&(!error||requestHash===null||error.file_hash!==requestHash))throw new Error('doctor診断と受付失敗記録の内容が一致しません');
 // 再試行時刻だけでは、確認した受付の内容が変わったとは扱わない。
 const semantic=error===undefined?null:{...error};if(semantic)delete semantic.updated_at;
 return{requestId,inputHash,pendingHash:pendingBytes===undefined?null:sha(pendingBytes),errorHash:semantic===null?null:sha(JSON.stringify(semantic))};
}
export async function coreDoctor(root,c,deps={},baseline){
 const r=await(deps.run??run)(process.execPath,[join(root,'packages/core/dist/cli.js'),'--config',c.hubConfigPath,'doctor'],{env:{...process.env,CONTEXT_HUB_CONFIG:c.hubConfigPath},logFile:deps.logFile});
 let d;try{d=JSON.parse(r.stdout);}catch{throw new Error('Vaultのdoctor診断の応答形式を確認してください');}
 if(!d||!Array.isArray(d.issues)||d.issues.some(v=>typeof v!=='string')||new Set(d.issues).size!==d.issues.length||!Number.isSafeInteger(d.inputs)||d.inputs<0||r.signal!=null||r.timedOut===true||r.code!==(d.issues.length?1:0))throw new Error('Vaultのdoctor診断の応答・終了状態を確認してください');
 const issues=d.issues.toSorted(),ids=[...new Set(issues.map(requestOf))];
 if(ids.includes(undefined))throw new Error('Vaultのdoctor診断に更新できない異常があります。保存したログを確認してください');
 if(new Set(issues.map(v=>`${requestOf(v)}:${v.startsWith('受付失敗:')?'error':'pending'}`)).size!==issues.length)throw new Error('doctor診断に同じ受付の失敗記録の重複があります');
 const intake=await Promise.all(ids.toSorted().map(id=>intakeState(c,id,issues)));
 if(baseline!==undefined){
  const approved=baseline?.issues===0?[]:baseline?.issues,previous=baseline?.intake??[];
  if(!Array.isArray(approved)||approved.some(v=>typeof v!=='string')||!Array.isArray(previous))throw new Error('planのdoctor診断記録を確認してください');
  if(issues.some(v=>!approved.includes(v)))throw new Error('確認後に新しいdoctor診断があります。planを作り直してください');
  for(const current of intake){
   const before=previous.find(v=>v?.requestId===current.requestId);
   if(!before||['inputHash','pendingHash','errorHash'].some(k=>before[k]!==current[k]))throw new Error('確認後に受付内容・停止回復・失敗記録が変更されています。planを作り直してください');
  }
 }
 return{issues,inputs:d.inputs,intake};
}
