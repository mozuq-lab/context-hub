import { z } from 'zod';
import { Vault, markdown, parseMarkdown } from './storage.js';
import { nowText } from './markdown-text.js';
import { readArea } from './areas.js';
import type { HubConfig, Project } from './types.js';
export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
// outcomeは本人が書く「望む結果」。書いていない定義（空・null）も有効で、読むときに無いものとして扱う。手で書いた長い文も読み、上限はdoctorで示す。
export const projectSchema = z.object({ id: projectIdSchema, title: z.string().min(1).max(200), aliases: z.array(z.string().max(100)).max(50), keywords: z.array(z.string().max(100)).max(50), status: z.string().max(100), merged_into: projectIdSchema.optional(), outcome: z.string().nullish(), area: z.unknown().optional() });
/** 望む結果の上限（正規化した後の文字数・行数）。 */
export const PROJECT_OUTCOME_CHARS = 500;
export const PROJECT_OUTCOME_LINES = 10;
export const outcomeLimitMessage = `望む結果は${PROJECT_OUTCOME_CHARS}文字・${PROJECT_OUTCOME_LINES}行までにしてください`;
/**
 * 望む結果の正規化。改行はLFにし、タブは空白にし、各行の前後の空白と空の行を除く。空なら空文字（望む結果を外す）。
 * 表示する行が残らない文（箇条書きの印だけなど）も空文字にする。改行とタブのほかの制御文字と、上限を超える文は受け付けない。
 * 上限の文字数はUTF-16の単位で数える（アプリの`normalizeProjectOutcome`と同じ）。
 */
export function normalizeOutcome(text: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) throw new Error('望む結果に使えない文字が含まれています');
  const value = cleanOutcome(text), lines = value ? value.split('\n').length : 0;
  if (value.length > PROJECT_OUTCOME_CHARS || lines > PROJECT_OUTCOME_LINES) throw new Error(outcomeLimitMessage);
  return value;
}
/** 上限を確かめない正規化（手で書いた文と、送られた文が同じかを比べるのに使う）。 */
export function cleanOutcome(text: string | null | undefined): string {
  const value = (text ?? '').replace(/\r\n?/g, '\n').replaceAll('\t', ' ').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  return outcomeLines(value).length ? value : '';
}
/**
 * 表示とAIへ渡すための望む結果の行。手で書いた文も読めるよう、制御文字を空白にし、空の行を除き、行頭の箇条書きの印を外す。
 * アプリが登録簿のハッシュを同じ規則で求めるので、変えるときはアプリの`outcomeLines`もそろえる。
 */
export function outcomeLines(outcome: string | null | undefined): string[] {
  return (outcome ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().replace(/^(?:[-*+](?:\s+|$)|・\s*)+/, '').trim()).filter(Boolean);
}
/**
 * AIへ渡す・登録簿のハッシュに含める望む結果。書いていなければundefined（書いていない定義のハッシュとAIへ渡す内容を変えない）。
 * 先頭からコードポイントで500文字に切る（アプリの`projectOutcomeForPrompt`はrunesで同じく切る）。
 */
export function outcomeForPrompt(outcome: string | null | undefined): string | undefined {
  const text = Array.from(outcomeLines(outcome).join('\n')).slice(0, PROJECT_OUTCOME_CHARS).join('');
  return text || undefined;
}
/** NOWとresumeの先頭に置く「望む結果」の欄（本人が書いた文の行。見出しから始まり空の行で終わる）。書いていなければ空文字。 */
export const OUTCOME_HEADING = '# 望む結果（本人が書いた完了の基準）';
export function outcomeSection(outcome: string | null | undefined): string {
  const lines = outcomeLines(outcome);
  return lines.length ? `${OUTCOME_HEADING}\n${lines.map(l => `- ${nowText(l)}`).join('\n')}\n\n` : '';
}
/** 望む結果を1行で（表示の見出しやふりかえりの行に使う）。書いていなければ空文字。 */
export const outcomeOneLine = (outcome: string | null | undefined): string => outcomeLines(outcome).join(' / ');
const schema=projectSchema;
/** 不正なプロジェクト定義のファイルと、不正な項目。 */
export interface ProjectDefinitionIssue { path: string; fields: string[] }
const fieldLabels: Record<string, string> = { id: 'ID', title: '名前（title）', aliases: '別名（aliases）', keywords: 'キーワード（keywords）', status: '状態（status）', merged_into: '統合先（merged_into）', outcome: '望む結果（outcome）', area: '領域（area）' };
export function projectIssueFields(issue: ProjectDefinitionIssue): string {
  return issue.fields.map(f => fieldLabels[f] ?? f).join('・');
}
export function describeProjectIssue(issue: ProjectDefinitionIssue): string {
  return `${issue.path}（${projectIssueFields(issue)}）`;
}
function parseProject(path: string, raw: string): { project?: Project; issue?: ProjectDefinitionIssue } {
  let meta: Record<string, unknown>;
  try { meta = parseMarkdown(raw).meta; }
  catch { return { issue: { path, fields: ['frontmatter'] } }; }
  const parsed = schema.safeParse(meta);
  if (!parsed.success) return { issue: { path, fields: [...new Set(parsed.error.issues.map(i => String(i.path[0] ?? 'frontmatter')))] } };
  if (path !== `10_projects/${parsed.data.id}/project.md`) return { issue: { path, fields: ['id'] } };
  // 空・nullの望む結果は書いていないものとして読む（登録簿のハッシュとAIへ渡す内容を、書いていない定義と同じにする）。
  // 領域は規則に合う値だけを読む（手で書いた不正な値は付いていないものとして扱い、doctorで示す）。
  const { outcome, area: rawArea, ...rest } = parsed.data, area = readArea(rawArea);
  return { project: { ...rest, ...(typeof outcome === 'string' && outcomeLines(outcome).length ? { outcome } : {}), ...(area !== undefined ? { area } : {}) } };
}
/** 全プロジェクト定義を検査し、正しい定義と不正な定義の一覧を返す。 */
export async function inspectProjects(config: HubConfig): Promise<{ projects: Project[]; issues: ProjectDefinitionIssue[] }> {
  const vault = new Vault(config), projects: Project[] = [], issues: ProjectDefinitionIssue[] = [];
  for (const path of await vault.files('10_projects')) {
    if (!/^10_projects\/[^/]+\/project\.md$/.test(path)) continue;
    const { project, issue } = parseProject(path, (await vault.read(path))!);
    if (project) projects.push(project); else issues.push(issue!);
  }
  return { projects, issues };
}
/**
 * 全プロジェクト定義を読む。不正な定義が1つでもあれば、ファイルと項目を示して止める。
 * 不正な定義を除いて続けると登録簿のhashが変わり、帰属未確定の全メモが再関連付け（モデル呼び出し）の対象になるため。
 */
export async function readProjects(config: HubConfig): Promise<Project[]> {
  const { projects, issues } = await inspectProjects(config);
  if (issues.length) throw new Error(`プロジェクト定義が不正です: ${issues.map(describeProjectIssue).join('、')}。ファイルを修正し、ctx doctorで確認してください`);
  return projects;
}
export async function addProject(config: HubConfig, value: Pick<Project, 'id' | 'title'> & Partial<Project>): Promise<Project> {
  const { outcome, ...fields } = value, text = outcome === undefined || outcome === null ? '' : normalizeOutcome(outcome);
  const project = schema.parse({ aliases: [], keywords: [], status: 'active', ...fields, ...(text ? { outcome: text } : {}) }) as Project;
  const vault = new Vault(config);
  return vault.withLock(async () => {
    if (!await vault.create(`10_projects/${project.id}/project.md`, markdown({ ...project }, `# ${project.title}\n\n人が保守するプロジェクト定義です。\n`))) throw new Error('プロジェクトは既に存在します');
    const {rebuildPoliciesLocked}=await import('./policies.js');await rebuildPoliciesLocked(config,vault);
    return project;
  });
}
/** 名前・別名を比べるための正規化（全角・半角、大文字・小文字、前後の空白の違いを無視する）。 */
export const normalizeName=(s:string)=>s.normalize('NFKC').trim().toLocaleLowerCase();
/** 名前・別名が既存のプロジェクトのID・名前・別名と重なるか。重なった最初のプロジェクトを返す。 */
export function overlappingProject(names:{title:string;aliases:string[]},projects:Project[]):Project|undefined{
  const wanted=new Set([names.title,...names.aliases].map(normalizeName).filter(Boolean));
  return projects.find(p=>[p.id,p.title,...p.aliases].some(s=>wanted.has(normalizeName(s))));
}

/**
 * 統合元のID→読み替え先のID。統合先がさらに統合されていれば最後までたどる。
 * 統合先が見つからない・自分自身・循環している定義は統合として扱わず（そのプロジェクトのまま読む）、mergeIssuesで示す。
 */
export function mergeTargets(projects: Project[]): Map<string, string> {
  const byId = new Map(projects.map(p => [p.id, p])), result = new Map<string, string>();
  for (const project of projects) {
    if (!project.merged_into) continue;
    const seen = new Set([project.id]); let current = project, broken = false;
    while (current.merged_into) {
      const next = byId.get(current.merged_into);
      if (!next || seen.has(next.id)) { broken = true; break; }
      seen.add(next.id); current = next;
    }
    if (!broken) result.set(project.id, current.id);
  }
  return result;
}
/** 統合されていれば統合先のID、そうでなければ元のID。 */
export function resolveProject(projects: Project[], id: string): string;
export function resolveProject(projects: Project[], id: string | undefined): string | undefined;
export function resolveProject(projects: Project[], id: string | undefined): string | undefined {
  return id === undefined ? undefined : mergeTargets(projects).get(id) ?? id;
}
/** このプロジェクトへ読み替えられる統合元のID（ID順）。 */
export function mergedSources(projects: Project[], id: string): string[] {
  return [...mergeTargets(projects)].filter(([, target]) => target === id).map(([source]) => source).sort();
}
/** 手で書いたmerged_intoの不整合。本体の統合操作では作られない。 */
export function mergeIssues(projects: Project[]): string[] {
  const byId = new Map(projects.map(p => [p.id, p])), targets = mergeTargets(projects), issues: string[] = [];
  for (const project of projects) {
    if (!project.merged_into) continue;
    if (!byId.has(project.merged_into)) issues.push(`統合先のプロジェクトが見つかりません: 10_projects/${project.id}/project.md（merged_into: ${project.merged_into}）`);
    else if (!targets.has(project.id)) issues.push(`統合先が循環しています: 10_projects/${project.id}/project.md（merged_into: ${project.merged_into}）`);
    else if (byId.get(project.merged_into)!.merged_into) issues.push(`統合先がさらに統合されています（${targets.get(project.id)}として読み替えています）: 10_projects/${project.id}/project.md（merged_into: ${project.merged_into}）`);
  }
  return issues;
}
/** 統合済みのプロジェクトを対象にした操作。受付で理由付きに記録し、統合先で操作し直すよう示す。 */
export class ProjectMergedError extends Error {
  readonly reason: { code: 'project-merged'; project_id: string };
  constructor(target: string) {
    super(`このプロジェクトは${target}に統合されています。統合先で操作するか、先に統合を取り消してください`);
    this.reason = { code: 'project-merged', project_id: target };
  }
}
/** 統合済みなら、統合先を示して止める。 */
export function assertNotMerged(projects: Project[], id: string): void {
  // 統合先が見つからない・循環している定義は統合として扱わない（mergeIssuesで示す）。
  const target = mergeTargets(projects).get(id);
  if (target) throw new ProjectMergedError(target);
}
