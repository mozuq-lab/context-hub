import { z } from 'zod';
import { ulid } from 'ulid';
import { parse, parseDocument, isMap, isScalar, isSeq } from 'yaml';
import { Vault, hash, parseMarkdown } from './storage.js';
import { projectIdSchema, projectSchema, readProjects } from './projects.js';
import { rebuildPoliciesLocked } from './policies.js';
import type { HubConfig } from './types.js';

/** 人が手入れするプロジェクト定義の項目。AIの帰属推定と検索に使われる。 */
export interface ProjectDefinition { title: string; aliases: string[]; keywords: string[] }
export const PROJECT_TERMS_MAX = 50;
export const PROJECT_TERM_CHARS = 100;
export const PROJECT_TITLE_CHARS = 200;

const termSchema = z.string().min(1).max(PROJECT_TERM_CHARS);
export const projectDefinitionSchema = z.object({
  title: z.string().min(1).max(PROJECT_TITLE_CHARS),
  aliases: z.array(termSchema).max(PROJECT_TERMS_MAX),
  keywords: z.array(termSchema).max(PROJECT_TERMS_MAX),
}).strict();
/** 変更前の定義。人が手で書いた値なので、project.mdの読取と同じ範囲（空の語・前後の空白を含む）を記録できる。 */
const storedDefinitionSchema = z.object({
  title: z.string().min(1).max(PROJECT_TITLE_CHARS),
  aliases: z.array(z.string().max(PROJECT_TERM_CHARS)).max(PROJECT_TERMS_MAX),
  keywords: z.array(z.string().max(PROJECT_TERM_CHARS)).max(PROJECT_TERMS_MAX),
}).strict();
const changeIdSchema = z.string().regex(/^PDEF-[0-9A-HJKMNP-TV-Z]{26}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const projectDefinitionChangeSchema = z.object({
  schema_version: z.literal(1), id: changeIdSchema, project_id: projectIdSchema,
  before: storedDefinitionSchema, after: projectDefinitionSchema, before_hash: digest, after_hash: digest,
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(),
  changed_at: z.string().datetime({ offset: true }),
}).strict();
export type ProjectDefinitionChange = z.infer<typeof projectDefinitionChangeSchema>;
export interface ProjectDefinitionRequest extends ProjectDefinition { projectId: string; expectedHash: string; source: string; sourceEventId?: string }
export type ProjectDefinitionField = 'title' | 'aliases' | 'keywords';
export interface ProjectDefinitionResult { projectId: string; changeId: string; deduped: boolean; changed: ProjectDefinitionField[] }
const changeDir = '90_system/project-definitions';

/** 前後の空白を除き、空の語と重複（大文字小文字・全角半角の違いを含む）を除いた一覧。順序は最初の出現を保つ。 */
export function normalizeTerms(values: readonly string[]): string[] {
  const seen = new Set<string>(), result: string[] = [];
  for (const value of values) {
    const term = value.replace(/[\r\n\t]+/g, ' ').trim();
    const key = term.normalize('NFKC').toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key); result.push(term);
  }
  return result;
}
export function normalizeDefinition(value: ProjectDefinition): ProjectDefinition {
  return projectDefinitionSchema.parse({ title: value.title.replace(/[\r\n\t]+/g, ' ').trim(), aliases: normalizeTerms(value.aliases), keywords: normalizeTerms(value.keywords) });
}
const same = (a: ProjectDefinition, b: ProjectDefinition) => JSON.stringify(a) === JSON.stringify(b);
/** 変わった項目名（title・aliases・keywords）。 */
export function changedFields(before: ProjectDefinition, after: ProjectDefinition): ProjectDefinitionField[] {
  return (['title', 'aliases', 'keywords'] as const).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/** YAMLとして元の値に戻る、なるべく素の書き方。戻らなければJSON（YAMLの二重引用符）で書く。 */
function scalar(value: string, wrap: (text: string) => string, read: (parsed: unknown) => unknown): string {
  try { if (/^[^\s].*[^\s]$|^[^\s]$/.test(value) && read(parse(wrap(value))) === value) return value; } catch { /* 引用符で書く */ }
  return JSON.stringify(value);
}
const flowItem = (v: string) => scalar(v, t => `[${t}]`, p => Array.isArray(p) && p.length === 1 ? p[0] : undefined);
const blockItem = (v: string) => scalar(v, t => `- ${t}`, p => Array.isArray(p) && p.length === 1 ? p[0] : undefined);
const titleText = (v: string) => scalar(v, t => `k: ${t}`, p => (p as Record<string, unknown> | null)?.k);
const flowList = (values: readonly string[]) => `[${values.map(flowItem).join(', ')}]`;

/**
 * 人が保守するfrontmatterのほかのキー・コメント・書式・本文を保ったまま、名前・別名・キーワードの値の部分だけを書き換える。
 * 一覧の書き方（ブロック・フロー）とキー行のコメントを保ち、残る語の行はコメントごと元の行を使う。
 */
export function withDefinition(raw: string, definition: ProjectDefinition): string {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('プロジェクト定義のfrontmatterを確認できません');
  const eol = match[1], body = match[2];
  const doc = parseDocument(body);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('プロジェクト定義のfrontmatterを読めません');
  const edits: { start: number; end: number; text: string }[] = [], appended: string[] = [];
  for (const key of ['title', 'aliases', 'keywords'] as const) {
    const pair = doc.contents.items.find(p => isScalar(p.key) && p.key.value === key);
    const node = pair?.value;
    if (!pair || !node || !(isScalar(node) || isSeq(node)) || !node.range) {
      if (pair) throw new Error('プロジェクト定義のfrontmatterを書き換えられません');
      appended.push(`${key}: ${key === 'title' ? titleText(definition.title) : flowList(definition[key])}`);
      continue;
    }
    const [start, valueEnd] = node.range;
    let text: string;
    if (key === 'title') text = titleText(definition.title);
    else if (!isSeq(node)) throw new Error('プロジェクト定義のfrontmatterを書き換えられません');
    else if (node.flow) text = flowList(definition[key]);
    else if (!definition[key].length) text = flowList([]) + (body.slice(start, valueEnd).match(/(\r?\n)*$/)?.[0] ?? '');
    else {
      // ブロックの一覧は、元の字下げで1行ずつ書く。残る語はコメントを含む元の行を使う。
      const lineStart = body.lastIndexOf('\n', start - 1) + 1, indent = body.slice(lineStart, start);
      if (indent.trim()) throw new Error('プロジェクト定義のfrontmatterを書き換えられません');
      const lines = definition[key].map(term => {
        const item = node.items.find(i => isScalar(i) && i.value === term && i.range);
        if (item && isScalar(item) && item.range) {
          const from = body.lastIndexOf('-', item.range[0]), to = body.indexOf('\n', item.range[0]);
          const line = body.slice(from, to < 0 ? body.length : to).replace(/\r$/, '');
          if (from >= lineStart && /^-\s/.test(line)) return line;
        }
        return `- ${blockItem(term)}`;
      });
      text = lines.join(`${eol}${indent}`);
      const tail = body.slice(start, valueEnd).match(/(\r?\n)*$/)?.[0] ?? '';
      text += tail;
    }
    edits.push({ start, end: valueEnd, text });
  }
  let next = body;
  for (const e of edits.sort((x, y) => y.start - x.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
  if (appended.length) next = `${next.replace(/\s*$/, '')}${eol}${appended.join(eol)}`;
  const result = `---${eol}${next}${raw.slice(3 + eol.length + body.length)}`;
  const parsed = projectSchema.parse(parseMarkdown(result).meta);
  if (!same({ title: parsed.title, aliases: parsed.aliases, keywords: parsed.keywords }, definition)) throw new Error('プロジェクト定義を書き換えられません');
  return result;
}

export const definitionLimitMessage = `名前は1〜${PROJECT_TITLE_CHARS}文字、別名・キーワードはそれぞれ${PROJECT_TERMS_MAX}件まで・1件${PROJECT_TERM_CHARS}文字までにしてください`;

export async function readProjectDefinitionChanges(vault: Vault): Promise<ProjectDefinitionChange[]> {
  const result: ProjectDefinitionChange[] = [];
  for (const path of await vault.files(changeDir)) {
    if (!/^90_system\/project-definitions\/PDEF-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    const change = projectDefinitionChangeSchema.parse(JSON.parse((await vault.read(path))!));
    if (path !== `${changeDir}/${change.id}.json`) throw new Error('定義変更の記録とパスが一致しません');
    result.push(change);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

const requestSchema = z.object({
  projectId: projectIdSchema, expectedHash: digest, title: z.string(), aliases: z.array(z.string()), keywords: z.array(z.string()),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict();

/**
 * 本人が確認したproject.mdのハッシュに結び付けて、名前・別名・キーワードを書き換える。
 * 記録を先に作り、定義の書き込み前に停止した場合は同じ受付IDの再送で回復する。
 * 定義が変わるとプロジェクト登録簿のhashが変わり、次のcycleで帰属未確定のメモが再関連付けの対象になる。
 */
export async function setProjectDefinition(config: HubConfig, request: ProjectDefinitionRequest): Promise<ProjectDefinitionResult> {
  const r = requestSchema.parse(request), vault = new Vault(config), path = `10_projects/${r.projectId}/project.md`;
  let after: ProjectDefinition;
  try { after = normalizeDefinition(r); }
  catch { throw new Error(definitionLimitMessage); }
  return vault.withLock(async () => {
    // ほかの定義が壊れているときは書き換えない。登録簿を読めず、方針の更新も止まるため。
    await readProjects(config);
    const raw = await vault.read(path);
    if (raw === undefined) throw new Error('プロジェクトが見つかりません');
    const project = projectSchema.parse(parseMarkdown(raw).meta);
    if (project.id !== r.projectId) throw new Error('プロジェクトIDとパスが一致しません');
    const current = hash(raw), before: ProjectDefinition = { title: project.title, aliases: project.aliases, keywords: project.keywords };
    if (r.sourceEventId) {
      const previous = (await readProjectDefinitionChanges(vault)).find(c => c.source === r.source && c.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.before_hash !== r.expectedHash || !same(previous.after, after)) throw new Error('同じ受付IDで別の定義変更が記録されています');
        const result = { projectId: r.projectId, changeId: previous.id, deduped: true, changed: changedFields(previous.before, previous.after) };
        if (current === previous.after_hash) return result;
        if (current !== previous.before_hash || hash(withDefinition(raw, after)) !== previous.after_hash) throw new Error('プロジェクト定義が変更されています。再確認してください');
        await vault.write(path, withDefinition(raw, after)); await rebuildPoliciesLocked(config, vault);
        return result;
      }
    }
    if (current !== r.expectedHash) throw new Error('プロジェクト定義が変更されています。再確認してください');
    const changed = changedFields(before, after);
    if (!changed.length) throw new Error('名前・別名・キーワードに変更がありません');
    const next = withDefinition(raw, after);
    const change: ProjectDefinitionChange = {
      schema_version: 1, id: `PDEF-${ulid()}`, project_id: r.projectId, before: storedDefinitionSchema.parse(before), after,
      before_hash: current, after_hash: hash(next), source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), changed_at: new Date().toISOString(),
    };
    if (!await vault.create(`${changeDir}/${change.id}.json`, JSON.stringify(change, null, 2) + '\n')) throw new Error('定義変更の記録が競合しました');
    await vault.write(path, next);
    await rebuildPoliciesLocked(config, vault);
    return { projectId: r.projectId, changeId: change.id, deduped: false, changed };
  });
}

/** CLIの追加・削除の指定を、今の定義に当てはめた新しい定義。 */
export function editDefinition(current: ProjectDefinition, edit: { title?: string; addAliases?: string[]; removeAliases?: string[]; addKeywords?: string[]; removeKeywords?: string[] }): ProjectDefinition {
  const key = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim();
  const apply = (list: string[], add: string[] = [], remove: string[] = []) => {
    const removing = new Set(remove.map(key)), missing = remove.filter(r => !list.some(v => key(v) === key(r)));
    if (missing.length) throw new Error(`削除する語が定義にありません: ${missing.join('、')}`);
    return [...list.filter(v => !removing.has(key(v))), ...add];
  };
  return { title: edit.title ?? current.title, aliases: apply(current.aliases, edit.addAliases, edit.removeAliases), keywords: apply(current.keywords, edit.addKeywords, edit.removeKeywords) };
}
