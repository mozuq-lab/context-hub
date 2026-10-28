import { ingest,type IntakeRunResult } from './intake.js';
import { organize,type OrganizeOptions,type OrganizeRunResult } from './organize.js';
import { rebuildDashboard } from './dashboard.js';
import type { HubConfig,LlmClient } from './types.js';
export interface CycleResult { intake:IntakeRunResult; organize:OrganizeRunResult; dashboard?:{path:string;conflict?:string}; dryRun:boolean }
export async function runCycle(config:HubConfig,llm:LlmClient,options:OrganizeOptions={}):Promise<CycleResult>{
 const intake=await ingest(config,{dryRun:options.dryRun}),organized=await organize(config,llm,options);
 return{intake,organize:organized,...(options.dryRun?{}:{dashboard:await rebuildDashboard(config)}),dryRun:options.dryRun===true};
}
