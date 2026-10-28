import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { logOperation } from './logger.js';
import { parseInput, readInputs } from './capture.js';
import { readProjects } from './projects.js';
import { readCorrectionChains, type CorrectionChain } from './corrections.js';
import { effectiveFromChains,readEffectiveInputs } from './effective-inputs.js';
import { saveProjectCandidateLocked,recoverProjectApprovalsLocked } from './project-proposals.js';
import { applyAssociations,associationEligible,associationViewsComplete,markAssociationViewsCompleteLocked,readAssociation,projectRegistryHash,reassociateInputLocked } from './associations.js';
import { buildOrganizePrompt, groundExtractedHistory, InvalidOrganizeOutput, validateOrganizeResult } from './llm.js';
import { hash,parseMarkdown,Vault } from './storage.js';
import { associatedProjects, dateLabel, generatedMarkdown, readReceipts, receiptSchema, rebuildNowLocked, writeGeneratedLocked } from './views.js';
import type { HubConfig, Input, LlmClient, LlmCompletion, OrganizeResult, Project, Receipt } from './types.js';

export interface OrganizeOptions { limit?: number; dryRun?: boolean; retryFailed?: boolean; id?: string }
export interface OrganizeRunResult { processed: number; failed: number; skipped: number; conflicts: string[]; dryRun: boolean; inputIds: string[]; recovered?:number; reassociated?:number }
const optionsSchema = z.object({ limit: z.number().int().min(1).optional(), dryRun: z.boolean().optional(), retryFailed: z.boolean().optional(), id: z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/).optional() }).strict();
class LlmTimeout extends Error {}
async function complete(config: HubConfig, llm: LlmClient, prompt: string): Promise<LlmCompletion> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = await Promise.race([
      llm.complete(prompt, { timeoutSec: config.organize.timeoutSec, maxOutputChars: config.organize.llm.maxOutputChars, model: config.organize.llm.model }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new LlmTimeout()), config.organize.timeoutSec * 1000); }),
    ]);
    if (!completion || typeof completion !== 'object' || typeof completion.text !== 'string') throw new InvalidOrganizeOutput();
    return completion;
  } finally { if (timer) clearTimeout(timer); }
}
async function classify(config: HubConfig, llm: LlmClient, input: Input, projects: Project[], chain: CorrectionChain): Promise<{ result: OrganizeResult; model?: string }> {
  if (input.text.length > config.capture.maxInputChars) throw new InvalidOrganizeOutput();
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await complete(config, llm, buildOrganizePrompt(input, projects, attempt > 0,chain));
    try {
      const result = groundExtractedHistory(chain, validateOrganizeResult(completion.text, projects.map((project) => project.id), config.organize.llm.maxOutputChars));
      return typeof completion.model === 'string' && completion.model ? { result, model: completion.model } : { result };
    }
    catch (error) { if (!(error instanceof InvalidOrganizeOutput) || attempt === 1) throw error; }
  }
  throw new InvalidOrganizeOutput();
}
function evidenceText(input: Input, config: HubConfig, prefix: string): string {
  return `入力: [${input.id}](${prefix}${input.path})\n出典: ${input.source}${input.tool ? ` / ${input.tool}` : ''}\n発生日時: ${dateLabel(input.occurred_at, config.timezone)} ${config.timezone}\n受信日時: ${dateLabel(input.received_at, config.timezone)} ${config.timezone}\n性質: ${input.origin}（未検証）\n`;
}

async function readJournal(vault: Vault, inputId: string): Promise<Receipt | undefined> {
  const raw = await vault.read(`90_system/receipts/pending/${inputId}.json`);
  if (raw === undefined) return undefined;
  try {
    const receipt = receiptSchema.parse(JSON.parse(raw));
    if (receipt.input_id !== inputId || !receipt.input_hash || receipt.status !== 'organized' || receipt.writes.length !== 0) throw new Error();
    return receipt;
  } catch { throw new Error(`処理journalが不正です: ${inputId}`); }
}

async function inputSnapshotHash(vault: Vault, input: Input): Promise<string> {
  const raw = await vault.read(input.path);
  // readInputsの解析値と同じ内容をハッシュへ結合し、再読時の別内容を誤って採用しない。
  if (raw === undefined || !isDeepStrictEqual(parseInput(input.path, raw), input)) throw new Error(`入力が取得中に変更されました: ${input.id}`);
  return hash(raw);
}

async function assertInputHash(vault: Vault, input: Input, expected: string | undefined): Promise<void> {
  const raw = await vault.read(input.path);
  if (!expected || raw === undefined || hash(raw) !== expected) throw new Error(`入力のハッシュが一致しません。原文の変更を確認してください: ${input.id}`);
}
async function assertEvidence(vault: Vault, chain: CorrectionChain): Promise<void> {
  const parts:string[]=[];
  for (const input of [chain.root,...chain.revisions]) parts.push(`${input.id}:${await inputSnapshotHash(vault,input)}`);
  if (hash(parts.join('\n')) !== chain.evidenceHash) throw new Error('訂正根拠のハッシュが一致しません');
}

export async function organize(config: HubConfig, llm: LlmClient, options: OrganizeOptions = {}): Promise<OrganizeRunResult> {
  optionsSchema.parse(options); const vault = new Vault(config); const started = Date.now();
  const outcome = await vault.withLock(async () => {
    const budget=Math.min(options.limit??config.organize.maxItemsPerRun,config.organize.maxItemsPerRun);
    const recovered=options.id?0:await recoverProjectApprovalsLocked(config,vault,budget,options.dryRun);
    const chains = await readCorrectionChains(config), inputs=chains.flatMap(c=>[c.root,...c.revisions]), active=chains.map(c=>c.latest); const receipts = await readReceipts(config); const byId = new Map(receipts.map((receipt) => [receipt.input_id, receipt]));
    if (options.id && !inputs.some((input) => input.id === options.id)) throw new Error('入力が見つかりません');
    const journals = new Map<string, Receipt>();
    const matchesId=(input:Input)=>!options.id||input.id===options.id||chains.find(c=>c.latest.id===input.id)?.root.id===options.id;
    for (const input of active) {
      // 完了receiptを正とし、同期・復旧用に保持したjournalで完了状態を巻き戻さない。
      if (!matchesId(input) || byId.get(input.id)?.status === 'organized') continue;
      const journal = await readJournal(vault, input.id);
      if (journal) journals.set(input.id, journal);
    }
    const eligible = active.filter((input) => {
      if (!matchesId(input)) return false;
      const receipt = byId.get(input.id);
      return journals.has(input.id) || !receipt || (options.retryFailed === true && receipt.status === 'failed' && receipt.attempts < config.organize.maxAttempts);
    }).sort((left, right) => Date.parse(chains.find(c=>c.latest.id===left.id)!.root.occurred_at) - Date.parse(chains.find(c=>c.latest.id===right.id)!.root.occurred_at) || left.id.localeCompare(right.id));
    const selected = eligible.slice(0,budget-recovered);
    const outcome: OrganizeRunResult = { processed: 0, failed: 0, skipped: inputs.length - selected.length, conflicts: [], dryRun: options.dryRun === true, inputIds: selected.map((input) => input.id) };
    if(recovered){outcome.recovered=recovered;if(!options.dryRun)outcome.processed=recovered;}
    const projects = await readProjects(config);
    const rebuildAffected=async(chain:CorrectionChain,current:Receipt[],generatedAt:string)=>{
      const projectIds=new Set<string>();
      for(const records of [receipts,current])for(const unit of await applyAssociations(config,effectiveFromChains(chains,records),projects))if(unit.chain.root.id===chain.root.id){if(unit.chain.root.project)projectIds.add(unit.chain.root.project);if(unit.receipt)for(const id of associatedProjects(unit.chain.root,unit.receipt,config))projectIds.add(id);}
      // 定義一覧の変更で旧関連付けが無効になっても、旧表示を取り消す。
      for(const project of projects){const raw=await vault.read(`10_projects/${project.id}/NOW.md`);if(raw)try{const{meta}=parseMarkdown(raw);if(Array.isArray(meta.input_ids)&&meta.input_ids.includes(chain.root.id))projectIds.add(project.id);}catch{ /* 自動領域の手動変更はWriterが競合へ退避する。 */ }}
      for(const id of projectIds)if(projects.some(p=>p.id===id)){const write=await rebuildNowLocked(vault,config,id,inputs,current,generatedAt);if(write.conflict)outcome.conflicts.push(write.conflict);}
    };
    for (const input of selected) {
      if(options.dryRun)continue;
      const chain=chains.find(c=>c.latest.id===input.id)!;
      const inputHash = await inputSnapshotHash(vault, input);
      await assertEvidence(vault,chain);
      let receipt = journals.get(input.id);
      if (receipt && receipt.input_hash !== inputHash) throw new Error(`journalと入力のハッシュが一致しません: ${input.id}`);
      if(receipt && chain.revisions.length && (receipt.root_input_id!==chain.root.id || receipt.evidence_hash!==chain.evidenceHash || JSON.stringify(receipt.evidence_ids)!==JSON.stringify([chain.root,...chain.revisions].map(i=>i.id))))throw new Error('journalと訂正根拠が一致しません');
      if (!receipt) {
        receipt = { schema_version: 1, input_id: input.id, input_hash: inputHash, status: 'organized', attempts: (byId.get(input.id)?.attempts ?? 0) + 1, organized_at: new Date().toISOString(), llm: { provider: config.organize.llm.provider, model: config.organize.llm.model ?? (config.organize.llm.provider === 'mock' ? 'mock' : 'inherited-unverified'), prompt_version: 1 }, result: null, writes: [], error: null };
        receipt.project_registry_hash=projectRegistryHash(projects);
        if(chain.revisions.length)Object.assign(receipt,{root_input_id:chain.root.id,evidence_ids:[chain.root,...chain.revisions].map(i=>i.id),evidence_hash:chain.evidenceHash});
        // 実行側が報告したモデル名を記録する。報告がなければ設定値、それもなければ未検証の継承を明示する。
        try { const classified = await classify(config, llm, input, projects,chain); receipt.result = classified.result; if (classified.model) receipt.llm.model = classified.model; }
        catch (error) {
          await assertInputHash(vault, input, receipt.input_hash);
          await assertEvidence(vault,chain);
          receipt.status = 'failed'; receipt.error = error instanceof InvalidOrganizeOutput ? 'invalid-output' : error instanceof LlmTimeout ? 'timeout' : 'llm-error';
          await vault.write(`90_system/receipts/${input.id}.json`, `${JSON.stringify(receipt, null, 2)}\n`); byId.set(input.id, receipt); await rebuildAffected(chain,[...byId.values()],receipt.organized_at);outcome.failed++; continue;
        }
        // モデル出力の検証後、派生ファイルより先に同じ結果・試行回数・生成日時を耐久化する。
        await assertInputHash(vault, input, receipt.input_hash);
        await assertEvidence(vault,chain);
        if (!await vault.create(`90_system/receipts/pending/${input.id}.json`, `${JSON.stringify(receipt, null, 2)}\n`)) throw new Error(`処理journalが競合しました: ${input.id}`);
      }
      await assertInputHash(vault, input, receipt.input_hash);
      await assertEvidence(vault,chain);
      const result = receipt.result;
      if (!result || result.project_candidates.some((candidate) => !projects.some((project) => project.id === candidate.id))) throw new Error(`処理journalの関連プロジェクトが不正です: ${input.id}`);
      const now = receipt.organized_at;
      const meta = { schema_version: 1, generated_by: { model: receipt.llm.model, prompt_version: 1 }, generated_at: now, input_ids: [chain.root,...chain.revisions].map(i=>i.id), source: chain.root.source, occurred_at: chain.root.occurred_at, origin: chain.root.origin, verified: false };
      const recordWrite = (write: { path: string; conflict?: string }): void => { receipt.writes.push(write.conflict ?? write.path); if (write.conflict) outcome.conflicts.push(write.conflict); };
      const projectCandidate=await saveProjectCandidateLocked(config,vault,chain,receipt);if(projectCandidate)receipt.writes.push(projectCandidate);
      if (result.category === 'idea') {
        const id = `IDEA-${chain.root.id.slice(3)}`;
        const text = `# アイデア（AI生成・未検証）\n\n${result.summary}\n\n${evidenceText(input, config, '../')}\n帰属候補: ${result.project_candidates.map((candidate) => `${candidate.id} (${candidate.confidence})`).join(', ') || 'なし'}\n`;
        recordWrite(await writeGeneratedLocked(vault, `20_ideas/${id}.md`, generatedMarkdown({ ...meta, id, category: 'idea', project_candidates: result.project_candidates }, text)));
      }
      else if(chain.revisions.length && await vault.read(`20_ideas/IDEA-${chain.root.id.slice(3)}.md`)!==undefined){const id=`IDEA-${chain.root.id.slice(3)}`;recordWrite(await writeGeneratedLocked(vault,`20_ideas/${id}.md`,generatedMarkdown({...meta,id,category:result.category,retracted:true},`# アイデアの分類取消（AI生成・未検証）\n\n現在の分類候補: ${result.category}\n${result.summary}\n\n${[chain.root,...chain.revisions].map(i=>evidenceText(i,config,'../')).join('\n')}`)));}
      if (result.knowledge_candidate) {
        const id = `CAN-${input.id.slice(3)}`; const candidate = result.knowledge_candidate;
        const text = `# 承認前の候補（AI生成・未検証）\n\n${candidate.claim}\n\n理由: ${candidate.rationale || '不明'}\n\n${evidenceText(input, config, '../../')}`;
        const frozen = await vault.read(`90_system/approvals/APR-${id.slice(4)}.json`) !== undefined;
        recordWrite(await writeGeneratedLocked(vault, `90_system/candidates/${id}.md`, generatedMarkdown({ ...meta, id, kind: candidate.kind, claim: candidate.claim, rationale: candidate.rationale }, text), frozen));
      }
      // 今回の結果をメモリで含め、すべての生成物が耐久化した後にreceiptを確定する。
      const currentReceipts = [...byId.values()].filter((existing) => existing.input_id !== input.id).concat(receipt);
      await rebuildAffected(chain,currentReceipts,now);
      await assertEvidence(vault,chain);
      await assertInputHash(vault, input, receipt.input_hash);
      await vault.write(`90_system/receipts/${input.id}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
      byId.set(input.id, receipt); outcome.processed++;
    }
    {
      let remaining=budget-recovered-selected.length;
      for(const unit of await readEffectiveInputs(config)){
        if(remaining<=0)break;
        if(!matchesId(unit.chain.latest))continue;
        const saved=await readAssociation(vault,unit,projects);
        if(saved?.status==='associated'&&!await associationViewsComplete(vault,saved)){
          remaining--;outcome.inputIds.push(unit.chain.root.id);
          if(options.dryRun)continue;
          await rebuildAffected(unit.chain,[...byId.values()],saved.associated_at);
          await markAssociationViewsCompleteLocked(vault,saved);
          outcome.processed++;outcome.recovered=(outcome.recovered??0)+1;continue;
        }
        if(!await associationEligible(config,vault,unit,projects,options.retryFailed))continue;
        remaining--;outcome.inputIds.push(unit.chain.root.id);
        if(options.dryRun)continue;
        const result=await reassociateInputLocked(config,vault,llm,unit,projects,{retryFailed:options.retryFailed});
        if(result.status==='failed'){outcome.failed++;continue;}
        outcome.processed++;outcome.reassociated=(outcome.reassociated??0)+1;
        await rebuildAffected(unit.chain,[...byId.values()],result.associated_at);
        await markAssociationViewsCompleteLocked(vault,result);
      }
    }
    return outcome;
  });
  if (!outcome.dryRun && !await logOperation(config, { op: 'organize', ms: Date.now() - started, ...(outcome.failed ? { error_kind: 'llm' as const } : {}), counts: { processed: outcome.processed, failed: outcome.failed, skipped: outcome.skipped, conflicts: outcome.conflicts.length } })) process.stderr.write('警告: 運用ログを書き込めませんでした。処理結果は保持されています。\n');
  return outcome;
}
