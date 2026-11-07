import { z } from 'zod';
import { Vault } from './storage.js';
import { readProjects } from './projects.js';
import { readReceipts, associatedProjects, dateLabel, generatedMarkdown, writeGeneratedLocked } from './views.js';
import { readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { buildReviewIndex } from './candidate-review.js';
import { lifecycleOf, projectStatusLabels } from './project-status.js';
import { lastEvidenceAt, daysSince } from './dashboard.js';
import { activeResolutions, itemKey, readItemResolutions } from './item-resolutions.js';
import type { HubConfig, Input, ExtractedItem } from './types.js';

const DAY = 86_400_000;
const plain = (s: string) => s.replace(/[\r\n|]/g, ' ').replaceAll('[', '\\[').replaceAll(']', '\\]');
const clip = (s: string, n = 120) => { const a = Array.from(plain(s)); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
const optionsSchema = z.object({ days: z.number().int().min(1).max(366).optional(), now: z.date().optional() }).strict();
export interface DigestOptions { days?: number; now?: Date }

interface Unit { input: Input; unit: EffectiveInput; projects: string[] }
function confirmed(items: ExtractedItem[]): string[] { return [...new Set(items.filter(i => i.status === 'confirmed').map(i => i.text))]; }
/** 作業要約の確定済み項目を、期間開始時点と現在とで比べる。NOWと同じく最新の作業要約を現在地とする。 */
function diff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return { added: after.filter(x => !before.includes(x)), removed: before.filter(x => !after.includes(x)) };
}

/**
 * 直近の期間に届いた入力・NOWの変化・持ち越しの未解決・滞留中の候補を、モデルを使わずにREVIEW.mdへまとめる。
 * 根拠と処理記録の集計だけを行い、要約はAI生成・未検証の表示を保つ。
 */
export async function buildDigest(config: HubConfig, options: DigestOptions = {}): Promise<string> {
  optionsSchema.parse(options);
  const days = options.days ?? config.retrieve.digestDays, now = options.now ?? new Date(), start = new Date(now.getTime() - days * DAY);
  const inWindow = (iso: string) => { const t = Date.parse(iso); return t > start.getTime() && t <= now.getTime(); };
  const before = (iso: string) => Date.parse(iso) <= start.getTime();
  const vault = new Vault(config), projects = await readProjects(config), effective = await readEffectiveInputs(config), receipts = await readReceipts(config);
  const review = await buildReviewIndex(config), resolutions = await readItemResolutions(vault);
  const units: Unit[] = effective.map(unit => ({ input: unit.chain.root, unit, projects: unit.receipt ? associatedProjects(unit.chain.root, unit.receipt, config) : unit.chain.root.project ? [unit.chain.root.project] : [] }));
  // 訂正も入力として扱い、元の入力か訂正のどれかが期間内に届いたものを「届いた入力」に数える。
  const evidenceOf = (u: Unit) => [u.unit.chain.root, ...u.unit.chain.revisions];
  const corrected = (u: Unit) => u.unit.chain.revisions.some(i => inWindow(i.received_at));
  const recent = units.filter(u => evidenceOf(u).some(i => inWindow(i.received_at)));
  const organizedById = new Map(receipts.filter(r => r.status === 'organized' && r.result).map(r => [r.input_id, r]));
  /** 期間開始の時点で有効だった解釈。開始までに届いた根拠のうち、最後に整理されたものを使う。 */
  const resultThen = (u: Unit) => evidenceOf(u).filter(i => before(i.received_at)).map(i => organizedById.get(i.id)?.result).filter(r => r != null).at(-1) ?? undefined;
  const state = (u: Unit) => { const latest = receipts.find(r => r.input_id === u.unit.chain.latest.id); return latest?.status === 'organized' ? 'organized' : latest?.status === 'failed' ? 'failed' : 'waiting'; };
  const count = (status: string) => recent.filter(u => state(u) === status).length;
  const ref = (input: Input) => `[${input.id}](${input.path})`;
  const label = (iso: string) => `${dateLabel(iso, config.timezone)}`;
  const pending = review.items.filter(c => c.status === 'pending');
  const lingering = pending.filter(c => c.generatedAt && before(c.generatedAt));
  const unassigned = recent.filter(u => u.unit.receipt?.result && !u.projects.length).length;

  const lines: string[] = [
    `# 直近${days}日のふりかえり`, '',
    `期間: ${label(start.toISOString())} 〜 ${label(now.toISOString())} ${config.timezone}`,
    '受領・整理の記録から決定的に集計した一覧です。要約と抽出はAI生成・未検証です。判断の前にリンク先の原文と出典を確認してください。', '',
    '## 概要',
    `- この期間に届いた入力: ${recent.length}件（整理済み ${count('organized')} / 整理待ち ${count('waiting')} / 整理失敗 ${count('failed')}）`,
    `- プロジェクト未帰属（整理済みのうち）: ${unassigned}件`,
    `- 確認待ちの候補: ${pending.length}件（うち期間より前から残っているもの ${lingering.length}件）`,
    '- 失敗・競合の詳細は[HOME](HOME.md)を参照してください。', '',
  ];

  const active: string[] = [], quiet: string[] = [], inactive: string[] = [];
  for (const project of [...projects].sort((a, b) => a.id.localeCompare(b.id))) {
    const lifecycle = lifecycleOf(project), last = await lastEvidenceAt(vault, project.id);
    const nowPath = `10_projects/${project.id}/NOW.md`, target = await vault.read(nowPath) !== undefined ? nowPath : `10_projects/${project.id}/project.md`;
    const head = `[${plain(project.title)}](${target}) — ${projectStatusLabels[lifecycle]}${last ? ` / 最終根拠: ${label(last)}（${daysSince(last, now)}日前）` : ' / 最終根拠なし'}`;
    if (lifecycle !== 'active') { inactive.push(`- ${head}`); continue; }
    const mine = units.filter(u => u.projects.includes(project.id) && u.unit.receipt?.result);
    const fresh = recent.filter(u => u.projects.includes(project.id));
    // 期間内の本人の完了・解決報告。最後の記録が解決のままのものだけを数える。
    const resolvedNow = activeResolutions(resolutions.filter(r => Date.parse(r.created_at) <= now.getTime()), project.id), closed = [...resolvedNow.values()].filter(r => inWindow(r.created_at));
    if (!fresh.length && !closed.length) { quiet.push(`- ${head}`); continue; }
    // NOWと同じ基準で、発生日時の順に最新の作業要約を選ぶ。期間開始時点は、その時点までに届いていた入力だけで決める。
    const byOccurred = (a: Unit, b: Unit) => Date.parse(a.input.occurred_at) - Date.parse(b.input.occurred_at) || a.input.id.localeCompare(b.input.id);
    const summaries = mine.filter(u => u.input.kind === 'work-summary').sort(byOccurred);
    const latestNow = summaries.at(-1), latestThen = summaries.filter(u => resultThen(u)).at(-1), thenResult = latestThen ? resultThen(latestThen) : undefined;
    const out = [`### ${head}`, `- 新しい入力: ${fresh.length}件（作業要約 ${fresh.filter(u => u.input.kind === 'work-summary').length} / メモ ${fresh.filter(u => u.input.kind === 'memo').length}${fresh.some(corrected) ? ` / うち期間内の訂正 ${fresh.filter(corrected).length}` : ''}）`];
    for (const [title, key] of [['現在地', 'current'], ['次の一手', 'next']] as const) {
      const then = thenResult ? confirmed(thenResult.extracted[key]) : [], current = latestNow ? confirmed(latestNow.unit.receipt!.result!.extracted[key]) : [];
      const change = diff(then, current);
      if (!change.added.length && !change.removed.length) { out.push(`- ${title}の変化: なし`); continue; }
      out.push(`- ${title}の変化（${latestNow ? ref(latestNow.input) : '根拠なし'}）:`);
      for (const text of change.added.slice(0, 10)) out.push(`  - 追加: ${clip(text)}`);
      for (const text of change.removed.slice(0, 10)) out.push(`  - 外れた: ${clip(text)}`);
    }
    if (closed.length) {
      out.push(`- 期間内に完了・解決と報告した項目: ${closed.length}件`);
      for (const r of closed.slice(-5).reverse()) out.push(`  - ${r.section === 'next' ? '完了' : '解決'}: ${clip(r.text)}（${label(r.created_at)} ${r.id}）`);
    }
    if (fresh.length) out.push('- 主な入力:');
    const lastReceived = (u: Unit) => Math.max(...evidenceOf(u).filter(i => inWindow(i.received_at)).map(i => Date.parse(i.received_at)));
    for (const u of [...fresh].sort((a, b) => lastReceived(b) - lastReceived(a)).slice(0, 5)) {
      const summary = u.unit.receipt?.result?.summary;
      out.push(`  - ${ref(u.input)} ${label(u.input.occurred_at)} ${summary ? clip(summary) : `（${state(u) === 'failed' ? '整理失敗' : '整理待ち'}）`}${corrected(u) ? ' / 期間内に訂正' : ''}${u.unit.pendingCorrection ? ' / 訂正未反映' : ''}${u.input.project !== project.id ? ' / 関連候補（AI推定）' : ''}`);
    }
    const carried = mine.filter(u => before(u.input.received_at)).sort(byOccurred).flatMap(u => {
      const result = u.unit.receipt!.result!;
      return [...(result.category === 'question' ? [result.summary] : []), ...result.extracted.open.map(i => i.text)].map(text => ({ text, input: u.input }));
    }).filter(item => !resolvedNow.has(itemKey(project.id, 'open', item.input.id, item.text)));
    if (carried.length) {
      out.push(`- 期間より前からの未解決（解決済みかは未確認・古い順に最大5件 / 全${carried.length}件）:`);
      for (const item of carried.slice(0, 5)) out.push(`  - ${clip(item.text)} ${ref(item.input)}（${daysSince(item.input.occurred_at, now)}日前）`);
    }
    active.push(out.join('\n'));
  }
  lines.push('## 動きのあったプロジェクト', active.join('\n\n') || 'この期間に新しい入力のあったプロジェクトはありません。', '');
  if (quiet.length) lines.push('## 動きのなかった進行中のプロジェクト', ...quiet, '');
  if (inactive.length) lines.push('## 休止・完了', ...inactive, '');
  lines.push('## 確認待ちの候補');
  if (!pending.length) lines.push('確認待ちの候補はありません。');
  for (const c of [...pending].sort((a, b) => (Date.parse(a.generatedAt ?? '') || 0) - (Date.parse(b.generatedAt ?? '') || 0)))
    lines.push(`- [${plain(c.title)}](${c.path})${c.generatedAt && Number.isFinite(Date.parse(c.generatedAt)) ? ` — ${daysSince(c.generatedAt, now)}日前から` : ''}`);
  return lines.join('\n') + '\n';
}

export async function rebuildDigest(config: HubConfig, options: DigestOptions = {}): Promise<{ path: string; conflict?: string }> {
  const now = options.now ?? new Date(), vault = new Vault(config);
  // HOMEと同じく、集計と書き込みをWriterロック内で行い、途中の承認や受付と混ざらないようにする。
  return vault.withLock(() => rebuildDigestLocked(config, vault, { ...options, now }));
}
/** Writerロックを持つ呼び出し元から使う。競合の片付けで、ふりかえりを作り直すときにも使う。 */
export async function rebuildDigestLocked(config: HubConfig, vault: Vault, options: DigestOptions = {}): Promise<{ path: string; conflict?: string }> {
  const now = options.now ?? new Date();
  { const text = await buildDigest(config, { ...options, now }); return writeGeneratedLocked(vault, 'REVIEW.md', generatedMarkdown({ schema_version: 1, generated_by: { model: 'deterministic-writer', prompt_version: 1 }, generated_at: now.toISOString(), period_days: options.days ?? config.retrieve.digestDays, verified: false }, text)); }
}
