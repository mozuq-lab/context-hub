import { z } from 'zod';
import { ulid } from 'ulid';
import { clipText, listText } from './markdown-text.js';
import { Vault } from './storage.js';
import { UNASSIGNED_SCOPE, activeResolutions, readItemResolutions, readNowItems, type NowItem } from './item-resolutions.js';
import { addDays, effectiveSchedules, readItemSchedules, scheduleBucket, scheduleDateSchema, todayIn, type ItemSchedule } from './item-schedules.js';
import { WAITING_LONG_DAYS, waitingDays } from './item-waits.js';
import { PROGRESS_STALE_DAYS, prerequisiteHold, progressStale } from './item-progress.js';
import { SOMEDAY_REVIEW_DAYS, buildSomedayList, somedayStale } from './someday.js';
import { buildReviewIndex } from './candidate-review.js';
import { readGitDraftRecords } from './git-drafts.js';
import { readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { lastEvidenceAt } from './views.js';
import { lifecycleOf } from './project-status.js';
import { mergeTargets, projectIdSchema, readProjects } from './projects.js';
import { UNASSIGNED_TITLE } from './unassigned-actions.js';
import { NO_AREA_LABEL, orderAreas, usesAreas } from './areas.js';
import { readAreaVocabulary } from './client-preferences.js';
import type { HubConfig, Project } from './types.js';

/**
 * 週次レビュー（GTDの週次レビュー）。今ある一覧を決まった順に点検し、その場で判断するための入口。
 * - 点検の一覧（90_system/weekly-review.json）は、項目一覧・候補・記録からモデルを使わずに作る派生物。内容が変わったときだけ書く。
 *   アプリはこれを読んで段を進め、各行の操作は既存の依頼（完了・日付・連絡待ち・いつかやる・状態の切り替えなど）で行う。
 *   ふりかえり（REVIEW.md）の「週次レビューの点検」も同じ一覧から書く。
 * - 「見直した」は本人の報告だけを記録する（90_system/weekly-reviews/）。AIは記録しない。最後に見直した日からの日数をHOMEとふりかえりに示す。
 * 点検の順: 確認待ち → プロジェクト未定の行動 → 進行中のプロジェクト → 停滞しているプロジェクト → 連絡待ち → 期日 → いつかやる。
 */
/** この日数以上見直していなければ、HOMEで週次レビューを促す。 */
export const WEEKLY_REVIEW_INTERVAL_DAYS = 7;
/** 領域を見渡す段で「しばらく動いていない」とみなす日数（進行中のプロジェクトのどれにも新しい入力がない日数）。 */
export const WEEKLY_AREA_QUIET_DAYS = 30;
/** 根拠のメモからこの日数以上たった次の一手を「長く残っている」とする。 */
export const WEEKLY_NEXT_STALE_DAYS = 14;
/** 根拠のメモからこの日数以上たった未解決を「長く残っている」とする。 */
export const WEEKLY_OPEN_STALE_DAYS = 30;
/** 一覧の「長く残っている項目」と期日の行の上限（古い順・期日の順）。件数は別に全件を数える。 */
const ROWS_MAX = 50;

export const weeklyReviewIdSchema = z.string().regex(/^WRV-[0-9A-HJKMNP-TV-Z]{26}$/);
export const weeklyReviewRecordSchema = z.object({
  schema_version: z.literal(1), id: weeklyReviewIdSchema,
  /** 本人が見直しを終えた日（設定のタイムゾーンでの暦日）。 */
  on: scheduleDateSchema,
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type WeeklyReviewRecord = z.infer<typeof weeklyReviewRecordSchema>;
const recordDir = '90_system/weekly-reviews';
const recordPath = (id: string) => `${recordDir}/${id}.json`;
export const weeklyReviewPath = '90_system/weekly-review.json';

/** 記録と、読めなかった記録のパス。不正な記録があっても一覧とHOMEの生成は止めず、HOMEとdoctorで示す。 */
export async function readWeeklyReviews(vault: Vault): Promise<{ records: WeeklyReviewRecord[]; problems: string[] }> {
  const records: WeeklyReviewRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(recordDir)) {
    if (!/^90_system\/weekly-reviews\/WRV-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = weeklyReviewRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== recordPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records, problems };
}
/** 最後に見直した記録（見直した日が最も新しいもの。同じ日は後の記録）。 */
export function lastWeeklyReview(records: WeeklyReviewRecord[]): WeeklyReviewRecord | undefined {
  return [...records].sort((a, b) => a.on.localeCompare(b.on) || a.id.localeCompare(b.id)).at(-1);
}

const itemRef = z.object({ scope: z.string(), item_key: z.string().regex(/^[a-f0-9]{64}$/), section: z.enum(['next', 'open']), label: z.string(), text: z.string() });
/** 長く残っている項目。sinceは根拠のメモの日付（設定のタイムゾーン）。 */
const lingeringSchema = itemRef.extend({ since: scheduleDateSchema }).strict();
/** 期限切れ・今日・7日以内の期日の項目（連絡待ち・「いつかやる」・見直す日まで休ませている項目を除く）。 */
const datedSchema = itemRef.extend({ due: scheduleDateSchema, bucket: z.enum(['overdue', 'today', 'week']), review_after: scheduleDateSchema.nullable() }).strict();
const waitingSchema = itemRef.extend({ since: scheduleDateSchema, check: z.boolean() }).strict();
/** 止まった取りかかり中。sinceは始めた日、updatedは印かひとことを最後に更新した日。 */
const progressStaleSchema = itemRef.extend({ since: scheduleDateSchema, updated: scheduleDateSchema, note: z.string().optional() }).strict();
/**
 * 進行中のプロジェクト。nextは連絡待ち・「いつかやる」を除いた未完了の次の一手の数（項目一覧を読めないときはnull）、
 * waitingは連絡待ちの次の一手・未解決の数、hintsは「片付いたかも」の付いた項目の数。staleは最終根拠からretrieve.staleDaysを超えたもの。
 */
const projectSchema = z.object({ project_id: projectIdSchema, title: z.string(), area: z.string().optional(), next: z.number().int().nonnegative().nullable(), open: z.number().int().nonnegative().nullable(), waiting: z.number().int().nonnegative(), hints: z.number().int().nonnegative(), last_evidence: z.string().nullable(), stale: z.boolean() }).strict();
/**
 * 領域ごとのまとめ。areaがnullは領域なし。active・paused・doneはその状態のプロジェクトの数（統合済みは数えない）、
 * last_evidenceは進行中・休止のプロジェクトの最終根拠の最も新しいもの。no_activeは進行中のプロジェクトが1つもないこと、
 * quietは進行中のプロジェクトがあるのに、どれも{@link WEEKLY_AREA_QUIET_DAYS}日以上新しい入力がないこと。
 */
const areaRowSchema = z.object({ area: z.string().nullable(), active: z.number().int().nonnegative(), paused: z.number().int().nonnegative(), done: z.number().int().nonnegative(), last_evidence: z.string().nullable(), no_active: z.boolean(), quiet: z.boolean() }).strict();
export const weeklyReviewListSchema = z.object({
  schema_version: z.literal(1), generated_at: z.string().datetime({ offset: true }),
  interval_days: z.number().int().min(1), next_stale_days: z.number().int().min(1), open_stale_days: z.number().int().min(1), project_stale_days: z.number().int().min(1), someday_review_days: z.number().int().min(1),
  /** 最後に本人が見直しを報告した記録。なければnull。 */
  last_review: z.object({ id: weeklyReviewIdSchema, on: scheduleDateSchema, created_at: z.string().datetime({ offset: true }) }).strict().nullable(),
  /** 1. 確認待ち（プロジェクト案・知識と方針の候補は代表の1件に数える）と、未確認の作業記録の下書き。 */
  inbox: z.object({ candidates: z.number().int().nonnegative(), drafts: z.number().int().nonnegative() }).strict(),
  /** 2. プロジェクト未定: 本人が追加した行動のうち残っているもの（連絡待ち・「いつかやる」を除く）と、メモから出たAIの行（片付けていないもの）。 */
  unassigned: z.object({ actions: z.number().int().nonnegative(), suggestions: z.number().int().nonnegative() }).strict(),
  /** 3・4. 進行中のプロジェクト（最近動いた順）。 */
  projects: z.array(projectSchema),
  /** 3. 長く残っている次の一手・未解決（根拠の古い順）。期日・見直す日を付けた項目は除く。lingering_totalは全件の数。 */
  lingering: z.array(lingeringSchema).max(ROWS_MAX), lingering_total: z.number().int().nonnegative(),
  /** 5. 連絡待ち（頼んだ日の古い順）。checkは見直す日が来たもの。 */
  waiting: z.array(waitingSchema),
  /** 6. 期日（期限切れ・今日・7日以内の順、同じ区分は期日の順）。dated_totalは全件の数、dated_countsは区分ごとの全件の数。 */
  dated: z.array(datedSchema).max(ROWS_MAX), dated_total: z.number().int().nonnegative(),
  dated_counts: z.object({ overdue: z.number().int().nonnegative(), today: z.number().int().nonnegative(), week: z.number().int().nonnegative() }).strict(),
  /** 7. 「いつかやる」の件数と、長く見直していないものの件数（行はsomeday.jsonで読む）。 */
  someday: z.object({ total: z.number().int().nonnegative(), stale: z.number().int().nonnegative() }).strict(),
  /** 8. 領域を見渡す。本人がプロジェクトに領域を1つでも付けているときだけある（本人が決めた語彙の順、領域なしは最後）。 */
  areas: z.array(areaRowSchema).optional(),
  area_quiet_days: z.number().int().min(1).optional(),
  /** 3. 止まった取りかかり中（印もひとことも progress_stale_days 日以上更新していない次の一手。更新の古い順）。1件でもあるときだけある。 */
  progress_stale: z.array(progressStaleSchema).max(ROWS_MAX).optional(), progress_stale_total: z.number().int().nonnegative().optional(), progress_stale_days: z.number().int().min(1).optional(),
}).strict();
export type WeeklyReviewList = z.infer<typeof weeklyReviewListSchema>;
type ItemRow = z.infer<typeof itemRef>;

export interface WeeklyReviewInputs { projects?: Project[]; effective?: EffectiveInput[] }
/**
 * 点検の一覧を組み立てる（書き込まない）。項目は直近に生成した項目一覧（now-items）から読み、期日は記録から引き継ぎを当てて読む（HOMEと同じ）。
 * 壊れた項目一覧・記録は飛ばす（HOMEとdoctorで示す）。
 */
export async function buildWeeklyReview(config: HubConfig, vault: Vault, now = new Date(), inputs: WeeklyReviewInputs = {}): Promise<WeeklyReviewList> {
  const today = todayIn(config.timezone, now), projects = inputs.projects ?? await readProjects(config), merged = mergeTargets(projects);
  // 壊れた記録があっても一覧は作る（その段だけ数えない）。記録の不正はHOMEとdoctorで示す。見直しの記録の後に必ず書き直すため、ここで止めない。
  const safe = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => { try { return await read(); } catch { return fallback; } };
  const effective = inputs.effective ?? await safe(() => readEffectiveInputs(config), []);
  // 項目の根拠のメモの日付。訂正のあるメモは元のメモの日付で数える（AIの行は訂正の後も同じ話が続いているため）。
  const sinceOf = new Map<string, string>();
  for (const u of effective) for (const i of [u.chain.root, ...u.chain.revisions]) sinceOf.set(i.id, todayIn(config.timezone, new Date(u.chain.root.occurred_at)));
  const candidates = await safe(async () => (await buildReviewIndex(config, { now })).items.filter(c => c.status === 'pending' && !c.duplicateOf).length, 0);
  const drafts = await safe(async () => (await readGitDraftRecords(config)).drafts.filter(d => d.status === 'pending').length, 0);
  const schedules = await safe(() => readItemSchedules(vault), { records: [], problems: [] } as Awaited<ReturnType<typeof readItemSchedules>>);
  const resolutions = await safe(() => readItemResolutions(vault), [] as Awaited<ReturnType<typeof readItemResolutions>>);
  const ref = (scope: string, i: NowItem): ItemRow => ({ scope, item_key: i.key, section: i.section, label: i.label, text: i.text });
  const rows: WeeklyReviewList['projects'] = [], stalled: z.infer<typeof progressStaleSchema>[] = [], lingering: z.infer<typeof lingeringSchema>[] = [], dated: z.infer<typeof datedSchema>[] = [], waiting: z.infer<typeof waitingSchema>[] = [];
  /** 期日の区分。連絡待ち・「いつかやる」・見直す日まで休ませている項目は呼ぶ側で除く。 */
  const addDated = (scope: string, i: NowItem, schedule: Pick<ItemSchedule, 'due' | 'review_after'> | undefined) => {
    if (!schedule?.due) return;
    const { bucket, hidden } = scheduleBucket(schedule, today);
    if (!hidden && (bucket === 'overdue' || bucket === 'today' || bucket === 'week')) dated.push({ ...ref(scope, i), due: schedule.due, bucket, review_after: schedule.review_after });
  };
  const addWaiting = (scope: string, i: NowItem, schedule: Pick<ItemSchedule, 'review_after'> | undefined) => {
    if (i.waiting) waiting.push({ ...ref(scope, i), since: i.waiting.since, check: schedule?.review_after != null && schedule.review_after <= today });
  };
  /** 止まった取りかかり中。連絡待ち・「いつかやる」の項目は呼ぶ側で除き、先待ちの項目（今は手を動かせない）はここで除く。 */
  const held = await prerequisiteHold(vault, [UNASSIGNED_SCOPE, ...projects.map(p => p.id)]);
  const addStalled = (scope: string, i: NowItem) => {
    if (i.progress && !held(i) && progressStale(i.progress, today)) stalled.push({ ...ref(scope, i), since: i.progress.since, updated: i.progress.updated, ...(i.progress.note !== undefined ? { note: i.progress.note } : {}) });
  };
  const ordered: { row: WeeklyReviewList['projects'][number]; at: number }[] = [];
  for (const project of projects) {
    if (merged.has(project.id) || lifecycleOf(project) !== 'active') continue;
    const last = await lastEvidenceAt(vault, project.id) ?? null, at = last ? Date.parse(last) : Number.NEGATIVE_INFINITY;
    const stale = last !== null && now.getTime() - at > config.retrieve.staleDays * 86_400_000;
    let list: NowItem[] | undefined;
    // NOWのないプロジェクトには次の一手がない。項目一覧を読めない（旧版・壊れた記録）ときは数えない。
    if (await vault.read(`10_projects/${project.id}/NOW.md`) === undefined) list = [];
    else try { list = (await readNowItems(vault, project.id))?.items; } catch { list = undefined; }
    let next: number | null = null, open: number | null = null, waits = 0, hints = 0;
    if (list) {
      const scheduled = effectiveSchedules(schedules.records, project.id, list, activeResolutions(resolutions, project.id)).byKey;
      next = 0; open = 0;
      for (const i of list) {
        if (i.resolution !== null || i.someday) continue;
        const schedule = scheduled.get(i.key);
        if (i.hints?.length) hints++;
        if (i.waiting) { waits++; addWaiting(project.id, i, schedule); continue; }
        if (i.section === 'next') next++; else open++;
        addDated(project.id, i, schedule);
        addStalled(project.id, i);
        // 期日・見直す日を付けた項目は本人が時期を決めているため、「長く残っている」には数えない。
        // 取りかかり中の項目も、本人が進めているところなので数えない（止まっていれば「止まった取りかかり中」に出る）。
        const since = sinceOf.get(i.input_id);
        if (!schedule && !i.progress && since !== undefined && waitingDays(since, today) >= (i.section === 'next' ? WEEKLY_NEXT_STALE_DAYS : WEEKLY_OPEN_STALE_DAYS)) lingering.push({ ...ref(project.id, i), since });
      }
    }
    ordered.push({ row: { project_id: project.id, title: project.title, ...(project.area ? { area: project.area } : {}), next, open, waiting: waits, hints, last_evidence: last, stale }, at });
  }
  rows.push(...ordered.sort((a, b) => b.at - a.at || a.row.project_id.localeCompare(b.row.project_id)).map(x => x.row));
  // プロジェクト未定: 本人が追加した行動（期日・連絡待ちを付けられる）と、メモから出たAIの行。
  let actions = 0, suggestions = 0;
  try {
    for (const i of (await readNowItems(vault, UNASSIGNED_SCOPE))?.items ?? []) {
      if (i.resolution !== null || i.someday) continue;
      if (!i.action) { suggestions++; continue; }
      const schedule = i.schedule ? { due: i.schedule.due, review_after: i.schedule.review_after } : undefined;
      if (i.waiting) { addWaiting(UNASSIGNED_SCOPE, i, schedule); continue; }
      actions++;
      addDated(UNASSIGNED_SCOPE, i, schedule);
      addStalled(UNASSIGNED_SCOPE, i);
    }
  } catch { /* 壊れた項目一覧はHOMEとdoctorで示す。 */ }
  let someday = { total: 0, stale: 0 };
  try { const list = await buildSomedayList(config, vault, now, projects); someday = { total: list.entries.length, stale: list.entries.filter(e => somedayStale(e, today)).length }; } catch { /* 壊れた記録はHOMEとdoctorで示す。 */ }
  // 領域を見渡す（本人が領域を1つでも付けているときだけ）。統合済みのプロジェクトは統合先に数える。
  let areas: z.infer<typeof areaRowSchema>[] | undefined;
  const live = projects.filter(p => !merged.has(p.id));
  if (usesAreas(live)) {
    const evidence = new Map<string, string | undefined>();
    for (const p of live) if (lifecycleOf(p) !== 'done') evidence.set(p.id, await lastEvidenceAt(vault, p.id));
    areas = orderAreas(live.map(p => p.area), await readAreaVocabulary(vault)).map(area => {
      const members = live.filter(p => p.area === area), count = (s: string) => members.filter(p => lifecycleOf(p) === s).length;
      const latest = (ids: Project[]) => ids.map(p => evidence.get(p.id)).filter((x): x is string => x !== undefined).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
      const recent = latest(members.filter(p => lifecycleOf(p) !== 'done')), active = count('active'), activeLast = latest(members.filter(p => lifecycleOf(p) === 'active'));
      return { area: area ?? null, active, paused: count('paused'), done: count('done'), last_evidence: recent, no_active: active === 0, quiet: active > 0 && (activeLast === null || now.getTime() - Date.parse(activeLast) >= WEEKLY_AREA_QUIET_DAYS * 86_400_000) };
    });
  }
  const last = lastWeeklyReview((await readWeeklyReviews(vault)).records);
  const order = { overdue: 0, today: 1, week: 2 } as const;
  lingering.sort((a, b) => a.since.localeCompare(b.since) || a.scope.localeCompare(b.scope) || a.section.localeCompare(b.section) || a.item_key.localeCompare(b.item_key));
  dated.sort((a, b) => order[a.bucket] - order[b.bucket] || a.due.localeCompare(b.due) || a.scope.localeCompare(b.scope) || a.item_key.localeCompare(b.item_key));
  waiting.sort((a, b) => a.since.localeCompare(b.since) || a.scope.localeCompare(b.scope) || a.item_key.localeCompare(b.item_key));
  stalled.sort((a, b) => a.updated.localeCompare(b.updated) || a.scope.localeCompare(b.scope) || a.item_key.localeCompare(b.item_key));
  return {
    schema_version: 1, generated_at: now.toISOString(),
    interval_days: WEEKLY_REVIEW_INTERVAL_DAYS, next_stale_days: WEEKLY_NEXT_STALE_DAYS, open_stale_days: WEEKLY_OPEN_STALE_DAYS, project_stale_days: config.retrieve.staleDays, someday_review_days: SOMEDAY_REVIEW_DAYS,
    last_review: last ? { id: last.id, on: last.on, created_at: last.created_at } : null,
    inbox: { candidates, drafts },
    unassigned: { actions, suggestions },
    projects: rows,
    lingering: lingering.slice(0, ROWS_MAX), lingering_total: lingering.length,
    waiting,
    dated: dated.slice(0, ROWS_MAX), dated_total: dated.length,
    dated_counts: { overdue: dated.filter(d => d.bucket === 'overdue').length, today: dated.filter(d => d.bucket === 'today').length, week: dated.filter(d => d.bucket === 'week').length },
    someday,
    ...(areas ? { areas, area_quiet_days: WEEKLY_AREA_QUIET_DAYS } : {}),
    // 旧版のアプリ・fixtureと同じ形を保つため、止まった取りかかり中がないときは欄ごと省く。
    ...(stalled.length ? { progress_stale: stalled.slice(0, ROWS_MAX), progress_stale_total: stalled.length, progress_stale_days: PROGRESS_STALE_DAYS } : {}),
  };
}

/**
 * Writerロックを持つ呼び出し元から使う。点検の一覧をアプリが読む派生物として書く（内容が変わったときだけ）。
 * forceは、見直しを記録した直後に、一覧の中身が変わらなくても書き直す（アプリは書いた日時で依頼の反映を確かめるため）。
 */
export async function rebuildWeeklyReviewLocked(config: HubConfig, vault: Vault, now = new Date(), inputs: WeeklyReviewInputs = {}, force = false): Promise<WeeklyReviewList> {
  const built = await buildWeeklyReview(config, vault, now, inputs), raw = await vault.read(weeklyReviewPath);
  let old: WeeklyReviewList | undefined;
  if (raw !== undefined) try { old = weeklyReviewListSchema.parse(JSON.parse(raw)); } catch { /* 壊れた一覧は作り直す。 */ }
  if (old && !force && JSON.stringify({ ...old, generated_at: '' }) === JSON.stringify({ ...weeklyReviewListSchema.parse(JSON.parse(JSON.stringify(built))), generated_at: '' })) return old;
  await vault.write(weeklyReviewPath, JSON.stringify(built, null, 2) + '\n');
  return built;
}

/** 最後に見直してからの日数（記録がなければnull）。 */
export const daysSinceWeeklyReview = (list: Pick<WeeklyReviewList, 'last_review'>, today: string): number | null => list.last_review ? waitingDays(list.last_review.on, today) : null;
/** 週次レビューを促すか（記録がないか、最後に見直してから間隔の日数以上）。 */
export const weeklyReviewDue = (list: Pick<WeeklyReviewList, 'last_review' | 'interval_days'>, today: string): boolean => { const days = daysSinceWeeklyReview(list, today); return days === null || days >= list.interval_days; };

/** HOMEの冒頭に置く1行（前後の改行は含めない）。 */
export function weeklyReviewHomeLine(list: WeeklyReviewList, today: string, reviewExists = true): string {
  const days = daysSinceWeeklyReview(list, today);
  const head = days === null ? '週次レビュー: まだ見直した記録がありません' : `週次レビュー: 最後に見直したのは${list.last_review!.on}（${days === 0 ? '今日' : `${days}日前`}）`;
  // ふりかえり（REVIEW.md）がまだ無いVaultでは、無いファイルへのリンクを出さない。
  const how = reviewExists ? 'アプリの「ふりかえり」の「週次レビューを始める」か、[REVIEW.md](REVIEW.md)の「週次レビューの点検」を順に確かめてください。' : 'アプリの「ふりかえり」の「週次レビューを始める」から順に確かめてください。';
  return weeklyReviewDue(list, today) ? `${head}。${how}` : `${head}。`;
}

const place = (scope: string, projects: ReadonlyMap<string, string>) => scope === UNASSIGNED_SCOPE ? UNASSIGNED_TITLE : `[${listText(projects.get(scope) ?? scope)}](10_projects/${scope}/NOW.md)`;
const rowText = (r: ItemRow) => `${r.section === 'next' ? '次の一手: ' : r.label ? '' : '未解決: '}${clipText(r.label + r.text, 120)}`;
/** ふりかえりに並べる行の上限（各段）。全件はアプリの週次レビューで確かめる。 */
const DIGEST_ROWS = 10;

/** ふりかえり（REVIEW.md）の「週次レビューの点検」の行。点検の順に、件数と確かめる行を並べる。 */
export function weeklyReviewDigestLines(list: WeeklyReviewList, now: Date, timezone: string): string[] {
  const today = todayIn(timezone, now), titles = new Map(list.projects.map(p => [p.project_id, p.title])), days = daysSinceWeeklyReview(list, today);
  const lines = ['## 週次レビューの点検',
    `${days === null ? '週次レビューの記録はまだありません' : `最後に見直した日: ${list.last_review!.on}（${days === 0 ? '今日' : `${days}日前`}）`}。上から順に確かめ、その場で判断してください。終えたら、アプリの「ふりかえり」の週次レビューで「見直した」と報告するか、\`ctx weekly-review done --confirm\`を使ってください。一覧はモデルを使わずに作っています。`, ''];
  const more = (shown: number, total: number) => total > shown ? [`   - ほか${total - shown}件（アプリの週次レビューで確認）`] : [];
  lines.push(`1. 確認待ち: 候補 ${list.inbox.candidates}件・作業記録の下書き ${list.inbox.drafts}件${list.inbox.candidates ? '（下の「確認待ちの候補」とHOMEで採用・却下する）' : ''}`);
  lines.push(`2. プロジェクト未定の行動: 残っている行動 ${list.unassigned.actions}件・メモから出たタスクと提案 ${list.unassigned.suggestions}件（プロジェクトに移すか、行動にする・完了・却下を選ぶ）`);
  const empty = list.projects.filter(p => p.next === 0 && p.waiting === 0), unread = list.projects.filter(p => p.next === null), hints = list.projects.reduce((n, p) => n + p.hints, 0);
  const lingNext = list.lingering.filter(r => r.section === 'next').length, lingOpen = list.lingering.length - lingNext;
  lines.push(`3. 進行中のプロジェクト: ${list.projects.length}件。次の一手がないもの ${empty.length}件・長く残っている項目 ${list.lingering_total}件（次の一手${list.next_stale_days}日以上・未解決${list.open_stale_days}日以上）・片付いたかも ${hints}件`);
  if (empty.length) lines.push(`   - 次の一手がないプロジェクト（次の一手を足すか、休止・完了にする）: ${empty.map(p => `[${listText(p.title)}](10_projects/${p.project_id}/project.md)`).join('、')}`);
  if (unread.length) lines.push(`   - 項目一覧を読めないプロジェクト: ${unread.map(p => listText(p.title)).join('、')}（cycleを実行するか、HOMEの失敗と競合を確認してください）`);
  if (list.lingering.length) {
    lines.push(`   - 長く残っている項目（根拠の古い順。次の一手${lingNext}件・未解決${lingOpen}件${list.lingering_total > list.lingering.length ? '・一部' : ''}）:`);
    for (const r of list.lingering.slice(0, DIGEST_ROWS)) lines.push(`     - ${place(r.scope, titles)} ${rowText(r)}（根拠から${waitingDays(r.since, today)}日）`);
    lines.push(...more(Math.min(DIGEST_ROWS, list.lingering.length), list.lingering_total).map(l => `  ${l}`));
  }
  if (list.progress_stale?.length) {
    const total = list.progress_stale_total ?? list.progress_stale.length;
    lines.push(`   - 止まった取りかかり中（${list.progress_stale_days ?? PROGRESS_STALE_DAYS}日以上更新なし ${total}件。続けるならどこまで進んだかを書き直し、手を止めているなら印を外すか「いつかやる」へ移す）:`);
    for (const r of list.progress_stale.slice(0, DIGEST_ROWS)) lines.push(`     - ${place(r.scope, titles)} ${rowText(r)}（${r.since}から・${waitingDays(r.updated, today)}日更新なし${r.note ? `・どこまで: ${listText(r.note)}` : ''}）`);
    lines.push(...more(Math.min(DIGEST_ROWS, list.progress_stale.length), total).map(l => `  ${l}`));
  }
  const stale = list.projects.filter(p => p.stale);
  lines.push(`4. 停滞しているプロジェクト: ${stale.length}件（最終根拠から${list.project_stale_days}日超。再開する・休止・完了を選ぶ）`);
  for (const p of stale) lines.push(`   - [${listText(p.title)}](10_projects/${p.project_id}/project.md)${p.last_evidence ? `（最終根拠から${Math.max(0, Math.floor((now.getTime() - Date.parse(p.last_evidence)) / 86_400_000))}日）` : ''}`);
  const checks = list.waiting.filter(w => w.check).length, long = list.waiting.filter(w => waitingDays(w.since, today) >= WAITING_LONG_DAYS).length;
  lines.push(`5. 連絡待ち: ${list.waiting.length}件（見直す日が来た ${checks}件・${WAITING_LONG_DAYS}日以上 ${long}件。催促する・待つ・片付ける）`);
  for (const w of list.waiting.filter(w => w.check).slice(0, DIGEST_ROWS)) lines.push(`   - 見直す日が来た: ${place(w.scope, titles)} ${rowText(w)}（頼んでから${waitingDays(w.since, today)}日）`);
  const count = list.dated_counts;
  lines.push(`6. 期日: 期限切れ ${count.overdue}件・今日 ${count.today}件・7日以内 ${count.week}件（期限切れは日付を付け直すか片付け、来週の期日を確かめる）`);
  for (const d of list.dated.slice(0, DIGEST_ROWS)) lines.push(`   - ${d.bucket === 'overdue' ? '期限切れ' : d.bucket === 'today' ? '今日' : '7日以内'} ${d.due} — ${place(d.scope, titles)} ${rowText(d)}`);
  lines.push(...more(Math.min(DIGEST_ROWS, list.dated.length), list.dated_total));
  lines.push(`7. いつかやる: ${list.someday.total}件（${list.someday_review_days}日以上見直していない ${list.someday.stale}件。始める・そのまま・やめる）`);
  if (list.areas?.length) {
    const empty = list.areas.filter(a => a.area !== null && a.no_active).length, quiet = list.areas.filter(a => a.quiet).length;
    lines.push(`8. 領域を見渡す: ${list.areas.length}件（進行中のプロジェクトがない領域 ${empty}件・${list.area_quiet_days ?? WEEKLY_AREA_QUIET_DAYS}日以上動いていない領域 ${quiet}件。手薄な領域にプロジェクトや次の一手が要るかを考える）`);
    for (const a of list.areas) lines.push(`   - ${a.area === null ? NO_AREA_LABEL : listText(a.area)}: 進行中 ${a.active}件・休止 ${a.paused}件・完了 ${a.done}件${a.last_evidence ? `・最終根拠から${Math.max(0, Math.floor((now.getTime() - Date.parse(a.last_evidence)) / 86_400_000))}日` : ''}${a.area !== null && a.no_active ? '（進行中なし）' : a.quiet ? '（しばらく動いていない）' : ''}`);
  }
  lines.push('');
  return lines;
}

export interface WeeklyReviewRequest { on: string; source: string; sourceEventId?: string; /** 今日（検証用）。 */ now?: Date }
export interface WeeklyReviewResult { weeklyReviewId: string; on: string; deduped: boolean }
const requestSchema = z.object({ on: scheduleDateSchema, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), now: z.date().optional() }).strict();

/**
 * 本人が週次レビューを終えたこと（見直した日）を記録する。AIの出力からは呼ばない。
 * 見直した日は今日まで（端末とのタイムゾーンの違いを見込み、翌日までは受け付ける）。同じ日の見直しが既にあれば、記録を増やさずに受け付ける（別の端末や二度押し）。
 * 記録の後に一覧を必ず書き直す（アプリは一覧の書いた日時で反映を確かめる）。
 */
export async function setWeeklyReview(config: HubConfig, request: WeeklyReviewRequest): Promise<WeeklyReviewResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  if (r.on > addDays(todayIn(config.timezone, r.now), 1)) throw new Error('見直した日に先の日付は付けられません');
  return vault.withLock(async () => {
    const { records } = await readWeeklyReviews(vault);
    const previous = r.sourceEventId ? records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId) : undefined;
    if (previous && previous.on !== r.on) throw new Error('同じ受付IDで別の日の見直しが記録されています');
    const same = previous ?? records.find(x => x.on === r.on);
    if (same) {
      // 記録の後、一覧を作り直す前に停止した場合に備えて作り直す。
      await rebuildWeeklyReviewLocked(config, vault, new Date(), {}, true);
      return { weeklyReviewId: same.id, on: same.on, deduped: true };
    }
    const record: WeeklyReviewRecord = { schema_version: 1, id: `WRV-${ulid()}`, on: r.on, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString() };
    if (!await vault.create(recordPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('週次レビューの記録が競合しました');
    await rebuildWeeklyReviewLocked(config, vault, new Date(), {}, true);
    return { weeklyReviewId: record.id, on: record.on, deduped: false };
  });
}
