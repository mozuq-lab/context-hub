import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { inputIdSchema, readInputs } from './capture.js';
import type { HubConfig } from './types.js';

/**
 * 本人が資料棚に載せる・外す記録（90_system/reference-marks/REFM-*.json）。
 * - add: AIの分類に関係なく資料棚に載せる。titleは本人が付けた資料の名前で、資料棚ではAIの要約の代わりに示す（nullなら要約のまま）。
 *   名前を変えるのも、外した資料を戻すのも、変更後の全体をaddで記録する。
 * - remove: AIが参考資料に分類したメモも含めて、資料棚から外す。メモ自体と整理結果は変えない。
 * 同じメモの記録は、本人が判断した日時（decided_at）の順で最後のものを有効にする。記録のないメモは、AIの分類（reference）で決まる。
 * 原文（00_inbox）は書き換えない。本文やURLを直すときは、今の訂正（correct）を使う。
 */
export const REFERENCE_TITLE_CHARS = 100;
export const referenceMarkIdSchema = z.string().regex(/^REFM-[0-9A-HJKMNP-TV-Z]{26}$/);
export const referenceMarkActions = ['add', 'remove'] as const;
export type ReferenceMarkAction = typeof referenceMarkActions[number];
export const referenceMarkActionSchema = z.enum(referenceMarkActions);
/** 資料の名前。1行で、前後に空白を付けない。 */
export const referenceTitleSchema = z.string().min(1, '資料の名前が空です').max(REFERENCE_TITLE_CHARS, `資料の名前は${REFERENCE_TITLE_CHARS}文字以内にしてください`)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]+$/u, '資料の名前は1行で書いてください（制御文字は使えません）').refine(v => v.trim() === v, '資料の名前の前後に空白は付けられません');
const timestamp = z.string().datetime({ offset: true });
export const referenceMarkSchema = z.object({
  schema_version: z.literal(1), id: referenceMarkIdSchema,
  /** 対象のメモ（訂正を除いた元の入力のID）。 */ input_id: inputIdSchema,
  action: referenceMarkActionSchema,
  /** 本人が付けた資料の名前。外す記録と、名前を付けていない資料ではnull。 */ title: referenceTitleSchema.nullable(),
  /** 本人が判断した日時（アプリの依頼の発生日時、CLIは実行日時）。 */ decided_at: timestamp,
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: timestamp,
}).strict().refine(v => v.action === 'add' || v.title === null, '外す記録には名前を付けません');
export type ReferenceMark = z.infer<typeof referenceMarkSchema>;

const markDir = '90_system/reference-marks';
const markPath = (id: string) => `${markDir}/${id}.json`;

/** 記録と、読めなかった記録のパス。不正な記録があっても資料棚とHOMEの生成は止めず、HOMEとdoctorで示す。 */
export async function readReferenceMarks(vault: Vault): Promise<{ records: ReferenceMark[]; problems: string[] }> {
  const records: ReferenceMark[] = [], problems: string[] = [];
  for (const path of await vault.files(markDir)) {
    if (!/^90_system\/reference-marks\/REFM-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = referenceMarkSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== markPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  return { records: records.sort((a, b) => a.id.localeCompare(b.id)), problems };
}

/** メモごとに最後の判断だけを有効にする。同期でまとめて届いた依頼は受付の順が判断の順と限らないため、判断した日時の順に並べる。 */
export function effectiveReferenceMarks(records: ReferenceMark[]): Map<string, ReferenceMark> {
  const ordered = [...records].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at) || a.id.localeCompare(b.id));
  const latest = new Map<string, ReferenceMark>();
  for (const r of ordered) latest.set(r.input_id, r);
  return latest;
}

/** 資料棚に載るか。本人の記録があればそれに従い、なければAIの分類（reference）で決まる。 */
export function onReferenceShelf(category: string | undefined, mark: ReferenceMark | undefined): boolean {
  return mark ? mark.action === 'add' : category === 'reference';
}

export type ReferenceRefusalCause = 'missing' | 'kind';
export const referenceRefusalCauses = ['missing', 'kind'] as const satisfies readonly ReferenceRefusalCause[];
export function referenceMessage(reason: { cause: ReferenceRefusalCause }): string {
  return reason.cause === 'missing'
    ? '資料にするメモが見つかりません。同期してから、メモを確かめ直してください。'
    : '資料にできるのはメモと作業要約だけです（本人が追加した行動と訂正は資料にできません）。';
}
export class ReferenceMarkError extends Error {
  constructor(readonly reason: { code: 'reference-refused'; cause: ReferenceRefusalCause }) {
    super(referenceMessage(reason));
    this.name = 'ReferenceMarkError';
  }
}

export interface ReferenceMarkRequest {
  inputId: string; action: ReferenceMarkAction; title?: string | null; source: string; sourceEventId?: string;
  /** 判断した日時。省略時は今。 */ decidedAt?: string;
}
export interface ReferenceMarkResult { inputId: string; action: ReferenceMarkAction; markId: string; deduped: boolean }
const requestSchema = z.object({
  inputId: inputIdSchema, action: referenceMarkActionSchema, title: referenceTitleSchema.nullable().optional(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
  decidedAt: z.string().refine(v => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))).optional(),
}).strict().refine(r => r.action === 'add' || r.title === undefined || r.title === null, '外すときは名前を指定しません');

/**
 * 記録を1件書く（Writerロック内）。同じ出典・受付IDの記録があれば、同じ内容なら書かずにそれを返す（再送）。
 * 対象のメモが資料にできるかは、呼び出し側が確かめる。
 */
export async function writeReferenceMarkLocked(vault: Vault, request: ReferenceMarkRequest): Promise<ReferenceMarkResult> {
  const r = requestSchema.parse(request), title = r.action === 'add' ? r.title ?? null : null;
  if (r.sourceEventId) {
    const previous = (await readReferenceMarks(vault)).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
    if (previous) {
      if (previous.input_id !== r.inputId || previous.action !== r.action || previous.title !== title) throw new Error('同じ受付IDで別の資料の記録があります');
      return { inputId: previous.input_id, action: previous.action, markId: previous.id, deduped: true };
    }
  }
  const record: ReferenceMark = {
    schema_version: 1, id: `REFM-${ulid()}`, input_id: r.inputId, action: r.action, title,
    decided_at: new Date(r.decidedAt ?? Date.now()).toISOString(),
    source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
  };
  if (!await vault.create(markPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('資料の記録が競合しました');
  return { inputId: record.input_id, action: record.action, markId: record.id, deduped: false };
}

/**
 * 保存済みのメモを資料棚に載せる（名前を変える・外した資料を戻すのも同じ）か、資料棚から外す。
 * 対象は、訂正を除いた元の入力のメモか作業要約。資料棚（REFERENCES.mdと一覧）はcycleが作り直す。
 */
export async function setReferenceMark(config: HubConfig, request: ReferenceMarkRequest): Promise<ReferenceMarkResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    // 再送は、記録の後にメモが見えなくなっていても同じ結果を返す。
    if (r.sourceEventId && (await readReferenceMarks(vault)).records.some(x => x.source === r.source && x.source_event_id === r.sourceEventId)) return writeReferenceMarkLocked(vault, r);
    const input = (await readInputs(config)).find(i => i.id === r.inputId);
    if (!input) throw new ReferenceMarkError({ code: 'reference-refused', cause: 'missing' });
    if (input.kind !== 'memo' && input.kind !== 'work-summary') throw new ReferenceMarkError({ code: 'reference-refused', cause: 'kind' });
    return writeReferenceMarkLocked(vault, r);
  });
}
