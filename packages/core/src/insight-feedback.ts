import { z } from 'zod';
import { Vault } from './storage.js';
import type { EffectiveInput } from './effective-inputs.js';

/**
 * 今週の気づきへの本人の反応と、問いへの答え。
 * - 反応（役に立った・的外れ）は、アプリの依頼（insight-reaction）で90_system/insight-reactions/に記録する。
 *   同じ項目への反応は、本人が判断した日時が最後のものを有効にし、noneで外す。記録は書き換えない。
 * - 答えは、ふつうのメモ（capture）に、どの気づきへの答えかをmetaで添えて保存する。新しい受付操作は使わない。
 * - 次の週次の統合に、前回の項目への反応と答えの有無、答えのメモが答えている問いを渡す。ふりかえりに実行ごとの件数を出す。
 * 依頼を記録する処理（setInsightReaction）は、実行の記録を確かめるため insights.ts にある。
 */
export const insightRunIdSchema = z.string().regex(/^SYN-[0-9A-HJKMNP-TV-Z]{26}$/);
export const insightItemKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const insightReactionIdSchema = z.string().regex(/^IRX-[0-9A-HJKMNP-TV-Z]{26}$/);
/** noneは、前の反応を外す依頼。 */
export const INSIGHT_REACTIONS = ['useful', 'off-target', 'none'] as const;
export type InsightReactionValue = (typeof INSIGHT_REACTIONS)[number];
export const insightReactionValueSchema = z.enum(INSIGHT_REACTIONS);
export const insightReactionSchema = z.object({
  schema_version: z.literal(1), id: insightReactionIdSchema, run_id: insightRunIdSchema, item_key: insightItemKeySchema, reaction: insightReactionValueSchema,
  /** 本人が判断した日時（アプリの依頼の発生日時。記録した日時より後にはしない）。同じ項目の反応はこの順で最後のものを有効にする。 */
  decided_at: z.string().datetime({ offset: true }),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type InsightReaction = z.infer<typeof insightReactionSchema>;
export const insightReactionDir = '90_system/insight-reactions';
export const insightReactionPath = (id: string): string => `${insightReactionDir}/${id}.json`;
/** 実行と項目の組の鍵。 */
export const insightItemRef = (runId: string, itemKey: string): string => `${runId}|${itemKey}`;

/** 反応の記録を読む。読めない記録・名前とIDが合わない記録はproblemsに返し、一覧やHOMEを止めない（doctorで示す）。 */
export async function readInsightReactions(vault: Vault): Promise<{ records: InsightReaction[]; problems: string[] }> {
  const records: InsightReaction[] = [], problems: string[] = [];
  for (const path of await vault.files(insightReactionDir)) {
    if (!path.endsWith('.json')) continue;
    try {
      const record = insightReactionSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== insightReactionPath(record.id)) throw new Error('名前とIDが合いません');
      records.push(record);
    } catch { problems.push(path); }
  }
  return { records, problems };
}

/** 項目ごとの有効な反応。判断した日時が最後の反応を採り、noneなら反応なしとして載せない。 */
export function latestInsightReactions(records: InsightReaction[]): Map<string, Exclude<InsightReactionValue, 'none'>> {
  const order = [...records].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at) || Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  const latest = new Map<string, InsightReactionValue>();
  for (const record of order) latest.set(insightItemRef(record.run_id, record.item_key), record.reaction);
  const result = new Map<string, Exclude<InsightReactionValue, 'none'>>();
  for (const [ref, value] of latest) if (value !== 'none') result.set(ref, value);
  return result;
}

/** 答えのメモに付けるmeta。capture_modeで答えだと示し、どの実行のどの項目への答えかと、そのときの問いの本文を残す。 */
export const INSIGHT_ANSWER_MODE = 'insight-answer';
export interface InsightAnswer { inputId: string; path: string; occurredAt: string; runId: string; itemKey: string }
/** 1つの項目に結び付けて示す答えの上限（新しい順に残す）。 */
export const INSIGHT_ANSWERS_MAX = 20;

/** メモが今週の気づきへの答えなら、答えている問いの本文を返す（metaの値。AIが書いた問い）。 */
export function insightAnswerQuestion(meta: Record<string, string> | undefined): string | undefined {
  if (meta?.capture_mode !== INSIGHT_ANSWER_MODE) return undefined;
  const question = meta.insight_question?.trim();
  return question ? question : undefined;
}

/** 有効な入力のうち、気づきへの答えのメモを、実行と項目の組ごとに古い順で返す。答え先の形が不正なメモは結び付けない。 */
export function insightAnswers(units: EffectiveInput[]): Map<string, InsightAnswer[]> {
  const result = new Map<string, InsightAnswer[]>();
  for (const { chain } of units) {
    const root = chain.root, meta = root.meta;
    if (meta?.capture_mode !== INSIGHT_ANSWER_MODE) continue;
    const run = insightRunIdSchema.safeParse(meta.insight_run), key = insightItemKeySchema.safeParse(meta.insight_key);
    if (!run.success || !key.success) continue;
    const ref = insightItemRef(run.data, key.data), list = result.get(ref) ?? [];
    list.push({ inputId: root.id, path: root.path, occurredAt: root.occurred_at, runId: run.data, itemKey: key.data });
    result.set(ref, list);
  }
  for (const list of result.values()) list.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.inputId.localeCompare(b.inputId));
  return result;
}

/** 本人の反応と答え。週次の統合と一覧の両方が使う。 */
export interface InsightFeedback { reactions: Map<string, Exclude<InsightReactionValue, 'none'>>; answers: Map<string, InsightAnswer[]>; problems: string[] }
/**
 * 反応の記録の場所を走査できない（symlinkなど）ときは、反応なしとして扱い、今週の気づきや週次の統合を止めない（doctorで示す）。
 */
export async function readInsightFeedback(vault: Vault, units: EffectiveInput[]): Promise<InsightFeedback> {
  let read: { records: InsightReaction[]; problems: string[] };
  try { read = await readInsightReactions(vault); } catch { read = { records: [], problems: [insightReactionDir] }; }
  return { reactions: latestInsightReactions(read.records), answers: insightAnswers(units), problems: read.problems };
}

/** 実行ごとの件数（ふりかえりに出す。段階3へ進むかの判断の材料）。 */
export interface InsightFeedbackTally { runId: string; createdAt: string; items: number; useful: number; offTarget: number; answered: number }
/** ふりかえりに出す実行の数（新しい順）。 */
export const INSIGHT_TALLY_RUNS = 4;
/** 項目を出した実行のうち新しいものから、項目数と、有効な反応・答えのある項目の数を数える。 */
export function insightFeedbackTallies(runs: { id: string; created_at: string; status: string; items: { key: string }[] }[], feedback: InsightFeedback, limit = INSIGHT_TALLY_RUNS): InsightFeedbackTally[] {
  return runs.filter(run => run.status === 'ok').slice(-limit).reverse().map(run => {
    const refs = run.items.map(item => insightItemRef(run.id, item.key));
    return {
      runId: run.id, createdAt: run.created_at, items: run.items.length,
      useful: refs.filter(ref => feedback.reactions.get(ref) === 'useful').length,
      offTarget: refs.filter(ref => feedback.reactions.get(ref) === 'off-target').length,
      answered: refs.filter(ref => (feedback.answers.get(ref)?.length ?? 0) > 0).length,
    };
  });
}
