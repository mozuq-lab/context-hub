#!/usr/bin/env node
import {readPolicies,formatPolicies,rebuildPoliciesLocked,resolvePolicyProject} from './policies.js';
import {retireKnowledge} from './knowledge-retirement.js';
import { Command, Option } from 'commander';
import { open } from 'node:fs/promises';
import { loadConfig, type ConfigOverrides } from './config.js';
import { capture } from './capture.js';
import { correctInput } from './corrections.js';
import { listProjectCandidates,decideProject } from './project-proposals.js';
import { ingest } from './intake.js';
import { runCycle } from './cycle.js';
import { rebuildDashboard } from './dashboard.js';
import { Vault, unlockVault, LOCK_SCOPES } from './storage.js';
import { addProject, readProjects } from './projects.js';
import { find, recent, pending, resume, context } from './retrieve.js';
import { doctor } from './doctor.js';
import { organize } from './organize.js';
import { MockLlm } from './llm.js';
import { OpenClawInferLlm } from './infer.js';
import { listCandidates, approve, reject, propose } from './approvals.js';
import type { HubConfig } from './types.js';

const program = new Command().name('ctx').description('Markdownを正本とする個人用AI Context Hub').version('0.1.0')
  .option('--config <path>', '設定ファイル').option('--vault <path>', '明示的な保存先').option('--state <path>', 'Vault外のローカル状態');
const output = (value: unknown): void => { process.stdout.write(typeof value === 'string' ? value.replace(/\n?$/, '\n') : JSON.stringify(value,null,2)+'\n'); };
async function config(overrides:ConfigOverrides={}): Promise<HubConfig> {
  const opts=program.opts();
  return loadConfig(opts.config,{...(opts.vault?{vaultPath:opts.vault}:{}),...(opts.state?{statePath:opts.state}:{}),...overrides});
}
function positive(value:string): number { const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new Error('正の整数を指定してください');return n; }
async function inputText(text:string|undefined, file:string|undefined,max:number):Promise<string> {
  if(text!==undefined&&file)throw new Error('本文と --file は同時に指定できません');
  if(text!==undefined)return text;
  const stream=file? (await open(file,'r')).createReadStream():process.stdin;
  if(!file&&process.stdin.isTTY)throw new Error('本文、--file、または標準入力が必要です');
  const chunks:Buffer[]=[];let size=0;
  try { for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>max*4)throw new Error('入力が文字数上限を超えています');chunks.push(bytes);} }
  finally{if(file)stream.destroy();}
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error('文字コードがUTF-8ではありません。変換してから取り込んでください'); }
}
program.command('init').description('保存先を初期化（既存ノートは保持）').action(async()=>{const c=await config();const vault=new Vault(c);await vault.init();await vault.withLock(()=>rebuildPoliciesLocked(c,vault));output({vaultPath:c.vaultPath,initialized:true});});
program.command('add [text]').description('原文を保存').option('--file <path>','Markdown/テキストファイル')
  .option('--event-id <id>','再送判定用ID').option('--source <name>','出典名').option('--occurred-at <iso>','タイムゾーン付き発生日時')
  .addOption(new Option('--kind <kind>','入力の種別').choices(['memo','work-summary']).default('memo'))
  .option('--project <id>','人が指定する既存プロジェクト').option('--tool <name>','作業したAI/ツール').option('--session <reference>','元セッションの参照先')
  .action(async(text,opts)=>{const c=await config();const body=await inputText(text,opts.file,c.capture.maxInputChars);output(await capture(c,{text:body,source:opts.source??(opts.file?'file':text!==undefined?'cli':'stdin'),sourceEventId:opts.eventId,occurredAt:opts.occurredAt??new Date().toISOString(),kind:opts.kind,project:opts.project,tool:opts.tool,meta:opts.session?{session:opts.session}:undefined}));});
const project=program.command('project').description('人によるプロジェクト管理');
program.command('correct <id> [text]').description('元原文を保持して最新入力を訂正').option('--file <path>','訂正文ファイル').option('--event-id <id>','再送判定ID').option('--source <name>','出典名','cli-correction')
  .action(async(id,text,opts)=>{const c=await config();output(await correctInput(c,id,{text:await inputText(text,opts.file,c.capture.maxInputChars),source:opts.source,sourceEventId:opts.eventId,occurredAt:new Date().toISOString()}));});
project.command('add <id>').requiredOption('--title <text>','プロジェクト名').option('--aliases <csv>','別名、カンマ区切り').option('--keywords <csv>','検索語、カンマ区切り')
  .action(async(id,opts)=>output(await addProject(await config(),{id,title:opts.title,aliases:opts.aliases?.split(',')??[],keywords:opts.keywords?.split(',')??[]})));
project.command('list').action(async()=>output(await readProjects(await config())));
project.command('candidates').action(async()=>output(await listProjectCandidates(await config())));
for(const action of ['approve','reject'] as const)project.command(`${action} <id>`).requiredOption('--hash <sha256>','確認した候補のハッシュ').requiredOption('--token <token>','候補の確認トークン').requiredOption('--confirm','候補詳細を読んだ人の明示確認').action(async(id,opts)=>output(await decideProject(await config(),{candidateId:id,expectedHash:opts.hash,confirmationToken:opts.token,confirmed:opts.confirm,action,source:'cli',sourceEventId:`cli:${id}:${action}`})));
program.command('organize').description('未処理入力を整理').option('--limit <n>','処理上限',positive).option('--dry-run','対象一覧のみ。モデル/書き込みなし').option('--retry-failed','失敗分を再処理').option('--id <id>','指定入力を処理').option('--quiet-empty','0件時にNO_REPLYを返す')
  .addOption(new Option('--thinking <level>','推論の思考水準。設定organize.llm.thinkingを上書き').choices(['off','minimal','low','medium','high']))
  .action(async opts=>{const c=await config(opts.thinking?{organize:{llm:{thinking:opts.thinking}}}:{});const llm=c.organize.llm.provider==='mock'?new MockLlm():new OpenClawInferLlm(c.organize.llm);const result=await organize(c,llm,{limit:opts.limit,dryRun:opts.dryRun,retryFailed:opts.retryFailed,id:opts.id});output(opts.quietEmpty&&result.processed===0&&result.failed===0?'NO_REPLY':result);if(result.failed>0)process.exitCode=1;});
program.command('find <query>').action(async query=>output(await find(await config(),query)));
program.command('ingest').description('同期受付ファイルを正式保存').option('--limit <n>','受付操作の上限',positive).option('--dry-run','書き込みなし').action(async opts=>{const result=await ingest(await config(),{limit:opts.limit,dryRun:opts.dryRun});output(result);if(result.rejected)process.exitCode=1;});
program.command('dashboard').description('プロジェクト一覧と処理状況のHOMEを生成').action(async()=>output(await rebuildDashboard(await config())));
program.command('cycle').description('受付・整理・再関連付け・HOME生成').option('--limit <n>','整理と回復の合計上限',positive).option('--dry-run','書き込みとモデル呼び出しなし').option('--retry-failed','失敗分を再試行').option('--quiet-empty','新規処理と失敗がない場合NO_REPLY').addOption(new Option('--thinking <level>','思考水準').choices(['off','minimal','low','medium','high'])).action(async opts=>{const c=await config(opts.thinking?{organize:{llm:{thinking:opts.thinking}}}:{});const llm=c.organize.llm.provider==='mock'?new MockLlm():new OpenClawInferLlm(c.organize.llm);const result=await runCycle(c,llm,{limit:opts.limit,dryRun:opts.dryRun,retryFailed:opts.retryFailed});output(opts.quietEmpty&&!result.intake.accepted&&!result.intake.rejected&&!result.organize.processed&&!result.organize.failed&&!result.intake.conflicts.length&&!result.dashboard?.conflict?'NO_REPLY':result);if(result.intake.rejected||result.organize.failed)process.exitCode=1;});
program.command('recent').option('--n <n>','表示件数',positive,10).action(async opts=>output(await recent(await config(),opts.n)));
program.command('pending').action(async()=>output(await pending(await config())));
program.command('resume <project>').action(async id=>output(await resume(await config(),id)));
program.command('context <project>').option('--max-chars <n>','最大文字数',positive).action(async(id,opts)=>output(await context(await config(),id,opts.maxChars)));
program.command('policies').description('同期版の有効方針を読取専用で取得').option('--project <id>','ContextHubプロジェクト').option('--cwd <path>','対応付ける作業フォルダー').option('--json','JSON出力').action(async opts=>{const c=await config(),id=opts.project??(opts.cwd?await resolvePolicyProject(c,opts.cwd):undefined),b=await readPolicies(c,id);output(opts.json?b:formatPolicies(b));});
program.command('retire <id>').requiredOption('--hash <sha256>','確認した正式知識のハッシュ').requiredOption('--confirm','本人による適用停止').action(async(id,opts)=>output(await retireKnowledge(await config(),id,opts.hash)));
program.command('candidates').action(async()=>output(await listCandidates(await config())));
program.command('approve <id>').requiredOption('--hash <sha256>','候補一覧で確認した内容ハッシュ').requiredOption('--scope <scope>','global または project').option('--project <id>','採用先ContextHubプロジェクト').option('--project-hash <sha256>','確認したproject.mdのハッシュ').action(async(id,opts)=>output(await approve(await config(),id,opts.hash,opts.scope==='project'?{scope:'project',projectId:opts.project,projectHash:opts.projectHash}:{scope:opts.scope})));
program.command('reject <id>').requiredOption('--hash <sha256>','候補一覧で確認した内容ハッシュ').action(async(id,opts)=>output(await reject(await config(),id,opts.hash)));
program.command('propose <claim>').addOption(new Option('--kind <kind>','候補の種別').choices(['knowledge','decision','preference']).default('knowledge')).option('--rationale <text>','根拠','人による候補作成').option('--supersedes <id>','置き換えるKNW-ID')
  .action(async(claim,opts)=>output(await propose(await config(),{claim,kind:opts.kind,rationale:opts.rationale,supersedes:opts.supersedes})));
program.command('doctor').description('Vaultと処理記録を検査').option('--unlock','全Writer・整理の停止後、死亡PIDのロック残骸のみ回収').action(async opts=>{const c=await config();if(opts.unlock)for(const scope of LOCK_SCOPES){try{await unlockVault(c,scope);}catch(error){/* 稼働中・判断不能なロックは回収せず、下のdoctorの検査結果で報告する。 */process.stderr.write(`警告: ${scope==='organize'?'整理':'Writer'}ロックを回収しませんでした: ${error instanceof Error&&/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(error.message)&&!error.message.includes('\n')?error.message:'理由を確認できません'}\n`);process.exitCode=1;}}const result=await doctor(c);output(result);if(result.issues.length)process.exitCode=1;});
try { await program.parseAsync(); }
catch (error) {
  // パス・本文・外部プロセスのstderrを例外から転記しない。
  const message=error instanceof Error?error.message:'';
  const safe=/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(message)&&!message.includes('\n')?message:'処理に失敗しました。設定・引数とctx doctorを確認してください';
  process.stderr.write(`エラー: ${safe}\n`);process.exitCode=1;
}
