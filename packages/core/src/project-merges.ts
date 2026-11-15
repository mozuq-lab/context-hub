import { z } from 'zod';
import { ulid } from 'ulid';
import { stringify } from 'yaml';
import { Vault, hash, parseMarkdown } from './storage.js';
import { readInputs } from './capture.js';
import { projectIdSchema, projectSchema, readProjects } from './projects.js';
import { PROJECT_TERMS_MAX, PROJECT_TERM_CHARS, withDefinition } from './project-definition.js';
import { rebuildPoliciesLocked } from './policies.js';
import { readReceipts, rebuildNowLocked } from './views.js';
import type { HubConfig, Project } from './types.js';

/**
 * 同じものを指す2つのプロジェクトを、本人の確認で1つにまとめる（統合）。
 * 統合元のファイル・原文・処理記録は動かさず、統合元の定義に統合先（merged_into）を書くだけにする。
 * 統合元に帰属した入力・完了報告・日付は、読むときに統合先のものとして読み替える。取り消せば元に戻る。
 * 統合元の名前・別名・キーワードは統合先の別名・キーワードへ足し、AIの帰属推定と検索が統合先へ向くようにする。
 * 統合元のプロジェクト限定の方針（POLICY.md）は移さない。必要なものは統合先で採用し直す。
 */
export const projectMergeActions = ['merge', 'unmerge'] as const;
export type ProjectMergeAction = typeof projectMergeActions[number];
export const projectMergeIdSchema = z.string().regex(/^PMG-[0-9A-HJKMNP-TV-Z]{26}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const termsSchema = z.array(z.string().min(1).max(PROJECT_TERM_CHARS)).max(PROJECT_TERMS_MAX);
export const projectMergeSchema = z.object({
  schema_version: z.literal(1), id: projectMergeIdSchema, action: z.enum(projectMergeActions), from_id: projectIdSchema, into_id: projectIdSchema,
  /** 統合では統合前の統合元の状態（取り消しで戻す値）、取り消しでは戻した状態。 */
  from_status: z.string().max(100),
  /** 統合では統合先へ足した語、取り消しでは統合先から外した語。 */
  aliases: termsSchema, keywords: termsSchema,
  from_before_hash: digest, from_after_hash: digest, into_before_hash: digest, into_after_hash: digest,
  /** 取り消した統合の記録。記録のない統合（手で書いたmerged_into）の取り消しでは省く。 */
  merge_id: projectMergeIdSchema.optional(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), changed_at: z.string().datetime({ offset: true }),
}).strict();
export type ProjectMerge = z.infer<typeof projectMergeSchema>;
export interface ProjectMergeRequest { fromId: string; intoId: string; fromHash: string; intoHash: string; source: string; sourceEventId?: string }
export interface ProjectMergeResult { fromId: string; intoId: string; action: ProjectMergeAction; mergeId: string; aliases: string[]; keywords: string[]; deduped: boolean }
const requestSchema = z.object({ fromId: projectIdSchema, intoId: projectIdSchema, fromHash: digest, intoHash: digest, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional() }).strict();
const mergeDir = '90_system/project-merges';

export type ProjectMergeReason =
  | { code: 'project-merge-changed' }
  | { code: 'project-merge-refused'; cause: 'missing' | 'same' | 'already-merged' | 'target-merged' | 'has-sources' | 'not-merged' | 'target-mismatch'; project_id?: string };
const reasonMessages: Record<Extract<ProjectMergeReason, { code: 'project-merge-refused' }>['cause'], string> = {
  missing: 'プロジェクトが見つかりません',
  same: '同じプロジェクトには統合できません',
  'already-merged': '統合元は既に別のプロジェクトへ統合されています。先に統合を取り消してください',
  'target-merged': '統合先が別のプロジェクトへ統合されています。最終の統合先を指定してください',
  'has-sources': '統合元にほかのプロジェクトが統合されています。先にそちらの統合を取り消すか、同じ統合先へ個別に統合してください',
  'not-merged': 'このプロジェクトは統合されていません',
  'target-mismatch': '指定した統合先が、いまの統合先と一致しません。同期して確認し直してください',
};
/** 受付で理由付きに記録し、アプリとHOMEで次の操作を示すための失敗。 */
export class ProjectMergeError extends Error {
  constructor(readonly reason: ProjectMergeReason) {
    super(reason.code === 'project-merge-changed' ? 'プロジェクト定義が変更されています。再確認してください' : reasonMessages[reason.cause]);
  }
}
export function projectMergeReasonMessage(reason: ProjectMergeReason): string {
  if (reason.code === 'project-merge-changed') return '確認した後にプロジェクト定義が変更されています。同期して確認し直し、新しい依頼を送ってください。';
  return `${reasonMessages[reason.cause]}${reason.project_id ? `（${reason.project_id}）` : ''}。`;
}

export async function readProjectMerges(vault: Vault): Promise<ProjectMerge[]> {
  const result: ProjectMerge[] = [];
  for (const path of await vault.files(mergeDir)) {
    if (!/^90_system\/project-merges\/PMG-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    const record = projectMergeSchema.parse(JSON.parse((await vault.read(path))!));
    if (path !== `${mergeDir}/${record.id}.json`) throw new Error('統合の記録とパスが一致しません');
    result.push(record);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 人が保守するfrontmatterのほかのキー・コメント・書式・本文を保ったまま、状態と統合先の行だけを書き換える。
 * mergedIntoを省くと統合先の行を消す。
 */
export function withMergeState(raw: string, state: { status: string; mergedInto?: string }): string {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('プロジェクト定義のfrontmatterを確認できません');
  const eol = match[1]!, body = match[2]!, statusLine = stringify({ status: state.status }).trimEnd();
  if (/[\r\n]/.test(statusLine)) throw new Error('状態を書き換えられません');
  const lines = body.split(/\r?\n/).filter(line => !/^merged_into\s*:/.test(line));
  const at = lines.findIndex(line => /^status\s*:/.test(line));
  if (at >= 0) lines[at] = statusLine; else lines.push(statusLine);
  // IDが数値や真偽値に読める場合（2026、trueなど）は引用符を付ける。
  if (state.mergedInto !== undefined) lines.push(stringify({ merged_into: state.mergedInto }).trimEnd());
  const result = `---${eol}${lines.join(eol)}${raw.slice(3 + eol.length + body.length)}`;
  const parsed = projectSchema.parse(parseMarkdown(result).meta);
  if (parsed.status !== state.status || parsed.merged_into !== state.mergedInto) throw new Error('状態を書き換えられません');
  return result;
}

const key = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase();
const clean = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();
/** 統合先へ足す語。統合先に既にある語（大文字小文字・全角半角の違いを含む）、長すぎる語、上限を超える分は足さない。 */
export function mergedTerms(from: Project, into: Project): { aliases: string[]; keywords: string[] } {
  const pick = (candidates: string[], existing: string[], room: number) => {
    const seen = new Set(existing.map(key)), added: string[] = [];
    for (const candidate of candidates) {
      const term = clean(candidate);
      if (!term || Array.from(term).length > PROJECT_TERM_CHARS || term.length > PROJECT_TERM_CHARS || seen.has(key(term)) || added.length >= room) continue;
      seen.add(key(term)); added.push(term);
    }
    return added;
  };
  return {
    aliases: pick([from.title, ...from.aliases], [into.id, into.title, ...into.aliases], Math.max(0, PROJECT_TERMS_MAX - into.aliases.length)),
    keywords: pick(from.keywords, into.keywords, Math.max(0, PROJECT_TERMS_MAX - into.keywords.length)),
  };
}

const projectPath = (id: string) => `10_projects/${id}/project.md`;
const resultOf = (record: ProjectMerge, deduped: boolean): ProjectMergeResult => ({ fromId: record.from_id, intoId: record.into_id, action: record.action, mergeId: record.id, aliases: record.aliases, keywords: record.keywords, deduped });

async function apply(config: HubConfig, action: ProjectMergeAction, request: ProjectMergeRequest): Promise<ProjectMergeResult> {
  const r = requestSchema.parse(request), vault = new Vault(config), fromPath = projectPath(r.fromId), intoPath = projectPath(r.intoId);
  return vault.withLock(async () => {
    // ほかの定義が壊れているときは書き換えない。登録簿を読めず、方針の更新も止まるため。
    const projects = await readProjects(config), from = projects.find(p => p.id === r.fromId), into = projects.find(p => p.id === r.intoId);
    const refuse = (cause: Extract<ProjectMergeReason, { code: 'project-merge-refused' }>['cause'], projectId?: string) => new ProjectMergeError({ code: 'project-merge-refused', cause, ...(projectId ? { project_id: projectId } : {}) });
    if (r.fromId === r.intoId) throw refuse('same');
    if (!from) throw refuse('missing', r.fromId);
    if (!into) throw refuse('missing', r.intoId);
    const rawFrom = (await vault.read(fromPath))!, rawInto = (await vault.read(intoPath))!, currentFrom = hash(rawFrom), currentInto = hash(rawInto);
    // 統合元と統合先のNOWを作り直す。入力の帰属は読み替えで決まるため、定義を書いた後に行う。
    const finish = async () => {
      await rebuildPoliciesLocked(config, vault);
      const inputs = await readInputs(config), receipts = await readReceipts(config);
      // 統合元にNOWがなければ、空のNOWを新しく作らない。取り消しで統合元を指定した入力が戻るときは、NOWがなくても作る。
      const returns = action === 'unmerge' && inputs.some(i => i.project === r.fromId);
      for (const id of [r.intoId, r.fromId]) if (id === r.intoId || returns || await vault.read(`10_projects/${id}/NOW.md`) !== undefined) await rebuildNowLocked(vault, config, id, inputs, receipts);
    };
    const records = await readProjectMerges(vault);
    if (r.sourceEventId) {
      const previous = records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.action !== action || previous.from_id !== r.fromId || previous.into_id !== r.intoId || previous.from_before_hash !== r.fromHash || previous.into_before_hash !== r.intoHash) throw new Error('同じ受付IDで別の統合の操作が記録されています');
        // この操作の後に同じ統合元の統合・取り消しがあれば、反映済みの古い操作の再送なので、定義には触れない。
        if (records.some(x => x.from_id === previous.from_id && x.id > previous.id)) return resultOf(previous, true);
        // 記録後・定義の書き込み前に止まった場合は、記録した内容と同じ書き換えになるときだけ続きを行う。
        const pending: [string, string][] = [];
        for (const [path, current, before, after, next] of [
          [fromPath, currentFrom, previous.from_before_hash, previous.from_after_hash, () => withMergeState(rawFrom, action === 'merge' ? { status: 'done', mergedInto: r.intoId } : { status: previous.from_status })],
          [intoPath, currentInto, previous.into_before_hash, previous.into_after_hash, () => withTerms(rawInto, into, previous.aliases, previous.keywords, action)],
        ] as const) {
          if (current === after) continue;
          const content = current === before ? next() : undefined;
          if (content === undefined || hash(content) !== after) throw new ProjectMergeError({ code: 'project-merge-changed' });
          pending.push([path, content]);
        }
        for (const [path, content] of pending) await vault.write(path, content);
        await finish();
        return resultOf(previous, true);
      }
    }
    if (currentFrom !== r.fromHash || currentInto !== r.intoHash) throw new ProjectMergeError({ code: 'project-merge-changed' });
    let record: ProjectMerge, nextFrom: string, nextInto: string;
    const base = { schema_version: 1 as const, id: `PMG-${ulid()}`, action, from_id: r.fromId, into_id: r.intoId, from_before_hash: currentFrom, into_before_hash: currentInto, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), changed_at: new Date().toISOString() };
    if (action === 'merge') {
      if (from.merged_into) throw refuse('already-merged', from.merged_into);
      if (into.merged_into) throw refuse('target-merged', into.merged_into);
      const source = projects.find(p => p.merged_into === from.id);
      if (source) throw refuse('has-sources', source.id);
      const terms = mergedTerms(from, into);
      nextFrom = withMergeState(rawFrom, { status: 'done', mergedInto: r.intoId });
      nextInto = withTerms(rawInto, into, terms.aliases, terms.keywords, 'merge');
      record = { ...base, from_status: from.status, ...terms, from_after_hash: hash(nextFrom), into_after_hash: hash(nextInto) };
    } else {
      if (!from.merged_into) throw refuse('not-merged');
      if (from.merged_into !== r.intoId) throw refuse('target-mismatch', from.merged_into);
      // 最後の統合の記録から、戻す状態と統合先へ足した語を求める。記録のない統合（手で書いたmerged_into）は進行中に戻す。
      const merged = records.filter(x => x.from_id === r.fromId).at(-1), last = merged?.action === 'merge' && merged.into_id === r.intoId ? merged : undefined;
      const status = last?.from_status ?? 'active';
      // 統合の後に本人が外した語は戻さず、同じ統合先に統合されたままのほかのプロジェクトが持つ語は外さない。
      // ほかのプロジェクトの統合で先に足されていた同じ語は、この統合の記録には載らない。統合先への統合で足した語の全体から、
      // このプロジェクトが持つ語を外す対象にする（最後の1つを取り消したときに残さないため）。
      const siblings = projects.filter(p => p.merged_into === r.intoId && p.id !== r.fromId);
      const termsOf = (p: Project, field: 'aliases' | 'keywords') => field === 'aliases' ? [p.title, ...p.aliases] : p.keywords;
      const has = (p: Project, term: string, field: 'aliases' | 'keywords') => termsOf(p, field).some(t => key(t) === key(term));
      const added = (field: 'aliases' | 'keywords') => [...new Set(records.filter(x => x.action === 'merge' && x.into_id === r.intoId).flatMap(x => x[field]))];
      const removable = (field: 'aliases' | 'keywords') => added(field).filter(t => into[field].includes(t) && ((last?.[field] ?? []).includes(t) || has(from, t, field)) && !siblings.some(p => has(p, t, field)));
      const aliases = removable('aliases'), keywords = removable('keywords');
      nextFrom = withMergeState(rawFrom, { status });
      nextInto = withTerms(rawInto, into, aliases, keywords, 'unmerge');
      record = { ...base, from_status: status, aliases, keywords, from_after_hash: hash(nextFrom), into_after_hash: hash(nextInto), ...(last ? { merge_id: last.id } : {}) };
    }
    if (!await vault.create(`${mergeDir}/${record.id}.json`, JSON.stringify(projectMergeSchema.parse(record), null, 2) + '\n')) throw new Error('統合の記録が競合しました');
    await vault.write(fromPath, nextFrom);
    if (nextInto !== rawInto) await vault.write(intoPath, nextInto);
    await finish();
    return resultOf(record, false);
  });
}
/** 統合先の別名・キーワードへ語を足す（統合）か、外す（取り消し）。変える語がなければ元のまま返す。 */
function withTerms(raw: string, into: Project, aliases: string[], keywords: string[], action: ProjectMergeAction): string {
  if (!aliases.length && !keywords.length) return raw;
  const edit = (list: string[], terms: string[]) => action === 'merge' ? [...list, ...terms] : list.filter(t => !terms.includes(t));
  return withDefinition(raw, { title: into.title, aliases: edit(into.aliases, aliases), keywords: edit(into.keywords, keywords) });
}

/**
 * 本人が確認した2つのproject.mdのハッシュに結び付けて、統合元を統合先へまとめる。
 * 記録を先に作り、定義の書き込み前に停止した場合は同じ受付IDの再送で回復する。
 * 統合先の定義が変わるとプロジェクト登録簿のhashが変わり、次のcycleで帰属未確定のメモが再関連付けの対象になる。
 */
export async function mergeProjects(config: HubConfig, request: ProjectMergeRequest): Promise<ProjectMergeResult> { return apply(config, 'merge', request); }
/** 統合を取り消す。統合元を統合前の状態へ戻し、統合で統合先へ足した語のうち残っているものを外す。 */
export async function unmergeProject(config: HubConfig, request: ProjectMergeRequest): Promise<ProjectMergeResult> { return apply(config, 'unmerge', request); }
