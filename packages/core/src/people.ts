import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash, markdown, parseMarkdown } from './storage.js';
import { clipText, listText } from './markdown-text.js';
import { readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { readProjects, mergeTargets } from './projects.js';
import { lifecycleOf } from './project-status.js';
import { readNowItems } from './item-resolutions.js';
import { associatedProjects, dateLabel, generatedMarkdown, isGeneratedIntact } from './views.js';
import { redactText, secretSettings } from './secrets.js';
import type { HubConfig, Project } from './types.js';

/**
 * 人ごとの見返し。本人が登録した人（名前と呼び名）が本文に出てくる記録と、その人が出てくる未完了の次の一手・未解決を、
 * モデルを使わずに集めて 40_people/<id>/SUMMARY.md と一覧 40_people/PEOPLE.md に書く。
 * 人名をAIに推定させず、登録した名前・呼び名との一致だけをコードで数えるため、登録していない人は一覧に出ない。
 */
export const PEOPLE_DIR = '40_people';
export const personIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
export const PERSON_NAME_CHARS = 100;
export const PERSON_ALIASES_MAX = 20;
/** 名前・呼び名の最短の文字数（前後の空白を除き、全角・半角をそろえた後）。1文字の名前は別の語に紛れやすいため受け付けない。 */
export const PERSON_TERM_MIN = 2;
/** 1人の画面に載せる記録の上限。超えた分は件数だけ示す（検索で名前を探せる）。 */
export const PERSON_RECORDS_SHOWN = 100;
/** 1人の画面に載せる未完了の項目の上限。 */
export const PERSON_ITEMS_SHOWN = 50;

export const personDefinitionPath = (id: string) => `${PEOPLE_DIR}/${id}/person.md`;
/** 生成する一覧。定義（person.md）と大文字・小文字だけが違う名前にすると、大文字・小文字を区別しないMacのファイルシステムで同じファイルになるため、別の名前にする。 */
export const personPagePath = (id: string) => `${PEOPLE_DIR}/${id}/SUMMARY.md`;
export const peopleIndexPath = `${PEOPLE_DIR}/PEOPLE.md`;
const changeDir = '90_system/people';

const fold = (s: string) => s.normalize('NFKC').toLocaleLowerCase();
const termLength = (s: string) => Array.from(fold(s).trim()).length;
const termSchema = z.string().max(PERSON_NAME_CHARS).refine(v => termLength(v) >= PERSON_TERM_MIN, `名前・呼び名は${PERSON_TERM_MIN}文字以上にしてください`);
/** person.mdのfrontmatter。人が手で書くこともあるので、前後の空白は読むときに除く。 */
export const personSchema = z.object({ id: personIdSchema, name: termSchema, aliases: z.array(termSchema).max(PERSON_ALIASES_MAX) }).strict();
export type Person = z.infer<typeof personSchema>;
export interface PersonDefinition { name: string; aliases: string[] }
export interface PersonDefinitionIssue { path: string; message: string }

export const personLimitMessage = `名前・呼び名は${PERSON_TERM_MIN}〜${PERSON_NAME_CHARS}文字、呼び名は${PERSON_ALIASES_MAX}件までにしてください`;

/** 改行・タブを空白にして前後の空白を除き、名前と重なる呼び名と重複（全角・半角、大文字・小文字の違いを含む）を除く。 */
export function normalizePersonDefinition(value: PersonDefinition): PersonDefinition {
  const clean = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();
  const name = clean(value.name), seen = new Set([fold(name)]), aliases: string[] = [];
  for (const raw of value.aliases) { const alias = clean(raw); if (!alias || seen.has(fold(alias))) continue; seen.add(fold(alias)); aliases.push(alias); }
  const parsed = personSchema.omit({ id: true }).safeParse({ name, aliases });
  if (!parsed.success) throw new PersonDefinitionError({ code: 'person-invalid' }, personLimitMessage);
  return parsed.data;
}

/** 登録・変更・削除で受け付けられない理由。同じ依頼は何度受け付けても同じ結果になるため、受付は再試行しない。 */
export type PersonReason =
  | { code: 'person-exists' } | { code: 'person-missing' } | { code: 'person-changed' } | { code: 'person-invalid' } | { code: 'person-unchanged' }
  | { code: 'person-overlap'; person_id: string };
export class PersonDefinitionError extends Error {
  constructor(readonly reason: PersonReason, message = personReasonMessage(reason)) { super(message); this.name = 'PersonDefinitionError'; }
}
export function personReasonMessage(reason: PersonReason): string {
  switch (reason.code) {
    case 'person-exists': return '同じIDの人が既に登録されています。同期して一覧を確かめてください。';
    case 'person-missing': return '人が見つかりません。既に外されている可能性があります。同期して一覧を確かめてください。';
    case 'person-changed': return '確認した後に人の定義が変更されています。同期して最新の内容を確かめ、新しい依頼を送ってください。';
    case 'person-invalid': return personLimitMessage;
    case 'person-unchanged': return '名前・呼び名に変更がありません。';
    case 'person-overlap': return `名前か呼び名が、登録済みの人（${reason.person_id}）と重なります。別の呼び名にするか、登録済みの人の呼び名を見直してください。`;
  }
}

/** 名前と呼び名を、比べるための形（全角・半角、大文字・小文字をそろえ、前後の空白を除く）で、長い順に返す。 */
export function personTerms(person: PersonDefinition): string[] {
  return [...new Set([person.name, ...person.aliases].map(t => fold(t).trim()).filter(Boolean))].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

const asciiWord = /[a-z0-9]/;
/**
 * 本文の中で最初に名前・呼び名が出てくる位置（元の本文の文字の位置と長さ）。見つからなければundefined。
 * 和文は語の区切りがないため、含まれていれば一致とする。英数字で始まる・終わる呼び名は、前後が英数字でないときだけ一致とする（「Ken」が「Kenji」に一致しない）。
 */
const combining = /^[\p{M}\uFF9E\uFF9F]$/u;
export function findMention(text: string, terms: readonly string[]): { start: number; end: number } | undefined {
  // 全角・半角をそろえた本文と、元の本文の文字の位置を対応させる。
  // 濁点・半濁点（半角を含む）や結合文字は直前の文字とまとめてそろえる（「ｶﾞ」を「ガ」にするため）。
  const chars = Array.from(text), folded: string[] = [], origin: number[] = [];
  for (let i = 0; i < chars.length;) {
    let j = i + 1;
    while (j < chars.length && combining.test(chars[j]!)) j++;
    for (const f of Array.from(fold(chars.slice(i, j).join('')))) { folded.push(f); origin.push(i); }
    i = j;
  }
  const joined = folded.join(''), offsets: number[] = [];
  { let o = 0; for (const f of folded) { offsets.push(o); o += f.length; } offsets.push(o); }
  const indexAt = (utf16: number) => { let lo = 0, hi = folded.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid]! < utf16) lo = mid + 1; else hi = mid; } return lo; };
  let best: { start: number; end: number } | undefined;
  for (const term of terms) {
    if (!term) continue;
    const first = Array.from(term)[0]!, last = Array.from(term).at(-1)!;
    for (let at = joined.indexOf(term); at >= 0; at = joined.indexOf(term, at + 1)) {
      const s = indexAt(at), e = indexAt(at + term.length);
      const before = folded[s - 1], after = folded[e];
      if (asciiWord.test(first) && before !== undefined && asciiWord.test(before)) continue;
      if (asciiWord.test(last) && after !== undefined && asciiWord.test(after)) continue;
      const start = origin[s]!, end = Math.max(start + 1, e < origin.length ? origin[e]! : chars.length);
      if (!best || start < best.start) best = { start, end };
      break;
    }
  }
  return best;
}

/** 名前が出てくるあたりの抜粋（1行）。前30字・後60字ほどを残し、改行は空白にする。 */
export function mentionExcerpt(text: string, at: { start: number; end: number }): string {
  const chars = Array.from(text), from = Math.max(0, at.start - 30), to = Math.min(chars.length, at.end + 60);
  const body = chars.slice(from, to).join('').replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < chars.length ? '…' : ''}`;
}

function parsePerson(path: string, raw: string): { person?: Person; issue?: PersonDefinitionIssue } {
  let meta: Record<string, unknown>;
  try { meta = parseMarkdown(raw).meta; } catch { return { issue: { path, message: 'frontmatterを読めません' } }; }
  const trimmed = { ...meta, ...(typeof meta.name === 'string' ? { name: meta.name.trim() } : {}), ...(Array.isArray(meta.aliases) ? { aliases: meta.aliases.map(a => typeof a === 'string' ? a.trim() : a) } : {}) };
  const parsed = personSchema.safeParse(trimmed);
  if (!parsed.success) return { issue: { path, message: `項目が不正です（${[...new Set(parsed.error.issues.map(i => String(i.path[0] ?? 'frontmatter')))].join('・')}）。${personLimitMessage}` } };
  if (path !== personDefinitionPath(parsed.data.id)) return { issue: { path, message: 'IDとフォルダー名が一致しません' } };
  return { person: parsed.data };
}
/** 登録した人と、読めなかった定義。読めない定義は人ごとの見返しから外し、doctorとHOMEで示す。 */
export async function inspectPeople(vault: Vault): Promise<{ people: Person[]; issues: PersonDefinitionIssue[]; hashes: Map<string, string> }> {
  const people: Person[] = [], issues: PersonDefinitionIssue[] = [], hashes = new Map<string, string>();
  for (const path of await vault.files(PEOPLE_DIR)) {
    if (!/^40_people\/[^/]+\/person\.md$/.test(path)) continue;
    const raw = (await vault.read(path))!, { person, issue } = parsePerson(path, raw);
    if (person) { people.push(person); hashes.set(person.id, hash(raw)); } else issues.push(issue!);
  }
  people.sort((a, b) => a.id.localeCompare(b.id));
  // 同じ名前・呼び名を2人に付けると、どちらの記録か区別できない。手で書いた定義の重なりは両方を示す。
  const owner = new Map<string, string>();
  for (const person of people) for (const term of personTerms(person)) {
    const other = owner.get(term);
    if (other && other !== person.id) issues.push({ path: personDefinitionPath(person.id), message: `名前・呼び名「${term}」が ${other} と重なっています（両方の記録に載ります）` });
    else owner.set(term, person.id);
  }
  return { people, issues, hashes };
}
export async function readPeople(config: HubConfig): Promise<Person[]> {
  return (await inspectPeople(new Vault(config))).people;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const personChangeIdSchema = z.string().regex(/^PPL-[0-9A-HJKMNP-TV-Z]{26}$/);
export const personActions = ['add', 'edit', 'remove'] as const;
export type PersonAction = typeof personActions[number];
const storedDefinition = z.object({ name: z.string().max(PERSON_NAME_CHARS), aliases: z.array(z.string().max(PERSON_NAME_CHARS)).max(PERSON_ALIASES_MAX) }).strict();
export const personChangeSchema = z.object({
  schema_version: z.literal(1), id: personChangeIdSchema, person_id: personIdSchema, action: z.enum(personActions),
  before: storedDefinition.nullable(), after: storedDefinition.nullable(), before_hash: digest.nullable(), after_hash: digest.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), changed_at: z.string().datetime({ offset: true }),
}).strict();
export type PersonChange = z.infer<typeof personChangeSchema>;
export async function readPersonChanges(vault: Vault): Promise<PersonChange[]> {
  const result: PersonChange[] = [];
  for (const path of await vault.files(changeDir)) {
    if (!/^90_system\/people\/PPL-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    // 変更記録は同じ受付IDの重複を防ぐ根拠なので、1件でも読めなければ人の定義の変更を止める。直す場所が分かるようパスを示す。
    let change: PersonChange;
    try { change = personChangeSchema.parse(JSON.parse((await vault.read(path))!)); } catch { throw new Error(`人の定義の変更記録が不正です: ${path}`); }
    if (path !== `${changeDir}/${change.id}.json`) throw new Error(`人の定義の変更記録とパスが一致しません: ${path}`);
    result.push(change);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export interface PersonRequest {
  personId: string; action: PersonAction;
  /** add・editで指定する。 */ name?: string; aliases?: string[];
  /** edit・removeで、本人が確認したperson.mdのハッシュ。 */ expectedHash?: string;
  source: string; sourceEventId?: string;
}
export interface PersonResult { personId: string; action: PersonAction; changeId: string; deduped: boolean }
const requestSchema = z.object({
  personId: personIdSchema, action: z.enum(personActions), name: z.string().optional(), aliases: z.array(z.string()).optional(), expectedHash: digest.optional(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.action !== 'remove' && v.name === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '名前を指定してください' });
  // 呼び名を省いた変更で、呼び名がすべて消えないようにする（変更は名前と呼び名の全体で指定する）。
  if (v.action === 'edit' && v.aliases === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '変更では呼び名の全体を指定してください（ないときは空）' });
  if (v.action === 'remove' && (v.name !== undefined || v.aliases !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '外すときは名前・呼び名を指定しません' });
  if (v.action === 'add' ? v.expectedHash !== undefined : v.expectedHash === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: v.action === 'add' ? '登録では確認用のハッシュを指定しません' : '確認用のハッシュを指定してください' });
});
const personText = (name: string) => `# ${name}\n\n本人が登録した人の定義です。名前（name）と呼び名（aliases）が本文に出てくる記録を、同じフォルダーのSUMMARY.mdに集めます。\n`;
/** 本文の見出しが前の名前のままなら、新しい名前にする（ほかの本文は変えない）。 */
const retitle = (doc: { meta: Record<string, unknown>; text: string }, name: string) => {
  const old = typeof doc.meta.name === 'string' ? doc.meta.name.trim() : undefined, lines = doc.text.split('\n');
  const at = lines.findIndex(l => l.trim() !== '');
  if (old !== undefined && at >= 0 && lines[at]!.trim() === `# ${old}`) lines[at] = `# ${name}`;
  return lines.join('\n');
};
const sameDefinition = (a: PersonDefinition | null, b: PersonDefinition | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 人を登録・変更・外す。変更と削除は本人が確認したperson.mdのハッシュに結び付ける。
 * 記録を先に作り、定義の書き込み前に停止した場合は同じ受付IDの再送で回復する。外すと、手で変えていないSUMMARY.mdも消す（記録そのものは消さない）。
 */
export async function setPerson(config: HubConfig, request: PersonRequest): Promise<PersonResult> {
  const r = requestSchema.parse(request), vault = new Vault(config), path = personDefinitionPath(r.personId);
  const after = r.action === 'remove' ? null : normalizePersonDefinition({ name: r.name!, aliases: r.aliases ?? [] });
  return vault.withLock(async () => {
    const raw = await vault.read(path), current = raw === undefined ? null : hash(raw);
    const nextRaw = after ? markdown({ id: r.personId, name: after.name, aliases: after.aliases }, raw === undefined ? personText(after.name) : (() => { try { return retitle(parseMarkdown(raw), after.name); } catch { return personText(after.name); } })()) : null;
    if (r.sourceEventId) {
      const changes = await readPersonChanges(vault), previous = changes.find(c => c.source === r.source && c.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.person_id !== r.personId || previous.action !== r.action || !sameDefinition(previous.after, after) || (r.action !== 'add' && previous.before_hash !== r.expectedHash)) throw new Error('同じ受付IDで別の人の定義の変更が記録されています');
        const result = { personId: r.personId, action: r.action, changeId: previous.id, deduped: true };
        if (current === previous.after_hash) { if (r.action === 'remove') await removePageLocked(vault, r.personId); return result; }
        // この記録の後に同じ人の変更があれば、依頼は反映済み（後の変更を巻き戻さない）。
        if (changes.filter(c => c.person_id === r.personId).at(-1)?.id !== previous.id) return result;
        if (current !== previous.before_hash) throw new PersonDefinitionError({ code: 'person-changed' });
        if (r.action === 'remove') { await vault.remove(path); await removePageLocked(vault, r.personId); }
        else await vault.write(path, nextRaw!);
        return result;
      }
    }
    if (r.action === 'add' && raw !== undefined) throw new PersonDefinitionError({ code: 'person-exists' });
    if (r.action !== 'add' && raw === undefined) throw new PersonDefinitionError({ code: 'person-missing' });
    if (r.action !== 'add' && current !== r.expectedHash) throw new PersonDefinitionError({ code: 'person-changed' });
    let before: PersonDefinition | null = null;
    if (raw !== undefined) { const { person } = parsePerson(path, raw); before = person ? { name: person.name, aliases: person.aliases } : null; }
    if (after) {
      const others = (await inspectPeople(vault)).people.filter(p => p.id !== r.personId), mine = new Set(personTerms(after));
      const overlap = others.find(p => personTerms(p).some(t => mine.has(t)));
      if (overlap) throw new PersonDefinitionError({ code: 'person-overlap', person_id: overlap.id });
      if (r.action === 'edit' && before && sameDefinition(before, after)) throw new PersonDefinitionError({ code: 'person-unchanged' });
    }
    const change: PersonChange = {
      schema_version: 1, id: `PPL-${ulid()}`, person_id: r.personId, action: r.action,
      before: before === null ? null : storedDefinition.parse(before), after, before_hash: current, after_hash: nextRaw === null ? null : hash(nextRaw),
      source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), changed_at: new Date().toISOString(),
    };
    if (!await vault.create(`${changeDir}/${change.id}.json`, JSON.stringify(change, null, 2) + '\n')) throw new Error('人の定義の変更記録が競合しました');
    if (r.action === 'remove') { await vault.remove(path); await removePageLocked(vault, r.personId); }
    else if (r.action === 'add') { if (!await vault.create(path, nextRaw!)) throw new PersonDefinitionError({ code: 'person-exists' }); }
    else await vault.write(path, nextRaw!);
    return { personId: r.personId, action: r.action, changeId: change.id, deduped: false };
  });
}
/** 手で変えていないSUMMARY.mdを消す。手で変えたものは残す（doctorで示す）。 */
async function removePageLocked(vault: Vault, personId: string): Promise<void> {
  const page = await vault.read(personPagePath(personId));
  if (page !== undefined && isGeneratedIntact(page)) await vault.remove(personPagePath(personId));
}

export interface PersonRecord { inputId: string; path: string; occurredAt: string; kind: 'memo' | 'work-summary'; excerpt: string; projects: { id: string; inferred: boolean }[]; corrected: boolean }
/** waitingは、本人が連絡待ちの印を付けた項目の頼んだ日（印のない項目にはない）。 */
export interface PersonItem { projectId: string; projectTitle: string; paused: boolean; section: 'next' | 'open'; text: string; due: string | null; inputId: string; waiting?: string }
export interface PersonSummary { person: Person; records: PersonRecord[]; items: PersonItem[]; lastSeen: string | null }

/** 登録した人ごとに、名前が出てくる記録（訂正があれば最新の訂正の本文で判定）と未完了の項目を集める。 */
export async function collectPeople(config: HubConfig, vault: Vault, people: Person[], units?: EffectiveInput[]): Promise<PersonSummary[]> {
  if (!people.length) return [];
  const settings = secretSettings(config), projects = await readProjects(config), merged = mergeTargets(projects);
  const resolve = (id: string) => merged.get(id) ?? id;
  const records = new Map<string, PersonRecord[]>(people.map(p => [p.id, []])), terms = people.map(p => ({ id: p.id, terms: personTerms(p) }));
  for (const unit of units ?? await readEffectiveInputs(config)) {
    const { chain, receipt } = unit, root = chain.root;
    // 本人が追加した行動は記録ではなく予定なので、未完了の項目（NOWの次の一手）としてだけ数える。
    if (root.kind !== 'memo' && root.kind !== 'work-summary') continue;
    const text = redactText(chain.latest.text, settings).text;
    let hits: { id: string; at: { start: number; end: number } }[] | undefined;
    for (const p of terms) { const at = findMention(text, p.terms); if (at) (hits ??= []).push({ id: p.id, at }); }
    if (!hits) continue;
    const own = root.project ? resolve(root.project) : undefined;
    const ids = [...new Set((receipt ? associatedProjects(root, receipt, config) : root.project ? [root.project] : []).map(resolve))];
    const linked = ids.map(id => ({ id, inferred: id !== own })).sort((a, b) => Number(a.inferred) - Number(b.inferred) || a.id.localeCompare(b.id));
    for (const hit of hits) records.get(hit.id)!.push({ inputId: root.id, path: root.path, occurredAt: root.occurred_at, kind: root.kind as 'memo' | 'work-summary', excerpt: mentionExcerpt(text, hit.at), projects: linked, corrected: chain.revisions.length > 0 });
  }
  const items = new Map<string, PersonItem[]>(people.map(p => [p.id, []]));
  for (const project of projects) {
    if (merged.has(project.id) || lifecycleOf(project) === 'done') continue;
    let now; try { now = await readNowItems(vault, project.id); } catch { continue; /* 壊れた項目一覧はNOWとdoctorで示す。 */ }
    for (const item of now?.items ?? []) {
      if (item.resolution) continue;
      const text = redactText(item.text, settings).text;
      // 連絡待ちの相手として名前を付けた項目も、その人の未完了の項目に含める（本文に名前がなくても）。
      const who = item.waiting?.who;
      for (const p of terms) if (findMention(text, p.terms) || (who !== undefined && findMention(who, p.terms))) items.get(p.id)!.push({ projectId: project.id, projectTitle: project.title, paused: lifecycleOf(project) === 'paused', section: item.section, text, due: item.schedule?.due ?? null, inputId: item.input_id, ...(item.waiting ? { waiting: item.waiting.since } : {}) });
    }
  }
  return people.map(person => {
    const mine = records.get(person.id)!.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.inputId.localeCompare(a.inputId));
    const open = items.get(person.id)!.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.projectId.localeCompare(b.projectId) || (a.section === b.section ? 0 : a.section === 'next' ? -1 : 1));
    return { person, records: mine, items: open, lastSeen: mine[0]?.occurredAt ?? null };
  });
}

const plain = listText;
const clip = (s: string, n = 160) => clipText(s, n);
const kindLabel = { memo: 'メモ', 'work-summary': '作業要約' } as const;
const sectionLabel = { next: '次の一手', open: '未解決' } as const;

/** 1人の画面の本文。日時は設定のタイムゾーンで表示し、生成時点に依存する表現は使わない。 */
export function buildPersonText(config: HubConfig, summary: PersonSummary, projects: Project[]): string {
  const tz = config.timezone, { person, records, items } = summary, title = (id: string) => projects.find(p => p.id === id)?.title ?? id;
  const day = (iso: string) => dateLabel(iso, tz).slice(0, 10);
  const lines = [`# ${plain(person.name)}`, ''];
  if (person.aliases.length) lines.push(`呼び名: ${person.aliases.map(plain).join('、')}`, '');
  lines.push(`最後に出てきた日: ${summary.lastSeen ? day(summary.lastSeen) : 'まだありません'} / 記録 ${records.length}件 / 未完了の項目 ${items.length}件`, '');
  lines.push('本人が登録した名前・呼び名が本文に出てくる記録と、名前が出てくる（または連絡待ちの相手にした）進行中・休止中のプロジェクトの次の一手・未解決を、モデルを使わずに集めた一覧です。同じ名前の別人や、名前を含む別の語も拾うことがあります。抜粋は記録の本文（訂正があれば最新の訂正）で、秘密情報らしい文字列は伏せています。定義は[person.md](person.md)、一覧は[PEOPLE.md](../PEOPLE.md)です。', '');
  lines.push(`## 未完了の次の一手・未解決（${items.length}件）`);
  if (!items.length) lines.push('名前が出てくる未完了の項目はありません。');
  for (const item of items.slice(0, PERSON_ITEMS_SHOWN)) {
    const notes = [item.waiting ? `連絡待ち ${item.waiting}から` : '', item.due ? `期日 ${item.due}` : '', item.paused ? '休止中のプロジェクト' : ''].filter(Boolean);
    lines.push(`- [${plain(item.projectTitle)}](../../10_projects/${item.projectId}/NOW.md) ${sectionLabel[item.section]}: ${clip(item.text)}${notes.length ? `（${notes.join(' / ')}）` : ''}`);
  }
  if (items.length > PERSON_ITEMS_SHOWN) lines.push(`ほか${items.length - PERSON_ITEMS_SHOWN}件は載せていません。`);
  lines.push('');
  const counts = new Map<string, number>(); let loose = 0;
  for (const r of records) { if (!r.projects.length) loose++; for (const p of r.projects) counts.set(p.id, (counts.get(p.id) ?? 0) + 1); }
  lines.push('## 関わったプロジェクト');
  if (!records.length) lines.push('まだありません。');
  for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`- [${plain(title(id))}](../../10_projects/${id}/NOW.md)（${n}件）`);
  if (loose) lines.push(`- プロジェクト未定（${loose}件）`);
  lines.push('');
  lines.push(`## 最近の記録（${records.length}件）`);
  if (!records.length) lines.push('まだ名前が出てくる記録はありません。名前か呼び名を含むメモを追加すると、次の整理でここに載ります。');
  let current: string | undefined;
  for (const r of records.slice(0, PERSON_RECORDS_SHOWN)) {
    const key = day(r.occurredAt).slice(0, 7);
    if (key !== current) { const [y, m] = key.split('-'); lines.push('', `### ${y}年${Number(m)}月`); current = key; }
    const where = r.projects.map(p => `${plain(title(p.id))}${p.inferred ? '（AI推定）' : ''}`).join('・');
    lines.push(`- ${day(r.occurredAt).slice(5)} ${kindLabel[r.kind]}${where ? `（${where}）` : ''}${r.corrected ? ' / 訂正あり' : ''} — ${clip(r.excerpt, 200)} — [${r.inputId}](../../${r.path})`);
  }
  if (records.length > PERSON_RECORDS_SHOWN) lines.push('', `ほか${records.length - PERSON_RECORDS_SHOWN}件は載せていません（検索で名前を探せます）。`);
  lines.push('');
  return lines.join('\n');
}

/** 一覧（PEOPLE.md）の本文。最後に出てきた日の新しい順に並べる。 */
export function buildPeopleIndexText(config: HubConfig, summaries: PersonSummary[], issues: PersonDefinitionIssue[]): string {
  const day = (iso: string | null) => iso ? dateLabel(iso, config.timezone).slice(0, 10) : '—';
  const sorted = [...summaries].sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || a.person.id.localeCompare(b.person.id));
  const lines = ['# 人', '', `登録した人 ${summaries.length}人。名前・呼び名が本文に出てくる記録と未完了の項目を、人ごとに集めています。人の登録は \`ctx person add\` かアプリの「人」から行います。`, ''];
  if (sorted.length) {
    lines.push('| 人 | 最後に出てきた日 | 記録 | 未完了の項目 |', '|---|---|---|---|');
    for (const s of sorted) lines.push(`| [${plain(s.person.name)}](${s.person.id}/SUMMARY.md) | ${day(s.lastSeen)} | ${s.records.length} | ${s.items.length} |`);
    lines.push('');
  }
  if (issues.length) { lines.push('## 読めない定義', ...issues.map(i => `- ${plain(i.path)}: ${plain(i.message)}`), ''); }
  return lines.join('\n');
}

export interface PeopleWrite { path: string; written: boolean; stopped?: boolean; removed?: boolean }
const summaryMeta = (s: PersonSummary) => ({ records: s.records.length, open_items: s.items.length, last_seen: s.lastSeen });

/**
 * 人ごとの画面と一覧を作り直す。本文が前回と同じなら書き込まない。手で書き換えた画面は上書きせず更新を止める（消すと次のcycleで作り直す）。
 * 人を1人も登録していなければ何も作らない。定義を外した人の画面は、手で変えていなければ消す。
 */
export async function rebuildPeopleLocked(config: HubConfig, vault: Vault, units?: EffectiveInput[]): Promise<PeopleWrite[]> {
  const { people, issues } = await inspectPeople(vault), result: PeopleWrite[] = [];
  const known = new Set(people.map(p => p.id));
  for (const path of await vault.files(PEOPLE_DIR)) {
    const m = /^40_people\/([^/]+)\/SUMMARY\.md$/.exec(path);
    if (!m || known.has(m[1]!)) continue;
    // 読めない定義の人の画面は残す（定義を直せば作り直す）。
    if (await vault.read(personDefinitionPath(m[1]!)) !== undefined) continue;
    const raw = await vault.read(path);
    if (raw !== undefined && isGeneratedIntact(raw)) { await vault.remove(path); result.push({ path, written: false, removed: true }); }
  }
  const indexRaw = await vault.read(peopleIndexPath);
  if (!people.length && !issues.length) {
    if (indexRaw !== undefined && isGeneratedIntact(indexRaw)) { await vault.remove(peopleIndexPath); result.push({ path: peopleIndexPath, written: false, removed: true }); }
    return result;
  }
  const summaries = await collectPeople(config, vault, people, units), projects = await readProjects(config);
  const write = async (path: string, text: string, meta: Record<string, unknown>) => {
    const existing = await vault.read(path);
    if (existing !== undefined && !isGeneratedIntact(existing)) { result.push({ path, written: false, stopped: true }); return; }
    const sourceHash = `sha256:${hash(text)}`;
    let same = false;
    if (existing !== undefined) try { same = parseMarkdown(existing).meta.source_hash === sourceHash; } catch { same = false; }
    if (same) { result.push({ path, written: false }); return; }
    await vault.write(path, generatedMarkdown({ schema_version: 1, ...meta, generated_by: { model: 'deterministic-writer', prompt_version: 1 }, generated_at: new Date().toISOString(), source_hash: sourceHash, verified: false }, text));
    result.push({ path, written: true });
  };
  for (const summary of summaries) {
    const text = buildPersonText(config, summary, projects);
    // 一覧の件数と最後に出てきた日も本文から決まるので、source_hashに含めて変わったときだけ書き直す。
    await write(personPagePath(summary.person.id), text, { person: summary.person.id, ...summaryMeta(summary) });
  }
  await write(peopleIndexPath, buildPeopleIndexText(config, summaries, issues), { people: summaries.length });
  return result;
}
export async function rebuildPeople(config: HubConfig): Promise<PeopleWrite[]> {
  const vault = new Vault(config);
  // すべての入力の読み取りはWriterロックの外で行い、ロックを持つ時間を短くする（受付を待たせない）。
  // 読んだ後に届いた入力は次の作り直し（cycle）で反映される。人を登録していなければ入力を読まない。
  const { people, issues } = await inspectPeople(vault);
  // 人がいなければ読まず、ロック内で人が増えていたときはロック内で読む。
  const units = people.length || issues.length ? await readEffectiveInputs(config) : undefined;
  return vault.withLock(() => rebuildPeopleLocked(config, vault, units));
}
/** 手で書き換えて更新を止めている人の画面・一覧。doctorとHOMEで示す。 */
export async function stoppedPeoplePages(vault: Vault): Promise<string[]> {
  const result: string[] = [];
  for (const path of await vault.files(PEOPLE_DIR)) {
    if (!/^40_people\/(?:[^/]+\/SUMMARY|PEOPLE)\.md$/.test(path)) continue;
    const raw = await vault.read(path);
    if (raw !== undefined && !isGeneratedIntact(raw)) result.push(path);
  }
  return result.sort();
}
/** CLI向け: 書き込まずに1人の画面の本文だけを組み立てる。 */
export async function buildPerson(config: HubConfig, personId: string): Promise<string> {
  const vault = new Vault(config), { people } = await inspectPeople(vault), person = people.find(p => p.id === personId);
  if (!person) throw new PersonDefinitionError({ code: 'person-missing' });
  const [summary] = await collectPeople(config, vault, [person]);
  return buildPersonText(config, summary!, await readProjects(config));
}
