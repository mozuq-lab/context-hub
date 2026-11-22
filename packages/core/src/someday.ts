import { z } from 'zod';
import { ulid } from 'ulid';
import { clipText, listText } from './markdown-text.js';
import { Vault } from './storage.js';
import { UNASSIGNED_SCOPE, readNowItems } from './item-resolutions.js';
import { addDays, scheduleDateSchema, todayIn } from './item-schedules.js';
import { waitingDays } from './item-waits.js';
import { SomedayError } from './item-somedays.js';
import { ideaIdSchema, readIdeas } from './idea-links.js';
import { assertNotMerged, mergeTargets, projectIdSchema, readProjects } from './projects.js';
import { lifecycleOf, readProjectStatusChanges, type ProjectStatusChange } from './project-status.js';
import type { HubConfig, Project } from './types.js';

/**
 * 「いつかやる」の一覧（GTDの「いつかやる／多分やる」）。置き場は増やさず、今あるものを1つの見直しの入口に並べる。
 * - 本人が「いつかやる」へ移した次の一手・未解決（item-somedays）
 * - 休止中のプロジェクト（project.mdの状態）
 * - 本人が「いつかやる」に置いたアイデア（このファイルの記録。アイデアは数が増えやすいため、全件は並べない）
 * 各行は最後に見直した日の古い順に並び、本人が「始める・そのまま・やめる」を選ぶ。AIは置きも、始めもしない。
 * アイデアのファイルとproject.mdは書き換えない（プロジェクトの状態の切り替えは既存のproject-statusで行う）。
 */
/** この日数以上見直していない行を「見直していない」として示す。 */
export const SOMEDAY_REVIEW_DAYS = 30;

export const somedayTargets = ['idea', 'project'] as const;
export type SomedayTarget = typeof somedayTargets[number];
/**
 * add: アイデアを「いつかやる」に置く / keep: 見直したが今は始めない（そのまま） /
 * start: アイデアを始めた（プロジェクトか行動にした）ので一覧から外す / drop: アイデアをやめて一覧から外す。
 * プロジェクトはkeepだけを記録する（始める・やめるは状態の切り替え）。
 */
export const somedayReviewActions = ['add', 'keep', 'start', 'drop'] as const;
export type SomedayReviewAction = typeof somedayReviewActions[number];
export const somedayReviewIdSchema = z.string().regex(/^SDR-[0-9A-HJKMNP-TV-Z]{26}$/);
export const somedayReviewSchema = z.object({
  schema_version: z.literal(1), id: somedayReviewIdSchema, target: z.enum(somedayTargets), target_id: z.string().min(1).max(100), action: z.enum(somedayReviewActions),
  /** 本人が判断した日（設定のタイムゾーンでの暦日）。 */
  on: scheduleDateSchema,
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((v, ctx) => {
  if (!(v.target === 'idea' ? ideaIdSchema : projectIdSchema).safeParse(v.target_id).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '対象のIDが不正です' });
  if (v.target === 'project' && v.action !== 'keep') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'プロジェクトには「そのまま」だけを記録します' });
});
export type SomedayReview = z.infer<typeof somedayReviewSchema>;
const reviewDir = '90_system/someday-reviews';
const reviewPath = (id: string) => `${reviewDir}/${id}.json`;
export const somedayListPath = '90_system/someday.json';

/** 記録と、読めなかった記録のパス。不正な記録があっても一覧とHOMEの生成は止めず、HOMEとdoctorで示す。 */
export async function readSomedayReviews(vault: Vault): Promise<{ records: SomedayReview[]; problems: string[] }> {
  const records: SomedayReview[] = [], problems: string[] = [];
  for (const path of await vault.files(reviewDir)) {
    if (!/^90_system\/someday-reviews\/SDR-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = somedayReviewSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== reviewPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records, problems };
}

/** アイデアごとの状態。最後のadd以降にstart・dropがなければ「いつかやる」に置いている。 */
function ideaStates(records: SomedayReview[]): Map<string, { since: string; reviewed: string } | null> {
  const states = new Map<string, { since: string; reviewed: string } | null>();
  for (const r of records) {
    if (r.target !== 'idea') continue;
    const current = states.get(r.target_id) ?? null;
    if (r.action === 'add') states.set(r.target_id, current ?? { since: r.on, reviewed: r.on });
    else if (r.action === 'keep') { if (current) states.set(r.target_id, { since: current.since, reviewed: r.on > current.reviewed ? r.on : current.reviewed }); }
    else states.set(r.target_id, null);
  }
  return states;
}

/** 休止した日。最後の状態の記録が休止への切り替えなら、その日（記録がない・手で書き換えたならnull）。 */
function pausedOn(changes: ProjectStatusChange[], projectId: string, timezone: string): string | null {
  const last = changes.filter(c => c.project_id === projectId).at(-1);
  return last?.to === 'paused' ? todayIn(timezone, new Date(last.changed_at)) : null;
}

/** 一覧の1行。reviewedは最後に見直した日（置いた日を含む）。項目のlabelはNOWの行頭の区分（「未解決: 」など。次の一手の本人が追加した行動は「本人が追加: 」）。休止した日も見直した記録もないプロジェクトはnull。 */
export const somedayEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), scope: z.string(), title: z.string(), item_key: z.string().regex(/^[a-f0-9]{64}$/), section: z.enum(['next', 'open']), label: z.string(), text: z.string(), since: z.string(), reviewed: z.string() }).strict(),
  z.object({ kind: z.literal('project'), project_id: projectIdSchema, title: z.string(), since: z.string().nullable(), reviewed: z.string().nullable() }).strict(),
  z.object({ kind: z.literal('idea'), idea_id: ideaIdSchema, path: z.string(), summary: z.string(), since: z.string(), reviewed: z.string() }).strict(),
]);
export type SomedayEntry = z.infer<typeof somedayEntrySchema>;
export const somedayListSchema = z.object({ schema_version: z.literal(1), generated_at: z.string().datetime({ offset: true }), review_days: z.number().int().min(1), entries: z.array(somedayEntrySchema) }).strict();
export type SomedayList = z.infer<typeof somedayListSchema>;
/** 一覧に載せるアイデアの要約の上限。 */
const SUMMARY_CHARS = 200;

/** 最後に見直した日の古い順（見直した記録のないプロジェクトが先）。同じ日は種類・IDの順。 */
const entryOrder = (e: SomedayEntry) => `${e.kind === 'item' ? 0 : e.kind === 'project' ? 1 : 2}:${e.kind === 'item' ? `${e.scope}:${e.item_key}` : e.kind === 'project' ? e.project_id : e.idea_id}`;
export function sortSomedayEntries(entries: SomedayEntry[]): SomedayEntry[] {
  return entries.sort((a, b) => (a.reviewed ?? '').localeCompare(b.reviewed ?? '') || entryOrder(a).localeCompare(entryOrder(b)));
}
/** 見直していないとみなす行か（最後に見直してからSOMEDAY_REVIEW_DAYS日以上、または見直した記録がない）。 */
export const somedayStale = (entry: Pick<SomedayEntry, 'reviewed'>, today: string) => entry.reviewed === null || waitingDays(entry.reviewed, today) >= SOMEDAY_REVIEW_DAYS;

/**
 * 「いつかやる」の一覧を組み立てる（書き込まない）。項目は直近に生成した項目一覧（now-items）から読む。
 * 進行中のプロジェクトの項目と、プロジェクト未定の本人が追加した行動が対象（休止中のプロジェクトはプロジェクトとして並べる）。
 * 壊れた項目一覧・記録は飛ばす（HOMEとdoctorで示す）。
 */
export async function buildSomedayList(config: HubConfig, vault: Vault, now = new Date(), projectsIn?: Project[]): Promise<SomedayList> {
  const projects = projectsIn ?? await readProjects(config), merged = mergeTargets(projects), entries: SomedayEntry[] = [];
  const scopes = [...projects.filter(p => !merged.has(p.id) && lifecycleOf(p) === 'active').map(p => ({ id: p.id, title: p.title })), { id: UNASSIGNED_SCOPE, title: 'プロジェクト未定' }];
  for (const scope of scopes) {
    let items;
    try { items = (await readNowItems(vault, scope.id))?.items ?? []; } catch { continue; }
    for (const i of items) if (i.resolution === null && i.someday && (scope.id !== UNASSIGNED_SCOPE || i.action)) entries.push({ kind: 'item', scope: scope.id, title: scope.title, item_key: i.key, section: i.section, label: i.label, text: i.text, since: i.someday.since, reviewed: i.someday.reviewed });
  }
  const { records } = await readSomedayReviews(vault);
  let changes: ProjectStatusChange[] = [];
  try { changes = await readProjectStatusChanges(vault); } catch { /* 壊れた状態の記録はdoctorで示す。休止した日は分からないものとして扱う。 */ }
  for (const p of projects) {
    if (merged.has(p.id) || lifecycleOf(p) !== 'paused') continue;
    const since = pausedOn(changes, p.id, config.timezone);
    const keeps = records.filter(r => r.target === 'project' && r.target_id === p.id && r.action === 'keep').map(r => r.on).sort();
    const last = keeps.at(-1), reviewed = since !== null && (last === undefined || last < since) ? since : last ?? since;
    entries.push({ kind: 'project', project_id: p.id, title: p.title, since, reviewed: reviewed ?? null });
  }
  const states = ideaStates(records);
  if ([...states.values()].some(Boolean)) {
    for (const idea of await readIdeas(vault)) {
      const state = states.get(idea.id);
      if (state) entries.push({ kind: 'idea', idea_id: idea.id, path: idea.path, summary: clipText(idea.summary.replace(/\s+/g, ' ').trim(), SUMMARY_CHARS), since: state.since, reviewed: state.reviewed });
    }
  }
  return { schema_version: 1, generated_at: now.toISOString(), review_days: SOMEDAY_REVIEW_DAYS, entries: sortSomedayEntries(entries) };
}

/** Writerロックを持つ呼び出し元から使う。一覧をアプリが読む派生物として書く（内容が変わったときだけ）。 */
export async function rebuildSomedayLocked(config: HubConfig, vault: Vault, now = new Date(), projects?: Project[]): Promise<SomedayList> {
  const built = await buildSomedayList(config, vault, now, projects), raw = await vault.read(somedayListPath);
  let old: SomedayList | undefined;
  if (raw !== undefined) try { old = somedayListSchema.parse(JSON.parse(raw)); } catch { /* 壊れた一覧は作り直す。 */ }
  if (old && JSON.stringify({ ...old, generated_at: '' }) === JSON.stringify({ ...somedayListSchema.parse(JSON.parse(JSON.stringify(built))), generated_at: '' })) return old;
  await vault.write(somedayListPath, JSON.stringify(built, null, 2) + '\n');
  return built;
}

/** HOMEに並べる、見直していない行の上限（古い順）。全件はアプリの「いつかやる」で確認する。 */
const HOME_ROWS = 5;
const entryRow = (e: SomedayEntry, today: string) => {
  const age = e.reviewed === null ? '見直した記録なし' : `${e.reviewed === e.since ? '置いてから' : '見直してから'}${waitingDays(e.reviewed, today)}日`;
  if (e.kind === 'item') return `- ${e.scope === UNASSIGNED_SCOPE ? listText(e.title) : `[${listText(e.title)}](10_projects/${e.scope}/NOW.md)`} ${e.section === 'next' ? '次の一手: ' : e.label ? '' : '未解決: '}${clipText(e.label + e.text, 120)}（${age}）`;
  if (e.kind === 'project') return `- 休止中のプロジェクト: [${listText(e.title)}](10_projects/${e.project_id}/project.md)（${age}）`;
  return `- アイデア: [${clipText(e.summary, 80)}](${e.path})（${age}）`;
};
/** HOMEの「いつかやる」の欄（前後の空行は含めない）。一覧が空なら空文字。 */
export function somedaySection(list: SomedayList, today: string): string {
  if (!list.entries.length) return '';
  const stale = list.entries.filter(e => somedayStale(e, today));
  const counts = (['item', 'project', 'idea'] as const).map(k => [k, list.entries.filter(e => e.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${{ item: '項目', project: '休止中のプロジェクト', idea: 'アイデア' }[k]}${n}件`).join('・');
  return `## いつかやる（${list.entries.length}件）\n今はやらないが残しておくものとして、本人が移した項目・置いたアイデアと、休止中のプロジェクトです（${counts}）。「次の一手」の一覧と件数には入れていません。${SOMEDAY_REVIEW_DAYS}日以上見直していないもの: ${stale.length}件。${stale.length ? `古い${Math.min(stale.length, HOME_ROWS)}件を並べます。` : ''}アプリの「いつかやる」で「始める・そのまま・やめる」を選んでください。${stale.length ? '\n' : ''}${stale.slice(0, HOME_ROWS).map(e => entryRow(e, today)).join('\n')}`;
}
/** ふりかえり（REVIEW.md）の「いつかやる」の欄の行。一覧が空なら空の配列。 */
export function somedayDigestLines(list: SomedayList, today: string): string[] {
  if (!list.entries.length) return [];
  const stale = list.entries.filter(e => somedayStale(e, today)), count = (k: SomedayEntry['kind']) => list.entries.filter(e => e.kind === k).length;
  return ['## いつかやる', `- いつかやる: ${list.entries.length}件（項目 ${count('item')}件・休止中のプロジェクト ${count('project')}件・アイデア ${count('idea')}件。うち${SOMEDAY_REVIEW_DAYS}日以上見直していない ${stale.length}件）`,
    ...(stale.length ? ['- 長く見直していないもの（古い順に最大5件）:', ...stale.slice(0, 5).map(e => `  ${entryRow(e, today)}`)] : []), ''];
}

export interface SomedayReviewRequest { target: SomedayTarget; targetId: string; action: SomedayReviewAction; on: string; source: string; sourceEventId?: string; /** 今日（検証用）。 */ now?: Date }
export interface SomedayReviewResult { target: SomedayTarget; targetId: string; action: SomedayReviewAction; reviewId: string; deduped: boolean }
const requestSchema = z.object({
  target: z.enum(somedayTargets), targetId: z.string().min(1).max(100), action: z.enum(somedayReviewActions), on: scheduleDateSchema,
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), now: z.date().optional(),
}).strict();

/**
 * アイデアを「いつかやる」に置く・見直す・始めた／やめたとして外す、休止中のプロジェクトを「そのまま」と見直したことを記録する。
 * 判断した日は今日まで（端末とのタイムゾーンの違いを見込み、翌日までは受け付ける）。アイデアのファイルとproject.mdは書き換えない。
 * 端末からの依頼が今の状態と同じ（別の端末や二度押し）なら、記録を増やさずに受け付ける。CLIでは理由を示して断る。
 */
export async function setSomedayReview(config: HubConfig, request: SomedayReviewRequest): Promise<SomedayReviewResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  if (!(r.target === 'idea' ? ideaIdSchema : projectIdSchema).safeParse(r.targetId).success) throw new Error('対象のIDが不正です');
  if (r.target === 'project' && r.action !== 'keep') throw new Error('休止中のプロジェクトを始める・やめるときは、プロジェクトの状態を切り替えてください');
  if (r.on > addDays(todayIn(config.timezone, r.now), 1)) throw new Error('判断した日に先の日付は付けられません');
  const result = (reviewId: string, deduped: boolean): SomedayReviewResult => ({ target: r.target, targetId: r.targetId, action: r.action, reviewId, deduped });
  return vault.withLock(async () => {
    const { records } = await readSomedayReviews(vault);
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.target !== r.target || previous.target_id !== r.targetId || previous.action !== r.action || previous.on !== r.on) throw new Error('同じ受付IDで別の見直しが記録されています');
        // 記録の後、一覧を作り直す前に停止した場合に備えて作り直す。
        await rebuildSomedayLocked(config, vault);
        return result(previous.id, true);
      }
    }
    const mine = records.filter(x => x.target === r.target && x.target_id === r.targetId), latest = mine.at(-1);
    if (r.target === 'project') {
      const projects = await readProjects(config), project = projects.find(p => p.id === r.targetId);
      if (!project) throw new SomedayError({ code: 'someday-refused', cause: 'missing' });
      assertNotMerged(projects, r.targetId);
      if (lifecycleOf(project) !== 'paused') throw new SomedayError({ code: 'someday-refused', cause: 'not-paused' });
      if (r.sourceEventId && latest?.action === 'keep' && latest.on === r.on) return result(latest.id, true);
    } else {
      if (!(await readIdeas(vault)).some(i => i.id === r.targetId)) throw new SomedayError({ code: 'someday-refused', cause: 'missing' });
      const state = ideaStates(mine).get(r.targetId) ?? null;
      if (r.action === 'add' && state) {
        if (r.sourceEventId && latest) return result(latest.id, true);
        throw new SomedayError({ code: 'someday-refused', cause: 'listed' });
      }
      if (r.action !== 'add' && !state) {
        if (r.sourceEventId && latest?.action === r.action) return result(latest.id, true);
        throw new SomedayError({ code: 'someday-refused', cause: 'not-listed' });
      }
      if (r.action === 'keep' && state!.reviewed === r.on && r.sourceEventId) return result(latest!.id, true);
    }
    const record: SomedayReview = { schema_version: 1, id: `SDR-${ulid()}`, target: r.target, target_id: r.targetId, action: r.action, on: r.on, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString() };
    if (!await vault.create(reviewPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('「いつかやる」の記録が競合しました');
    await rebuildSomedayLocked(config, vault);
    return result(record.id, false);
  });
}
