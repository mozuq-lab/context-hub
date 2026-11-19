import { z } from 'zod';
import { listText } from './markdown-text.js';
import { Vault } from './storage.js';
import { dateLabel } from './views.js';
import type { EffectiveInput } from './effective-inputs.js';
import {
  OPENCLAW_WAIT_MS, readSynthesisRuns, synthesisState, synthesisWarnings, SYNTHESIS_ERROR_KINDS, SYNTHESIS_MAX_ATTEMPTS,
  type SynthesisErrorKind, type SynthesisRun, type SynthesisState,
} from './synthesis.js';
import { SYNTHESIS_ITEMS_PER_SECTION, SYNTHESIS_SECTIONS, SYNTHESIS_SECTION_LABELS } from './synthesis-prompt.js';
import type { HubConfig } from './types.js';

/**
 * 今週の気づき（90_system/insights.json）。
 * 週次の統合の記録のうち、最後に成功した回の結果を、根拠のメモの場所・日付と合わせた一覧。HOME・ふりかえり・アプリのホームが同じ内容を示す。
 * 表示だけの派生物で、実行の記録（90_system/synthesis/）から作り直せる。統合を一度も有効にしていなければ作らない。
 * 項目はAI生成・未検証。根拠のメモが後から訂正されたら、訂正ありと示す（項目は作り直さない）。
 */
export const insightsPath = '90_system/insights.json';

const instant = z.string().datetime();
const inputId = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
const count = z.number().int().nonnegative();
const runId = z.string().regex(/^SYN-[0-9A-HJKMNP-TV-Z]{26}$/);
const itemSchema = z.object({
  /** 項目のキー。反応や答えを結び付けるときに使う。 */ key: z.string().regex(/^[a-f0-9]{64}$/),
  section: z.enum(SYNTHESIS_SECTIONS),
  /** モデルが書いた本文（AI生成・未検証）。 */ text: z.string().min(1),
  /** 止まっている意図の、最初の一歩。 */ first_step: z.string().min(1).optional(),
  sources: z.array(z.object({
    /** 根拠のメモ。 */ input_id: inputId,
    /** 根拠のメモの原文。 */ path: z.string().regex(/^00_inbox\/.+\.md$/),
    occurred_at: z.string().refine(s => Number.isFinite(Date.parse(s))),
    /** 気づきを作った後に、このメモへ訂正が届いたか。 */ corrected: z.boolean(),
  }).strict()).min(1),
}).strict();
export const insightsSchema = z.object({
  schema_version: z.literal(1), generated_at: instant,
  /** 設定で統合が有効か。無効のときlatest・last_attemptはnull。 */ enabled: z.boolean(),
  interval_days: z.number().int().positive(),
  /** 最後に成功した実行の結果。足せる気づきがなかった回はitemsが空。まだ成功していなければnull。 */
  latest: z.object({
    id: runId, created_at: instant, mode: z.enum(['first', 'weekly', 'quiet']),
    period: z.object({ since: instant.nullable(), until: instant }).strict(),
    counts: z.object({ new_memos: count, focus: count, context: count, omitted: count }).strict(),
    items: z.array(itemSchema).max(SYNTHESIS_SECTIONS.length * SYNTHESIS_ITEMS_PER_SECTION),
  }).strict().nullable(),
  /** 最後の実行（失敗を含む）。runningは、開始の記録だけがあり、まだ実行中かもしれない状態。elapsed_msは呼び出しの所要時間の合計。 */
  last_attempt: z.object({ id: runId, created_at: instant, status: z.enum(['ok', 'empty', 'failed', 'running']), error: z.enum(SYNTHESIS_ERROR_KINDS).nullable(), warnings: z.array(z.enum(['partial', 'slow'])), elapsed_ms: count }).strict().nullable(),
  /** 次に自動で実行する時刻（新しい入力がなければ、その後も実行しない）。まだ実行していなければnull。 */ next_due_at: instant.nullable(),
  /** 読めない実行の記録の件数。1件でもあると自動では実行しない。 */ record_problems: count,
}).strict();
export type Insights = z.infer<typeof insightsSchema>;
export type InsightItem = NonNullable<Insights['latest']>['items'][number];
export interface InsightsBuild { insights: Insights; /** 統合が無効のときはundefined。 */ state?: SynthesisState }

/**
 * 開始の記録だけがあり、まだ実行中かもしれないか。時間の上限に余裕を足した時間が過ぎるまでは、失敗と示さない。
 * 実行するかの判定では、開始の記録も1回の実行として数える（synthesisState）。ここは表示だけに使う。
 */
export function synthesisMayBeRunning(config: HubConfig, run: SynthesisRun | undefined, now: Date): boolean {
  return run?.error === 'interrupted' && !run.calls.length && now.getTime() - Date.parse(run.created_at) < config.synthesis.timeoutSec * 1000 + RUNNING_GRACE_MS;
}
const RUNNING_GRACE_MS = 60_000;

/** 実行の記録と、いまの入力（根拠のメモの場所と訂正の有無）から一覧を組み立てる。根拠のメモが1件も見つからない項目は載せない。 */
export function buildInsights(config: HubConfig, state: SynthesisState | undefined, units: EffectiveInput[], now = new Date()): Insights {
  const head = { schema_version: 1 as const, generated_at: now.toISOString() }, interval_days = config.synthesis.intervalDays;
  if (!config.synthesis.enabled || !state) return { ...head, enabled: false, interval_days, latest: null, last_attempt: null, next_due_at: null, record_problems: 0 };
  const chains = new Map(units.map(u => [u.chain.root.id, u.chain])), latest = state.lastShown, last = state.lastAttempt;
  const items = (latest?.items ?? []).flatMap((item): InsightItem[] => {
    const sources = item.sources.flatMap(s => { const chain = chains.get(s.input_id); return chain ? [{ input_id: s.input_id, path: chain.root.path, occurred_at: chain.root.occurred_at, corrected: chain.latest.id !== s.latest_id }] : []; });
    const built = { key: item.key, section: item.section, text: item.text, ...(item.first_step ? { first_step: item.first_step } : {}), sources };
    // 形式に合わない項目は載せない。一覧のファイルを、読む側がいつも検証できる形に保つ。
    return itemSchema.safeParse(built).success ? [built] : [];
  });
  // キーの順序を形式の定義にそろえる（前回の内容と比べて、同じなら書き直さないため）。
  return insightsSchema.parse({
    ...head, enabled: true, interval_days,
    latest: latest ? { id: latest.id, created_at: latest.created_at, mode: latest.mode, period: latest.period, counts: latest.counts, items } : null,
    last_attempt: last ? { id: last.id, created_at: last.created_at, ...(synthesisMayBeRunning(config, last, now) ? { status: 'running' as const, error: null } : { status: last.status, error: last.error }), warnings: synthesisWarnings(last), elapsed_ms: last.calls.reduce((sum, c) => sum + c.elapsed_ms, 0) } : null,
    next_due_at: state.nextDueAt, record_problems: state.problems.length,
  } satisfies Insights);
}

/** 一覧を組み立てる（書き込まない）。統合が無効のときは、実行の記録を読まない。 */
export async function readInsights(config: HubConfig, vault: Vault, units: EffectiveInput[], now = new Date()): Promise<InsightsBuild> {
  const state = config.synthesis.enabled ? synthesisState(config, await readSynthesisRuns(vault)) : undefined;
  return { insights: buildInsights(config, state, units, now), state };
}

/**
 * Writerロックを持つ呼び出し元から使う。内容が前回と同じなら書き込まず、同期のたびに差分を作らない。
 * 統合が無効で一覧のファイルもなければ、何も作らない（一度も有効にしていないVaultを変えない）。有効にした後で無効へ戻したときは、一覧を空にする。
 */
export async function rebuildInsightsLocked(config: HubConfig, vault: Vault, units: EffectiveInput[], now = new Date()): Promise<InsightsBuild> {
  const raw = await vault.read(insightsPath), build = await readInsights(config, vault, units, now);
  if (!config.synthesis.enabled && raw === undefined) return build;
  let old: Insights | undefined;
  if (raw !== undefined) try { old = insightsSchema.parse(JSON.parse(raw)); } catch { /* 壊れた一覧は作り直す。 */ }
  if (old && JSON.stringify({ ...old, generated_at: '' }) === JSON.stringify({ ...build.insights, generated_at: '' })) return { ...build, insights: old };
  await vault.write(insightsPath, JSON.stringify(build.insights, null, 2) + '\n');
  return build;
}

const DAY = 86_400_000;
const daysAgo = (iso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY));
/** リンク先。空白や括弧を含むパスは、リンクが途中で切れないよう山括弧で囲む。 */
const destination = (path: string) => /[\s()]/.test(path) ? `<${path}>` : path;
/**
 * 箇条書きの行頭に置くモデルの本文。行頭の記号が、見出し・引用・入れ子の箇条書き・区切り線・コードブロックとして読まれないよう、
 * バックスラッシュで打ち消す（「1. 」のような番号は、点の前に入れる）。
 */
const leadText = (text: string): string => {
  const safe = listText(text);
  return /^[#>+\-*=_~`]/.test(safe) ? `\\${safe}` : safe.replace(/^(\d{1,9})([.)])/, '$1\\$2');
};

/**
 * HOMEとふりかえりの「今週の気づき」（前後の空行は含めない）。示す項目がなければ空文字。
 * モデルが書いた本文は、見出し・リンク・HTMLとして読まれないよう無害化して1行で載せる。
 */
export function insightsSection(config: HubConfig, insights: Insights, now = new Date()): string {
  const latest = insights.latest;
  if (!insights.enabled || !latest?.items.length) return '';
  const day = (iso: string) => dateLabel(iso, config.timezone).slice(0, 10), age = daysAgo(latest.created_at, now), { counts } = latest;
  const row = (item: InsightItem) => `- ${leadText(item.text)}${item.first_step ? `（最初の一歩: ${listText(item.first_step)}）` : ''} — 根拠: ${item.sources.map(s => `[${day(s.occurred_at)}のメモ](${destination(s.path)})${s.corrected ? '（訂正あり）' : ''}`).join('、')}`;
  const blocks = SYNTHESIS_SECTIONS.flatMap(section => {
    const rows = latest.items.filter(item => item.section === section).map(row);
    return rows.length ? [`### ${SYNTHESIS_SECTION_LABELS[section]}\n${rows.join('\n')}`] : [];
  });
  const scope = `全文で渡したメモ${counts.focus}件${counts.context ? `、1行にして渡したメモ${counts.context}件` : ''}${counts.omitted ? `、渡していないメモ${counts.omitted}件` : ''}`;
  const intro = [
    `${day(latest.created_at)}に、たまったメモをAIがまとめて読み直した結果です（${scope}）。`,
    ...(latest.mode === 'quiet' ? ['新しく届いたメモが少なかったので、以前のメモの見直しを中心にしています。'] : []),
    // 間隔を過ぎても新しい結果がないとき（新しい入力がない・実行に失敗した）は、古い結果だと分かるようにする。
    ...(age > insights.interval_days ? [`${age}日前の結果です。`] : []),
    'AIの推定であり、事実や本人の決定ではありません。「根拠」のメモを確かめてから使ってください。',
  ].join('');
  return `## 今週の気づき（AI生成・未検証）\n${intro}\n\n${blocks.join('\n\n')}`;
}

const errorLabels: Record<SynthesisErrorKind, string> = { 'invalid-output': '応答の形式が不正', timeout: '応答待ちの時間切れ', 'prompt-too-large': '送る内容が大きすぎる', 'llm-error': 'モデルの呼び出しに失敗', interrupted: '実行が途中で止まった' };
/** HOMEの「失敗と競合」に載せる行。最後の実行の失敗・一部の失敗・所要時間の注意と、読めない記録を示す。統合が無効のときは空。 */
export function insightsNotices(config: HubConfig, build: InsightsBuild, now = new Date()): string[] {
  const state = build.state, last = state?.lastAttempt, lines: string[] = [];
  if (!state) return lines;
  const when = (iso: string) => dateLabel(iso, config.timezone);
  if (last?.status === 'failed' && !synthesisMayBeRunning(config, last, now)) {
    const next = state.nextDueAt ? `次の自動実行は${when(state.nextDueAt)}以降です。` : '';
    const kept = state.lastShown?.items.length ? '前回までの気づきは表示したままにしています。' : '';
    lines.push(`- 週次の統合に失敗しました（${errorLabels[last.error ?? 'llm-error']}）。${when(last.created_at)}の実行です。${kept}${next}${state.failedStreak < SYNTHESIS_MAX_ATTEMPTS
      ? `すぐにやり直すには \`ctx cycle --retry-failed\`（連続${SYNTHESIS_MAX_ATTEMPTS}回まで）か \`ctx synthesize --force\` を実行してください。`
      : `${state.failedStreak}回続けて失敗しています。設定のsynthesisとモデルの状態を確かめてから \`ctx synthesize --force\` でやり直せます。`}`);
  }
  if (last) {
    const warnings = synthesisWarnings(last);
    if (warnings.includes('partial')) lines.push(`- 週次の統合で、${last.calls.length}回の呼び出しのうち${last.calls.filter(c => c.error !== null).length}回が失敗しました。成功した分だけを載せています。`);
    if (warnings.includes('slow')) {
      const slowest = Math.max(...last.calls.map(c => c.slowest_ms));
      lines.push(`- 週次の統合で、モデルの応答に${Math.round(slowest / 1000)}秒かかりました。OpenClawの待ち時間（${OPENCLAW_WAIT_MS / 1000}秒）${slowest >= OPENCLAW_WAIT_MS ? 'を超えています' : 'に近づいています'}。設定のsynthesis.maxFocusMemos・synthesis.maxContextMemosを減らすか、synthesis.thinkingを下げてください。`);
    }
  }
  for (const path of state.problems) lines.push(`- [週次の統合の記録が不正です](${destination(path)})（直すか別の場所へ移すまで、自動では実行しません）`);
  return lines;
}
