import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { addDays, scheduleDateSchema, todayIn } from './item-schedules.js';
import { listText } from './markdown-text.js';
import type { HubConfig } from './types.js';

/**
 * 1日の締め。本人がその日を締めた記録と、翌日の自分へ残す「明日へのひとこと」（任意・1〜3行）。
 * ひとことは、次に締めるか本人が消すまでHOMEとアプリの先頭に出し、ふりかえりにはその週の締めを日付順に添える。
 * メモ（原文）ではないので整理しない（AIへは渡さない）。今日の成果の集計（完了した項目など）は記録せず、表示のたびに記録から作る。
 */
export const DAY_NOTE_CHARS = 300;
export const DAY_NOTE_LINES = 3;
/** さかのぼって締められる日数（朝に前の日を締める、数日まとめて締めるなど）。 */
export const DAY_CLOSE_BACK_DAYS = 7;
export const dayCloseIdSchema = z.string().regex(/^DAY-[0-9A-HJKMNP-TV-Z]{26}$/);
export const dayCloseActions = ['close', 'dismiss'] as const;

/** ひとことを整える。改行をそろえ、行末の空白と前後の空行を除く。空ならnull。 */
export function normalizeDayNote(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd());
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.length ? lines.join('\n') : null;
}
/** 整えたひとことの検証。上限と、使えない文字（改行以外の制御文字）。 */
export const dayNoteSchema = z.string().min(1).max(DAY_NOTE_CHARS, `明日へのひとことは${DAY_NOTE_CHARS}文字以内にしてください`)
  .refine(v => v.split('\n').length <= DAY_NOTE_LINES, `明日へのひとことは${DAY_NOTE_LINES}行以内にしてください`)
  .refine(v => v.split('\n').every(line => !/[\p{Cc}\u2028\u2029]/u.test(line)), '明日へのひとことに使えない文字が含まれています');

/** closeは、onの日を締めた記録（noteは明日へのひとこと。なければnull）。dismissは、表示中のひとこと（close_idの締め）を消した記録。 */
export const dayCloseRecordSchema = z.discriminatedUnion('action', [
  z.object({ schema_version: z.literal(1), id: dayCloseIdSchema, action: z.literal('close'), on: scheduleDateSchema, note: dayNoteSchema.nullable(), source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }) }).strict(),
  z.object({ schema_version: z.literal(1), id: dayCloseIdSchema, action: z.literal('dismiss'), close_id: dayCloseIdSchema, source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }) }).strict(),
]);
export type DayCloseRecord = z.infer<typeof dayCloseRecordSchema>;
export type DayClose = Extract<DayCloseRecord, { action: 'close' }>;
export const dayClosesDir = '90_system/day-closes';
export const dayClosePath = (id: string) => `${dayClosesDir}/${id}.json`;

/** 記録と、読めなかった記録のパス（古い順）。不正な記録があってもHOMEの生成は止めず、HOMEとdoctorで示す。 */
export async function readDayCloses(vault: Vault): Promise<{ records: DayCloseRecord[]; problems: string[] }> {
  const records: DayCloseRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(dayClosesDir)) {
    if (!/^90_system\/day-closes\/DAY-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = dayCloseRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== dayClosePath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records, problems };
}

/** 日ごとの締め（同じ日を締め直したときは最後の記録）。日付の古い順。 */
export function dayClosesByDate(records: DayCloseRecord[]): DayClose[] {
  const byDate = new Map<string, DayClose>();
  for (const r of records) if (r.action === 'close') byDate.set(r.on, r);
  return [...byDate.values()].sort((a, b) => a.on.localeCompare(b.on));
}
/** いちばん新しい日の締め（なければundefined）。 */
export const latestDayClose = (records: DayCloseRecord[]): DayClose | undefined => dayClosesByDate(records).at(-1);
/**
 * いま示す明日へのひとこと。いちばん新しい日の締めにひとことがあり、本人が消していなければ、その締め。
 * 新しく締めると、ひとことの有無にかかわらず前のひとことは出さない（次の締めまでの引き継ぎのため）。
 */
export function currentDayNote(records: DayCloseRecord[]): (DayClose & { note: string }) | undefined {
  const latest = latestDayClose(records);
  if (!latest?.note || records.some(r => r.action === 'dismiss' && r.close_id === latest.id)) return undefined;
  return latest as DayClose & { note: string };
}

/** HOMEの先頭に置く「前回の締め」。示すひとことがなければ空。 */
export function dayNoteSection(records: DayCloseRecord[], today: string): string {
  const current = currentDayNote(records);
  if (!current) return '';
  const days = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${current.on}T00:00:00Z`)) / 86_400_000));
  const when = days === 0 ? '今日' : days === 1 ? '昨日' : `${days}日前`;
  return `## 前回の締め（${current.on}・${when}）\n明日へのひとこと:\n${current.note.split('\n').map(l => `> ${listText(l)}`).join('\n')}\n\n次に締めると置き換わります。読んだら、アプリの「消す」か\`ctx day dismiss --confirm\`で消せます。`;
}
/** ふりかえりに添える、期間内の締め（日付の古い順）。 */
export function dayClosesWithin(records: DayCloseRecord[], from: string, to: string): DayClose[] {
  return dayClosesByDate(records).filter(r => r.on >= from && r.on <= to);
}

/**
 * 締められない・消せない理由。out-of-range: 締める日が先の日か、さかのぼれる日数より前 / missing: 消すひとことが見当たらない（別の端末で締め直したなど）。
 */
export const dayCloseRefusalCauses = ['out-of-range', 'missing'] as const;
export type DayCloseReason = { code: 'day-close-refused'; cause: typeof dayCloseRefusalCauses[number] };
export class DayCloseError extends Error {
  constructor(readonly reason: DayCloseReason) { super(dayCloseMessage(reason)); this.name = 'DayCloseError'; }
}
export function dayCloseMessage(reason: DayCloseReason): string {
  return reason.cause === 'missing'
    ? '消す明日へのひとことが見当たりませんでした。別の端末で締め直したか、既に消してあります。同期して確かめてください。'
    : `締める日は、今日から${DAY_CLOSE_BACK_DAYS}日前までの日を選んでください。`;
}

export type DayCloseRequest =
  | { action: 'close'; on: string; note: string | null; source: string; sourceEventId?: string; now?: Date }
  | { action: 'dismiss'; closeId: string; source: string; sourceEventId?: string };
export interface DayCloseResult { dayCloseId: string; action: typeof dayCloseActions[number]; deduped: boolean }
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('close'), on: scheduleDateSchema, note: z.string().max(DAY_NOTE_CHARS * 4).nullable(), source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), now: z.date().optional() }).strict(),
  z.object({ action: z.literal('dismiss'), closeId: dayCloseIdSchema, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional() }).strict(),
]);

/**
 * 1日を締める（ひとことは任意）か、表示中のひとことを消す。締めの日は今日から{@link DAY_CLOSE_BACK_DAYS}日前まで
 * （端末とのタイムゾーンの違いを見込み、翌日までは受け付ける）。同じ日を締め直すと、最後の記録がその日の締めになる。
 * HOMEは呼び出し側が作り直す（受付・CLIと同じく、cycleの最後に作り直す）。
 */
export async function setDayClose(config: HubConfig, request: DayCloseRequest): Promise<DayCloseResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  let note: string | null = null;
  if (r.action === 'close') {
    note = r.note === null ? null : normalizeDayNote(r.note);
    if (note !== null) dayNoteSchema.parse(note);
    const today = todayIn(config.timezone, r.now);
    if (r.on > addDays(today, 1) || r.on < addDays(today, -DAY_CLOSE_BACK_DAYS)) throw new DayCloseError({ code: 'day-close-refused', cause: 'out-of-range' });
  }
  return vault.withLock(async () => {
    const { records } = await readDayCloses(vault);
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        const same = previous.action === r.action && (previous.action === 'close' ? r.action === 'close' && previous.on === r.on && previous.note === note : r.action === 'dismiss' && previous.close_id === r.closeId);
        if (!same) throw new Error('同じ受付IDで別の締めが記録されています');
        return { dayCloseId: previous.id, action: previous.action, deduped: true };
      }
    }
    if (r.action === 'dismiss') {
      const target = records.find(x => x.id === r.closeId);
      if (!target || target.action !== 'close' || target.note === null) throw new DayCloseError({ code: 'day-close-refused', cause: 'missing' });
      // 既に消してあれば、望んだ状態になっているので何も記録しない（別の端末で先に消したなど）。
      const done = records.find(x => x.action === 'dismiss' && x.close_id === r.closeId);
      if (done) return { dayCloseId: done.id, action: 'dismiss', deduped: true };
    }
    const id = `DAY-${ulid()}`, origin = { source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString() };
    const record: DayCloseRecord = r.action === 'close' ? { schema_version: 1, id, action: 'close', on: r.on, note, ...origin } : { schema_version: 1, id, action: 'dismiss', close_id: r.closeId, ...origin };
    if (!await vault.create(dayClosePath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('締めの記録が競合しました');
    return { dayCloseId: record.id, action: record.action, deduped: false };
  });
}
