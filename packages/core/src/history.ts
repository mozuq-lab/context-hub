import { clipText, listText } from './markdown-text.js';
import { z } from 'zod';
import { Vault, hash, parseMarkdown } from './storage.js';
import { readProjects } from './projects.js';
import { associatedProjects, dateLabel, generatedMarkdown, isGeneratedIntact, readReceipts } from './views.js';
import { groundedResult, readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { lifecycleOf, projectStatusLabels, readProjectStatusChanges, type ProjectStatusChange } from './project-status.js';
import { exclusionReasonLabels, readItemResolutions, readNowItems, type ItemResolution } from './item-resolutions.js';
import { readItemOccurrences, repeatLabel, type ItemOccurrence } from './item-schedules.js';
import { readProjectCreations } from './project-creations.js';
import { readProjectDefinitionChanges } from './project-definition.js';
import { readProjectMerges, type ProjectMerge } from './project-merges.js';
import { mergeTargets } from './projects.js';
import { knowledgePaths } from './knowledge-scope.js';
import { retirementPath, retirementSchema } from './knowledge-retirement.js';
import type { HubConfig, Input, Project, Receipt } from './types.js';

/**
 * プロジェクトの経緯（10_projects/<id>/HISTORY.md）。モデルを使わず、根拠と処理記録だけから月ごとの出来事を組み立てる。
 * NOWは「今」、REVIEWは直近の期間だけを示すため、休止から戻るときや完了にするときに流れを通して読む場所として使う。
 */
const plain = listText;
const clip = (s: string, n = 120) => clipText(s, n);
/** 月ごとに載せる入力の上限。超えた分は件数だけ示す。 */
const INPUTS_PER_MONTH = 8;
/** 現在地の変化として1件の作業要約から載せる項目の上限。 */
const CHANGES_PER_SUMMARY = 5;
export const historyPath = (projectId: string) => `10_projects/${projectId}/HISTORY.md`;

interface Event { at: string; order: number; line: string }
interface HistorySources {
  config: HubConfig; projects: Project[]; units: EffectiveInput[]; receipts: Receipt[]; resolutions: ItemResolution[]; occurrences: ItemOccurrence[]; statuses: ProjectStatusChange[];
  /** 読めなかった記録の種類。経緯からは省き、本文にその旨を書く（cycleとHOMEを止めない）。 */ problems: string[];
  creations: Awaited<ReturnType<typeof readProjectCreations>>; definitions: Awaited<ReturnType<typeof readProjectDefinitionChanges>>; merges: ProjectMerge[]; knowledge: { projectId: string; id: string; kind: string; claim: string; approvedAt: string; retiredAt?: string }[];
}

async function readSources(config: HubConfig, vault: Vault): Promise<HistorySources> {
  const knowledge: HistorySources['knowledge'] = [];
  for (const path of await knowledgePaths(vault)) {
    const match = /^10_projects\/([a-z0-9][a-z0-9-]{1,40})\/knowledge\/(KNW-[0-9A-HJKMNP-TV-Z]{26})\.md$/.exec(path);
    if (!match) continue;
    try {
      const { meta, text } = parseMarkdown((await vault.read(path))!);
      if (meta.id !== match[2] || typeof meta.approved_at !== 'string' || !Number.isFinite(Date.parse(meta.approved_at))) continue;
      // 本文は「# 人が承認した…」の見出しの次の段落が採用した内容。
      const claim = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? '';
      let retiredAt: string | undefined;
      const raw = await vault.read(retirementPath(match[2]));
      if (raw !== undefined) try { retiredAt = retirementSchema.parse(JSON.parse(raw)).retired_at; } catch { /* 不正な適用停止記録はdoctorと方針の生成で報告する。 */ }
      knowledge.push({ projectId: match[1]!, id: match[2]!, kind: typeof meta.kind === 'string' ? meta.kind : 'knowledge', claim, approvedAt: meta.approved_at, ...(retiredAt ? { retiredAt } : {}) });
    } catch { /* 読めない知識は方針の生成とdoctorで報告する。経緯からは省く。 */ }
  }
  const problems: string[] = [];
  const tolerant = async <T>(label: string, read: () => Promise<T[]>): Promise<T[]> => { try { return await read(); } catch { problems.push(label); return []; } };
  return {
    config, projects: await readProjects(config), units: await readEffectiveInputs(config), receipts: await readReceipts(config),
    resolutions: await tolerant('完了・解決の報告', () => readItemResolutions(vault)),
    occurrences: await tolerant('定例の回', async () => { const read = await readItemOccurrences(vault); if (read.problems.length) throw new Error(); return read.records; }), statuses: await tolerant('状態の切り替え', () => readProjectStatusChanges(vault)),
    creations: await tolerant('プロジェクトの作成', () => readProjectCreations(vault)), definitions: await tolerant('定義の変更', () => readProjectDefinitionChanges(vault)), merges: await tolerant('プロジェクトの統合', () => readProjectMerges(vault)), knowledge, problems,
  };
}

const confirmed = (items: { text: string; status: string }[]) => [...new Set(items.filter(i => i.status === 'confirmed').map(i => i.text))];
/** NOWと同じく、原文の印と照合した確認済みだけを信じる（古い・手で変えた処理記録のモデルの申告をそのまま使わない）。 */
function groundedCurrent(u: EffectiveInput): string[] {
  return confirmed(groundedResult(u.chain, u.receipt!.input_id, u.receipt!.result!).extracted.current);
}
const kindLabels: Record<string, string> = { knowledge: '知識', decision: '判断・方針', preference: '好み' };

/** 経緯の本文。日時は設定のタイムゾーンで表示し、「何日前」のような生成時点に依存する表現は使わない。 */
async function buildHistoryText(sources: HistorySources, vault: Vault, project: Project): Promise<string> {
  const { config } = sources, tz = config.timezone, id = project.id;
  const month = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date(iso)).slice(0, 7);
  const day = (iso: string) => dateLabel(iso, tz).slice(0, 10);
  const ref = (input: Input) => `[${input.id}](../../${input.path})`;
  const mine = sources.units.filter(u => {
    const root = u.chain.root;
    return u.receipt ? associatedProjects(root, u.receipt, config).includes(id) : root.project === id;
  }).sort((a, b) => Date.parse(a.chain.root.occurred_at) - Date.parse(b.chain.root.occurred_at) || a.chain.root.id.localeCompare(b.chain.root.id));
  const state = (u: EffectiveInput) => { const latest = sources.receipts.find(r => r.input_id === u.chain.latest.id); return latest?.status === 'organized' ? 'organized' : latest?.status === 'failed' ? 'failed' : 'waiting'; };
  const events: Event[] = [], inputsByMonth = new Map<string, EffectiveInput[]>();
  for (const u of mine) { const key = month(u.chain.root.occurred_at); const list = inputsByMonth.get(key); if (list) list.push(u); else inputsByMonth.set(key, [u]); }

  // 現在地の移り変わり。NOWと同じく作業要約を発生日時の順に並べ、直前の作業要約と比べて変わったときだけ載せる。
  let previous: string[] | undefined;
  for (const u of mine.filter(u => u.chain.root.kind === 'work-summary' && u.receipt?.result)) {
    const current = groundedCurrent(u), input = u.chain.root;
    if (previous === undefined) {
      if (current.length) events.push({ at: input.occurred_at, order: 1, line: `- ${day(input.occurred_at)} 現在地（最初の作業要約 ${ref(input)}）: ${current.slice(0, CHANGES_PER_SUMMARY).map(t => clip(t, 80)).join(' / ')}${current.length > CHANGES_PER_SUMMARY ? ` ほか${current.length - CHANGES_PER_SUMMARY}件` : ''}` });
      previous = current; continue;
    }
    const added = current.filter(t => !previous!.includes(t)), removed = previous.filter(t => !current.includes(t));
    if (added.length || removed.length) {
      const parts = [...added.slice(0, CHANGES_PER_SUMMARY).map(t => `  - 追加: ${clip(t)}`), ...removed.slice(0, CHANGES_PER_SUMMARY).map(t => `  - 外れた: ${clip(t)}`)];
      const more = Math.max(0, added.length - CHANGES_PER_SUMMARY) + Math.max(0, removed.length - CHANGES_PER_SUMMARY);
      events.push({ at: input.occurred_at, order: 1, line: [`- ${day(input.occurred_at)} 現在地が変わった（${ref(input)}）:`, ...parts, ...(more ? [`  - ほか${more}件`] : [])].join('\n') });
    }
    previous = current;
  }
  for (const r of sources.resolutions.filter(r => r.project_id === id))
    events.push({ at: r.created_at, order: 2, line: `- ${day(r.created_at)} ${r.action === 'resolve' ? (r.section === 'next' ? '完了' : '解決') : r.action === 'exclude' ? `誤りとして外した（${r.reason ? exclusionReasonLabels[r.reason] : '理由なし'}）` : '未解決に戻した'}: ${clip(r.text)}（本人報告 ${r.id}）` });
  // 定例の回。項目は欄に残るので、完了・解決とは分けて「今回を完了」「今回を見送り」として載せる。
  for (const o of sources.occurrences.filter(o => o.project_id === id))
    events.push({ at: o.created_at, order: 2, line: `- ${day(o.created_at)} 定例（${repeatLabel(o.repeat)}）の${o.due}の回を${o.action === 'done' ? '完了' : '見送り'}: ${clip(o.text)}（次は ${o.next_due}・本人報告 ${o.id}）` });
  for (const s of sources.statuses.filter(s => s.project_id === id)) {
    const from = (projectStatusLabels as Record<string, string>)[s.from] ?? (s.from ? s.from : '進行中');
    events.push({ at: s.changed_at, order: 3, line: `- ${day(s.changed_at)} 状態: ${plain(from)} → ${projectStatusLabels[s.to]}（${s.id}）` });
  }
  for (const c of sources.creations.filter(c => c.project_id === id))
    events.push({ at: c.created_at, order: 0, line: `- ${day(c.created_at)} プロジェクトを作成: ${clip(c.title)}（${c.id}）` });
  for (const d of sources.definitions.filter(d => d.project_id === id)) {
    const changed = [d.before.title !== d.after.title ? `名前 ${clip(d.before.title, 60)} → ${clip(d.after.title, 60)}` : '', JSON.stringify(d.before.aliases ?? []) !== JSON.stringify(d.after.aliases) ? '別名' : '', JSON.stringify(d.before.keywords ?? []) !== JSON.stringify(d.after.keywords) ? 'キーワード' : ''].filter(Boolean);
    events.push({ at: d.changed_at, order: 3, line: `- ${day(d.changed_at)} 定義を変更: ${changed.join('・') || '書式のみ'}（${d.id}）` });
  }
  // 統合と取り消し。統合元と統合先の両方の経緯に載せる。
  const titleOf = (projectId: string) => `${clip(sources.projects.find(p => p.id === projectId)?.title ?? projectId, 60)}（${projectId}）`;
  for (const m of sources.merges.filter(m => m.from_id === id || m.into_id === id)) {
    const text = m.from_id === id
      ? (m.action === 'merge' ? `${titleOf(m.into_id)}へ統合した。入力・完了報告・日付は統合先のものとして読み替える` : `${titleOf(m.into_id)}への統合を取り消した`)
      : (m.action === 'merge' ? `${titleOf(m.from_id)}を統合した。統合元の入力・完了報告・日付をこのプロジェクトのものとして読み替える` : `${titleOf(m.from_id)}の統合を取り消した`);
    events.push({ at: m.changed_at, order: 3, line: `- ${day(m.changed_at)} ${text}（${m.id}）` });
  }
  for (const k of sources.knowledge.filter(k => k.projectId === id)) {
    events.push({ at: k.approvedAt, order: 4, line: `- ${day(k.approvedAt)} ${kindLabels[k.kind] ?? '知識'}を採用: ${clip(k.claim)}（[${k.id}](knowledge/${k.id}.md)）` });
    if (k.retiredAt) events.push({ at: k.retiredAt, order: 4, line: `- ${day(k.retiredAt)} ${kindLabels[k.kind] ?? '知識'}の適用を停止: ${clip(k.claim)}（${k.id}）` });
  }
  for (const [key, units] of inputsByMonth) {
    const shown = units.slice(0, INPUTS_PER_MONTH).map(u => {
      const input = u.chain.root, summary = u.receipt?.result?.summary, s = state(u);
      const flags = [u.chain.revisions.length ? (u.pendingCorrection ? '訂正未反映' : '訂正あり') : '', input.project !== id ? '関連候補（AI推定）' : ''].filter(Boolean);
      return `  - ${day(input.occurred_at)} ${input.kind === 'work-summary' ? '作業要約' : 'メモ'} ${ref(input)} ${summary ? clip(summary) : s === 'failed' ? '（整理失敗）' : '（整理待ち）'}${flags.length ? ` / ${flags.join(' / ')}` : ''}`;
    });
    const summaries = units.filter(u => u.chain.root.kind === 'work-summary').length;
    events.push({ at: `${key}-01T00:00:00Z`, order: -1, line: [`- 届いた入力: ${units.length}件（作業要約 ${summaries} / メモ ${units.length - summaries}）`, ...shown, ...(units.length > INPUTS_PER_MONTH ? [`  - ほか${units.length - INPUTS_PER_MONTH}件（検索で絞り込めます）`] : [])].join('\n') });
  }

  // 月ごとにまとめる。入力の一覧は月の先頭に置き、ほかの出来事は日時の順に並べる。
  const months = new Map<string, Event[]>();
  for (const e of events) { const key = e.order === -1 ? e.at.slice(0, 7) : month(e.at); const list = months.get(key); if (list) list.push(e); else months.set(key, [e]); }
  const lifecycle = lifecycleOf(project), mergedInto = mergeTargets(sources.projects).get(id), firstAt = mine[0]?.chain.root.occurred_at, lastAt = mine.at(-1)?.chain.root.occurred_at;
  const resolvedCount = sources.resolutions.filter(r => r.project_id === id && r.action === 'resolve').length;
  const lines = [
    `# ${plain(project.title)}の経緯`, '',
    `状態: ${mergedInto ? `統合済み（統合先: ${titleOf(mergedInto)}）` : `${projectStatusLabels[lifecycle]}${project.status === lifecycle ? '' : `（${plain(project.status)}）`}`}`,
    `期間: ${firstAt ? `${day(firstAt)} 〜 ${day(lastAt!)}（最初と最後の根拠の日付、${tz}）` : '根拠となる入力はまだありません'}`,
    `入力 ${mine.length}件 / 完了・解決の報告 ${resolvedCount}件 / 状態の切り替え ${sources.statuses.filter(s => s.project_id === id).length}件 / 採用した知識・方針 ${sources.knowledge.filter(k => k.projectId === id).length}件`, '',
    '根拠と処理記録から決定的に組み立てた一覧です。要約と抽出はAI生成・未検証です。判断の前にリンク先の原文と出典を確認してください。今の状態は[NOW](NOW.md)を参照してください。', '',
  ];
  if (sources.problems.length) lines.push(`読めない記録があるため、次の出来事を省いています: ${sources.problems.join('・')}（\`ctx doctor\`で確認してください）`, '');
  if (!months.size) lines.push('まだ記録はありません。', '');
  for (const key of [...months.keys()].sort()) {
    const [y, m] = key.split('-');
    lines.push(`## ${y}年${Number(m)}月`);
    for (const e of months.get(key)!.sort((a, b) => (a.order === -1 ? -1 : 0) - (b.order === -1 ? -1 : 0) || Date.parse(a.at) - Date.parse(b.at) || a.order - b.order || a.line.localeCompare(b.line))) lines.push(e.line);
    lines.push('');
  }
  // 休止・完了では、切り替えた時点で残っていたものを末尾にまとめる。統合済みでは、残っているものは統合先のNOWにある。
  if (mergedInto) lines.push('## いま残っているもの（統合済み）', `- 次の一手と未解決は、統合先の[NOW](../${mergedInto}/NOW.md)を参照してください。`, '');
  else if (lifecycle !== 'active') {
    let items: Awaited<ReturnType<typeof readNowItems>>;
    try { items = await readNowItems(vault, id); } catch { items = undefined; }
    const lastSummary = mine.filter(u => u.chain.root.kind === 'work-summary' && u.receipt?.result).at(-1);
    const current = lastSummary ? groundedCurrent(lastSummary) : [];
    const left = (section: 'next' | 'open') => items?.items.filter(i => i.section === section && i.resolution === null) ?? [];
    // 切り替えた時点ではなく、今の記録で残っているもの（休止中に届いた入力や報告も反映する）。
    lines.push(`## いま残っているもの（${projectStatusLabels[lifecycle]}）`);
    lines.push(`- 最後の現在地${lastSummary ? `（${ref(lastSummary.chain.root)}）` : ''}: ${current.length ? current.map(t => clip(t, 80)).join(' / ') : '不明'}`);
    for (const [section, title] of [['next', '次の一手'], ['open', '未解決']] as const) {
      const rest = left(section);
      lines.push(`- 残っている${title}: ${items ? `${rest.length}件` : 'NOW項目の記録がないため不明'}`);
      for (const i of rest.slice(0, 10)) lines.push(`  - ${clip(i.label + i.text)}`);
      if (rest.length > 10) lines.push(`  - ほか${rest.length - 10}件はNOWで確認`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const optionsSchema = z.object({ projectId: z.string().optional() }).strict();
export interface HistoryWrite { projectId: string; path: string; written: boolean; stopped?: boolean }

/**
 * 経緯を作り直す。本文が前回と同じなら書き込まず、同期のたびに差分を作らない。
 * 手で書き換えたHISTORY.mdは上書きも退避もせず、更新を止める（HOMEの「失敗と競合」に示す。消すと次のcycleで作り直す）。
 */
export async function rebuildHistoriesLocked(config: HubConfig, vault: Vault, options: { projectId?: string } = {}): Promise<HistoryWrite[]> {
  optionsSchema.parse(options);
  const sources = await readSources(config, vault), targets = options.projectId ? sources.projects.filter(p => p.id === options.projectId) : sources.projects;
  if (options.projectId && !targets.length) throw new Error('プロジェクトが見つかりません');
  const result: HistoryWrite[] = [];
  for (const project of targets) {
    const path = historyPath(project.id), existing = await vault.read(path);
    if (existing !== undefined && !isGeneratedIntact(existing)) { result.push({ projectId: project.id, path, written: false, stopped: true }); continue; }
    const text = await buildHistoryText(sources, vault, project), sourceHash = `sha256:${hash(text)}`;
    let same = false;
    if (existing !== undefined) try { same = parseMarkdown(existing).meta.source_hash === sourceHash; } catch { same = false; }
    if (same) { result.push({ projectId: project.id, path, written: false }); continue; }
    await vault.write(path, generatedMarkdown({ schema_version: 1, project: project.id, generated_by: { model: 'deterministic-writer', prompt_version: 1 }, generated_at: new Date().toISOString(), source_hash: sourceHash, verified: false }, text));
    result.push({ projectId: project.id, path, written: true });
  }
  return result;
}
/** HISTORY.mdが手で書き換えられ、更新を止めているか。HOMEの表示に使う。 */
export async function historyStopped(vault: Vault, projectId: string): Promise<boolean> {
  const raw = await vault.read(historyPath(projectId));
  return raw !== undefined && !isGeneratedIntact(raw);
}
export async function rebuildHistories(config: HubConfig, options: { projectId?: string } = {}): Promise<HistoryWrite[]> {
  const vault = new Vault(config);
  return vault.withLock(() => rebuildHistoriesLocked(config, vault, options));
}
/** テスト・CLI向け: 書き込まずに本文だけを組み立てる。 */
export async function buildHistory(config: HubConfig, projectId: string): Promise<string> {
  const vault = new Vault(config), sources = await readSources(config, vault), project = sources.projects.find(p => p.id === projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  return buildHistoryText(sources, vault, project);
}
