import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash, parseMarkdown } from './storage.js';
import type { HubConfig } from './types.js';

/**
 * 似ているアイデアを決まった計算で見つけ、本人が「同じ話」と確かめた組だけを束ねる。
 * AIは使わない。生成されたIDEAファイルと原文は書き換えず、判断は90_system/idea-links/に記録する。
 * 候補と束ねの一覧は90_system/idea-index.jsonに派生物として書き、アプリとHOMEが読む。
 */
export const ideaIdSchema = z.string().regex(/^IDEA-[0-9A-HJKMNP-TV-Z]{26}$/);
export const ideaLinkIdSchema = z.string().regex(/^ILNK-[0-9A-HJKMNP-TV-Z]{26}$/);
export const ideaLinkActions = ['link', 'separate'] as const;
export type IdeaLinkAction = typeof ideaLinkActions[number];
export const ideaLinkActionSchema = z.enum(ideaLinkActions);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pairSchema = z.tuple([ideaIdSchema, ideaIdSchema]).refine(([a, b]) => a < b, 'アイデアIDは異なる2件を昇順で指定します');
export const ideaLinkSchema = z.object({
  schema_version: z.literal(1), id: ideaLinkIdSchema, ideas: pairSchema, action: ideaLinkActionSchema,
  /** 束ねるときに本人が確認したIDEAファイルのハッシュ（ideasと同じ順）。 */
  idea_hashes: z.tuple([digest, digest]).optional(),
  /** 本人が判断した日時（アプリの依頼の発生日時、CLIは実行日時）。同じ組の判断はこの順で最後のものを有効にする。 */
  decided_at: z.string().datetime({ offset: true }),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type IdeaLink = z.infer<typeof ideaLinkSchema>;

const linkDir = '90_system/idea-links';
export const ideaIndexPath = '90_system/idea-index.json';
/** この値以上を似ているとみなす（文字bi-gramのDice係数）。 */
export const IDEA_SIMILARITY_THRESHOLD = 0.4;
/** 索引とHOMEに載せる未確認の候補の上限。似ている度合いの高い順。 */
const MAX_CANDIDATES = 50;
const HOME_CANDIDATES = 10;
/** 比べるのに短すぎる要約（bi-gramの数）。 */
const MIN_GRAMS = 4;

export interface IdeaDoc { id: string; path: string; summary: string; occurredAt: string; hash: string }
const evidenceLine = /^(?:入力|出典|発生日時|受信日時|性質|帰属候補): /;
/** 生成されたアイデアの本文から、見出しと出典の行を除いた要約を取り出す。 */
export function ideaSummary(text: string): string {
  return text.split(/\r?\n/).filter(line => !/^#\s/.test(line) && !evidenceLine.test(line)).join('\n').trim();
}
/** 分類を取り消していない、整理済みのアイデア。 */
export async function readIdeas(vault: Vault): Promise<IdeaDoc[]> {
  const ideas: IdeaDoc[] = [];
  for (const path of await vault.files('20_ideas')) {
    if (!/^20_ideas\/IDEA-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(path)) continue;
    const raw = (await vault.read(path))!;
    let parsed;
    try { parsed = parseMarkdown(raw); } catch { continue; }
    const { meta, text } = parsed;
    if (meta.category !== 'idea' || meta.retracted === true || `20_ideas/${meta.id}.md` !== path) continue;
    ideas.push({ id: String(meta.id), path, summary: ideaSummary(text), occurredAt: String(meta.occurred_at ?? ''), hash: hash(raw) });
  }
  return ideas.sort((a, b) => a.id.localeCompare(b.id));
}

/** NFKCで正規化し、URL・記号・空白を除いた文字bi-gramの集合。 */
export function ideaGrams(text: string): Set<string> {
  const chars = Array.from(text.normalize('NFKC').toLocaleLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ''));
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) grams.add(chars[i]! + chars[i + 1]!);
  return grams;
}
export function ideaSimilarity(a: string, b: string): number {
  const x = ideaGrams(a), y = ideaGrams(b);
  if (x.size < MIN_GRAMS || y.size < MIN_GRAMS) return 0;
  let shared = 0; for (const g of x) if (y.has(g)) shared++;
  return 2 * shared / (x.size + y.size);
}
const round = (n: number) => Math.round(n * 1000) / 1000;
/**
 * Dice係数がしきい値以上の組を、漏れなく、総当たりより少ない比較で見つける（prefix filter）。
 * 各集合のbi-gramを全体で珍しい順に並べ、先頭の一部（prefix）だけを索引に入れる。
 * Dice≥tなら共有数は|x|·t/(2−t)以上になるため、似ている組は必ずprefixのどこかを共有する。
 * 日本語の要約にほぼ必ず現れる「して」「たい」のような語は後ろに回り、比べる組が膨らまない。
 */
export function similarPairs(ideas: IdeaDoc[], threshold = IDEA_SIMILARITY_THRESHOLD): { ideas: [string, string]; score: number }[] {
  const grams = ideas.map(i => ideaGrams(i.summary)), df = new Map<string, number>();
  for (const set of grams) if (set.size >= MIN_GRAMS) for (const g of set) df.set(g, (df.get(g) ?? 0) + 1);
  const index = new Map<string, number[]>(), seen = new Set<number>(), pairs: { ideas: [string, string]; score: number }[] = [];
  grams.forEach((set, i) => {
    if (set.size < MIN_GRAMS) return;
    const sorted = [...set].sort((a, b) => df.get(a)! - df.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    const prefix = Math.max(1, set.size - Math.ceil(threshold * set.size / (2 - threshold)) + 1);
    for (const g of sorted.slice(0, prefix)) {
      const list = index.get(g);
      if (list) for (const j of list) {
        const key = j * ideas.length + i;
        if (seen.has(key)) continue;
        seen.add(key);
        let shared = 0; for (const x of set) if (grams[j]!.has(x)) shared++;
        const score = 2 * shared / (set.size + grams[j]!.size);
        if (score >= threshold) pairs.push({ ideas: [ideas[i]!.id, ideas[j]!.id].sort() as [string, string], score: round(score) });
      }
      if (list) list.push(i); else index.set(g, [i]);
    }
  });
  return pairs.sort((a, b) => b.score - a.score || a.ideas[0].localeCompare(b.ideas[0]) || a.ideas[1].localeCompare(b.ideas[1]));
}

export async function readIdeaLinks(vault: Vault): Promise<IdeaLink[]> {
  const result: IdeaLink[] = [];
  for (const path of await vault.files(linkDir)) {
    if (!/^90_system\/idea-links\/ILNK-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    let record: IdeaLink;
    try { record = ideaLinkSchema.parse(JSON.parse((await vault.read(path))!)); } catch { throw new Error(`アイデアの束ねの記録が不正です: ${path}`); }
    if (path !== `${linkDir}/${record.id}.json`) throw new Error(`アイデアの束ねの記録とパスが一致しません: ${path}`);
    result.push(record);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
const pairKey = (pair: readonly [string, string]) => `${pair[0]}\n${pair[1]}`;
/** 組ごとに最後の判断だけを有効にする。 */
export function latestDecisions(records: IdeaLink[]): Map<string, IdeaLink> {
  // 同期でまとめて届いた依頼は受付の順が判断の順と限らないため、判断した日時の順に並べる。
  const ordered = [...records].sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at) || a.id.localeCompare(b.id));
  const latest = new Map<string, IdeaLink>();
  for (const r of ordered) latest.set(pairKey(r.ideas), r);
  return latest;
}

/** linksは束をつないでいる、本人が束ねた組（直接の判断）。束から外すにはこの組を別の話にする。 */
export interface IdeaGroup { representative: string; ideas: string[]; links: [string, string][] }
export interface IdeaCandidate { ideas: [string, string]; score: number; hashes: [string, string] }
export interface IdeaIndex {
  schema_version: 1; generated_at: string; threshold: number;
  /** 未確認の候補。同じ組を束ねたか別の話と判断したもの、既に同じ束にあるものは含めない。 */
  candidates: IdeaCandidate[];
  /** 束ねたアイデア。代表は元のメモの発生日時が最も新しいもの。 */
  groups: IdeaGroup[];
  /** 見つかった候補の総数（索引にはMAX_CANDIDATES件まで載せる）。 */
  total_candidates: number;
  /** 索引の元にしたアイデアと判断のハッシュ。変わっていなければ計算し直さない。 */
  basis: string;
  summaries: Record<string, string>;
}
export const ideaIndexSchema = z.object({
  schema_version: z.literal(1), generated_at: z.string().datetime({ offset: true }), threshold: z.number().min(0).max(1),
  candidates: z.array(z.object({ ideas: pairSchema, score: z.number().min(0).max(1), hashes: z.tuple([digest, digest]) }).strict()),
  groups: z.array(z.object({ representative: ideaIdSchema, ideas: z.array(ideaIdSchema).min(2), links: z.array(pairSchema).min(1) }).strict()),
  total_candidates: z.number().int().min(0),
  basis: digest,
  summaries: z.record(ideaIdSchema, z.string()),
}).strict();

/** 束ねの判断から、今あるアイデアの束を組み立てる。 */
export function ideaGroups(ideas: IdeaDoc[], decisions: Map<string, IdeaLink>): IdeaGroup[] {
  const alive = new Map(ideas.map(i => [i.id, i])), parent = new Map<string, string>(), linked: [string, string][] = [];
  const root = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  for (const d of decisions.values()) {
    if (d.action !== 'link' || !alive.has(d.ideas[0]) || !alive.has(d.ideas[1])) continue;
    linked.push([d.ideas[0], d.ideas[1]]);
    for (const id of d.ideas) if (!parent.has(id)) parent.set(id, id);
    const [a, b] = [root(d.ideas[0]), root(d.ideas[1])];
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const members = new Map<string, string[]>();
  for (const id of parent.keys()) { const r = root(id); const list = members.get(r); if (list) list.push(id); else members.set(r, [id]); }
  const newest = (a: IdeaDoc, b: IdeaDoc) => (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0) || b.id.localeCompare(a.id);
  return [...members.values()].filter(m => m.length > 1).map(m => {
    const docs = m.map(id => alive.get(id)!).sort(newest);
    const set = new Set(m);
    return { representative: docs[0]!.id, ideas: docs.map(d => d.id), links: linked.filter(([a]) => set.has(a)).sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1])) };
  }).sort((a, b) => newest(alive.get(a.representative)!, alive.get(b.representative)!));
}

const basisOf = (ideas: IdeaDoc[], links: IdeaLink[]) => hash(`${IDEA_SIMILARITY_THRESHOLD}\n${ideas.map(i => `${i.id}:${i.hash}`).join('\n')}\n${links.map(l => l.id).join('\n')}`);
export async function buildIdeaIndex(vault: Vault, now = new Date(), previous?: IdeaIndex): Promise<IdeaIndex> {
  const ideas = await readIdeas(vault), links = await readIdeaLinks(vault), basis = basisOf(ideas, links);
  // アイデアも判断も変わっていなければ、計算をせずに前回の索引を使う。
  if (previous?.basis === basis) return previous;
  const decisions = latestDecisions(links), groups = ideaGroups(ideas, decisions);
  const groupOf = new Map<string, number>(); groups.forEach((g, i) => g.ideas.forEach(id => groupOf.set(id, i)));
  const byId = new Map(ideas.map(i => [i.id, i]));
  const open = similarPairs(ideas).filter(p => !decisions.has(pairKey(p.ideas)) && (groupOf.get(p.ideas[0]) === undefined || groupOf.get(p.ideas[0]) !== groupOf.get(p.ideas[1])));
  const candidates = open.slice(0, MAX_CANDIDATES).map(p => ({ ...p, hashes: [byId.get(p.ideas[0])!.hash, byId.get(p.ideas[1])!.hash] as [string, string] }));
  const shown = new Set([...candidates.flatMap(c => c.ideas), ...groups.flatMap(g => g.ideas)]);
  const summaries = Object.fromEntries(ideas.filter(i => shown.has(i.id)).map(i => [i.id, i.summary]));
  return { schema_version: 1, generated_at: now.toISOString(), threshold: IDEA_SIMILARITY_THRESHOLD, candidates, groups, total_candidates: open.length, basis, summaries };
}
/** 内容が変わったときだけ書き、同期の無駄な変更を避ける。Writerロック内で呼ぶ。 */
export async function rebuildIdeaIndexLocked(_config: HubConfig, vault: Vault, now = new Date()): Promise<IdeaIndex> {
  const raw = await vault.read(ideaIndexPath);
  let old: IdeaIndex | undefined;
  if (raw !== undefined) try { old = ideaIndexSchema.parse(JSON.parse(raw)); } catch { /* 壊れた索引は作り直す。 */ }
  const index = await buildIdeaIndex(vault, now, old);
  if (old && (index === old || JSON.stringify({ ...old, generated_at: '' }) === JSON.stringify({ ...index, generated_at: '' }))) return old;
  await vault.write(ideaIndexPath, JSON.stringify(index, null, 2) + '\n');
  return index;
}

const plain = (s: string) => s.replace(/[\r\n|]/g, ' ').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('<!--', '&lt;!--');
const clip = (s: string, n = 60) => { const a = Array.from(plain(s)); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
const ideaLink = (index: IdeaIndex, id: string) => `[${clip(index.summaries[id] || id, 40)}](20_ideas/${id}.md)`;
/** HOMEの「似ているアイデア」「束ねたアイデア」。どちらもなければ空。 */
export function ideaSection(index: IdeaIndex): string {
  const parts: string[] = [];
  if (index.candidates.length) parts.push(`## 似ているアイデア（未確認${index.total_candidates}件）\n同じ話かもしれないアイデアの組です。アプリで「同じ話として束ねる」か「別の話」を選ぶか、\`ctx idea similar\`でハッシュを確認して\`ctx idea link\`／\`ctx idea separate\`を使ってください。\n${index.candidates.slice(0, HOME_CANDIDATES).map(c => `- ${ideaLink(index, c.ideas[0])} と ${ideaLink(index, c.ideas[1])}（似ている度合い ${c.score.toFixed(2)}）`).join('\n')}${index.total_candidates > HOME_CANDIDATES ? `\n- ほか${index.total_candidates - HOME_CANDIDATES}件` : ''}`);
  if (index.groups.length) parts.push(`## 束ねたアイデア（${index.groups.length}組）\n先頭が代表（元のメモが最も新しいもの）です。検索では1件にまとめて表示します。束から外すには、アプリで「束から外す」を選ぶか、\`ctx idea groups\`で直接束ねた組を確認して\`ctx idea separate\`を使ってください。\n${index.groups.map(g => `- ${ideaLink(index, g.representative)} ← ${g.ideas.filter(id => id !== g.representative).map(id => ideaLink(index, id)).join('、')}`).join('\n')}`);
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

export class IdeaLinkError extends Error {
  constructor(readonly reason: { code: 'idea-missing' } | { code: 'idea-changed' }) {
    super(reason.code === 'idea-missing' ? 'アイデアが見つからないか、分類が取り消されています' : '確認した後にアイデアが変更されています。最新の内容で確認し直してください');
    this.name = 'IdeaLinkError';
  }
}
export interface IdeaLinkRequest { ideas: [string, string]; action: IdeaLinkAction; hashes?: [string, string]; source: string; sourceEventId?: string; /** 判断した日時。省略時は今。 */ decidedAt?: string }
export interface IdeaLinkResult { linkId: string; action: IdeaLinkAction; deduped: boolean }
const requestSchema = z.object({ ideas: z.tuple([ideaIdSchema, ideaIdSchema]), action: ideaLinkActionSchema, hashes: z.tuple([digest, digest]).optional(), source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(), decidedAt: z.string().refine(v => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))).optional() }).strict()
  .refine(r => r.ideas[0] !== r.ideas[1], '異なる2件のアイデアを指定してください')
  .refine(r => r.action !== 'link' || r.hashes !== undefined, '束ねるには両方のアイデアのハッシュが必要です');

/**
 * 2件のアイデアを束ねる（link）か、別の話として候補から外す（separate）。束ねた組にseparateを記録すると束から外れる。
 * 束ねるときは本人が確認した内容のハッシュと一致することを確かめる。記録の後に索引を作り直す。
 */
export async function setIdeaLink(config: HubConfig, request: IdeaLinkRequest): Promise<IdeaLinkResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  const order = r.ideas[0] < r.ideas[1] ? [0, 1] : [1, 0];
  const ideas = [r.ideas[order[0]!]!, r.ideas[order[1]!]!] as [string, string];
  const hashes = r.hashes ? [r.hashes[order[0]!]!, r.hashes[order[1]!]!] as [string, string] : undefined;
  return vault.withLock(async () => {
    const records = await readIdeaLinks(vault);
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (pairKey(previous.ideas) !== pairKey(ideas) || previous.action !== r.action) throw new Error('同じ受付IDで別の判断が記録されています');
        await rebuildIdeaIndexLocked(config, vault);
        return { linkId: previous.id, action: previous.action, deduped: true };
      }
    }
    const current = new Map((await readIdeas(vault)).map(i => [i.id, i]));
    const docs = ideas.map(id => current.get(id));
    // 別の話の判断は、片方が取り消された後でも記録できる。束ねるのは今あるアイデアどうしだけ。
    if (r.action === 'link' && docs.some(d => !d)) throw new IdeaLinkError({ code: 'idea-missing' });
    if (r.action === 'separate' && docs.every(d => !d)) throw new IdeaLinkError({ code: 'idea-missing' });
    if (r.action === 'link' && (docs[0]!.hash !== hashes![0] || docs[1]!.hash !== hashes![1])) throw new IdeaLinkError({ code: 'idea-changed' });
    const record: IdeaLink = {
      schema_version: 1, id: `ILNK-${ulid()}`, ideas, action: r.action, ...(r.action === 'link' ? { idea_hashes: hashes! } : {}),
      decided_at: new Date(r.decidedAt ?? Date.now()).toISOString(),
      source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(`${linkDir}/${record.id}.json`, JSON.stringify(record, null, 2) + '\n')) throw new Error('アイデアの束ねの記録が競合しました');
    await rebuildIdeaIndexLocked(config, vault);
    return { linkId: record.id, action: record.action, deduped: false };
  });
}

/** 検索で使う、アイデアIDから束の一覧への対応。記録が不正なら束ねずに扱う。 */
export async function readIdeaGroupMap(vault: Vault): Promise<Map<string, IdeaGroup>> {
  let groups: IdeaGroup[];
  try { groups = ideaGroups(await readIdeas(vault), latestDecisions(await readIdeaLinks(vault))); } catch { return new Map(); }
  const map = new Map<string, IdeaGroup>();
  for (const g of groups) for (const id of g.ideas) map.set(id, g);
  return map;
}
