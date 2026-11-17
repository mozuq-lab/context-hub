import {afterEach,expect,test} from 'vitest';
import {writeFile,readFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './fixtures.mjs';
import {preparePlan} from '../prepare.mjs';
const fs=[];afterEach(async()=>{for(const f of fs.splice(0))await f.cleanup();});
async function setup(){const f=await fixture();fs.push(f);return f;}
test('cleanなHEADだけを別候補へ配置して検証し、運用先と原文を変更しない',async()=>{
 const f=await setup(),p=await preparePlan(f.file,{repository:f.repository,run:f.execute});
 expect(p.summary.commit).toBe(f.git('rev-parse','HEAD'));expect(p.summary.initialAdoption).toBe(true);
 const plan=JSON.parse(await readFile(p.planPath,'utf8'));expect(await readFile(join(plan.candidate,'code.txt'),'utf8')).toBe('version one\n');
 expect(f.calls.filter(x=>x[0]==='npm').map(x=>x.slice(1))).toEqual([['ci'],['run','check'],['test','--','--maxWorkers=2'],['run','build'],['run','demo']]);
 expect(p.summary.changes).toContain(join(f.vault,'AGENTS.md'));
 expect(f.calls.some(x=>x.includes('cycle')||x.includes('organize'))).toBe(false);
});
test('未コミット変更があれば候補の検証前に停止する',async()=>{
 const f=await setup();await writeFile(join(f.repository,'code.txt'),'uncommitted');
 await expect(preparePlan(f.file,{repository:f.repository,run:f.execute})).rejects.toThrow(/未コミット|clean/);expect(f.calls.some(x=>x[0]==='npm')).toBe(false);
});
test('独自に変更した配布物を上書きせず、明示した保持対象なら候補に含めない',async()=>{
 const f=await setup();await writeFile(join(f.vault,'AGENTS.md'),'利用者の独自規約\n');
 await expect(preparePlan(f.file,{repository:f.repository,run:f.execute})).rejects.toThrow(/独自変更/);
 f.config.preserveAssets=['vault-agents'];await writeFile(f.file,JSON.stringify(f.config));const p=await preparePlan(f.file,{repository:f.repository,run:f.execute});
 expect(p.summary.preserved).toEqual(['vault-agents']);expect(p.summary.changes).not.toContain(join(f.vault,'AGENTS.md'));
},20000);
test('配布manifestから原文領域への書き込みを要求しても拒否する',async()=>{
 const f=await setup();await writeFile(join(f.repository,'scripts/deploy/manifest.json'),JSON.stringify({schema_version:1,vaultFormat:1,assets:[{id:'bad-target',scope:'vault',source:'agents.md',target:'00_inbox/overwrite.md'}]}));f.git('add','.');f.git('commit','-qm','不正な配布先のfixture');
 await expect(preparePlan(f.file,{repository:f.repository,run:f.execute})).rejects.toThrow(/配布先|原文/);
});
test('検証失敗時はplanを発行せず、内部から外へ抜ける依存リンクも拒否する',async()=>{
 const f=await setup();const broken=async(exe,args,o)=>exe==='npm'?{code:1,stdout:'',stderr:'fixture failure'}:f.execute(exe,args,o);
 await expect(preparePlan(f.file,{repository:f.repository,run:broken})).rejects.toThrow(/失敗/);
 const linked=async(exe,args,o)=>{const r=await f.execute(exe,args,o);if(exe==='npm'&&args[0]==='ci')await symlink(f.root,join(o.cwd,'outside'));return r;};
 await expect(preparePlan(f.file,{repository:f.repository,run:linked})).rejects.toThrow(/外部/);
},20000);
