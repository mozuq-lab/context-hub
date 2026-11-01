import {assertAdoptionCapacity,rebuildPoliciesLocked} from './policies.js';
import {adoptionTargetSchema,knowledgePath,readKnowledge,sameScope,validateAdoptionTarget,type AdoptionTarget} from './knowledge-scope.js';
import {isDeepStrictEqual} from 'node:util';
import {relative as pathRelative,dirname} from 'node:path/posix';
import { z } from 'zod';
import { logOperation } from './logger.js';
import { ulid } from 'ulid';
import { Vault, hash, parseMarkdown } from './storage.js';
import { dateLabel, generatedMarkdown, isGeneratedIntact } from './views.js';
import type { HubConfig } from './types.js';
import {readKnowledgeCandidate,readKnowledgeDecision,knowledgeDecisionSchema} from './knowledge-candidates.js';

export interface Proposal { claim: string; kind?: 'knowledge' | 'decision' | 'preference'; rationale?: string; supersedes?: string }
export interface DecisionResult { candidateId: string; approvalId: string; knowledgeId?: string; adoptedTarget?: AdoptionTarget; deduped: boolean }
const candidateIdSchema = z.string().regex(/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/);
const knowledgeIdSchema = z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/);
const proposalSchema = z.object({ claim: z.string().trim().min(1).max(1000), kind: z.enum(['knowledge', 'decision', 'preference']).default('knowledge'), rationale: z.string().max(1000).default(''), supersedes: knowledgeIdSchema.optional() }).strict();
const candidateSchema = z.object({ id: candidateIdSchema, claim: z.string().min(1).max(1000), kind: z.enum(['knowledge', 'decision', 'preference']), rationale: z.string().max(1000), input_ids: z.array(z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/)), supersedes: knowledgeIdSchema.optional() });
const decisionSchema = knowledgeDecisionSchema;
type Decision = z.infer<typeof decisionSchema>;

async function candidateAt(vault: Vault, id: string): Promise<{ content: string; meta: z.infer<typeof candidateSchema> }> {
  candidateIdSchema.parse(id); const content = await vault.read(`90_system/candidates/${id}.md`);
  if (content === undefined) throw new Error('候補が見つかりません');
  const meta = candidateSchema.parse(parseMarkdown(content).meta);
  if (meta.id !== id) throw new Error('候補IDが一致しません');
  return { content, meta };
}
async function decisionAt(vault: Vault, candidateId: string): Promise<Decision | undefined> {
  return readKnowledgeDecision(vault,candidateId);
}
async function previousKnowledge(vault: Vault, id: string, replacement?: string): Promise<{ content: string; meta: Record<string, unknown>; text: string; path: string; target?: AdoptionTarget }> {
  knowledgeIdSchema.parse(id); const record=await readKnowledge(vault,id); const content = record?.raw;
  if (!content) throw new Error('置き換え元の知識が見つかりません');
  if (!isGeneratedIntact(content)) throw new Error('置き換え元の知識に手動変更があります');
  const { meta, text } = parseMarkdown(content);
  if (meta.id !== id || meta.verified !== true || !/^APR-[0-9A-HJKMNP-TV-Z]{26}$/.test(String(meta.approval_id))) throw new Error('置き換え元の承認記録が不正です');
  if (meta.superseded_by && meta.superseded_by !== replacement) throw new Error('置き換え元には既に後継があります');
  return { content, meta, text, path:record!.path, target:record!.target };
}

export async function propose(config: HubConfig, proposal: Proposal): Promise<{ candidateId: string; hash: string; path: string }> {
  const value = proposalSchema.parse(proposal); const vault = new Vault(config); const started = Date.now();
  const result = await vault.withLock(async () => {
    if (value.supersedes) await previousKnowledge(vault, value.supersedes);
    const id = `CAN-${ulid()}`; const relative = `90_system/candidates/${id}.md`; const now = new Date().toISOString();
    const content = generatedMarkdown({ schema_version: 1, id, ...value, input_ids: [], generated_by: { model: 'human-proposal', prompt_version: 1 }, generated_at: now, source: 'human-proposal', origin: 'user-note', verified: false }, `# 承認前の候補（利用者作成・未承認）\n\n${value.claim}\n\n理由: ${value.rationale || '不明'}\n`);
    if (!await vault.create(relative, content)) throw new Error('候補IDが競合しました');
    return { candidateId: id, hash: hash(content), path: relative };
  });
  if (!await logOperation(config, { op: 'propose', ms: Date.now() - started, counts: { processed: 1 } })) process.stderr.write('警告: 運用ログを書き込めませんでした。候補は保存済みです。\n');
  return result;
}

export async function listCandidates(config: HubConfig): Promise<string> {
  const {readReviewCandidates}=await import('./candidate-review.js');const lines:string[]=[];
  for(const item of await readReviewCandidates(config)){
    if(item.kind==='project'||item.status==='approved'||item.status==='rejected')continue;
    lines.push(`## ${item.id}\n種別: ${item.kind}\n主張: ${item.claim}\n理由: ${item.rationale||'不明'}\n出典: ${item.inputIds.join(', ')||'利用者の提案'}\nハッシュ: ${item.candidateHash}\n状態: ${item.status==='pending'?'未承認':'要確認'}\n${item.warnings.join(' ')}\n`);
  }
  return lines.join('\n') || '承認待ち候補はありません';
}

async function materializeKnowledge(vault: Vault, config: HubConfig, decision: Decision): Promise<string> {
  const candidate = parseMarkdown(decision.snapshot); const value = candidateSchema.parse(candidate.meta); const id = `KNW-${decision.candidate_id.slice(4)}`;
  const relative = knowledgePath(id,decision.target);
  const duplicate=await readKnowledge(vault,id);if(duplicate&&duplicate.path!==relative)throw new Error('知識IDの保存先が競合しています');
  const content = generatedMarkdown({ schema_version: 1, id, ...(decision.target?{scope:decision.target.scope,...(decision.target.scope==='project'?{project_id:decision.target.projectId,project_hash:decision.target.projectHash}:{})}:{}), kind: value.kind, input_ids: value.input_ids, generated_by: { model: 'human-approval', prompt_version: 1 }, generated_at: decision.decided_at, verified: true, approval_id: decision.id, approved_candidate: decision.candidate_id, approved_hash: decision.candidate_hash, approved_at: decision.decided_at, source: candidate.meta.source ?? 'human-proposal', origin: candidate.meta.origin ?? 'user-note', ...(value.supersedes ? { supersedes: value.supersedes } : {}) }, `# 人が承認した${value.kind === 'decision' ? '判断' : value.kind === 'preference' ? '好み' : '知識'}\n\n${value.claim}\n\n理由: ${value.rationale || '不明'}\n\n出典: ${value.input_ids.join(', ') || '利用者の提案'}\n元候補: [${decision.candidate_id}](${pathRelative(dirname(relative),`90_system/candidates/${decision.candidate_id}.md`)})\n承認: ${decision.id}\n承認日時: ${dateLabel(decision.decided_at, config.timezone)} ${config.timezone}\n\n承認は利用者の判断を記録します。AI自己申告の独立した実機検証を意味しません。\n`);
  const existing = await vault.read(relative);
  if (existing === undefined) { if (!await vault.create(relative, content)) throw new Error('知識の生成が競合しました'); }
  else {
    const parsed = parseMarkdown(existing);
    if (!isGeneratedIntact(existing) || parsed.meta.approval_id !== decision.id || parsed.meta.approved_hash !== decision.candidate_hash) throw new Error('承認済み知識に手動変更があります');
  }
  if (value.supersedes) {
    const previous = await previousKnowledge(vault, value.supersedes, id);
    if (previous.meta.superseded_by !== id) await vault.write(previous.path, generatedMarkdown({ ...previous.meta, superseded_by: id, superseded_at: decision.decided_at }, previous.text));
  }
  return id;
}

async function decide(config: HubConfig, id: string, expectedHash: string, action: 'approve' | 'reject', target?:AdoptionTarget): Promise<DecisionResult> {
  candidateIdSchema.parse(id);
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('候補のSHA-256ハッシュが必要です');
  if(action==='approve')adoptionTargetSchema.parse(target);
  const vault = new Vault(config); const started = Date.now();
  const result = await vault.withLock(async () => {
    let decision = await decisionAt(vault, id); const deduped = decision !== undefined;
    if (decision && (decision.action !== action || decision.candidate_hash !== expectedHash || !isDeepStrictEqual(decision.target,target))) throw new Error('この候補には異なる判断が記録済みです');
    if (!decision) {
      const candidate = await candidateAt(vault, id);
      if (hash(candidate.content) !== expectedHash) throw new Error('候補のハッシュが一致しません。内容を再確認してください');
      const state=await readKnowledgeCandidate(config,id);
      if(state.status!=='pending')throw new Error(state.warnings[0]??'候補を確認できません');
      if(state.candidateHash!==expectedHash)throw new Error('確認中に候補の内容が変わりました。再確認してください');
      for(const[path,want]of Object.entries(state.dependencies)){
        const bytes=await vault.readBytes(path,1_048_576),actual=bytes===undefined?null:hash(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
        if(actual!==want)throw new Error('確認中に根拠・承認記録が変わりました。再確認してください');
      }
      if(action==='approve'){
        await validateAdoptionTarget(vault,target!);
        await assertAdoptionCapacity(vault,{id:`KNW-${id.slice(4)}`,kind:candidate.meta.kind,claim:candidate.meta.claim,path:knowledgePath(`KNW-${id.slice(4)}`,target),target:target!,supersedes:candidate.meta.supersedes});
        if(candidate.meta.supersedes){const previous=await previousKnowledge(vault,candidate.meta.supersedes,`KNW-${id.slice(4)}`);if(!sameScope(previous.target,target))throw new Error('置き換え元と採用先の範囲が一致しません');}
      }
      decision = { schema_version: 1, id: `APR-${id.slice(4)}`, candidate_id: id, candidate_hash: expectedHash, action, actor: 'user', decided_at: new Date().toISOString(), snapshot: candidate.content, ...(target?{target}:{}) };
      // 先に承認済み内容のスナップショットを追記し、停止後も同じ判断から知識を復元する。
      if (!await vault.create(`90_system/approvals/${decision.id}.json`, `${JSON.stringify(decision, null, 2)}\n`)) throw new Error('承認記録が競合しました');
    }
    const knowledgeId=action==='approve'?await materializeKnowledge(vault,config,decision):undefined;
    await rebuildPoliciesLocked(config,vault);
    return { candidateId: id, approvalId: decision.id, ...(action === 'approve' ? { knowledgeId, ...(decision.target?{adoptedTarget:decision.target}:{}) } : {}), deduped };
  });
  if (!await logOperation(config, { op: action, ms: Date.now() - started, counts: { processed: Number(!result.deduped), deduped: Number(result.deduped) } })) process.stderr.write('警告: 運用ログを書き込めませんでした。判断は記録済みです。\n');
  return result;
}
export async function approve(config: HubConfig, id: string, expectedHash: string, target:AdoptionTarget): Promise<DecisionResult> { return decide(config, id, expectedHash, 'approve',target); }
export async function reject(config: HubConfig, id: string, expectedHash: string): Promise<DecisionResult> { return decide(config, id, expectedHash, 'reject'); }
export async function recoverKnowledgeApprovalsLocked(config:HubConfig,vault:Vault,limit:number,dryRun=false):Promise<number>{
 let recovered=0;
 for(const path of await vault.files('90_system/approvals')){
  const match=/^90_system\/approvals\/APR-([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);if(!match)continue;
  const decision=await readKnowledgeDecision(vault,`CAN-${match[1]}`);if(!decision||decision.action!=='approve')continue;
  const state=await readKnowledgeCandidate(config,decision.candidate_id);if(state.reflected)continue;
  if(recovered>=limit)break;
  if(!dryRun)await materializeKnowledge(vault,config,decision);recovered++;
 }return recovered;
}
