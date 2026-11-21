import { ingest,type IntakeRunResult } from './intake.js';
import { organize,type OrganizeOptions,type OrganizeRunResult } from './organize.js';
import { rebuildDashboard } from './dashboard.js';
import { rebuildDigest } from './digest.js';
import { rebuildHistories,type HistoryWrite } from './history.js';
import { rebuildReferences,type ReferencesWrite } from './references.js';
import { collectGitDrafts,type CollectOutcome } from './git-drafts.js';
import { nowItemsPath } from './item-resolutions.js';
import { readProjects,inspectProjects } from './projects.js';
import { rebuildNow } from './views.js';
import { runSynthesis,type SynthesisOutcome } from './synthesis.js';
import { answerPending,type AnswerPendingResult } from './ask.js';
import { userFacingError } from './error-message.js';
import { Vault } from './storage.js';
import type { HubConfig,LlmClient } from './types.js';
export interface CycleResult { intake:IntakeRunResult; organize:OrganizeRunResult; dashboard?:{path:string;conflict?:string}; digest?:{path:string;conflict?:string}; history?:HistoryWrite[]|{error:string}; references?:ReferencesWrite[]|{error:string}; git?:CollectOutcome; /** 週次の統合。設定で有効にしたときだけ入る。 */ synthesis?:SynthesisOutcome|{error:string}; /** 記録に聞くの答え待ちに答えた結果。答え待ちがあったときだけ入る。 */ ask?:AnswerPendingResult|{error:string}; dryRun:boolean }
export interface CycleExtras {
 /** 週次の統合に使うモデル。思考の深さを整理と分けるには、synthesisLlmConfigの設定で作ったクライアントを渡す。省略時は整理と同じllmを使う。 */ synthesisLlm?:LlmClient;
 /** 週次の統合の実行時刻（検証用）。 */ now?:Date;
}
export async function runCycle(config:HubConfig,llm:LlmClient,options:OrganizeOptions={},extras:CycleExtras={}):Promise<CycleResult>{
 const intake=await ingest(config,{dryRun:options.dryRun});
 // 不正なプロジェクト定義があるときはモデルを呼ばず、HOMEに不正な箇所を示してから止める。
 if((await inspectProjects(config)).issues.length){if(!options.dryRun)await rebuildDashboard(config);await readProjects(config);}
 const organized=await organize(config,llm,options);
 // HOMEがふりかえりへリンクできるよう、REVIEW.mdを先に生成する。
 if(options.dryRun)return{intake,organize:organized,dryRun:true};
 // 旧版で生成したNOWには項目一覧がないため、一覧のないプロジェクトだけNOWを作り直す。
 const vault=new Vault(config);
 for(const project of await readProjects(config))if(await vault.read(`10_projects/${project.id}/NOW.md`)!==undefined&&await vault.read(nowItemsPath(project.id))===undefined)await rebuildNow(config,project.id);
 // 設定で有効にしたときだけ、間隔ごとに週次の統合を実行する。同じcycleのふりかえりとHOMEに出せるよう、整理の後・生成の前に行う。失敗してもcycleは止めない。
 let synthesis:CycleResult['synthesis'];
 if(config.synthesis.enabled)try{synthesis=await runSynthesis(config,extras.synthesisLlm??llm,{...(extras.now?{now:extras.now}:{}),retryFailed:options.retryFailed===true});}catch(error){synthesis={error:userFacingError(error)};}
 // アプリから届いた問い（記録に聞く）に答える。整理の後に行い、今回整理したメモも根拠にする。失敗してもcycleは止めない。
 let ask:CycleResult['ask'];
 if(config.ask.enabled)try{const answered=await answerPending(config,llm,extras.now?{now:extras.now}:{});if(answered.answered||answered.failed||answered.waiting||answered.removed)ask=answered;}catch(error){ask={error:userFacingError(error)};}
 // 設定で有効にしたときだけ、コミット履歴から下書きを作ってHOMEに載せる。失敗してもcycleは止めない。
 let git:CollectOutcome|undefined;
 if(config.git.enabled)try{git=await collectGitDrafts(config);}catch(error){git={created:[],skipped:[],errors:[{projectId:'*',repo:'*',error:error instanceof Error?error.message:String(error)}]};}
 // 経緯は本文が変わったプロジェクトだけ書き換える。HOMEが手で変えたHISTORY.mdを示せるよう、HOMEより先に作る。
 const digest=await rebuildDigest(config);
 // 経緯は派生の読み物なので、作れなくてもHOMEの生成とcycleは止めない（失敗はcycleの結果とdoctorで示す）。
 let history:HistoryWrite[]|{error:string};
 try{history=(await rebuildHistories(config)).filter(h=>h.written||h.stopped);}catch(error){history={error:error instanceof Error?error.message:String(error)};}
 // 資料棚も派生の読み物。資料のあるプロジェクトだけに作り、作れなくてもcycleは止めない。
 let references:ReferencesWrite[]|{error:string};
 try{references=(await rebuildReferences(config)).filter(r=>r.written||r.stopped);}catch(error){references={error:error instanceof Error?error.message:String(error)};}
 const dashboard=await rebuildDashboard(config);
 return{intake,organize:organized,dashboard,digest,history,references,...(git?{git}:{}),...(synthesis?{synthesis}:{}),...(ask?{ask}:{}),dryRun:false};
}
