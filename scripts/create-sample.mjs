import {resolve} from 'node:path';
import {defaultConfig,Vault,readProjects,addProject,capture,organize,MockLlm,rebuildDashboard} from '../packages/core/dist/index.js';
const config=defaultConfig(resolve('sample-vault'),resolve('.ctx-state/sample-build'));
await new Vault(config).init();
if(!(await readProjects(config)).some(p=>p.id==='context-hub'))await addProject(config,{id:'context-hub',title:'AI Context Hub',aliases:['Hub'],keywords:['再開','コンテキスト']});
for(const request of [
 {source:'cli',sourceEventId:'sample-idea',occurredAt:'2026-09-14T09:00:00+09:00',text:'数日ぶりの開発再開を助ける仕組み、面白そう。\nhttps://example.com/context'},
 {source:'file',sourceEventId:'sample-summary',occurredAt:'2026-09-14T10:00:00+09:00',kind:'work-summary',project:'context-hub',tool:'sample-ai',meta:{session:'local:sample-only'},text:'## 現在地\n- [確認済み] サンプルで原文保存を確認した。\n## 次の一手\n- [確認済み] サンプルの検索を確認する。\n- [提案] 同期導入は後日検討する。\n## 未解決\n- [未確認] Discord実機接続は承認後に確認する。\n'},
 {source:'cli',sourceEventId:'sample-question',occurredAt:'2026-09-14T10:10:00+09:00',project:'context-hub',text:'同期とバックアップを分けるにはどうする？'}
])await capture(config,request);
const result=await organize(config,new MockLlm());
await rebuildDashboard(config);
process.stdout.write(JSON.stringify({sampleVault:config.vaultPath,...result},null,2)+'\n');
