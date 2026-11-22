import { createHash } from 'node:crypto';
import { Vault } from './storage.js';
import { redactText, secretSettings } from './secrets.js';
import { UNASSIGNED_SCOPE } from './item-resolutions.js';
import type { HubConfig } from './types.js';

/**
 * 本人が付けた期日（と、設定で選んだときは次に見直す日）を、カレンダーに読み込めるiCalendar（RFC 5545）のファイルにする。
 * 進行中のプロジェクトの項目と、プロジェクト未定の本人が追加した行動（projectIdは_unassigned）が対象。
 * 予定は終日で、UIDは項目のキーから決めるため、読み込み直すと重複せずに置き換わる。日付はAIが推測したものを含まない。
 * カレンダーはクラウドへ同期されることが多いため、件名と説明には伏せ字の規則を当て、設定で件名をプロジェクト名だけにできる。
 */
export const CALENDAR_PATH = '90_system/calendar/contexthub.ics';
/** 件名に入れる項目の本文の文字数。 */
const TITLE_CHARS = 30;
/** 説明に入れる項目の本文の文字数。 */
const DESCRIPTION_CHARS = 500;
export type CalendarTitles = 'item' | 'project';
export interface CalendarSettings { enabled: boolean; reviewDates: boolean; titles: CalendarTitles }
export const defaultCalendar = (): CalendarSettings => ({ enabled: false, reviewDates: false, titles: 'item' });
export function calendarSettings(config: Pick<HubConfig, 'calendar'>): CalendarSettings { return { ...defaultCalendar(), ...config.calendar }; }

export interface CalendarItem {
  projectId: string; projectTitle: string; itemKey: string; section: 'next' | 'open'; text: string;
  due: string | null; reviewAfter: string | null; /** 日付を付けた記録の日時。予定の更新日時（DTSTAMP）にする。 */ scheduledAt: string;
}
interface CalendarEvent { uid: string; date: string; stamp: string; summary: string; description: string }

const sectionLabel = (section: CalendarItem['section']) => section === 'next' ? '次の一手' : '未解決';
function clip(text: string, limit: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : chars.join('');
}
/** TEXT値のエスケープ（バックスラッシュ・セミコロン・カンマ・改行）。 */
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}
/** 1行を75オクテット以内に折り返す。UTF-8の文字の途中では切らない。続きの行は空白1文字で始める。 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '', size = 0, limit = 75;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch);
    if (size + bytes > limit) { parts.push(current); current = ''; size = 0; limit = 74; }
    current += ch; size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
const basicDate = (date: string) => date.replaceAll('-', '');
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}
function stamp(iso: string): string {
  const t = Date.parse(iso);
  return (Number.isFinite(t) ? new Date(t) : new Date(0)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function calendarEvents(config: Pick<HubConfig, 'calendar' | 'privacy'>, items: CalendarItem[]): CalendarEvent[] {
  const settings = calendarSettings(config), secrets = secretSettings(config);
  const hide = (text: string) => secrets.enabled ? redactText(text, secrets).text : text;
  const events: CalendarEvent[] = [];
  for (const item of items) {
    const dates: ['due' | 'review', string][] = [];
    if (item.due) dates.push(['due', item.due]);
    if (settings.reviewDates && item.reviewAfter) dates.push(['review', item.reviewAfter]);
    for (const [kind, date] of dates) {
      const label = kind === 'due' ? '期日' : '見直す日';
      // 本文は伏せ字にしてから切る（切ってから伏せると、途中で切れた値が検出されずに残る）。
      const body = hide(item.text);
      const summary = settings.titles === 'item' ? `[${label}] ${item.projectTitle}: ${clip(body, TITLE_CHARS)}` : `[${label}] ${item.projectTitle}: ${sectionLabel(item.section)}`;
      const description = [
        `ContextHubの${sectionLabel(item.section)}に本人が付けた${label}です。`,
        ...(settings.titles === 'item' ? [clip(body, DESCRIPTION_CHARS)] : []),
        ...(kind === 'due' && item.reviewAfter ? [`見直す日: ${item.reviewAfter}`] : []),
        ...(kind === 'review' && item.due ? [`期日: ${item.due}`] : []),
        item.projectId === UNASSIGNED_SCOPE ? `プロジェクト: 未定` : `プロジェクト: ${item.projectId}`,
      ].join('\n');
      const uid = createHash('sha256').update(`${item.projectId}\n${item.itemKey}\n${kind}`).digest('hex').slice(0, 32);
      events.push({ uid: `${uid}-${kind}@context-hub`, date, stamp: stamp(item.scheduledAt), summary: hide(summary), description: hide(description) });
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.uid.localeCompare(b.uid));
}
export function buildCalendar(config: Pick<HubConfig, 'calendar' | 'privacy'>, items: CalendarItem[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ContextHub//Schedule//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:ContextHub'];
  for (const e of calendarEvents(config, items)) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${e.stamp}`, `DTSTART;VALUE=DATE:${basicDate(e.date)}`, `DTEND;VALUE=DATE:${basicDate(nextDay(e.date))}`,
      `SUMMARY:${escapeText(e.summary)}`, `DESCRIPTION:${escapeText(e.description)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
/**
 * Writerロック内で使う。有効なときは内容が変わったときだけ書き、無効にしたときは以前に書いたファイルを消す
 * （古い予定が同期先に残り続けないようにする）。
 */
export async function writeCalendarLocked(config: HubConfig, vault: Vault, items: CalendarItem[]): Promise<'written' | 'unchanged' | 'removed' | 'disabled'> {
  if (!calendarSettings(config).enabled) return await vault.remove(CALENDAR_PATH) ? 'removed' : 'disabled';
  const text = buildCalendar(config, items);
  if (await vault.read(CALENDAR_PATH) === text) return 'unchanged';
  await vault.write(CALENDAR_PATH, text);
  return 'written';
}
