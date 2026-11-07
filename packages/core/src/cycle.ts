import { ingest,type IntakeRunResult } from './intake.js';
import { organize,type OrganizeOptions,type OrganizeRunResult } from './organize.js';
import { rebuildDashboard } from './dashboard.js';
import { rebuildDigest } from './digest.js';
import { collectGitDrafts,type CollectOutcome } from './git-drafts.js';
import { nowItemsPath } from './item-resolutions.js';
import { readProjects,inspectProjects } from './projects.js';
import { rebuildNow } from './views.js';
import { Vault } from './storage.js';
import type { HubConfig,LlmClient } from './types.js';
export interface CycleResult { intake:IntakeRunResult; organize:OrganizeRunResult; dashboard?:{path:string;conflict?:string}; digest?:{path:string;conflict?:string}; git?:CollectOutcome; dryRun:boolean }
export async function runCycle(config:HubConfig,llm:LlmClient,options:OrganizeOptions={}):Promise<CycleResult>{
 const intake=await ingest(config,{dryRun:options.dryRun});
 // 不正なプロジェクト定義があるときはモデルを呼ばず、HOMEに不正な箇所を示してから止める。
 if((await inspectProjects(config)).issues.length){if(!options.dryRun)await rebuildDashboard(config);await readProjects(config);}
 const organized=await organize(config,llm,options);
 // HOMEがふりかえりへリンクできるよう、REVIEW.mdを先に生成する。
 if(options.dryRun)return{intake,organize:organized,dryRun:true};
 // 旧版で生成したNOWには項目一覧がないため、一覧のないプロジェクトだけNOWを作り直す。
 const vault=new Vault(config);
 for(const project of await readProjects(config))if(await vault.read(`10_projects/${project.id}/NOW.md`)!==undefined&&await vault.read(nowItemsPath(project.id))===undefined)await rebuildNow(config,project.id);
 // 設定で有効にしたときだけ、コミット履歴から下書きを作ってHOMEに載せる。失敗してもcycleは止めない。
 let git:CollectOutcome|undefined;
 if(config.git.enabled)try{git=await collectGitDrafts(config);}catch(error){git={created:[],skipped:[],errors:[{projectId:'*',repo:'*',error:error instanceof Error?error.message:String(error)}]};}
 const digest=await rebuildDigest(config),dashboard=await rebuildDashboard(config);
 return{intake,organize:organized,dashboard,digest,...(git?{git}:{}),dryRun:false};
}
