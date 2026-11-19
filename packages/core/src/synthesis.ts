import { ulid } from 'ulid';
import { z } from 'zod';
import { readEffectiveInputs } from './effective-inputs.js';
import { insightItemRef, readInsightFeedback } from './insight-feedback.js';
import { PromptTooLargeError } from './infer.js';
import { logOperation } from './logger.js';
import { readProjects } from './projects.js';
import { completeRedacted, redactPrompt, redactText, secretSettings } from './secrets.js';
import { hash, LockTimeoutError, Vault } from './storage.js';
import {
  buildSynthesisBrief, buildSynthesisPrompt, InvalidSynthesisOutput, mergeSynthesisDrafts, synthesisRepeatKey, validateSynthesisOutput,
  SYNTHESIS_DROP_REASONS, SYNTHESIS_FIRST_STEP_CHARS, SYNTHESIS_MAX_SOURCES, SYNTHESIS_ITEMS_PER_SECTION, SYNTHESIS_MAX_OUTPUT_CHARS, SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SECTIONS, SYNTHESIS_TEXT_CHARS,
  type SynthesisBrief, type SynthesisDraft, type SynthesisDrop, type SynthesisMode,
} from './synthesis-prompt.js';
import type { HubConfig, LlmClient, LlmCompletion } from './types.js';

/**
 * 週次の統合。たまったメモをモデルがまとめて読み、メモ1件を読むだけでは分からないことを返す。
 * - 設定（synthesis.enabled）で有効にしたときだけ動く。モデルの呼び出しは間隔（synthesis.intervalDays）ごとに1回で、形式が崩れたときだけ1回作り直させる。
 * - 実行のたびに、結果・所要時間・渡した件数を90_system/synthesis/<ID>.jsonへ残す。モデルを呼ぶ前に開始を記録し、終わったら同じ記録を結果で置き換える。
 * - 失敗した回・途中で止められた回の後は、次の間隔まで自動では実行しない（本人が再試行を明示したときを除く）。モデルの障害やジョブの制限時間で、毎回の呼び出しを重ねないため。
 * - 時間の上限（synthesis.timeoutSec）は、形式の作り直しと分けた呼び出しを含む実行全体に掛ける。
 * - 結果はAI生成・未検証。HOME・ふりかえり・アプリへの表示は insights.ts が作る。
 */
export const synthesisDir = '90_system/synthesis';
export const synthesisRunPath = (id: string): string => `${synthesisDir}/${id}.json`;
/** 所要時間がこれ以上の呼び出しは、OpenClawの待ち時間に近いとして注意を示す。 */
export const SYNTHESIS_SLOW_MS = 90_000;
/** OpenClawのGatewayが応答を待つ時間（設定では変えられない）。これを超える呼び出しは完走しない。 */
export const OPENCLAW_WAIT_MS = 120_000;
/** 失敗が続いたとき、再試行の明示（--retry-failed）でやり直せる回数。これ以降は次の間隔を待つ。 */
export const SYNTHESIS_MAX_ATTEMPTS = 3;
/** 残りの時間がこれに満たなければ、形式の作り直しや次の呼び出しを始めない（終わる見込みのない呼び出しをしない）。 */
export const SYNTHESIS_MIN_CALL_MS = 30_000;
/** interruptedは、開始を記録したまま結果が残っていない実行（ジョブの制限時間・再起動などで途中で止められた）。 */
export const SYNTHESIS_ERROR_KINDS = ['invalid-output', 'timeout', 'prompt-too-large', 'llm-error', 'interrupted'] as const;
export type SynthesisErrorKind = (typeof SYNTHESIS_ERROR_KINDS)[number];
const DAY = 86_400_000;

const instant = z.string().datetime();
const inputId = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
const count = z.number().int().nonnegative();
const errorKind = z.enum(SYNTHESIS_ERROR_KINDS);
const runItemSchema = z.object({
  /** 項目のキー。実行・欄・根拠・本文から決まる。 */ key: z.string().regex(/^[a-f0-9]{64}$/),
  section: z.enum(SYNTHESIS_SECTIONS),
  /** モデルが書いた本文（AI生成・未検証）。1行。 */ text: z.string().min(1).max(SYNTHESIS_TEXT_CHARS * 2),
  /** 止まっている意図の、最初の一歩。 */ first_step: z.string().min(1).max(SYNTHESIS_FIRST_STEP_CHARS * 2).optional(),
  /** 根拠のメモ。latest_idは実行時点での訂正チェーンの最新の入力で、後から訂正が届いたかの判定に使う。 */
  sources: z.array(z.object({ input_id: inputId, latest_id: inputId }).strict()).min(1).max(SYNTHESIS_MAX_SOURCES),
}).strict();
export const synthesisRunSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(/^SYN-[0-9A-HJKMNP-TV-Z]{26}$/),
  /** ok: 項目あり / empty: 応答は正しいが足せる項目なし / failed: すべての呼び出しが失敗。 */ status: z.enum(['ok', 'empty', 'failed']),
  /** first: 初回 / weekly: 新しく届いたメモが中心 / quiet: 新しいメモが少なく、以前のメモの見直し。 */ mode: z.enum(['first', 'weekly', 'quiet']),
  created_at: instant,
  /** sinceより後に届いたメモを新しいメモとして扱った。初回はnull。untilは実行時刻。 */ period: z.object({ since: instant.nullable(), until: instant }).strict(),
  llm: z.object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(400), thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high']), prompt_version: z.number().int().positive() }).strict(),
  /** 新しく届いたメモ、全文で渡したメモ、1行にして渡したメモ、上限のため渡さなかったメモの件数。 */
  counts: z.object({ new_memos: count, focus: count, context: count, omitted: count }).strict(),
  /**
   * モデルの呼び出しごとの記録。開始だけを記録した時点では空。
   * elapsed_msは形式の作り直しを含む所要時間、slowest_msは最も長くかかった1回の試行（OpenClawの待ち時間と比べる）。
   * attemptsは形式の作り直しを含む回数（時間が足りず始めなかった呼び出しは0）、prompt_bytesは最後に送ったプロンプトの大きさ、focusは全文で渡したメモの件数。
   */
  calls: z.array(z.object({ elapsed_ms: count, slowest_ms: count, attempts: z.number().int().min(0).max(2), prompt_bytes: count, focus: count, error: errorKind.nullable() }).strict()).max(4),
  items: z.array(runItemSchema).max(SYNTHESIS_SECTIONS.length * SYNTHESIS_ITEMS_PER_SECTION),
  /** 検証で落とした項目の欄と理由。本文は残さない。 */ dropped: z.array(z.object({ section: z.enum(SYNTHESIS_SECTIONS), reason: z.enum(SYNTHESIS_DROP_REASONS) }).strict()).max(600),
  error: errorKind.nullable(),
}).strict();
export type SynthesisRun = z.infer<typeof synthesisRunSchema>;

/** 実行の記録を古い順に読む。読めない記録・名前とIDが合わない記録はproblemsに返す（HOMEやcycleを止めない）。 */
export async function readSynthesisRuns(vault: Vault): Promise<{ runs: SynthesisRun[]; problems: string[] }> {
  const runs: SynthesisRun[] = [], problems: string[] = [];
  for (const path of await vault.files(synthesisDir)) {
    if (!path.endsWith('.json')) continue;
    try {
      const run = synthesisRunSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== synthesisRunPath(run.id)) throw new Error('名前とIDが合いません');
      runs.push(run);
    } catch { problems.push(path); }
  }
  runs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  return { runs, problems };
}

export interface SynthesisState {
  runs: SynthesisRun[]; problems: string[];
  /** 最後の実行（失敗を含む）。次に自動で実行する時刻の基準。 */ lastAttempt?: SynthesisRun;
  /** 最後に成功した実行（項目がなかった回を含む）。この後に届いたメモを新しいメモとして扱う。 */ lastSuccess?: SynthesisRun;
  /** 最後に項目を出した実行。同じ項目を繰り返さないための基準。 */ lastWithItems?: SynthesisRun;
  /**
   * HOMEとアプリに出す実行。ふつうは最後に成功した実行で、項目がなかった回の後は欄を出さない。
   * ただし、前回と同じ項目しか返らず繰り返しとして落とした回の後は、前回までの項目がいまも当てはまるので、最後に項目を出した実行を出す。
   */
  lastShown?: SynthesisRun;
  /** 末尾で続いている失敗の回数。 */ failedStreak: number;
  /** 次に自動で実行する時刻。まだ実行していなければnull。 */ nextDueAt: string | null;
}
export function synthesisState(config: HubConfig, records: { runs: SynthesisRun[]; problems: string[] }): SynthesisState {
  const { runs, problems } = records, lastAttempt = runs.at(-1);
  let failedStreak = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i]!.status === 'failed'; i--) failedStreak++;
  const lastSuccess = runs.findLast(r => r.status !== 'failed'), lastWithItems = runs.findLast(r => r.status === 'ok');
  const onlyRepeated = lastSuccess?.status === 'empty' && lastSuccess.dropped.length > 0 && lastSuccess.dropped.every(d => d.reason === 'repeated');
  return {
    runs, problems, lastAttempt, lastSuccess, lastWithItems, lastShown: onlyRepeated ? lastWithItems : lastSuccess, failedStreak,
    nextDueAt: lastAttempt ? new Date(Date.parse(lastAttempt.created_at) + config.synthesis.intervalDays * DAY).toISOString() : null,
  };
}

export type SynthesisWarning = 'partial' | 'slow';
/** partial: 複数回の呼び出しの一部が失敗した / slow: 所要時間がOpenClawの待ち時間に近い呼び出しがあった。 */
export function synthesisWarnings(run: SynthesisRun): SynthesisWarning[] {
  return [
    ...(run.status !== 'failed' && run.calls.some(c => c.error !== null) ? ['partial' as const] : []),
    ...(run.calls.some(c => c.slowest_ms >= SYNTHESIS_SLOW_MS) ? ['slow' as const] : []),
  ];
}

/** 統合に使うモデルの設定。接続先は整理と同じで、思考の深さと出力の上限だけを統合用にする。 */
export function synthesisLlmConfig(config: HubConfig): HubConfig['organize']['llm'] {
  return { ...config.organize.llm, thinking: config.synthesis.thinking, maxOutputChars: SYNTHESIS_MAX_OUTPUT_CHARS };
}

export interface SynthesisOptions {
  /** 実行時刻（検証用）。 */ now?: Date;
  /** 間隔・新しい入力の有無・記録の不正にかかわらず実行する。本人が明示したときだけ使う。 */ force?: boolean;
  /** 最後の実行が失敗していれば、間隔を待たずにやり直す（連続SYNTHESIS_MAX_ATTEMPTS回まで）。 */ retryFailed?: boolean;
}
export type SynthesisSkipReason = 'disabled' | 'record-problem' | 'not-due' | 'no-memos' | 'no-new-input';
export type SynthesisOutcome =
  | { ran: false; reason: Exclude<SynthesisSkipReason, 'not-due'> }
  | { ran: false; reason: 'not-due'; nextDueAt: string }
  | { ran: true; id: string; status: SynthesisRun['status']; mode: SynthesisMode; items: number; dropped: number; calls: number; warnings: SynthesisWarning[]; error?: SynthesisErrorKind };
export interface SynthesisPreview {
  enabled: boolean;
  /** いま実行すると、モデルを呼ぶか（無効のときは、有効にした場合）。 */ due: boolean;
  /** 実行しない理由。 */ reason?: Exclude<SynthesisSkipReason, 'disabled'>;
  mode: SynthesisMode;
  counts: SynthesisRun['counts'];
  /** モデルを呼ぶ回数（形式の作り直しを除く）。 */ calls: number;
  /** 呼び出しごとの、伏せ字の後のプロンプトの大きさ（バイト）。 */ prompt_bytes: number[];
  next_due_at: string | null;
}

interface Prepared { state: SynthesisState; skip?: Exclude<SynthesisSkipReason, 'disabled'>; brief?: SynthesisBrief; previousKeys: Set<string> }
/**
 * 記録と入力を読み、実行するかを決める。
 * - 読めない記録があるときは、前回の実行時刻が分からず呼び出しを重ねるおそれがあるので、自動では実行しない。
 * - 最後の実行（失敗を含む）から間隔が空くまでは実行しない。
 * - 前回の成功の後に新しい入力がなければ、同じ内容を読み直させない。
 * alwaysは、実行しないと決まった後も渡す内容を組み立てる（dry-runの表示用）。
 */
async function prepare(config: HubConfig, vault: Vault, now: Date, options: SynthesisOptions, always: boolean): Promise<Prepared> {
  const state = synthesisState(config, await readSynthesisRuns(vault)), last = state.lastAttempt;
  const blocked = options.force ? undefined
    : state.problems.length ? 'record-problem' as const
    : !last || (options.retryFailed && last.status === 'failed' && state.failedStreak < SYNTHESIS_MAX_ATTEMPTS) || now.getTime() >= Date.parse(state.nextDueAt!) ? undefined
    : 'not-due' as const;
  const shownRun = state.lastWithItems, shown = shownRun?.items ?? [];
  const previousKeys = new Set(shown.map(i => synthesisRepeatKey(i.section, i.sources.map(s => ({ inputId: s.input_id, latestId: s.latest_id })))));
  if (blocked && !always) return { state, skip: blocked, previousKeys };
  // 前回の項目に、本人の反応と答えのメモを添える（的外れと言われた方向を避け、答えた問いを聞き直さないため）。
  const units = await readEffectiveInputs(config), feedback = await readInsightFeedback(vault, units);
  const itemTexts = new Map(state.runs.flatMap(run => run.items.map(item => [insightItemRef(run.id, item.key), item.text] as const)));
  const brief = buildSynthesisBrief(config, units, await readProjects(config), {
    now, since: state.lastSuccess?.period.until, itemTexts,
    previous: shown.map(i => {
      const ref = insightItemRef(shownRun!.id, i.key), reaction = feedback.reactions.get(ref), answers = feedback.answers.get(ref) ?? [];
      return { section: i.section, text: i.text, sourceIds: i.sources.map(s => s.input_id), ...(reaction ? { reaction } : {}), ...(answers.length ? { answerIds: answers.map(a => a.inputId) } : {}) };
    }),
  });
  const skip = blocked ?? (!brief.plan.refs.size ? 'no-memos' as const : !options.force && state.lastSuccess && brief.plan.newMemos === 0 ? 'no-new-input' as const : undefined);
  return { state, skip, brief, previousKeys };
}
const countsOf = (brief: SynthesisBrief): SynthesisRun['counts'] => ({ new_memos: brief.plan.newMemos, focus: brief.plan.focus.length, context: brief.plan.context.length, omitted: brief.plan.omitted });
/** モデルへ実際に送る（伏せ字の後の）プロンプトの大きさ。 */
const sentBytes = (config: HubConfig, prompt: string): number => Buffer.byteLength(redactPrompt(prompt, secretSettings(config)).text, 'utf8');

/** いま実行すると何件のメモをどの大きさで送るかを返す。モデルを呼ばず、何も書き込まない。無効のときも確かめられる。 */
export async function previewSynthesis(config: HubConfig, options: SynthesisOptions = {}): Promise<SynthesisPreview> {
  const prepared = await prepare(config, new Vault(config), options.now ?? new Date(), options, true), brief = prepared.brief!, empty = !brief.plan.refs.size;
  return {
    enabled: config.synthesis.enabled, due: !prepared.skip, ...(prepared.skip ? { reason: prepared.skip } : {}), mode: brief.plan.mode, counts: countsOf(brief),
    calls: empty ? 0 : brief.plan.chunks.length, prompt_bytes: empty ? [] : brief.plan.chunks.map((_, i) => sentBytes(config, buildSynthesisPrompt(brief, i))),
    next_due_at: prepared.state.nextDueAt,
  };
}

class LlmTimeout extends Error {}
/** モデルを1回呼ぶ。waitMsは、この呼び出しに使える残りの時間。 */
async function complete(config: HubConfig, llm: LlmClient, prompt: string, waitMs: number): Promise<LlmCompletion> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = await Promise.race([
      completeRedacted(config, llm, prompt, { timeoutSec: Math.max(1, Math.ceil(waitMs / 1000)), maxOutputChars: SYNTHESIS_MAX_OUTPUT_CHARS, model: config.organize.llm.model }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new LlmTimeout()), waitMs); }),
    ]);
    if (!completion || typeof completion !== 'object' || typeof completion.text !== 'string') throw new InvalidSynthesisOutput();
    return completion;
  } finally { if (timer) clearTimeout(timer); }
}
const errorKindOf = (error: unknown): SynthesisErrorKind => error instanceof InvalidSynthesisOutput ? 'invalid-output'
  : error instanceof LlmTimeout || (error instanceof Error && error.message === 'infer:timeout') ? 'timeout'
  : error instanceof PromptTooLargeError ? 'prompt-too-large' : 'llm-error';

/**
 * 週次の統合を実行する。無効・間隔の途中・新しい入力なしのときは、モデルを呼ばず理由を返す。
 * 整理と同じロック（organize）で1つずつ実行し、モデルを待つ間はWriterロックを持たない。
 * 呼び出しが失敗しても例外にせず、失敗として記録する（記録や入力を読めないときは例外）。
 */
export async function runSynthesis(config: HubConfig, llm: LlmClient, options: SynthesisOptions = {}): Promise<SynthesisOutcome> {
  if (!config.synthesis.enabled) return { ran: false, reason: 'disabled' };
  const vault = new Vault(config), now = options.now ?? new Date(), started = Date.now();
  const save = (run: SynthesisRun) => JSON.stringify(run, null, 2) + '\n';
  const outcome = await vault.withLock(async (): Promise<SynthesisOutcome> => {
    const prepared = await vault.withLock(async () => {
      const ready = await prepare(config, vault, now, options, false);
      if (ready.skip) return { ...ready, opened: undefined };
      const provider = config.organize.llm.provider;
      // モデルを呼ぶ前に、実行を始めたことを記録する。途中で止められても1回の実行として数え、次のcycleで呼び出しを重ねない。
      const opened = synthesisRunSchema.parse({
        schema_version: 1, id: `SYN-${ulid(now.getTime())}`, status: 'failed', mode: ready.brief!.plan.mode, created_at: now.toISOString(),
        period: { since: ready.state.lastSuccess?.period.until ?? null, until: now.toISOString() },
        // modelは実行側の報告を優先し、報告がなければ整理と同じく設定の値を記録する。
        llm: { provider, model: config.organize.llm.model ?? (provider === 'mock' ? 'mock' : 'inherited-unverified'), thinking: config.synthesis.thinking, prompt_version: SYNTHESIS_PROMPT_VERSION },
        counts: countsOf(ready.brief!), calls: [], items: [], dropped: [], error: 'interrupted',
      } satisfies SynthesisRun);
      if (!await vault.create(synthesisRunPath(opened.id), save(opened))) throw new Error('週次の統合の記録を保存できません（同じIDの記録があります）');
      return { ...ready, opened };
    });
    if (prepared.skip || !prepared.opened) return prepared.skip === 'not-due' ? { ran: false, reason: 'not-due', nextDueAt: prepared.state.nextDueAt! } : { ran: false, reason: prepared.skip ?? 'no-memos' };
    const brief = prepared.brief!, { plan } = brief, opened = prepared.opened, settings = secretSettings(config);
    const hide = (text: string) => settings.enabled ? redactText(text, settings).text : text;
    const calls: SynthesisRun['calls'] = [], perCall: SynthesisDraft[][] = [], dropped: SynthesisDrop[] = [];
    const deadline = performance.now() + config.synthesis.timeoutSec * 1000;
    let model: string | undefined, called = false;
    // 呼び出しは1つずつ順に行う。全文で渡すメモが1回の上限に収まれば1回だけ。
    for (let chunk = 0; chunk < plan.chunks.length; chunk++) {
      const begun = performance.now();
      let attempts = 0, bytes = 0, slowest = 0, error: SynthesisErrorKind | null = null;
      try {
        for (;;) {
          // 最初の呼び出しのほかは、残りの時間が足りなければ始めない。
          const left = deadline - performance.now();
          if (called && left < SYNTHESIS_MIN_CALL_MS) { if (!attempts) throw new LlmTimeout(); throw new InvalidSynthesisOutput(); }
          attempts++; called = true;
          try {
            // 形式が崩れた応答は、理由を添えて1回だけ作り直させる。
            const prompt = buildSynthesisPrompt(brief, chunk, attempts === 2);
            bytes = sentBytes(config, prompt);
            const tried = performance.now();
            const completion = await complete(config, llm, prompt, Math.max(1, left)).finally(() => { slowest = Math.max(slowest, Math.round(performance.now() - tried)); });
            model = completion.model ?? model;
            const result = validateSynthesisOutput(completion.text, plan, { previousKeys: prepared.previousKeys, hide });
            perCall.push(result.items); dropped.push(...result.dropped);
            break;
          } catch (failure) { if (!(failure instanceof InvalidSynthesisOutput) || attempts === 2) throw failure; }
        }
      } catch (failure) { error = errorKindOf(failure); }
      calls.push({ elapsed_ms: attempts ? Math.round(performance.now() - begun) : 0, slowest_ms: slowest, attempts, prompt_bytes: bytes, focus: plan.chunks[chunk]!.length, error });
    }
    const merged = perCall.length > 1 ? mergeSynthesisDrafts(perCall) : { items: perCall[0] ?? [], dropped: [] };
    const failed = calls.every(c => c.error !== null), llmUsed = { ...opened.llm, model: model ? [...model].slice(0, 400).join('') : opened.llm.model };
    const result = synthesisRunSchema.safeParse({
      ...opened, status: failed ? 'failed' : merged.items.length ? 'ok' : 'empty', llm: llmUsed, calls,
      items: merged.items.map(item => ({
        key: hash([opened.id, item.section, item.sources.map(s => s.inputId).sort().join(','), item.text].join('\n')), section: item.section, text: item.text,
        ...(item.firstStep ? { first_step: item.firstStep } : {}), sources: item.sources.map(s => ({ input_id: s.inputId, latest_id: s.latestId })),
      })),
      dropped: [...dropped, ...merged.dropped].slice(0, 600), error: failed ? calls[0]!.error : null,
    } satisfies SynthesisRun);
    // 結果が記録の形に収まらないときも例外で止めず、応答の不正として失敗を記録する（途中で止まった扱いのまま残さない）。
    const run = result.success ? result.data
      : synthesisRunSchema.parse({ ...opened, status: 'failed', llm: llmUsed, calls, items: [], dropped: [], error: 'invalid-output' } satisfies SynthesisRun);
    // 開始の記録を、結果で置き換える。ほかの書き込みでロックを待ちきれないときは、数回まで待ち直す（検証済みの結果を捨てない）。
    for (let tries = 1; ; tries++) {
      try { await vault.withLock(() => vault.write(synthesisRunPath(run.id), save(run))); break; }
      catch (failure) { if (!(failure instanceof LockTimeoutError) || tries >= 3) throw failure; }
    }
    return { ran: true, id: run.id, status: run.status, mode: run.mode, items: run.items.length, dropped: run.dropped.length, calls: run.calls.length, warnings: synthesisWarnings(run), ...(run.error ? { error: run.error } : {}) };
  }, 'organize');
  if (outcome.ran && !await logOperation(config, { op: 'synthesize', ms: Date.now() - started, ...(outcome.status === 'failed' ? { error_kind: 'llm' as const } : {}), counts: { processed: outcome.items, failed: outcome.status === 'failed' ? 1 : 0, skipped: outcome.dropped } })) process.stderr.write('警告: 運用ログを書き込めませんでした。処理結果は保持されています。\n');
  return outcome;
}
