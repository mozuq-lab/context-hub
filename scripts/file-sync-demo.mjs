import { resolve,join } from 'node:path';
import { utimes,cp } from 'node:fs/promises';
import { defaultConfig,Vault,markdown,readInputs,readProjects,runCycle,MockLlm,listProjectCandidates,doctor } from '../packages/core/dist/index.js';
const config=defaultConfig(resolve('.demo/file-sync-vault'),resolve('.demo/file-sync-state')),vault=new Vault(config);await vault.init();
await cp('examples/quickadd',join(config.vaultPath,'_ContextHub'),{recursive:true});
const proposal={category:'idea',summary:'家庭菜園を続ける計画',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:null,new_project_hint:null,project_proposal:{title:'家庭菜園',aliases:['菜園'],keywords:['栽培'],rationale:'公開サンプルの継続的な活動'}};
const llm={complete:async(prompt,opts)=>{const data=JSON.parse(prompt.split('\n入力データ(JSON):\n')[1]);return data.operation!=='association'&&data.source_text.includes('プロジェクト化')?{text:JSON.stringify(proposal),model:'mock'}:new MockLlm().complete(prompt,opts);}};
async function submit(letter,fields,text=''){
 const request_id=`REQ-${letter.repeat(32)}`,path=`Input/${request_id}.md`,meta={schema_version:1,request_id,operation:'capture',kind:'memo',source:'demo-other-device',occurred_at:'2026-10-03T10:00:00+09:00',...fields};if(meta.operation!=='capture')delete meta.kind;
 const raw=markdown(meta,text);if(!await vault.create(path,raw)&&await vault.read(path)!==raw)throw new Error('デモの受付が変更されています');await utimes(join(config.vaultPath,path),new Date(0),new Date(0));
}
await submit('a',{kind:'work-summary',tool:'demo-ai'},'## 現在地\n- [確認済み] 菜園を栽培中');await runCycle(config,llm);
const root=(await readInputs(config)).find(i=>i.source_event_id==='REQ-'+'a'.repeat(32)),original=await vault.read(root.path);
await submit('b',{operation:'correct',target_id:root.id},'## 現在地\n- [確認済み] 菜園で苗を育成中');await submit('c',{},'菜園の計画をプロジェクト化したい');await runCycle(config,llm);
const candidate=(await listProjectCandidates(config))[0];await submit('d',{operation:'project-approve',candidate_id:candidate.candidateId,candidate_hash:candidate.candidateHash,confirmation_token:candidate.confirmationToken,confirmed:true});await runCycle(config,llm,{limit:2});
if(await vault.read(root.path)!==original)throw new Error('デモの原文が変わりました');
const report=await doctor(config);if(report.issues.length)throw new Error(`デモの検査失敗: ${report.issues.join('、')}`);
process.stdout.write(JSON.stringify({fileSyncDemo:config.vaultPath,projects:await readProjects(config),inputs:(await readInputs(config)).length,home:join(config.vaultPath,'HOME.md'),rawPreserved:true,model:'mock',doctor:report},null,2)+'\n');
