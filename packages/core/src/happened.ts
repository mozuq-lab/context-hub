import { z } from 'zod';

/**
 * 出来事の日付（happened_on）。昨日の会議を今日書くように、本人が後から記録したメモの「いつのことか」。
 * 指定があると、原文の発生日時（occurred_at）をその日の正午（設定のタイムゾーン）にし、実際に書いた日時をrecorded_atに残す。
 * 経緯・最終根拠・NOWの最新の作業要約・検索の期間は発生日時で並ぶため、出来事の日付の順になる。
 */
const DAY = 86_400_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 既定では、記録した日から365日前までの出来事を受け付ける。 */
export const DEFAULT_MAX_BACKDATE_DAYS = 365;
/** 2000〜2099年の実在する暦日（YYYY-MM-DD）。 */
export const calendarDateSchema = z.string().refine(value => {
  const m = datePattern.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (year < 2000 || year > 2099) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}, '日付はYYYY-MM-DDの実在する日で指定してください（2000〜2099年）');

/** 設定のタイムゾーンでの暦日（YYYY-MM-DD）。 */
export function localDate(iso: string | Date, timezone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(typeof iso === 'string' ? new Date(iso) : iso);
}
function shiftDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + days * DAY).toISOString().slice(0, 10);
}
/** その暦日の正午（設定のタイムゾーン）をUTCのISO文字列で返す。正午にするのは、どのタイムゾーンでも同じ暦日に収めるため。 */
export function localNoon(date: string, timezone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, 12);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(guess - (asLocal - guess)).toISOString();
}

export type HappenedOnProblem = 'future' | 'too-old';
/** 出来事の日付が、記録した日（設定のタイムゾーン）より後か、上限より古ければ理由を返す。 */
export function happenedOnProblem(happenedOn: string, recordedAt: string, timezone: string, maxDays: number): HappenedOnProblem | undefined {
  const recorded = localDate(recordedAt, timezone);
  if (happenedOn > recorded) return 'future';
  if (happenedOn < shiftDays(recorded, -maxDays)) return 'too-old';
  return undefined;
}
export class HappenedOnError extends Error {
  constructor(readonly reason: { code: 'happened-on-invalid'; cause: HappenedOnProblem; max_days: number }) {
    super(happenedOnMessage(reason));
  }
}
export function happenedOnMessage(reason: { cause: HappenedOnProblem; max_days: number }): string {
  return reason.cause === 'future'
    ? '出来事の日付が記録した日より後です。今日までの日付を選んで、新しい依頼を送ってください。'
    : `出来事の日付が古すぎます（記録した日から${reason.max_days}日前まで）。日付を見直して、新しい依頼を送ってください。`;
}
/** 記録した日と同じ出来事の日付は、指定がないのと同じに扱う（原文に余計な欄を作らない）。 */
export function effectiveHappenedOn(happenedOn: string | undefined, recordedAt: string, timezone: string): string | undefined {
  return happenedOn !== undefined && happenedOn !== localDate(recordedAt, timezone) ? happenedOn : undefined;
}

/**
 * 「この入力より後の根拠か」を比べるときの、入力の側の時刻。出来事の日付の発生日時はその日の正午に置いた値なので、
 * 同じ日の夕方の根拠を「後」と誤らないよう、その日の終わり（正午の12時間後の直前）として比べる。
 */
export function evidenceBound(input: Timed): number {
  const at = Date.parse(input.occurred_at);
  return input.happened_on !== undefined ? at + 12 * 3_600_000 - 1 : at;
}
interface Timed { occurred_at: string; happened_on?: string; recorded_at?: string }
/**
 * 一覧に出す日時。出来事の日付があれば「YYYY-MM-DDのこと（記録 YYYY-MM-DD HH:MM）」、なければ発生日時。
 * 出来事の日付の発生日時は正午に置いた値なので、時刻としては示さない。
 */
export function inputWhen(input: Timed, format: (iso: string) => string): string {
  return input.happened_on !== undefined && input.recorded_at !== undefined ? `${input.happened_on}のこと（記録 ${format(input.recorded_at)}）` : format(input.occurred_at);
}
