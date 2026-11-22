import { nowText } from './markdown-text.js';
import { z } from 'zod';
import { ulid } from 'ulid';
import { readInputs } from './capture.js';
import { readProjects, mergedSources, mergeTargets } from './projects.js';
import { organizeResultSchema } from './llm.js';
import { correctionNotice, effectiveFromInputs, groundedResult } from './effective-inputs.js';
import { applyAssociations } from './associations.js';
import { readCorrectionChains } from './corrections.js';
import { Vault, hash, markdown, parseMarkdown, readOncePerLock } from './storage.js';
import { activeResolutions, closedMergeWindows, withinMergeWindow, exclusionReasonLabels, itemKey, nowItemsPath, readItemResolutions, type ItemSection, type NowItem } from './item-resolutions.js';
import { effectiveSchedules, readItemSchedules, scheduleLabel } from './item-schedules.js';
import { evidenceBound, inputWhen } from './happened.js';
import { dismissalKey, readHintDismissals } from './resolution-hints.js';
import { appliedReread, readExclusionOverlays } from './item-rereads.js';
import { ACTION_LABEL, actionSource, sourceRef } from './actions.js';
import type { HubConfig, Input, Project, Receipt } from './types.js';

const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
export const receiptSchema = z.object({
  schema_version: z.literal(1), input_id: inputIdSchema, input_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(), status: z.enum(['organized', 'failed']), attempts: z.number().int().min(1), organized_at: z.string().datetime({ offset: true }),
  root_input_id: inputIdSchema.optional(), evidence_ids: z.array(inputIdSchema).max(33).optional(), evidence_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  project_registry_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  llm: z.object({ provider: z.string(), model: z.string(), prompt_version: z.number().int().min(1) }).strict(), result: organizeResultSchema.nullable(), writes: z.array(z.string()), error: z.string().nullable(),
}).strict().refine((receipt) => receipt.status === 'organized' ? receipt.result !== null && receipt.error === null : receipt.result === null && receipt.error !== null);

export async function readReceipts(config: HubConfig): Promise<Receipt[]> {
  return readOncePerLock(config, 'receipts', ['90_system/receipts'], () => loadReceipts(config));
}
async function loadReceipts(config: HubConfig): Promise<Receipt[]> {
  const vault = new Vault(config); const receipts: Receipt[] = [];
  for (const file of await vault.files('90_system/receipts')) {
    if (!/^90_system\/receipts\/IN-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(file)) continue;
    try {
      const receipt = await readOncePerLock(config, `receipt:${file}`, [file], async () => receiptSchema.parse(JSON.parse((await vault.read(file))!)));
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
/**
 * 人が書き換えた生成物の代わりに、新版を退避する。同じ対象の退避が既にあれば最新の1件を書き直し、
 * 再生成のたびに退避が増え続けないようにする（退避は派生物で、正本は入力と処理記録）。
 */
async function stashConflictLocked(vault: Vault, stem: string, content: string): Promise<string> {
  const escaped = stem.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const pattern = new RegExp('^90_system/conflicts/' + escaped + '\\.[0-9A-HJKMNP-TV-Z]{26}\\.md$');
  const latest = (await vault.files('90_system/conflicts')).filter(p => pattern.test(p)).sort().at(-1);
  if (latest) { await vault.write(latest, content); return latest; }
  const path = `90_system/conflicts/${stem}.${ulid()}.md`;
  if (!await vault.create(path, content)) throw new Error('退避ファイルが競合しました');
  return path;
}
export async function writeGeneratedLocked(vault: Vault, relative: string, content: string, frozen = false): Promise<{ path: string; conflict?: string }> {
  const existing = await vault.read(relative);
  if (existing !== undefined && (frozen || !isGeneratedIntact(existing))) return { path: relative, conflict: await stashConflictLocked(vault, relative.replaceAll('/', '.'), content) };
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
const plain = nowText;
export function dateLabel(iso: string, timezone: string): string { return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }

/** 最後に書いたNOWの自動領域。手で変えた行を求める基準。 */
export const nowBaselinePath = (projectId: string) => `90_system/now-generated/${projectId}.json`;
/**
 * NOWを根拠から作り直す。overwriteAutoは本人が「生成版に戻す」を確認した場合だけ使い、
 * 手で書き換えた自動領域を上書きする（自動領域の外の手動領域は保持する）。
 */
/** 入力と処理記録から、訂正・再関連付け・本人の「誤りとして外す」記録を反映した有効な解釈を組み立てる。 */
async function effectiveUnits(config: HubConfig, inputs: Input[], receipts: Receipt[], projects?: Project[]) {
  const chains=await readCorrectionChains(config), hashes=new Map(chains.map(c=>[c.root.id,c.evidenceHash]));
  return applyAssociations(config,effectiveFromInputs(inputs,receipts).map(e=>({...e,chain:{...e.chain,evidenceHash:hashes.get(e.chain.root.id)??''}})),projects);
}
/**
 * ある入力に関わるNOWをまとめて作り直す。誤りとして外す・それを戻す操作では、帰属の取り消しや読み直しの結果が
 * 効いたり外れたりして、操作したプロジェクト以外のNOWも変わるため。今その入力を載せているNOWと、今の帰属先を対象にする。
 */
export async function rebuildNowsForInputLocked(vault: Vault, config: HubConfig, projectIds: string[], inputId: string, alsoProject: string | undefined, inputs: Input[], receipts: Receipt[]): Promise<void> {
  const targets = new Set(alsoProject === undefined ? [] : [alsoProject]);
  for (const id of projectIds) {
    const raw = await vault.read(`10_projects/${id}/NOW.md`);
    if (raw) try { const { meta } = parseMarkdown(raw); if (Array.isArray(meta.input_ids) && meta.input_ids.includes(inputId)) targets.add(id); } catch { /* 手で壊したNOWは、作り直しのときに競合として退避する。 */ }
  }
  for (const unit of await effectiveUnits(config, inputs, receipts)) if (unit.chain.root.id === inputId && unit.receipt) for (const id of associatedProjects(unit.chain.root, unit.receipt, config)) targets.add(id);
  const generatedAt = new Date().toISOString();
  for (const id of projectIds) if (targets.has(id)) await rebuildNowLocked(vault, config, id, inputs, receipts, generatedAt);
}
export async function rebuildNowLocked(vault: Vault, config: HubConfig, projectId: string, inputs: Input[], receipts: Receipt[], generatedAt = new Date().toISOString(), options: { overwriteAuto?: boolean } = {}): Promise<{ path: string; conflict?: string }> {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(projectId)) throw new Error('プロジェクトIDが不正です');
  // 統合元のプロジェクトへの帰属は、applyAssociationsがこのプロジェクト（統合先）のものとして読み替える。
  const projects = await readProjects(config), sources = mergedSources(projects, projectId);
  const units = await effectiveUnits(config, inputs, receipts, projects);
  const evidence = units.flatMap((unit) => {
    const {chain,receipt}=unit, input=chain.root;
    return receipt?.result && associatedProjects(input,receipt,config).includes(projectId) ? [{input,result:groundedResult(chain,receipt.input_id,receipt.result),notice:correctionNotice(unit)}] : [];
  }).sort((left, right) => Date.parse(left.input.occurred_at) - Date.parse(right.input.occurred_at) || left.input.id.localeCompare(right.input.id));
  const summaries = evidence.filter(({ input }) => input.kind === 'work-summary'); const latest = summaries.at(-1);
  // 本人が直接追加した行動。モデルで整理しないため処理記録はなく、最新の文面（訂正があれば訂正）を本人の言葉のまま載せる。
  // 統合元のプロジェクトへ追加した行動も、統合先のNOWに載せる。新しい作業要約が届いても外さない。
  const actions = units.filter(u => u.chain.root.kind === 'action' && u.chain.root.project !== undefined && (u.chain.root.project === projectId || sources.includes(u.chain.root.project)))
    .sort((left, right) => Date.parse(left.chain.root.occurred_at) - Date.parse(right.chain.root.occurred_at) || left.chain.root.id.localeCompare(right.chain.root.id));
  // 行動にしたAIの読み取り（提案・作業要約の次の一手）は、元の欄に二重に並べない。どのプロジェクトで行動にしても同じ行は本人が引き取ったものとして扱う。
  const converted = new Set<string>(), convertedKeys = new Set<string>();
  for (const unit of units) { const from = actionSource(unit.chain.root); if (from) { converted.add(sourceRef(from.input_id, from.text)); if (from.key) convertedKeys.add(from.key); } }
  const notices = new Map([...evidence.map(e => [e.input.id, e.notice] as const), ...actions.map(u => [u.chain.root.id, correctionNotice(u)] as const)]), unitsById = new Map(units.map(u => [u.chain.root.id, u])), occurredAt = new Map(inputs.map(i => [i.id, i.occurred_at]));
  const ref = (input: Input): string => `[${input.id}](../../${input.path}) [${inputWhen(input, iso => `${dateLabel(iso, config.timezone)} ${config.timezone}`)} 出典:${plain(input.source)}${input.tool ? `/${plain(input.tool)}` : ''} ${input.kind === 'action' ? '本人が追加した行動' : input.origin === 'ai-self-report' ? 'AI自己申告/ai-self-report・未検証' : '利用者メモ・未検証'}${input.project === projectId ? '' : '・帰属候補'}]${notices.get(input.id) ? ' '+notices.get(input.id)!.replaceAll('](00_inbox/','](../../00_inbox/') : ''}`;
  const row = (text: string, input: Input, label = ''): string => `- ${label}${plain(text)} ${ref(input)}`;
  // 本人が完了・解決と報告した項目は該当欄から外し、「解決済み・完了」へ移す。項目一覧はアプリ・CLIからの報告の照合に使う。
  // AIの読み違いなどの「誤り」として外した項目も欄から外すが、完了・解決とは分けて理由と一緒に示す。
  const resolutionRecords = await readItemResolutions(vault), resolved = activeResolutions(resolutionRecords, projectId), items = new Map<string, NowItem>(), done: string[] = [], excluded: string[] = [];
  // 本人が付けた期日・見直す日は行の末尾に示す（出典より後ろに置き、項目との照合に使う行頭は変えない）。
  // 引き継ぎは項目がそろってから決まるため、行には項目キーの印を付けておき、最後に日付へ置き換える。
  const mark = '\u0000';
  const entry = (section: ItemSection, text: string, input: Input, label = ''): string[] => {
    const key = itemKey(projectId, section, input.id, text), resolution = resolved.get(key);
    if (!items.has(key)) {
      const wrong = resolution?.action === 'exclude' && resolution.reason ? { action: 'exclude' as const, reason: resolution.reason, ...(resolution.note ? { note: resolution.note } : {}) } : undefined;
      items.set(key, { key, section, label, text, input_id: input.id, resolution: resolution ? { id: resolution.id, at: resolution.created_at, source: resolution.source, ...wrong } : null, schedule: null });
      if (wrong) excluded.push(`- ${label || (section === 'next' ? '次の一手: ' : '未解決: ')}${plain(text)} ${ref(input)} — 理由: ${exclusionReasonLabels[wrong.reason]}${wrong.note ? `（${plain(wrong.note)}）` : ''} / 本人報告 ${dateLabel(resolution!.created_at, config.timezone)} ${resolution!.id}`);
      else if (resolution) done.push(`- ${section === 'next' ? '完了' : '解決'}: ${label}${plain(text)} ${ref(input)} — 本人報告 ${dateLabel(resolution.created_at, config.timezone)} ${resolution.id}`);
    }
    return resolution ? [] : [`${row(text, input, label)}${mark}${key}`];
  };
  const current = latest?.result.extracted.current.filter((item) => item.status === 'confirmed').map((item) => row(item.text, latest.input)) ?? [];
  // 本人が追加した行動を先に、作業要約の次の一手を後に並べる。
  const own = actions.flatMap(unit => {
    const root = unit.chain.root, text = unit.chain.latest.text, rows = entry('next', text, root, ACTION_LABEL), item = items.get(itemKey(projectId, 'next', root.id, text));
    const from = actionSource(root);
    if (item) item.action = from ? { from } : {};
    return rows;
  });
  const taken = (input: Input, text: string, section?: ItemSection) => converted.has(sourceRef(input.id, text)) || (section !== undefined && convertedKeys.has(itemKey(projectId, section, input.id, text)));
  const next = [...own, ...(latest?.result.extracted.next.filter((item) => item.status === 'confirmed' && !taken(latest.input, item.text, 'next')).flatMap((item) => entry('next', item.text, latest.input)) ?? [])];
  const proposals: string[] = []; const open: string[] = [];
  const propose = (text: string, input: Input, label: string) => { if (!taken(input, text)) proposals.push(row(text, input, label)); };
  for (const item of evidence) {
    const { input, result } = item;
    if (result.category === 'task' && input.kind === 'memo' && (!latest || Date.parse(input.occurred_at) > Date.parse(latest.input.occurred_at))) propose(result.summary, input, '分類候補task・要確認: ');
    if (result.category === 'question') open.push(...entry('open', result.summary, input));
    for (const suggestion of result.next_action_suggestions) propose(suggestion, input, 'AI提案: ');
    for (const value of [...result.extracted.current, ...result.extracted.next]) {
      if (value.status === 'proposal') propose(value.text, input, '提案: ');
      if (value.status === 'unverified') open.push(...entry('open', value.text, input, '未確認: '));
    }
    for (const value of result.extracted.open) open.push(...entry('open', value.text, input, value.status === 'proposal' ? '提案・判断待ち: ' : '未解決: '));
  }
  if (latest) {
    const latestTexts = new Set(latest.result.extracted.current.filter((item) => item.status === 'confirmed').map((item) => item.text));
    for (const old of summaries.slice(0, -1)) for (const item of old.result.extracted.current) {
      if (item.status === 'confirmed' && !latestTexts.has(item.text)) open.push(...entry('open', item.text, old.input, '過去の報告との差異（矛盾・時点差は未確認）: '));
    }
  }
  // 外した後にNOWの根拠から消えた項目も、戻せるように一覧へ残す。「別のプロジェクトの話」としてメモごとこのプロジェクトから外れた場合、
  // 読み直しで項目の本文が変わった場合、読み直した項目をさらに外して次の読み直しを待っている場合、訂正の整理で項目が変わった場合が当たる。
  // 新しい作業要約に置き換わって自然に外れた次の一手は載せない（完了・解決の報告と同じ）。
  const overlays = await readExclusionOverlays(vault);
  for (const r of resolved.values()) {
    if (r.action !== 'exclude' || !r.reason || items.has(r.item_key)) continue;
    const unit = unitsById.get(r.input_id), input = unit?.chain.root;
    // 行動は文面を直すと別の項目になり、直した後の行動として欄に戻る（外した記録は直す前の文面のもの）。
    if (!unit || !input || input.kind === 'action') continue;
    const detached = input.project !== projectId && overlays.wrongProjects.get(input.id)?.has(projectId) === true;
    if (!detached && r.section === 'next' && latest && latest.input.id !== input.id) continue;
    const reread = appliedReread(overlays, unit)?.resolution_ids.includes(r.id);
    items.set(r.item_key, { key: r.item_key, section: r.section, label: '', text: r.text, input_id: r.input_id, resolution: { id: r.id, at: r.created_at, source: r.source, action: 'exclude', reason: r.reason, ...(r.note ? { note: r.note } : {}) }, schedule: null });
    excluded.push(`- ${r.section === 'next' ? '次の一手: ' : '未解決: '}${plain(r.text)} ${ref(input)} — 理由: ${exclusionReasonLabels[r.reason]}${r.note ? `（${plain(r.note)}）` : ''} / 本人報告 ${dateLabel(r.created_at, config.timezone)} ${r.id}${detached ? ' / このメモはこのプロジェクトから外しています' : reread ? ' / メモを読み直しました' : ' / いまの整理結果にはない項目です'}`);
  }
  const scheduled = effectiveSchedules((await readItemSchedules(vault)).records, projectId, [...items.values()], resolved).byKey;
  for (const item of items.values()) { const s = scheduled.get(item.key); if (s) item.schedule = { id: s.id, due: s.due, review_after: s.review_after, ...(s.repeat ? { repeat: s.repeat } : {}) }; }
  const dated = (rows: string[]) => rows.map(r => r.replace(new RegExp(`${mark}([a-f0-9]{64})$`), (_, key: string) => { const s = scheduled.get(key); return s ? ` — ${scheduleLabel(s)}` : ''; }));
  next.splice(0, next.length, ...dated(next)); open.splice(0, open.length, ...dated(open));
  // 「片付いたかも」: 本人がこのプロジェクトを指定したメモの整理で、AIが示した既存項目。片付いていない項目にだけ付け、
  // 訂正が未反映のメモ・本人が「違う」と見送った組・最後の「未解決に戻す」より前の整理からは示さない。
  // 統合元で整理・見送りしたときの項目キーは統合元のIDで作られているため、同じ項目のこのプロジェクトでのキーへ対応付ける。
  // 統合を取り消した後は、統合していた間に統合先で見送った組も、このプロジェクトの見送りとして読む（完了報告・日付の読み替えと同じ期間）。
  const windows = await closedMergeWindows(vault, mergeTargets(projects)), owners = [projectId, ...sources];
  const formerInto = [...windows.values()].flat().filter(w => owners.includes(w.from));
  const alias = new Map<string, string>();
  for (const item of items.values()) for (const other of [...sources, ...new Set(formerInto.map(w => w.into))]) alias.set(itemKey(other, item.section, item.input_id, item.text), item.key);
  const dismissed = new Set((await readHintDismissals(vault)).filter(d => d.project_id === projectId || sources.includes(d.project_id) || formerInto.some(w => w.into === d.project_id && withinMergeWindow(windows, w.into, w.from, d.created_at))).map(d => dismissalKey(projectId, alias.get(d.item_key) ?? d.item_key, d.input_id)));
  const reopenedAt = new Map<string, number>();
  for (const r of resolutionRecords) if (r.project_id === projectId && r.action === 'reopen') reopenedAt.set(r.item_key, Math.max(reopenedAt.get(r.item_key) ?? 0, Date.parse(r.created_at)));
  const hinted: { item: NowItem; input: Input; quote: string }[] = [];
  for (const unit of units) {
    const { chain, receipt } = unit;
    if (chain.root.project !== projectId || unit.pendingCorrection || receipt?.status !== 'organized' || receipt.input_id !== chain.latest.id) continue;
    for (const hint of receipt.result?.resolution_hints ?? []) {
      const item = items.get(hint.item_key) ?? items.get(alias.get(hint.item_key) ?? '');
      if (!item || item.resolution || item.input_id === chain.root.id || dismissed.has(dismissalKey(projectId, item.key, chain.root.id))) continue;
      // このメモより後の根拠で改めて挙がった項目は、このメモでは片付いていない。
      if (evidenceBound(chain.root) < Date.parse(occurredAt.get(item.input_id) ?? chain.root.occurred_at)) continue;
      if (Date.parse(receipt.organized_at) <= (reopenedAt.get(item.key) ?? Number.NEGATIVE_INFINITY)) continue;
      if ((item.hints ??= []).some(h => h.input_id === chain.root.id) || item.hints.length >= 20) continue;
      item.hints.push({ input_id: chain.root.id, quote: hint.quote, at: receipt.organized_at });
      hinted.push({ item, input: chain.root, quote: hint.quote });
    }
  }
  for (const item of items.values()) if (item.hints && !item.hints.length) delete item.hints;
  hinted.sort((a, b) => Date.parse(b.input.occurred_at) - Date.parse(a.input.occurred_at) || a.input.id.localeCompare(b.input.id));
  const hintRows = hinted.map(({ item, input, quote }) => `- ${item.label || (item.section === 'next' ? '次の一手: ' : '未解決: ')}${plain(item.text)} ← 「${plain(quote)}」 ${ref(input)}`);
  const fallback = '- 不明（根拠となる入力がありません）';
  // 欄が空になった理由。誤りとして外した項目だけで空になったときは、完了・解決と書かない。
  const closedNote = (section: ItemSection, reported: string) => [...items.values()].some(i => i.section === section && i.resolution && i.resolution.action !== 'exclude') ? reported : '誤りとして外した項目のみ';
  const auto = `\n# 現在地\n${current.join('\n') || fallback}\n\n# 次の一手\n${next.join('\n') || ((latest || actions.length) && [...items.values()].some(i => i.section === 'next') ? `- 残っている次の一手はありません（${closedNote('next', '完了報告済み')}）` : fallback)}\n\n## 提案\n${[...new Set(proposals)].join('\n') || '- 提案はありません'}\n\n# 未解決\n${[...new Set(open)].join('\n') || ([...items.values()].some(i => i.section === 'open') ? `- 残っている未解決はありません（${closedNote('open', '解決報告済み')}）` : '- 不明（未解決事項の確認が必要です）')}\n${hintRows.length ? `\n# 片付いたかも（AI推定・本人の確認待ち）\nメモの記述から、片付いた可能性がある項目です。AIの推定で、まだ完了・解決にはしていません。アプリで確認するか、\`ctx item list\`でキーを確かめて\`ctx item resolve\`（違う場合は\`ctx item dismiss-hint\`）を使ってください。\n${hintRows.join('\n')}\n` : ''}${done.length ? `\n# 解決済み・完了（本人報告）\n${done.join('\n')}\n` : ''}${excluded.length ? `\n# 誤りとして外した項目（本人報告）\nAIの読み違いなどとして、本人が外した項目です。完了・解決ではありません。理由と一言は、次からの整理でAIへ渡します。戻すときはアプリか\`ctx item reopen\`を使ってください。\n${excluded.join('\n')}\n` : ''}`;
  // 項目一覧はNOWの手動編集と無関係に、常に最新の整理結果から書き直す。
  await vault.write(nowItemsPath(projectId), JSON.stringify({ schema_version: 1, project: projectId, generated_at: generatedAt, items: [...items.values()] }, null, 2) + '\n');
  // NOWは書く直前に読み、手編集の有無を判定する（読んでから書くまでの間に同期で届いた手編集を上書きしにくくする）。
  const relative = `10_projects/${projectId}/NOW.md`; const existing = await vault.read(relative);
  let before = '（手動領域: この領域は再生成しても保持されます）\n\n'; let after = '\n'; let oldMeta: Record<string, unknown> = {}; let conflict = false;
  if (existing !== undefined) {
    try {
      const parsed = parseMarkdown(existing); const region = autoRegion(parsed.text); oldMeta = parsed.meta;
      if (!region) conflict = true;
      else { before = region.before; after = region.after; conflict = parsed.meta.generated_hash !== `sha256:${hash(region.auto)}`; }
    } catch { conflict = true; }
    if (options.overwriteAuto) conflict = false;
  }
  const meta = { ...oldMeta, schema_version: 1, project: projectId, generated_by: { model: 'deterministic-writer', prompt_version: 1 }, generated_at: generatedAt, last_evidence_at: [...evidence.map(e => e.input.occurred_at), ...actions.map(u => u.chain.root.occurred_at)].sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null, input_ids: [...evidence.map(({ input }) => input.id), ...actions.map(u => u.chain.root.id)], verified: false, generated_hash: `sha256:${hash(auto)}` };
  const content = markdown(meta, `${before}${autoStart}${auto}${autoEnd}${after}`);
  if (conflict) return { path: relative, conflict: await stashConflictLocked(vault, `NOW.${projectId}`, content) };
  await vault.write(relative, content);
  // 手で書き換えられたときに「どこを変えたか」を示せるよう、書いた自動領域を基準として残す（NOW.mdのgenerated_hashと対応）。
  await vault.write(nowBaselinePath(projectId), JSON.stringify({ schema_version: 1, project: projectId, generated_hash: meta.generated_hash, auto }) + '\n');
  return { path: relative };
}

/** NOW.mdの最終根拠日時。未生成・解析不能なら未定（HOME・ふりかえり・作業記録の下書きで共通）。 */
export async function lastEvidenceAt(vault: Vault, projectId: string): Promise<string | undefined> {
  const raw = await vault.read(`10_projects/${projectId}/NOW.md`); if (raw === undefined) return undefined;
  try { const value = parseMarkdown(raw).meta.last_evidence_at; return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined; } catch { return undefined; }
}

export async function rebuildNow(config: HubConfig, projectId: string): Promise<{ path: string; conflict?: string }> {
  const vault = new Vault(config);
  return vault.withLock(async () => {
    if (!(await readProjects(config)).some((project) => project.id === projectId)) throw new Error('プロジェクトが見つかりません');
    return rebuildNowLocked(vault, config, projectId, await readInputs(config), await readReceipts(config));
  });
}
