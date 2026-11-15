import {afterEach,expect,test} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fixture,project} from './fixtures.mjs';
const roots=[];afterEach(async()=>{for(const f of roots.splice(0))await f.cleanup();});
const invoke=args=>spawnSync(process.execPath,[join(project,'scripts/deploy.mjs'),...args],{encoding:'utf8',env:{...process.env,CONTEXT_HUB_CONFIG:'/missing/must-not-be-used'}});
test('helpと未導入statusを実CLIから読み取り、未確認applyは拒否する',async()=>{
 const help=invoke(['--help']);expect(help.status).toBe(0);expect(help.stdout).toMatch(/plan.*apply.*status/s);
 const f=await fixture();roots.push(f);const status=invoke(['status','--config',f.file]);expect(status.status).toBe(0);expect(JSON.parse(status.stdout).commit).toBeNull();
 const apply=invoke(['apply','--plan',join(f.root,'missing.json')]);expect(apply.status).toBe(1);expect(JSON.parse(apply.stderr).error).toMatch(/確認/);
});
test('未知の操作と曖昧な引数を拒否する',()=>{
 const r=invoke(['update','--config','/missing']);expect(r.status).toBe(1);expect(JSON.parse(r.stderr).error).toMatch(/操作|引数/);
});
