import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup,packet } from './workflow-fixtures.js';
import { runCycle } from '../src/cycle.js';
import { MockLlm } from '../src/llm.js';
import { readInputs } from '../src/capture.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test('受付から整理とHOMEまで実行し再送で原文を増やさない',async()=>{
 const{config,vault}=await workflowSetup(roots);await packet(config);const run=await runCycle(config,new MockLlm());expect(run.intake.accepted).toBe(1);expect(run.organize.processed).toBe(1);expect(await vault.read('HOME.md')).toContain('整理済み');await runCycle(config,new MockLlm());expect(await readInputs(config)).toHaveLength(1);
});
test('cycleのdry-runは原文・処理記録・HOMEを書かない',async()=>{
 const{config,vault}=await workflowSetup(roots);await packet(config);await runCycle(config,{complete:async()=>{throw new Error('モデルは禁止');}},{dryRun:true});expect(await readInputs(config)).toHaveLength(0);expect(await vault.files('90_system/intake')).toHaveLength(0);expect(await vault.read('HOME.md')).toBeUndefined();
});
