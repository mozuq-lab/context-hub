import {readPolicies,resolvePolicyProject,formatPolicies,type PolicyBundle} from './policies.js';
import type {HubConfig} from './types.js';
export const MAX_POLICY_CONTEXT_BYTES=68*1024;
const events=new Set(['SessionStart','UserPromptSubmit','SubagentStart']);
export const policyUnavailable='有効方針を読み取れません。未読のまま変更や外部操作を始めないでください。同期・設定の復旧相談は続けられます。';
export interface PolicyHookResult{status:'ok'|'unavailable'|'unsupported';output:Record<string,unknown>;bundle?:PolicyBundle}
export function policyFailure(engine:'codex'|'claude',event:string,status:'unavailable'|'unsupported'='unavailable'):PolicyHookResult{
 if(event==='UserPromptSubmit')return{status,output:{decision:'block',reason:policyUnavailable,...(engine==='claude'?{hookSpecificOutput:{hookEventName:event,suppressOriginalPrompt:true}}:{})}};
 return{status,output:{...(engine==='codex'&&event==='SessionStart'?{continue:false,stopReason:policyUnavailable}:{}),systemMessage:policyUnavailable,hookSpecificOutput:{hookEventName:event,additionalContext:policyUnavailable+' このhookは子タスク作成そのものを停止する保証を持ちません。'}}};
}
export function policyContext(bundle:PolicyBundle):string{const text=formatPolicies(bundle);if(Buffer.byteLength(text)>MAX_POLICY_CONTEXT_BYTES)throw new Error('必須方針の全文がhook出力上限を超えています');return text;}
export async function policyHook(config:HubConfig,engine:'codex'|'claude',input:unknown):Promise<PolicyHookResult>{
 const data=input!==null&&typeof input==='object'?input as Record<string,unknown>:{},event=typeof data.hook_event_name==='string'?data.hook_event_name:'';
 if(!events.has(event))return policyFailure(engine,event,'unsupported');
 try{
  if(typeof data.cwd!=='string')throw new Error('作業フォルダーがありません');
  if(event==='SessionStart'&&data.source!==undefined&&!['startup','resume','clear','compact','fork'].includes(String(data.source)))return policyFailure(engine,event,'unsupported');
  const projectId=await resolvePolicyProject(config,data.cwd),bundle=await readPolicies(config,projectId),text=policyContext(bundle);
  return{status:'ok',bundle,output:{hookSpecificOutput:{hookEventName:event,additionalContext:text}}};
 }catch{return policyFailure(engine,event);}
}
