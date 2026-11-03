import { ingest,type IntakeRunResult } from './intake.js';
import { organize,type OrganizeOptions,type OrganizeRunResult } from './organize.js';
import { rebuildDashboard } from './dashboard.js';
import { rebuildDigest } from './digest.js';
import { collectGitDrafts,type CollectOutcome } from './git-drafts.js';
import type { HubConfig,LlmClient } from './types.js';
export interface CycleResult { intake:IntakeRunResult; organize:OrganizeRunResult; dashboard?:{path:string;conflict?:string}; digest?:{path:string;conflict?:string}; git?:CollectOutcome; dryRun:boolean }
export async function runCycle(config:HubConfig,llm:LlmClient,options:OrganizeOptions={}):Promise<CycleResult>{
 const intake=await ingest(config,{dryRun:options.dryRun}),organized=await organize(config,llm,options);
 // HOMEがふりかえりへリンクできるよう、REVIEW.mdを先に生成する。
 if(options.dryRun)return{intake,organize:organized,dryRun:true};
 // 設定で有効にしたときだけ、コミット履歴から下書きを作ってHOMEに載せる。失敗してもcycleは止めない。
 let git:CollectOutcome|undefined;
 if(config.git.enabled)try{git=await collectGitDrafts(config);}catch(error){git={created:[],skipped:[],errors:[{projectId:'*',repo:'*',error:error instanceof Error?error.message:String(error)}]};}
 const digest=await rebuildDigest(config),dashboard=await rebuildDashboard(config);
 return{intake,organize:organized,dashboard,digest,...(git?{git}:{}),dryRun:false};
}
