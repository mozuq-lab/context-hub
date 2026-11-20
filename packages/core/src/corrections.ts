import { ulid } from 'ulid';
import { eventMarker, inputIdSchema, inputSchema, readInputRecords, readInputs } from './capture.js';
import { Vault, hash, markdown, parseMarkdown, readOncePerLock } from './storage.js';
import { readProjects } from './projects.js';
import { actionTextSchema } from './actions.js';
import { readReceipts,rebuildNowLocked } from './views.js';
import type { CaptureRequest, CaptureResult, HubConfig, Input } from './types.js';

export type CorrectionRequest = Omit<CaptureRequest, 'kind' | 'project' | 'tool'>;
export type CorrectionTargetReason = { code:'stale-correction-target'; latest_input_id:string } | { code:'missing-correction-target' };
export class CorrectionTargetError extends Error {
  constructor(readonly reason:CorrectionTargetReason) {
    super(reason.code==='stale-correction-target'?'訂正対象が古くなっています。最新の訂正IDを指定してください':'訂正対象がありません');
    this.name='CorrectionTargetError';
    if(reason.code==='stale-correction-target')inputIdSchema.parse(reason.latest_input_id);
  }
}
export interface CorrectionChain { root: Input; revisions: Input[]; latest: Input; evidenceHash: string }
export async function readCorrectionChains(config: HubConfig): Promise<CorrectionChain[]> {
  return readOncePerLock(config, 'correction-chains', ['00_inbox'], () => buildCorrectionChains(config));
}
async function buildCorrectionChains(config: HubConfig): Promise<CorrectionChain[]> {
  // 根拠のハッシュは、解釈したのと同じ読み取りの原文から求める（同じファイルを2回読まない）。
  const records = await readInputRecords(config), inputs = records.map(r => r.input), rawHashes = new Map(records.map(r => [r.input.id, r.rawHash]));
  const byId = new Map(inputs.map(i => [i.id, i])), children = new Map<string, Input>();
  if (byId.size !== inputs.length) throw new Error('入力IDが重複しています');
  for (const input of inputs.filter(i => i.kind === 'correction')) {
    const target = input.corrects_input_id!;
    if (!byId.has(target) || children.has(target) || target === input.id) throw new Error('訂正履歴に参照不明・分岐があります');
    children.set(target,input);
  }
  const seen = new Set<string>(), chains: CorrectionChain[] = [];
  for (const root of inputs.filter(i => i.kind !== 'correction')) {
    const revisions: Input[] = []; let latest = root;
    while (children.has(latest.id)) { latest = children.get(latest.id)!; if (seen.has(latest.id)) throw new Error('訂正履歴が循環しています'); seen.add(latest.id); revisions.push(latest); }
    if (revisions.length > 32 || [root,...revisions].reduce((n,i) => n+i.text.length,0) > config.capture.maxInputChars*4) throw new Error('訂正履歴が上限を超えています');
    const evidence = [root,...revisions].map(input => `${input.id}:${rawHashes.get(input.id)!}`);
    chains.push({ root,revisions,latest,evidenceHash:hash(evidence.join('\n')) });
  }
  if (seen.size !== inputs.filter(i => i.kind === 'correction').length) throw new Error('訂正履歴が循環しています');
  return chains;
}
export async function correctInput(config: HubConfig, targetId: string, request: CorrectionRequest): Promise<CaptureResult> {
  inputIdSchema.parse(targetId);
  if (!request.text?.trim() || request.text.length > config.capture.maxInputChars) throw new Error('訂正文が空か上限を超えています');
  const vault = new Vault(config);
  return vault.withLock(async () => {
    const chains = await readCorrectionChains(config), inputs = chains.flatMap(c => [c.root,...c.revisions]);
    const event = request.sourceEventId ? inputs.find(i => i.source === request.source && i.source_event_id === request.sourceEventId) : undefined;
    if (event && (event.kind !== 'correction' || event.corrects_input_id !== targetId || event.text !== request.text)) throw new Error('訂正イベントと内容が一致しません');
    // 受付IDが一致しない同じ本文の訂正は、それが今も最新の訂正である間だけ再送と見なす。
    // 後に訂正が続いていれば、古い対象への新しい訂正として下の検査で拒否する（古い本文へ黙って戻さない）。
    const latestIds = new Set(chains.map(c => c.latest.id));
    const previous = event ?? inputs.find(i => i.kind === 'correction' && i.corrects_input_id === targetId && i.text === request.text && latestIds.has(i.id));
    const refreshNow=async(root:Input)=>{
      const current=await readInputs(config),receipts=await readReceipts(config);
      for(const project of await readProjects(config)){
        const raw=await vault.read(`10_projects/${project.id}/NOW.md`);let referenced=false;
        if(raw)try{const{meta}=parseMarkdown(raw);referenced=Array.isArray(meta.input_ids)&&meta.input_ids.includes(root.id);}catch{ /* 手動変更はWriterの競合保護で扱う。 */ }
        if(root.project===project.id||referenced)await rebuildNowLocked(vault,config,project.id,current,receipts);
      }
    };
    if (previous) {
      const marker = eventMarker(previous.source,previous.source_event_id), raw = await vault.read(marker);
      if (raw !== undefined && raw.trim() !== previous.id) throw new Error('訂正イベント記録が一致しません');
      if (raw === undefined) await vault.create(marker,`${previous.id}\n`);
      await refreshNow(chains.find(c=>[c.root,...c.revisions].some(i=>i.id===previous.id))!.root);
      return { inputId:previous.id,path:previous.path,receivedAt:previous.received_at,deduped:true };
    }
    const chain = chains.find(c => [c.root,...c.revisions].some(i => i.id === targetId));
    if (!chain) throw new CorrectionTargetError({code:'missing-correction-target'});
    if (chain.latest.id !== targetId) throw new CorrectionTargetError({code:'stale-correction-target',latest_input_id:chain.latest.id});
    // 行動の文面を直すときも、行動と同じく1行・200文字以内にする（元の文面は元の入力に残る）。
    if (chain.root.kind === 'action') { const text = actionTextSchema.safeParse(request.text); if (!text.success) throw new Error(text.error.issues[0]?.message ?? '行動の文面が不正です'); }
    if (chain.revisions.length >= 32 || [chain.root,...chain.revisions].reduce((n,i) => n+i.text.length,request.text.length) > config.capture.maxInputChars*4) throw new Error('訂正履歴の上限を超えています');
    const meta = inputSchema.omit({ text:true,path:true }).parse({ schema_version:1,id:`IN-${ulid()}`,kind:'correction',corrects_input_id:targetId,source:request.source,source_event_id:request.sourceEventId??ulid(),occurred_at:request.occurredAt,received_at:request.receivedAt??new Date().toISOString(),origin:chain.root.origin,tool:chain.root.tool,meta:request.meta });
    const marker = eventMarker(meta.source,meta.source_event_id);
    if (await vault.read(marker) !== undefined) throw new Error('訂正イベント記録に原文がありません');
    const date = new Intl.DateTimeFormat('sv-SE',{ timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(meta.occurred_at));
    const path = `00_inbox/${date}_${meta.id}.md`;
    if (!await vault.create(path,markdown(meta,request.text))) throw new Error('訂正IDが競合しました');
    if (!await vault.create(marker,`${meta.id}\n`)) throw new Error('訂正イベントが競合しました。再送してください');
    await refreshNow(chain.root);
    return { inputId:meta.id,path,receivedAt:meta.received_at,deduped:false };
  });
}
