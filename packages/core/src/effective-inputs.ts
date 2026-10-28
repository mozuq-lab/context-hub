import { readCorrectionChains, type CorrectionChain } from './corrections.js';
import { readReceipts } from './views.js';
import { hash, Vault } from './storage.js';
import { applyAssociations } from './associations.js';
import type { HubConfig, Input, Receipt } from './types.js';
export interface EffectiveInput { chain: CorrectionChain; receipt?: Receipt; pendingCorrection: boolean }
export function effectiveFromChains(chains: CorrectionChain[], receipts: Receipt[]): EffectiveInput[] {
  const byId = new Map(receipts.map(r => [r.input_id,r]));
  return chains.map(chain => {
    const receipt = [chain.root,...chain.revisions].map(i => byId.get(i.id)).filter((r):r is Receipt => r?.status === 'organized').at(-1);
    return { chain,receipt,pendingCorrection:chain.revisions.length > 0 && receipt?.input_id !== chain.latest.id };
  });
}
// Writerへ渡された同じスナップショットから有効解釈を選ぶ。
export function effectiveFromInputs(inputs: Input[], receipts: Receipt[]): EffectiveInput[] {
  const children = new Map(inputs.filter(i => i.corrects_input_id).map(i => [i.corrects_input_id!,i]));
  const chains = inputs.filter(i => i.kind !== 'correction').map(root => {
    const revisions: Input[] = []; let latest = root; const seen = new Set([root.id]);
    while (children.has(latest.id)) { latest = children.get(latest.id)!; if (seen.has(latest.id)) throw new Error('訂正履歴が循環しています'); seen.add(latest.id); revisions.push(latest); }
    return { root,revisions,latest,evidenceHash:'' };
  });
  return effectiveFromChains(chains,receipts);
}
export async function readEffectiveInputs(config: HubConfig): Promise<EffectiveInput[]> {
  const chains = await readCorrectionChains(config), receipts = await readReceipts(config), vault = new Vault(config);
  const result = effectiveFromChains(chains,receipts);
  for (const {chain,receipt} of result) {
    if (!receipt) continue;
    const evidence = [chain.root,...chain.revisions], index = evidence.findIndex(i => i.id === receipt.input_id), input = evidence[index];
    const raw = await vault.read(input.path);
    if (receipt.input_hash && (raw === undefined || hash(raw) !== receipt.input_hash)) throw new Error('有効解釈の原文ハッシュが一致しません');
    if (index > 0) {
      const subset = evidence.slice(0,index+1), parts:string[]=[];
      for (const input of subset) { const raw = await vault.read(input.path); if (raw === undefined) throw new Error('訂正根拠がありません'); parts.push(`${input.id}:${hash(raw)}`); }
      if (receipt.root_input_id !== chain.root.id || JSON.stringify(receipt.evidence_ids) !== JSON.stringify(subset.map(i=>i.id)) || receipt.evidence_hash !== hash(parts.join('\n'))) throw new Error('訂正解釈と根拠が一致しません');
    }
  }
  return applyAssociations(config,result);
}
export function correctionNotice(effective: EffectiveInput): string {
  const {chain,pendingCorrection} = effective;
  return chain.revisions.length ? `${pendingCorrection ? '訂正未反映（旧解釈を表示・最新とは限りません）' : '訂正反映済み'}: ${[chain.root,...chain.revisions].map(i=>`[${i.id}](${i.path})（出典:${i.source.replace(/[\r\n]/g,' ')} / ${i.occurred_at}）`).join(' → ')}` : '';
}
