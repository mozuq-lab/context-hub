import { z } from 'zod';
import { clipText } from './markdown-text.js';
import { Vault } from './storage.js';
import { associatedProjects, dateLabel } from './views.js';
import { readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { UNASSIGNED_SCOPE, activeResolutions, itemKey, nowItemsPath, nowItemsSchema, readItemResolutions, type ItemResolution, type NowItem, type NowItems } from './item-resolutions.js';
import { redactText, secretSettings } from './secrets.js';
import { shortMemoText } from './short-memo.js';
import { ACTION_LABEL, actionSource, sourceRef } from './actions.js';
import { effectiveSchedules, readItemSchedules, scheduleLabel, type ItemSchedule } from './item-schedules.js';
import { effectiveEfforts, effortLabel, readItemEfforts, type ItemEffortRecord } from './item-efforts.js';
import type { HubConfig } from './types.js';

/**
 * プロジェクト未定の次の一手（90_system/unassigned-actions.json）。
 * どのプロジェクトにも結び付いていないメモは、どのNOWにも載らない。そのメモをAIが「タスク」と分類したことと、
 * AIが挙げた次の一手の提案を、モデルを使わずに新しい順へ集め、HOMEとアプリの「次の一手」に示す。
 * 行（タスクと分類したメモ・AIの提案）ごとに項目キーを付け、項目一覧（90_system/now-items/_unassigned.json）にも書く。
 * 本人は行を完了にする・「もう古い」として外す（却下）・未解決へ戻すことができ、片付けた行はこの一覧から外れる。
 * メモがプロジェクトに結び付くと一覧から外れ、そのプロジェクトのNOWに載る。
 * 本人がプロジェクトを指定せずに追加した行動（入力の種類action）も、「本人が追加: 」を付けて項目一覧の先頭に載せる。メモの件数の上限には数えず、
 * 片付けるまで残す。行動には、プロジェクトの項目と同じく期日・見直す日・定例の繰り返しと手間の目安を付けられる（項目一覧のschedule・effort）。
 * AIの行には付けない（先に行動にしてもらう）。行動はモデルで読まないため、後からプロジェクトに結び付くことはない。メモの一覧（unassigned-actions.json）には載せない
 * （旧版のアプリが読む形を変えないため。HOMEには載せる）。
 * 行動にしたAIの読み取り（タスク候補・AIの提案）は、本人が引き取ったものとして一覧から外す（プロジェクトのNOWと同じ扱い）。
 */
export const unassignedActionsPath = '90_system/unassigned-actions.json';
/** 一覧のファイルに載せるメモの上限。新しい順に載せ、全体の件数はtotal_memosで示す。 */
export const UNASSIGNED_MEMOS_MAX = 30;
/** 項目一覧に、片付いていない行を載せるメモの上限（新しい順）。アプリの「今日の3つ」に選んだ行を、新しいメモが届いても見失わないよう広めに取る。 */
export const UNASSIGNED_ITEM_MEMOS_MAX = 100;
/** 項目一覧に残す、片付けたAIの行の上限（新しい報告順）。アプリから未解決へ戻せるようにする。片付けた本人の行動は上限の外で全件残す。 */
export const UNASSIGNED_CLOSED_MAX = 30;
/** 項目一覧での行のラベル。AIの要約で示すメモの行と、AIの提案の行に付ける（本人の言葉のメモの行には付けない）。 */
export const UNASSIGNED_SUMMARY_LABEL = 'AI要約: ', UNASSIGNED_SUGGESTION_LABEL = 'AI提案: ';
/** HOME・カレンダーで、プロジェクトの名前の代わりに示す置き場の名前。 */
export const UNASSIGNED_TITLE = 'プロジェクト未定';
/** HOMEに載せる、プロジェクト未定の本人の行動の上限（古い順）。 */
export const UNASSIGNED_HOME_ACTIONS = 10;
/** HOMEに載せるメモの上限。 */
export const UNASSIGNED_HOME_MEMOS = 5;
/** HOMEに載せる、メモ1件あたりのAIの提案の上限。ファイルには重複を除いた全件を載せる。 */
export const UNASSIGNED_SUGGESTIONS_PER_MEMO = 3;
/** 本文と提案の1件の上限（文字数）。整理結果の上限（要約200・提案300）に、伏せ字で伸びた分の余裕を持たせる。 */
const TEXT_CHARS = 400;

const memoSchema = z.object({
  /** 元のメモ。 */ input_id: z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/),
  /** 元のメモの原文。受信箱の下の階層にあってもよい。 */ path: z.string().regex(/^00_inbox\/.+\.md$/),
  occurred_at: z.string().refine(s => Number.isFinite(Date.parse(s))),
  /** 訂正のない短いメモは本人の言葉、それ以外はAIの一行要約（未検証）。 */ text: z.string().min(1),
  /** textが本人の言葉か。falseならAIの一行要約（未検証）。 */ own_words: z.boolean(),
  /** AIが「タスク」と分類したメモか（未検証）。 */ task: z.boolean(),
  /** AIが挙げた次の一手の提案（未検証）。 */ suggestions: z.array(z.string().min(1)).max(10),
}).strict();
export const unassignedActionsSchema = z.object({
  schema_version: z.literal(1), generated_at: z.string().datetime(),
  /** 対象のメモの総数。memosは新しい順にUNASSIGNED_MEMOS_MAX件まで。 */ total_memos: z.number().int().nonnegative(),
  memos: z.array(memoSchema).max(UNASSIGNED_MEMOS_MAX),
}).strict().refine(d => d.total_memos >= d.memos.length);
export type UnassignedActions = z.infer<typeof unassignedActionsSchema>;
export type UnassignedMemo = UnassignedActions['memos'][number];

const clipChars = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join('') : s; };

/** 行の項目キー。プロジェクトの項目と同じ決め方で、置き場を「プロジェクト未定」にする。 */
export const unassignedItemKey = (inputId: string, text: string) => itemKey(UNASSIGNED_SCOPE, 'next', inputId, text);

/**
 * どのプロジェクトにも結び付いていない整理済みのメモから、タスクの分類とAIの提案を集める。
 * 訂正の反映を待つメモは、古い解釈を行動として示さないよう載せない。本人がプロジェクトを指定したメモと、
 * AIが基準以上の確信度で帰属を推定したメモは、そのプロジェクトのNOWに載るので対象外。
 * 本人が片付けた行（完了・却下）は一覧から外し、項目一覧には片付けた行として残す。
 */
export function buildUnassignedActions(config: HubConfig, units: EffectiveInput[], now = new Date(), resolutions: ItemResolution[] = []): UnassignedActions {
  return buildUnassigned(config, units, now, resolutions).actions;
}
/** 本人が行動に付けた記録（期日・見直す日・手間の目安）。読めなかったときは空として一覧を作る。 */
export interface UnassignedRecords { schedules?: ItemSchedule[]; efforts?: ItemEffortRecord[] }
export function buildUnassigned(config: HubConfig, units: EffectiveInput[], now = new Date(), resolutions: ItemResolution[] = [], records: UnassignedRecords = {}): { actions: UnassignedActions; items: NowItems } {
  const settings = secretSettings(config), hide = (s: string) => settings.enabled ? redactText(s, settings).text : s;
  const closed = activeResolutions(resolutions, UNASSIGNED_SCOPE);
  const memos: UnassignedMemo[] = [], openRows: NowItem[][] = [], closedRows: NowItem[] = [], seen = new Set<string>();
  const found: { memo: UnassignedMemo; rows: NowItem[] }[] = [];
  const resolutionOf = (key: string): NowItem['resolution'] => {
    const r = closed.get(key);
    return r ? { id: r.id, at: r.created_at, source: r.source, ...(r.action === 'exclude' ? { action: 'exclude' as const, reason: r.reason, ...(r.note ? { note: r.note } : {}) } : {}) } : null;
  };
  // 行動にしたAIの読み取り。どのプロジェクトで（またはプロジェクト未定で）行動にしても、元の行は本人が引き取ったものとして扱う。
  const converted = new Set<string>(), convertedKeys = new Set<string>();
  for (const unit of units) { const from = actionSource(unit.chain.root); if (from) { converted.add(sourceRef(from.input_id, from.text)); if (from.key) convertedKeys.add(from.key); } }
  // プロジェクトを指定せずに本人が追加した行動。最新の文面（訂正があれば訂正）を本人の言葉のまま、追加した順に載せる。
  const own = units.filter(u => u.chain.root.kind === 'action' && u.chain.root.project === undefined)
    .sort((a, b) => Date.parse(a.chain.root.occurred_at) - Date.parse(b.chain.root.occurred_at) || a.chain.root.id.localeCompare(b.chain.root.id));
  // 片付けた本人の行動は、上限の外で全件残す（プロジェクトの項目一覧と同じ。消えると、アプリが追加の依頼を反映待ちに戻すため）。
  const ownOpen: NowItem[] = [], ownClosed: NowItem[] = [];
  for (const unit of own) {
    const root = unit.chain.root, text = unit.chain.latest.text, key = unassignedItemKey(root.id, text), from = actionSource(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const item: NowItem = { key, section: 'next', label: ACTION_LABEL, text, input_id: root.id, resolution: resolutionOf(key), action: from ? { from } : {} };
    (item.resolution ? ownClosed : ownOpen).push(item);
  }
  // 行動の日付と手間の目安。引き継ぎの規則はプロジェクトの項目と同じ（文面を直しても同じ行動の記録が効く）。片付けた行動には付けない。
  const ownItems = [...ownOpen, ...ownClosed];
  const scheduled = effectiveSchedules(records.schedules ?? [], UNASSIGNED_SCOPE, ownItems, closed).byKey;
  const efforts = effectiveEfforts(records.efforts ?? [], UNASSIGNED_SCOPE, ownItems, closed);
  for (const item of ownOpen) {
    const s = scheduled.get(item.key), e = efforts.get(item.key);
    if (s) item.schedule = { id: s.id, due: s.due, review_after: s.review_after, ...(s.repeat ? { repeat: s.repeat } : {}) };
    if (e) item.effort = e;
  }
  for (const unit of units) {
    const { chain, receipt } = unit, result = receipt?.result;
    if (!receipt || !result || unit.pendingCorrection || associatedProjects(chain.root, receipt, config).length) continue;
    const task = result.category === 'task' && chain.root.kind === 'memo';
    const suggestions = [...new Set(result.next_action_suggestions.map(s => clipChars(hide(s).trim().replace(/\s+/g, ' '), TEXT_CHARS)).filter(Boolean))].slice(0, 10);
    if (!task && !suggestions.length) continue;
    // 短いメモは、古い整理結果の言い換えではなく本人の言葉を見せる（モデルへ渡すときと同じ伏せ字の本文）。
    const own = shortMemoText({ root: { ...chain.root, text: hide(chain.root.text) }, revisions: chain.revisions });
    const text = clipChars(own ?? hide(result.summary).trim().replace(/\s+/g, ' '), TEXT_CHARS);
    if (!text) continue;
    const memo: UnassignedMemo = { input_id: chain.root.id, path: chain.root.path, occurred_at: chain.root.occurred_at, text, own_words: own !== undefined, task, suggestions };
    // 形式に合わないメモは載せない。一覧のファイルを、読む側がいつも検証できる形に保つ。
    if (!memoSchema.safeParse(memo).success) continue;
    const row = (label: string, value: string): NowItem[] => {
      const key = unassignedItemKey(memo.input_id, value);
      // 行動にした行は、片付けた行とも分けて一覧から外す（項目一覧にも残さない。行動の側で完了・却下を扱う）。
      if (converted.has(sourceRef(memo.input_id, value)) || convertedKeys.has(key)) return [];
      return [{ key, section: 'next', label, text: value, input_id: memo.input_id, resolution: resolutionOf(key) }];
    };
    const rows = [...(task ? row(own !== undefined ? '' : UNASSIGNED_SUMMARY_LABEL, text) : []), ...suggestions.flatMap(s => row(UNASSIGNED_SUGGESTION_LABEL, s))];
    if (rows.length) found.push({ memo, rows });
  }
  found.sort((a, b) => Date.parse(b.memo.occurred_at) - Date.parse(a.memo.occurred_at) || b.memo.input_id.localeCompare(a.memo.input_id));
  for (const { memo, rows } of found) {
    // 同じ本文の行（メモの本文と提案が同じなど）は同じ項目になる。1回だけ数える。
    const unique = rows.filter(r => !seen.has(r.key) && seen.add(r.key));
    const open = unique.filter(r => r.resolution === null), openKeys = new Set(rows.filter(r => r.resolution === null).map(r => r.key));
    closedRows.push(...unique.filter(r => r.resolution !== null));
    if (!open.length) continue;
    // 片付けた行・行動にした行はメモの一覧から外す。メモの行がなければタスクの印を外し、提案は残っている行のものだけを残す。
    memos.push({ ...memo, task: memo.task && openKeys.has(unassignedItemKey(memo.input_id, memo.text)), suggestions: memo.suggestions.filter(s => openKeys.has(unassignedItemKey(memo.input_id, s))) });
    openRows.push(open);
  }
  closedRows.sort((a, b) => b.resolution!.id.localeCompare(a.resolution!.id));
  ownClosed.sort((a, b) => b.resolution!.id.localeCompare(a.resolution!.id));
  const generatedAt = now.toISOString();
  const items: NowItems = { schema_version: 1, project: UNASSIGNED_SCOPE, generated_at: generatedAt, items: [...ownOpen, ...openRows.slice(0, UNASSIGNED_ITEM_MEMOS_MAX).flat(), ...ownClosed, ...closedRows.slice(0, UNASSIGNED_CLOSED_MAX)] };
  return { actions: { schema_version: 1, generated_at: generatedAt, total_memos: memos.length, memos: memos.slice(0, UNASSIGNED_MEMOS_MAX) }, items };
}

/** 項目一覧のパス。 */
export const unassignedItemsPath = nowItemsPath(UNASSIGNED_SCOPE);
/** 内容が前回と同じなら書き込まず、同期のたびに差分を作らない。 */
async function writeIfChanged<T extends { generated_at: string }>(vault: Vault, path: string, built: T, parse: (raw: string) => T): Promise<T> {
  const raw = await vault.read(path);
  let old: T | undefined;
  if (raw !== undefined) try { old = parse(raw); } catch { /* 壊れた一覧は作り直す。 */ }
  // 読み直した形（スキーマの項目順）どうしで比べる。組み立てた順のままだと、日付の付いた行で毎回書き直してしまう。
  if (old && JSON.stringify({ ...old, generated_at: '' }) === JSON.stringify({ ...parse(JSON.stringify(built)), generated_at: '' })) return old;
  await vault.write(path, JSON.stringify(built, null, 2) + '\n');
  return built;
}
/**
 * Writerロックを持つ呼び出し元から使う。一覧と項目一覧を書く（内容が変わったときだけ）。
 * 完了・却下の記録を読めないときは、片付けた行がないものとして一覧を作る（不正な記録はdoctorとHOMEで示し、報告の受付も止まる）。
 * 日付・手間の目安の記録を読めないときは、付いていないものとして作る。
 */
export async function rebuildUnassignedActionsLocked(config: HubConfig, vault: Vault, units: EffectiveInput[], now = new Date()): Promise<{ actions: UnassignedActions; items: NowItems }> {
  let resolutions: ItemResolution[] = [];
  try { resolutions = await readItemResolutions(vault); } catch { /* 上のとおり。 */ }
  // 日付・手間の目安の記録は、読めたものだけを使う（不正な記録はdoctorとHOMEで示す）。
  const records: UnassignedRecords = {};
  try { records.schedules = (await readItemSchedules(vault)).records; } catch { /* 上のとおり。 */ }
  try { records.efforts = (await readItemEfforts(vault)).records; } catch { /* 上のとおり。 */ }
  const built = buildUnassigned(config, units, now, resolutions, records);
  const items = await writeIfChanged(vault, unassignedItemsPath, built.items, raw => nowItemsSchema.parse(JSON.parse(raw)));
  return { actions: await writeIfChanged(vault, unassignedActionsPath, built.actions, raw => unassignedActionsSchema.parse(JSON.parse(raw))), items };
}
/** 行の完了・却下、行動の日付・手間の目安を記録した後に、一覧と項目一覧を作り直す（Writerロック内）。 */
export async function rebuildUnassignedLocked(config: HubConfig, vault: Vault, now = new Date()): Promise<void> {
  await rebuildUnassignedActionsLocked(config, vault, await readEffectiveInputs(config), now);
}

const clip = (s: string, n = 120) => clipText(s, n);
/** 原文へのリンク先。空白や括弧を含むパスは、リンクが途中で切れないよう山括弧で囲む。 */
const destination = (path: string) => /[\s()]/.test(path) ? `<${path}>` : path;
/** 行動の行末に付ける、本人が付けた日付と手間の目安の表示（なければ空文字）。 */
export function unassignedItemLabel(item: Pick<NowItem, 'schedule' | 'effort'>): string {
  const label = [item.schedule ? scheduleLabel({ due: item.schedule.due, review_after: item.schedule.review_after, repeat: item.schedule.repeat ?? null }) : '', item.effort ? effortLabel(item.effort) : ''].filter(Boolean).join('・');
  return label ? `（${label}）` : '';
}
/**
 * HOMEの「プロジェクト未定の次の一手」（前後の空行は含めない）。本人が追加した行動と対象のメモがなければ空文字。
 * pathsは入力IDから原文のパスを引く表（本人が追加した行動の原文へのリンクに使う）。
 * frontは、期日が近いため、HOMEの「次の一手」の期日の欄に載せた行動のキー。ここでは件数だけを示す（見直す日まで休ませている行動は、HOMEではここにだけ載るので、日付を付けて載せる）。
 */
export function unassignedActionsSection(config: HubConfig, built: { actions: UnassignedActions; items: NowItems }, paths: ReadonlyMap<string, string> = new Map(), front: ReadonlySet<string> = new Set()): string {
  const { actions } = built, open = built.items.items.filter(i => i.action && i.resolution === null), own = open.filter(i => !front.has(i.key));
  if (!actions.memos.length && !open.length) return '';
  const link = (inputId: string) => { const path = paths.get(inputId); return path ? `[${inputId}](${destination(path)})` : inputId; };
  const moved = open.length - own.length;
  const ownRows = [
    ...own.slice(0, UNASSIGNED_HOME_ACTIONS).map(i => `- ${ACTION_LABEL}${clip(i.text)}${unassignedItemLabel(i)} — ${link(i.input_id)}`),
    ...(own.length > UNASSIGNED_HOME_ACTIONS ? [`- ほか本人が追加した行動${own.length - UNASSIGNED_HOME_ACTIONS}件（アプリの「次の一手」で確認）`] : []),
    ...(moved ? [`- 期日が近い行動${moved}件は、「次の一手」の期日の欄で示します`] : []),
  ];
  const rows = actions.memos.slice(0, UNASSIGNED_HOME_MEMOS).flatMap(m => [
    `- ${dateLabel(m.occurred_at, config.timezone).slice(0, 10)} ${m.own_words ? '' : 'AI要約: '}${clip(m.text)} — [${m.input_id}](${destination(m.path)})${m.task ? ' / タスク候補' : ''}`,
    ...m.suggestions.slice(0, UNASSIGNED_SUGGESTIONS_PER_MEMO).map(s => `  - AI提案: ${clip(s)}`),
    ...(m.suggestions.length > UNASSIGNED_SUGGESTIONS_PER_MEMO ? [`  - ほかAI提案${m.suggestions.length - UNASSIGNED_SUGGESTIONS_PER_MEMO}件（アプリの「次の一手」で確認）`] : []),
  ]);
  const counts = [open.length ? `本人が追加した行動${open.length}件` : '', actions.memos.length ? `メモ${actions.total_memos}件` : ''].filter(Boolean).join('・');
  const ownText = open.length ? `「${ACTION_LABEL.trim()}」は、本人がプロジェクトを決めずに追加した行動です（${own.length > UNASSIGNED_HOME_ACTIONS ? `古い${UNASSIGNED_HOME_ACTIONS}件を載せます。` : ''}完了・却下するまで残ります。期日・見直す日・手間の目安を付けられます）。` : '';
  const memoText = actions.memos.length ? `${own.length ? 'ほかは、' : ''}どのプロジェクトにも結び付いていないメモから、AIが「タスク」と分類したものと、AIが挙げた次の一手の提案を集めた一覧です。短いメモは本人の言葉のまま、長いメモは「AI要約:」を付けた一行要約で示します。分類・要約・提案はAI生成・未検証です。` : '';
  const moveText = actions.memos.length ? `メモがプロジェクトに結び付くと、そのプロジェクトのNOWへ移ります。${actions.total_memos > UNASSIGNED_HOME_MEMOS ? `新しい${UNASSIGNED_HOME_MEMOS}件を載せます。` : ''}` : '';
  return `## プロジェクト未定の次の一手（${counts}）\n${ownText}${memoText}アプリから行ごとに「今日やる」「完了」「却下」ができ、片付けた行はここから外れます${actions.memos.length ? '（AIの行に期日を付けるときは、先に「自分の行動にする」で行動にしてください）' : ''}。${moveText}\n${[...ownRows, ...rows].join('\n')}`;
}
