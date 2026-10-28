import { z } from 'zod';
import { ulid } from 'ulid';
import { readInputs } from './capture.js';
import { readProjects } from './projects.js';
import { groundExtractedStatuses, organizeResultSchema } from './llm.js';
import { groundExtractedHistory } from './llm.js';
import { correctionNotice, effectiveFromInputs } from './effective-inputs.js';
import { applyAssociations } from './associations.js';
import { readCorrectionChains } from './corrections.js';
import { Vault, hash, markdown, parseMarkdown } from './storage.js';
import type { HubConfig, Input, Receipt } from './types.js';

const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
export const receiptSchema = z.object({
  schema_version: z.literal(1), input_id: inputIdSchema, input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(), status: z.enum(['organized', 'failed']), attempts: z.number().int().min(1), organized_at: z.string().datetime({ offset: true }),
  root_input_id: inputIdSchema.optional(), evidence_ids: z.array(inputIdSchema).max(33).optional(), evidence_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  project_registry_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  llm: z.object({ provider: z.string(), model: z.string(), prompt_version: z.number().int().min(1) }).strict(), result: organizeResultSchema.nullable(), writes: z.array(z.string()), error: z.string().nullable(),
}).strict().refine((receipt) => receipt.status === 'organized' ? receipt.result !== null && receipt.error === null : receipt.result === null && receipt.error !== null);

export async function readReceipts(config: HubConfig): Promise<Receipt[]> {
  const vault = new Vault(config); const receipts: Receipt[] = [];
  for (const file of await vault.files('90_system/receipts')) {
    if (!/^90_system\/receipts\/IN-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(file)) continue;
    try {
      const receipt = receiptSchema.parse(JSON.parse((await vault.read(file))!));
      if (file !== `90_system/receipts/${receipt.input_id}.json`) throw new Error();
      receipts.push(receipt);
    } catch { throw new Error(`処理記録が不正です: ${file}`); }
  }
  return receipts;
}

// NOW以外の生成物は本文とfrontmatterの両方を保護する。
export function generatedMarkdown(meta: Record<string, unknown>, text: string): string {
  const { generated_hash: _unused, ...contentMeta } = meta;
  return markdown({ ...contentMeta, generated_hash: `sha256:${hash(markdown(contentMeta, text))}` }, text);
}
export function isGeneratedIntact(content: string): boolean {
  try {
    const parsed = parseMarkdown(content); const { generated_hash: expected, ...meta } = parsed.meta;
    return expected === `sha256:${hash(markdown(meta, parsed.text))}`;
  } catch { return false; }
}
export async function writeGeneratedLocked(vault: Vault, relative: string, content: string, frozen = false): Promise<{ path: string; conflict?: string }> {
  const existing = await vault.read(relative);
  if (existing !== undefined && (frozen || !isGeneratedIntact(existing))) {
    const conflict = `90_system/conflicts/${relative.replaceAll('/', '.')}.${ulid()}.md`;
    if (!await vault.create(conflict, content)) throw new Error('退避ファイルが競合しました');
    return { path: relative, conflict };
  }
  await vault.write(relative, content); return { path: relative };
}

export function associatedProjects(input: Input, receipt: Receipt, config: HubConfig): string[] {
  return [...new Set([...(input.project ? [input.project] : []), ...(receipt.result?.project_candidates.filter((candidate) => candidate.confidence >= config.organize.projectThreshold).map((candidate) => candidate.id) ?? [])])];
}
export const autoStart = '<!-- ctx:auto:start -->';
export const autoEnd = '<!-- ctx:auto:end -->';
export function autoRegion(text: string): { before: string; auto: string; after: string } | undefined {
  const start = text.indexOf(autoStart); const end = text.indexOf(autoEnd);
  if (start < 0 || end <= start || text.indexOf(autoStart, start + autoStart.length) >= 0 || text.indexOf(autoEnd, end + autoEnd.length) >= 0) return undefined;
  return { before: text.slice(0, start), auto: text.slice(start + autoStart.length, end), after: text.slice(end + autoEnd.length) };
}
function plain(text: string): string { return text.replace(/[\r\n]+/g, ' ').replaceAll('<!--', '&lt;!--'); }
export function dateLabel(iso: string, timezone: string): string { return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }

export async function rebuildNowLocked(vault: Vault, config: HubConfig, projectId: string, inputs: Input[], receipts: Receipt[], generatedAt = new Date().toISOString()): Promise<{ path: string; conflict?: string }> {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(projectId)) throw new Error('プロジェクトIDが不正です');
  const chains=await readCorrectionChains(config), hashes=new Map(chains.map(c=>[c.root.id,c.evidenceHash]));
  const units = await applyAssociations(config,effectiveFromInputs(inputs,receipts).map(e=>({...e,chain:{...e.chain,evidenceHash:hashes.get(e.chain.root.id)??''}})));
  const evidence = units.flatMap((unit) => {
    const {chain,receipt}=unit, input=chain.root;
    const index=[chain.root,...chain.revisions].findIndex(i=>i.id===receipt?.input_id);
    const bound={...chain,revisions:chain.revisions.slice(0,Math.max(0,index)),latest:receipt?.input_id===input.id?input:chain.revisions[index-1]??input};
    return receipt?.result && associatedProjects(input,receipt,config).includes(projectId) ? [{input,result:chain.revisions.length?groundExtractedHistory(bound,receipt.result):groundExtractedStatuses(input,receipt.result),notice:correctionNotice(unit)}] : [];
  }).sort((left, right) => Date.parse(left.input.occurred_at) - Date.parse(right.input.occurred_at) || left.input.id.localeCompare(right.input.id));
  const summaries = evidence.filter(({ input }) => input.kind === 'work-summary'); const latest = summaries.at(-1);
  const ref = (input: Input): string => `[${input.id}](../../${input.path}) [${dateLabel(input.occurred_at, config.timezone)} ${config.timezone} 出典:${plain(input.source)}${input.tool ? `/${plain(input.tool)}` : ''} ${input.origin === 'ai-self-report' ? 'AI自己申告/ai-self-report・未検証' : '利用者メモ・未検証'}${input.project === projectId ? '' : '・帰属候補'}]${evidence.find(e=>e.input.id===input.id)?.notice ? ' '+evidence.find(e=>e.input.id===input.id)!.notice.replaceAll('](00_inbox/','](../../00_inbox/') : ''}`;
  const row = (text: string, input: Input, label = ''): string => `- ${label}${plain(text)} ${ref(input)}`;
  const current = latest?.result.extracted.current.filter((item) => item.status === 'confirmed').map((item) => row(item.text, latest.input)) ?? [];
  const next = latest?.result.extracted.next.filter((item) => item.status === 'confirmed').map((item) => row(item.text, latest.input)) ?? [];
  const proposals: string[] = []; const open: string[] = [];
  for (const item of evidence) {
    const { input, result } = item;
    if (result.category === 'task' && input.kind === 'memo' && (!latest || Date.parse(input.occurred_at) > Date.parse(latest.input.occurred_at))) proposals.push(row(result.summary, input, '分類候補task・要確認: '));
    if (result.category === 'question') open.push(row(result.summary, input));
    for (const suggestion of result.next_action_suggestions) proposals.push(row(suggestion, input, 'AI提案: '));
    for (const value of [...result.extracted.current, ...result.extracted.next]) {
      if (value.status === 'proposal') proposals.push(row(value.text, input, '提案: '));
      if (value.status === 'unverified') open.push(row(value.text, input, '未確認: '));
    }
    for (const value of result.extracted.open) open.push(row(value.text, input, value.status === 'proposal' ? '提案・判断待ち: ' : '未解決: '));
  }
  if (latest) {
    const latestTexts = new Set(latest.result.extracted.current.filter((item) => item.status === 'confirmed').map((item) => item.text));
    for (const old of summaries.slice(0, -1)) for (const item of old.result.extracted.current) {
      if (item.status === 'confirmed' && !latestTexts.has(item.text)) open.push(row(item.text, old.input, '過去の報告との差異（矛盾・時点差は未確認）: '));
    }
  }
  const fallback = '- 不明（根拠となる入力がありません）';
  const auto = `\n# 現在地\n${current.join('\n') || fallback}\n\n# 次の一手\n${next.join('\n') || fallback}\n\n## 提案\n${[...new Set(proposals)].join('\n') || '- 提案はありません'}\n\n# 未解決\n${[...new Set(open)].join('\n') || '- 不明（未解決事項の確認が必要です）'}\n`;
  const relative = `10_projects/${projectId}/NOW.md`; const existing = await vault.read(relative);
  let before = '（手動領域: この領域は再生成しても保持されます）\n\n'; let after = '\n'; let oldMeta: Record<string, unknown> = {}; let conflict = false;
  if (existing !== undefined) {
    try {
      const parsed = parseMarkdown(existing); const region = autoRegion(parsed.text); oldMeta = parsed.meta;
      if (!region) conflict = true;
      else { before = region.before; after = region.after; conflict = parsed.meta.generated_hash !== `sha256:${hash(region.auto)}`; }
    } catch { conflict = true; }
  }
  const meta = { ...oldMeta, schema_version: 1, project: projectId, generated_by: { model: 'deterministic-writer', prompt_version: 1 }, generated_at: generatedAt, last_evidence_at: evidence.at(-1)?.input.occurred_at ?? null, input_ids: evidence.map(({ input }) => input.id), verified: false, generated_hash: `sha256:${hash(auto)}` };
  const content = markdown(meta, `${before}${autoStart}${auto}${autoEnd}${after}`);
  if (conflict) {
    const conflictPath = `90_system/conflicts/NOW.${projectId}.${ulid()}.md`;
    if (!await vault.create(conflictPath, content)) throw new Error('NOWの退避ファイルが競合しました');
    return { path: relative, conflict: conflictPath };
  }
  await vault.write(relative, content); return { path: relative };
}

export async function rebuildNow(config: HubConfig, projectId: string): Promise<{ path: string; conflict?: string }> {
  const vault = new Vault(config);
  return vault.withLock(async () => {
    if (!(await readProjects(config)).some((project) => project.id === projectId)) throw new Error('プロジェクトが見つかりません');
    return rebuildNowLocked(vault, config, projectId, await readInputs(config), await readReceipts(config));
  });
}
