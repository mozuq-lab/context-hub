import {cp,mkdir,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
await mkdir('.demo',{recursive:true});
try{await access('.demo/vault');}catch{await cp('sample-vault','.demo/vault',{recursive:true,errorOnExist:true});}
const args=['packages/core/dist/cli.js','--config','examples/config.sample.json'];
function run(command,input){const p=spawnSync(process.execPath,[...args,...command],{input,encoding:'utf8'});if(p.error||p.status!==0)throw new Error(`デモ失敗: ${command[0]}\n${p.stderr}`);process.stdout.write(`\n$ ctx ${command.join(' ')}\n${p.stdout}`);}
run(['init']);
run(['add','--event-id','demo-note','--occurred-at','2026-09-14T10:30:00+09:00'],'日本語・改行のデモ\nhttps://example.com/demo\n');
run(['organize']);run(['organize','--quiet-empty']);run(['find','日本語']);run(['resume','context-hub']);run(['context','context-hub','--max-chars','1800']);run(['doctor']);
process.stdout.write(`\nデモの保存先: ${resolve('.demo/vault')}\nモデル・Bot接続: なし\n`);
await import('./file-sync-demo.mjs');
