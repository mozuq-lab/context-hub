import { z } from 'zod';
import { clipText } from './markdown-text.js';
import { Vault } from './storage.js';
import { associatedProjects, dateLabel } from './views.js';
import { readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { UNASSIGNED_SCOPE, activeResolutions, itemKey, nowItemsPath, nowItemsSchema, readItemResolutions, type ItemResolution, type NowItem, type NowItems } from './item-resolutions.js';
import { redactText, secretSettings } from './secrets.js';
import { shortMemoText } from './short-memo.js';
import type { HubConfig } from './types.js';

/**
 * プロジェクト未定の次の一手（90_system/unassigned-actions.json）。
 * どのプロジェクトにも結び付いていないメモは、どのNOWにも載らない。そのメモをAIが「タスク」と分類したことと、
 * AIが挙げた次の一手の提案を、モデルを使わずに新しい順へ集め、HOMEとアプリの「次の一手」に示す。
 * 行（タスクと分類したメモ・AIの提案）ごとに項目キーを付け、項目一覧（90_system/now-items/_unassigned.json）にも書く。
 * 本人は行を完了にする・「もう古い」として外す（却下）・未解決へ戻すことができ、片付けた行はこの一覧から外れる。期日の対象にはしない。
 * メモがプロジェクトに結び付くと一覧から外れ、そのプロジェクトのNOWに載る。
 */
export const unassignedActionsPath = '90_system/unassigned-actions.json';
/** 一覧のファイルに載せるメモの上限。新しい順に載せ、全体の件数はtotal_memosで示す。 */
export const UNASSIGNED_MEMOS_MAX = 30;
/** 項目一覧に、片付いていない行を載せるメモの上限（新しい順）。アプリの「今日の3つ」に選んだ行を、新しいメモが届いても見失わないよう広めに取る。 */
export const UNASSIGNED_ITEM_MEMOS_MAX = 100;
/** 項目一覧に残す、片付けた行の上限（新しい報告順）。アプリから未解決へ戻せるようにする。 */
export const UNASSIGNED_CLOSED_MAX = 30;
/** 項目一覧での行のラベル。AIの要約で示すメモの行と、AIの提案の行に付ける（本人の言葉のメモの行には付けない）。 */
export const UNASSIGNED_SUMMARY_LABEL = 'AI要約: ', UNASSIGNED_SUGGESTION_LABEL = 'AI提案: ';
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
export function buildUnassigned(config: HubConfig, units: EffectiveInput[], now = new Date(), resolutions: ItemResolution[] = []): { actions: UnassignedActions; items: NowItems } {
  const settings = secretSettings(config), hide = (s: string) => settings.enabled ? redactText(s, settings).text : s;
  const closed = activeResolutions(resolutions, UNASSIGNED_SCOPE);
  const memos: UnassignedMemo[] = [], openRows: NowItem[][] = [], closedRows: NowItem[] = [], seen = new Set<string>();
  const found: { memo: UnassignedMemo; rows: NowItem[] }[] = [];
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
    const row = (label: string, value: string): NowItem => {
      const key = unassignedItemKey(memo.input_id, value), r = closed.get(key);
      return { key, section: 'next', label, text: value, input_id: memo.input_id, resolution: r ? { id: r.id, at: r.created_at, source: r.source, ...(r.action === 'exclude' ? { action: 'exclude' as const, reason: r.reason, ...(r.note ? { note: r.note } : {}) } : {}) } : null };
    };
    found.push({ memo, rows: [...(task ? [row(own !== undefined ? '' : UNASSIGNED_SUMMARY_LABEL, text)] : []), ...suggestions.map(s => row(UNASSIGNED_SUGGESTION_LABEL, s))] });
  }
  found.sort((a, b) => Date.parse(b.memo.occurred_at) - Date.parse(a.memo.occurred_at) || b.memo.input_id.localeCompare(a.memo.input_id));
  for (const { memo, rows } of found) {
    // 同じ本文の行（メモの本文と提案が同じなど）は同じ項目になる。1回だけ数える。
    const unique = rows.filter(r => !seen.has(r.key) && seen.add(r.key));
    const open = unique.filter(r => r.resolution === null), openKeys = new Set(rows.filter(r => r.resolution === null).map(r => r.key));
    closedRows.push(...unique.filter(r => r.resolution !== null));
    if (!open.length) continue;
    // 片付けた行はメモの一覧から外す。メモの行を片付けたらタスクの印を外し、提案は片付いていないものだけを残す。
    memos.push({ ...memo, task: memo.task && openKeys.has(unassignedItemKey(memo.input_id, memo.text)), suggestions: memo.suggestions.filter(s => openKeys.has(unassignedItemKey(memo.input_id, s))) });
    openRows.push(open);
  }
  closedRows.sort((a, b) => b.resolution!.id.localeCompare(a.resolution!.id));
  const generatedAt = now.toISOString();
  const items: NowItems = { schema_version: 1, project: UNASSIGNED_SCOPE, generated_at: generatedAt, items: [...openRows.slice(0, UNASSIGNED_ITEM_MEMOS_MAX).flat(), ...closedRows.slice(0, UNASSIGNED_CLOSED_MAX)] };
  return { actions: { schema_version: 1, generated_at: generatedAt, total_memos: memos.length, memos: memos.slice(0, UNASSIGNED_MEMOS_MAX) }, items };
}

/** 項目一覧のパス。 */
export const unassignedItemsPath = nowItemsPath(UNASSIGNED_SCOPE);
/** 内容が前回と同じなら書き込まず、同期のたびに差分を作らない。 */
async function writeIfChanged<T extends { generated_at: string }>(vault: Vault, path: string, built: T, parse: (raw: string) => T): Promise<T> {
  const raw = await vault.read(path);
  let old: T | undefined;
  if (raw !== undefined) try { old = parse(raw); } catch { /* 壊れた一覧は作り直す。 */ }
  if (old && JSON.stringify({ ...old, generated_at: '' }) === JSON.stringify({ ...built, generated_at: '' })) return old;
  await vault.write(path, JSON.stringify(built, null, 2) + '\n');
  return built;
}
/**
 * Writerロックを持つ呼び出し元から使う。一覧と項目一覧を書く（内容が変わったときだけ）。
 * 完了・却下の記録を読めないときは、片付けた行がないものとして一覧を作る（不正な記録はdoctorとHOMEで示し、報告の受付も止まる）。
 */
export async function rebuildUnassignedActionsLocked(config: HubConfig, vault: Vault, units: EffectiveInput[], now = new Date()): Promise<UnassignedActions> {
  let resolutions: ItemResolution[] = [];
  try { resolutions = await readItemResolutions(vault); } catch { /* 上のとおり。 */ }
  const built = buildUnassigned(config, units, now, resolutions);
  await writeIfChanged(vault, unassignedItemsPath, built.items, raw => nowItemsSchema.parse(JSON.parse(raw)));
  return writeIfChanged(vault, unassignedActionsPath, built.actions, raw => unassignedActionsSchema.parse(JSON.parse(raw)));
}
/** 行の完了・却下を記録した後に、一覧と項目一覧を作り直す（Writerロック内）。 */
export async function rebuildUnassignedLocked(config: HubConfig, vault: Vault, now = new Date()): Promise<void> {
  await rebuildUnassignedActionsLocked(config, vault, await readEffectiveInputs(config), now);
}

const clip = (s: string, n = 120) => clipText(s, n);
/** 原文へのリンク先。空白や括弧を含むパスは、リンクが途中で切れないよう山括弧で囲む。 */
const destination = (path: string) => /[\s()]/.test(path) ? `<${path}>` : path;
/** HOMEの「プロジェクト未定の次の一手」（前後の空行は含めない）。対象のメモがなければ空文字。 */
export function unassignedActionsSection(config: HubConfig, actions: UnassignedActions): string {
  if (!actions.memos.length) return '';
  const rows = actions.memos.slice(0, UNASSIGNED_HOME_MEMOS).flatMap(m => [
    `- ${dateLabel(m.occurred_at, config.timezone).slice(0, 10)} ${m.own_words ? '' : 'AI要約: '}${clip(m.text)} — [${m.input_id}](${destination(m.path)})${m.task ? ' / タスク候補' : ''}`,
    ...m.suggestions.slice(0, UNASSIGNED_SUGGESTIONS_PER_MEMO).map(s => `  - AI提案: ${clip(s)}`),
    ...(m.suggestions.length > UNASSIGNED_SUGGESTIONS_PER_MEMO ? [`  - ほかAI提案${m.suggestions.length - UNASSIGNED_SUGGESTIONS_PER_MEMO}件（アプリの「次の一手」で確認）`] : []),
  ]);
  return `## プロジェクト未定の次の一手（メモ${actions.total_memos}件）\nどのプロジェクトにも結び付いていないメモから、AIが「タスク」と分類したものと、AIが挙げた次の一手の提案を集めた一覧です。短いメモは本人の言葉のまま、長いメモは「AI要約:」を付けた一行要約で示します。分類・要約・提案はAI生成・未検証です。アプリから行ごとに「今日やる」「完了」「却下」ができ、片付けた行はここから外れます（期日は付けられません）。メモがプロジェクトに結び付くと、そのプロジェクトのNOWへ移ります。${actions.total_memos > UNASSIGNED_HOME_MEMOS ? `新しい${UNASSIGNED_HOME_MEMOS}件を載せます。` : ''}\n${rows.join('\n')}`;
}
