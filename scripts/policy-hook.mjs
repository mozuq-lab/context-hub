#!/usr/bin/env node
// stdinのpromptやtranscript_pathを参照・転記せず、cwdとイベントだけを共通アダプターへ渡す。
import {parseArgs} from 'node:util';
import {loadConfig,policyHook,policyFailure} from '../packages/core/dist/index.js';
let engine='codex',event='UserPromptSubmit';
try{
 const {values}=parseArgs({options:{engine:{type:'string'},config:{type:'string'}}});engine=values.engine;
 if(!['codex','claude'].includes(engine)||!values.config)throw new Error('引数不正');
 const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1_048_576)throw new Error('入力上限');chunks.push(chunk);}
 const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 event=typeof input.hook_event_name==='string'?input.hook_event_name:event;
 const result=await policyHook(await loadConfig(values.config),engine,{cwd:input.cwd,hook_event_name:event,source:input.source});
 process.stdout.write(JSON.stringify(result.output)+'\n');
 process.stderr.write(JSON.stringify({schema_version:1,status:result.status,...(result.bundle?{revision:result.bundle.revision,scope:result.bundle.projectId??'global',count:result.bundle.global.length+result.bundle.project.length}:{})})+'\n');
 if(result.status==='unsupported')process.exitCode=2;
}catch{
 process.stdout.write(JSON.stringify(policyFailure(engine==='claude'?'claude':'codex',event).output)+'\n');
 process.stderr.write('{"schema_version":1,"status":"unavailable"}\n');
}
