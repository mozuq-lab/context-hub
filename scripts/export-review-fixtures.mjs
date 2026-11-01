// 架空の一時Vaultから両クライアント共用fixtureを生成する。
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {defaultConfig,Vault,capture,organize,MockLlm,propose,approve,reject,correctInput,rebuildDashboard,buildReviewIndex} from '../packages/core/dist/index.js';
const root=await mkdtemp(join(tmpdir(),'context-hub-review-'));
try{
 const config=defaultConfig(join(root,'vault'),join(root,'state')),vault=new Vault(config);await vault.init();
 const model=new MockLlm([{category:'decision-candidate',summary:'保存方針',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:{kind:'decision',claim:'正本はMarkdownとする',rationale:'アプリを替えても読める'},new_project_hint:null,project_proposal:{title:'ノート管理の改善',aliases:['ノート改善'],keywords:['記録'],rationale:'継続的に使いやすさを改善する'}}]);
 await capture(config,{source:'cli',occurredAt:'2026-11-01T01:00:00Z',text:'正本はMarkdownとし、ノート管理を改善したい。'});await organize(config,model);
 for(const kind of ['knowledge','preference'])await propose(config,{kind,claim:kind==='knowledge'?'同期とバックアップを分ける':'短い説明を好む',rationale:'利用者の提案'});
 const yes=await propose(config,{claim:'原文を残す'});await approve(config,yes.candidateId,yes.hash,{scope:'global'});
 const no=await propose(config,{claim:'毎日すべてを削除する'});await reject(config,no.candidateId,no.hash);
 const old=await capture(config,{source:'cli',occurredAt:'2026-11-01T02:00:00Z',text:'一時的な方針'});await organize(config,new MockLlm([{category:'decision-candidate',summary:'方針候補',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:{kind:'knowledge',claim:'古い方針',rationale:'検討中'},new_project_hint:null}]));
 await correctInput(config,old.inputId,{source:'cli',occurredAt:'2026-11-01T03:00:00Z',text:'方針を見直す'});
 await vault.create('90_system/candidates/CAN-'+'0'.repeat(26)+'.md','同期途中の候補');await rebuildDashboard(config);
 const files={};for(const dir of ['00_inbox','10_projects','20_ideas','30_knowledge','90_system','Input'])for(const path of await vault.files(dir))files[path]=await vault.read(path);
 files['POLICY.md']=await vault.read('POLICY.md');
 const index=await buildReviewIndex(config),target=resolve(process.argv[2]??'.demo/review-fixture.json');await mkdir(dirname(target),{recursive:true});
 assert.equal(index.items.filter(i=>i.status==='pending').length,4);
 assert.equal(index.items.filter(i=>['stale','unavailable'].includes(i.status)).length,2);
 assert.equal(index.items.filter(i=>['approved','rejected'].includes(i.status)).length,2);
 await writeFile(target,JSON.stringify({schema_version:1,files,expected:{pending:index.items.filter(i=>i.status==='pending').length,attention:index.items.filter(i=>['stale','unavailable'].includes(i.status)).length,history:index.items.filter(i=>['approved','rejected'].includes(i.status)).length}},null,2)+'\n');
 process.stdout.write('架空の確認待ちfixtureを生成しました\n');
}finally{await rm(root,{recursive:true,force:true});}
