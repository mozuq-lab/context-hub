import { clipText, listText } from './markdown-text.js';
import { z } from 'zod';
import { Vault } from './storage.js';
import { readProjects, mergeTargets, outcomeOneLine } from './projects.js';
import { readReceipts, associatedProjects, dateLabel, generatedMarkdown, writeGeneratedLocked } from './views.js';
import { groundedResult, readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { buildReviewIndex } from './candidate-review.js';
import { lifecycleOf, projectStatusLabels } from './project-status.js';
import { daysSince } from './dashboard.js';
import { lastEvidenceAt } from './views.js';
import { insightFeedbackSection, insightsSection, readInsights } from './insights.js';
import { UNASSIGNED_SCOPE, activeResolutions, exclusionReasonLabels, itemKey, readItemResolutions, readNowItems } from './item-resolutions.js';
import { WAITING_LONG_DAYS, waitingDays } from './item-waits.js';
import { buildSomedayList, somedayDigestLines } from './someday.js';
import { buildWeeklyReview, weeklyReviewDigestLines } from './weekly-review.js';
import { todayIn } from './item-schedules.js';
import { UNASSIGNED_TITLE } from './unassigned-actions.js';
import type { HubConfig, Input, ExtractedItem } from './types.js';
import { inputWhen } from './happened.js';
import { actionSource } from './actions.js';

const DAY = 86_400_000;
// 以前はHTMLコメントの開始を無効にしていなかった。ほかの生成物と同じ無害化にそろえる。
const plain = listText;
const clip = (s: string, n = 120) => clipText(s, n);
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
  // 別の置き場へ移した行動（元の行動の入力ID→移した日時）。移した先の行動が引き継ぐので、元の置き場では追加・残りに数えない
  // （プロジェクト未定の欄では、期間内に移した件数だけを示す。移したのが今より後なら、まだ元の置き場の行動として数える）。
  const movedAt = new Map<string, string>();
  for (const u of units) { const from = actionSource(u.input); if (from && Date.parse(u.input.received_at) <= now.getTime() && !movedAt.has(from.input_id)) movedAt.set(from.input_id, u.input.received_at); }
  // 訂正も入力として扱い、元の入力か訂正のどれかが期間内に届いたものを「届いた入力」に数える。
  const evidenceOf = (u: Unit) => [u.unit.chain.root, ...u.unit.chain.revisions];
  const corrected = (u: Unit) => u.unit.chain.revisions.some(i => inWindow(i.received_at));
  const recent = units.filter(u => evidenceOf(u).some(i => inWindow(i.received_at)));
  const organizedById = new Map(receipts.filter(r => r.status === 'organized' && r.result).map(r => [r.input_id, r]));
  /** 期間開始の時点で有効だった解釈。開始までに届いた根拠のうち、最後に整理されたものを使う。 */
  // NOW・経緯と同じく、原文の印と照合した結果を使う（古い・手で変えた処理記録のモデルの申告をそのまま信じない）。
  const resultThen = (u: Unit) => evidenceOf(u).filter(i => before(i.received_at)).flatMap(i => { const r = organizedById.get(i.id)?.result; return r ? [groundedResult(u.unit.chain, i.id, r)] : []; }).at(-1);
  // 本人が直接追加した行動はモデルで整理しないため、整理済み・整理待ちとは分けて数える。
  const state = (u: Unit) => { if (u.input.kind === 'action') return 'action'; const latest = receipts.find(r => r.input_id === u.unit.chain.latest.id); return latest?.status === 'organized' ? 'organized' : latest?.status === 'failed' ? 'failed' : 'waiting'; };
  const count = (status: string) => recent.filter(u => state(u) === status).length;
  const ref = (input: Input) => `[${input.id}](${input.path})`;
  const label = (iso: string) => `${dateLabel(iso, config.timezone)}`;
  // 同じ対象を指すプロジェクト案は代表の1件にまとめて数え、待っている日数は組の中で最も古い案から数える。
  const pending = review.items.filter(c => c.status === 'pending' && !c.duplicateOf);
  const since = (c: typeof pending[number]) => [c.generatedAt, ...(c.duplicates ?? []).map(id => review.items.find(i => i.id === id)?.generatedAt)].filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const lingering = pending.filter(c => { const at = since(c); return at !== undefined && before(at); });
  const unassigned = recent.filter(u => u.unit.receipt?.result && !u.projects.length).length;
  // 本人が書いた望む結果（1行にまとめて示す）。進行中で書いていないプロジェクトは概要に件数を示す。
  const outcomeText = (project: typeof projects[number]) => outcomeOneLine(project.outcome);
  const outcomeLine = (project: typeof projects[number]) => `望む結果: ${outcomeText(project) ? clip(outcomeText(project), 200) : '未記入'}`;
  const noOutcome = projects.filter(p => !mergeTargets(projects).has(p.id) && lifecycleOf(p) === 'active' && !outcomeText(p)).length;

  // 週次の統合の結果（今週の気づき）を、件数の集計より前に置く。設定で有効にしたときだけ出す。記録を読めないときは出さず、HOMEの「失敗と競合」で示す。
  // 続けて、気づきへの本人の反応と答えの件数を出す（ふりかえりだけに出す）。
  let insights = '', feedback = '';
  if (config.synthesis.enabled) try { const build = await readInsights(config, vault, effective, now); insights = insightsSection(config, build.insights, now); feedback = insightFeedbackSection(config, build); } catch { /* HOMEで示す。 */ }
  // 週次レビューの点検（HOMEとアプリと同じ一覧）。今週の気づきの後、件数の集計より前に置き、Obsidianだけでも同じ順で確かめられるようにする。
  let weekly: string[] = [];
  try { weekly = weeklyReviewDigestLines(await buildWeeklyReview(config, vault, now, { projects, effective }), now, config.timezone); } catch { /* 壊れた記録はHOMEとdoctorで示す。 */ }
  const lines: string[] = [
    `# 直近${days}日のふりかえり`, '',
    `期間: ${label(start.toISOString())} 〜 ${label(now.toISOString())} ${config.timezone}`,
    '受領・整理の記録から決定的に集計した一覧です。要約と抽出はAI生成・未検証です。判断の前にリンク先の原文と出典を確認してください。', '',
    ...(insights ? [insights, ''] : []),
    ...(feedback ? [feedback, ''] : []),
    ...weekly,
    '## 概要',
    `- この期間に届いた入力: ${recent.length}件（整理済み ${count('organized')} / 整理待ち ${count('waiting')} / 整理失敗 ${count('failed')}${count('action') ? ` / 本人が追加した行動 ${count('action')}` : ''}）`,
    `- プロジェクト未帰属（整理済みのうち）: ${unassigned}件`,
    `- 確認待ちの候補: ${pending.length}件（うち期間より前から残っているもの ${lingering.length}件）`,
    ...(noOutcome ? [`- 望む結果が未記入の進行中のプロジェクト: ${noOutcome}件（アプリのプロジェクトの画面か\`ctx project edit <ID> --outcome <文> --hash <hash> --confirm\`で書けます）`] : []),
    '- 失敗・競合の詳細は[HOME](HOME.md)を参照してください。', '',
  ];

  const active: string[] = [], quiet: string[] = [], inactive: string[] = [], merged = mergeTargets(projects);
  for (const project of [...projects].sort((a, b) => a.id.localeCompare(b.id))) {
    const lifecycle = lifecycleOf(project), last = await lastEvidenceAt(vault, project.id);
    const nowPath = `10_projects/${project.id}/NOW.md`, target = await vault.read(nowPath) !== undefined ? nowPath : `10_projects/${project.id}/project.md`;
    // 統合済みのプロジェクトは統合先だけを示す（入力は統合先のものとして集計している）。
    const mergedInto = merged.get(project.id);
    if (mergedInto) { inactive.push(`- [${plain(project.title)}](10_projects/${project.id}/project.md) — 統合済み（統合先: ${plain(projects.find(p => p.id === mergedInto)?.title ?? mergedInto)}）`); continue; }
    const head = `[${plain(project.title)}](${target}) — ${projectStatusLabels[lifecycle]}${last ? ` / 最終根拠: ${label(last)}（${daysSince(last, now)}日前）` : ' / 最終根拠なし'}`;
    // 休止・完了のプロジェクトは、望む結果を書いてあるときだけ添える（再開・完了の判断の基準）。
    if (lifecycle !== 'active') { inactive.push(`- ${head}${outcomeText(project) ? `\n  - ${outcomeLine(project)}` : ''}`); continue; }
    const mine = units.filter(u => u.projects.includes(project.id) && u.unit.receipt?.result);
    const fresh = recent.filter(u => u.projects.includes(project.id));
    // 期間内の本人の完了・解決報告。最後の記録が解決のままのものだけを数える。
    const resolvedNow = activeResolutions(resolutions.filter(r => Date.parse(r.created_at) <= now.getTime()), project.id), inPeriod = [...resolvedNow.values()].filter(r => inWindow(r.created_at)), closed = inPeriod.filter(r => r.action === 'resolve'), excludedNow = inPeriod.filter(r => r.action === 'exclude');
    if (!fresh.length && !closed.length && !excludedNow.length) { quiet.push(`- ${head}\n  - ${outcomeLine(project)}`); continue; }
    // NOWと同じ基準で、発生日時の順に最新の作業要約を選ぶ。期間開始時点は、その時点までに届いていた入力だけで決める。
    const byOccurred = (a: Unit, b: Unit) => Date.parse(a.input.occurred_at) - Date.parse(b.input.occurred_at) || a.input.id.localeCompare(b.input.id);
    const summaries = mine.filter(u => u.input.kind === 'work-summary').sort(byOccurred);
    const latestNow = summaries.at(-1), latestThen = summaries.filter(u => resultThen(u)).at(-1), thenResult = latestThen ? resultThen(latestThen) : undefined;
    const added = fresh.filter(u => u.input.kind === 'action' && inWindow(u.input.received_at) && !movedAt.has(u.input.id));
    const out = [`### ${head}`, `- ${outcomeLine(project)}`, `- 新しい入力: ${fresh.length}件（作業要約 ${fresh.filter(u => u.input.kind === 'work-summary').length} / メモ ${fresh.filter(u => u.input.kind === 'memo').length}${added.length ? ` / 行動 ${added.length}` : ''}${fresh.some(corrected) ? ` / うち期間内の訂正 ${fresh.filter(corrected).length}` : ''}）`];
    for (const [title, key] of [['現在地', 'current'], ['次の一手', 'next']] as const) {
      const then = thenResult ? confirmed(thenResult.extracted[key]) : [], current = latestNow ? confirmed(groundedResult(latestNow.unit.chain, latestNow.unit.receipt!.input_id, latestNow.unit.receipt!.result!).extracted[key]) : [];
      const change = diff(then, current);
      if (!change.added.length && !change.removed.length) { out.push(`- ${title}の変化: なし`); continue; }
      out.push(`- ${title}の変化（${latestNow ? ref(latestNow.input) : '根拠なし'}）:`);
      for (const text of change.added.slice(0, 10)) out.push(`  - 追加: ${clip(text)}`);
      for (const text of change.removed.slice(0, 10)) out.push(`  - 外れた: ${clip(text)}`);
    }
    // 期間内に本人が次の一手へ追加した行動と、そのうち今も完了の報告が有効なもの。
    if (added.length) {
      const text = (u: Unit) => u.unit.chain.latest.text, done = (u: Unit) => resolvedNow.get(itemKey(project.id, 'next', u.input.id, text(u)))?.action === 'resolve';
      out.push(`- 期間内に本人が追加した行動: ${added.length}件（うち完了 ${added.filter(done).length}件）`);
      for (const u of [...added].sort((a, b) => Date.parse(b.input.received_at) - Date.parse(a.input.received_at)).slice(0, 5)) out.push(`  - ${done(u) ? '完了' : '未完了'}: ${clip(text(u))} ${ref(u.input)}`);
    }
    if (closed.length) {
      out.push(`- 期間内に完了・解決と報告した項目: ${closed.length}件`);
      for (const r of closed.slice(-5).reverse()) out.push(`  - ${r.section === 'next' ? '完了' : '解決'}: ${clip(r.text)}（${label(r.created_at)} ${r.id}）`);
    }
    // AIの読み違いなどとして外した項目は、完了・解決と分けて数える。
    if (excludedNow.length) {
      out.push(`- 期間内に誤りとして外した項目: ${excludedNow.length}件`);
      for (const r of excludedNow.slice(-5).reverse()) out.push(`  - ${r.reason ? exclusionReasonLabels[r.reason] : '誤り'}: ${clip(r.text)}（${label(r.created_at)} ${r.id}）`);
    }
    if (fresh.length) out.push('- 主な入力:');
    const lastReceived = (u: Unit) => Math.max(...evidenceOf(u).filter(i => inWindow(i.received_at)).map(i => Date.parse(i.received_at)));
    for (const u of [...fresh].sort((a, b) => lastReceived(b) - lastReceived(a)).slice(0, 5)) {
      const summary = u.input.kind === 'action' ? `本人が追加した行動: ${u.unit.chain.latest.text}` : u.unit.receipt?.result?.summary;
      out.push(`  - ${ref(u.input)} ${inputWhen(u.input, label)} ${summary ? clip(summary) : `（${state(u) === 'failed' ? '整理失敗' : '整理待ち'}）`}${corrected(u) ? ' / 期間内に訂正' : ''}${u.unit.pendingCorrection ? ' / 訂正未反映' : ''}${u.input.project !== project.id ? ' / 関連候補（AI推定）' : ''}`);
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
  if (inactive.length) lines.push(merged.size ? '## 休止・完了・統合済み' : '## 休止・完了', ...inactive, '');
  // プロジェクトを決めずに本人が追加した行動。残っている件数と、期間内に追加・完了・却下した件数を示す（項目キーは最新の文面で決まる）。
  const ownAll = units.filter(u => u.input.kind === 'action' && u.input.project === undefined && Date.parse(u.input.received_at) <= now.getTime());
  const own = ownAll.filter(u => !movedAt.has(u.input.id)), movedOut = ownAll.filter(u => inWindow(movedAt.get(u.input.id) ?? '')).length;
  if (own.length || movedOut) {
    const closedNow = activeResolutions(resolutions.filter(r => Date.parse(r.created_at) <= now.getTime()), UNASSIGNED_SCOPE);
    const text = (u: Unit) => u.unit.chain.latest.text, state = (u: Unit) => closedNow.get(itemKey(UNASSIGNED_SCOPE, 'next', u.input.id, text(u)));
    // 連絡待ちの印を付けた行動は「残っている行動」に数えず、下の「連絡待ち」に示す（HOMEとアプリの件数と同じ）。
    let waitingKeys = new Set<string>();
    // 「いつかやる」へ移した行動も「残っている行動」に数えず、下の「いつかやる」に示す。
    let somedayKeys = new Set<string>();
    try { const items = (await readNowItems(vault, UNASSIGNED_SCOPE))?.items ?? []; waitingKeys = new Set(items.filter(i => i.resolution === null && i.waiting && !i.someday).map(i => i.key)); somedayKeys = new Set(items.filter(i => i.resolution === null && i.someday).map(i => i.key)); } catch { /* 壊れた項目一覧はHOMEとdoctorで示す。 */ }
    const keyOf = (u: Unit) => itemKey(UNASSIGNED_SCOPE, 'next', u.input.id, text(u));
    const waitingOwn = (u: Unit) => !state(u) && waitingKeys.has(keyOf(u)), somedayOwn = (u: Unit) => !state(u) && somedayKeys.has(keyOf(u));
    const remaining = own.filter(u => !state(u) && !waitingOwn(u) && !somedayOwn(u)), parked = own.filter(waitingOwn).length, someday = own.filter(somedayOwn).length, added = ownAll.filter(u => inWindow(u.input.received_at));
    const closedIn = (action: 'resolve' | 'exclude') => own.filter(u => { const r = state(u); return r?.action === action && inWindow(r.created_at); });
    const done = closedIn('resolve'), dropped = closedIn('exclude');
    const oldest = [...remaining].sort((a, b) => Date.parse(a.input.received_at) - Date.parse(b.input.received_at) || a.input.id.localeCompare(b.input.id));
    const others = [parked ? `連絡待ち ${parked}件` : '', someday ? `いつかやる ${someday}件` : ''].filter(Boolean).join('・');
    lines.push('## プロジェクト未定の行動', `- 残っている行動: ${remaining.length}件${others ? `（ほかに${others}）` : ''} / 期間内に追加 ${added.length}件・完了 ${done.length}件・却下 ${dropped.length}件${movedOut ? `・プロジェクトへ移した ${movedOut}件` : ''}`);
    for (const u of [...done].sort((a, b) => state(b)!.id.localeCompare(state(a)!.id)).slice(0, 5)) lines.push(`  - 完了: ${clip(text(u))} ${ref(u.input)}`);
    if (oldest.length) lines.push(`- 残っている行動（追加した順に最大5件）:`, ...oldest.slice(0, 5).map(u => `  - ${clip(text(u))} ${ref(u.input)}（${daysSince(u.input.received_at, now)}日前に追加）`));
    lines.push('');
  }
  // 本人が連絡待ちの印を付けている項目（進行中のプロジェクトとプロジェクト未定の行動）。今の項目一覧から数え、長く待っている順に示す。
  {
    const today = todayIn(config.timezone, now), waits: { days: number; since: string; place: string; text: string; who?: string }[] = [];
    const lists: { id: string; place: string }[] = [...projects.filter(p => !merged.has(p.id) && lifecycleOf(p) === 'active').map(p => ({ id: p.id, place: `[${plain(p.title)}](10_projects/${p.id}/NOW.md)` })), { id: UNASSIGNED_SCOPE, place: UNASSIGNED_TITLE }];
    for (const { id, place } of lists) {
      let list; try { list = await readNowItems(vault, id); } catch { continue; /* 壊れた項目一覧はHOMEとdoctorで示す。 */ }
      for (const i of list?.items ?? []) if (i.resolution === null && i.waiting && !i.someday && (id !== UNASSIGNED_SCOPE || i.action)) waits.push({ days: waitingDays(i.waiting.since, today), since: i.waiting.since, place, text: `${i.section === 'next' ? '次の一手: ' : i.label ? '' : '未解決: '}${clip(i.label + i.text)}`, ...(i.waiting.who ? { who: i.waiting.who } : {}) });
    }
    if (waits.length) {
      const long = waits.filter(w => w.days >= WAITING_LONG_DAYS).length;
      lines.push('## 連絡待ち', `- 連絡待ちの項目: ${waits.length}件（うち${WAITING_LONG_DAYS}日以上 ${long}件）`, '- 長く待っている項目（頼んだ日の古い順に最大5件）:');
      for (const w of waits.sort((a, b) => a.since.localeCompare(b.since)).slice(0, 5)) lines.push(`  - ${w.place} ${w.text}（${w.who ? `相手: ${plain(w.who)}・` : ''}頼んでから${w.days}日）`);
      lines.push('');
    }
  }
  // 「いつかやる」の件数と、長く見直していないもの（移した項目・休止中のプロジェクト・置いたアイデア）。
  try { lines.push(...somedayDigestLines(await buildSomedayList(config, vault, now, projects), todayIn(config.timezone, now))); } catch { /* 壊れた記録はHOMEとdoctorで示す。 */ }
  lines.push('## 確認待ちの候補');
  if (!pending.length) lines.push('確認待ちの候補はありません。');
  for (const c of [...pending].sort((a, b) => (Date.parse(since(a) ?? '') || 0) - (Date.parse(since(b) ?? '') || 0))) {
    const at = since(c);
    lines.push(`- [${plain(c.title)}](${c.path})${c.duplicates?.length ? `（根拠のメモ${c.duplicates.length + 1}件）` : ''}${at ? ` — ${daysSince(at, now)}日前から` : ''}`);
  }
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
