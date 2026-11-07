import { z } from 'zod';
import { Vault, markdown, parseMarkdown } from './storage.js';
import type { HubConfig, Project } from './types.js';
export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
export const projectSchema = z.object({ id: projectIdSchema, title: z.string().min(1).max(200), aliases: z.array(z.string().max(100)).max(50), keywords: z.array(z.string().max(100)).max(50), status: z.string().max(100) });
const schema=projectSchema;
/** 不正なプロジェクト定義のファイルと、不正な項目。 */
export interface ProjectDefinitionIssue { path: string; fields: string[] }
const fieldLabels: Record<string, string> = { id: 'ID', title: '名前（title）', aliases: '別名（aliases）', keywords: 'キーワード（keywords）', status: '状態（status）' };
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
  return { project: parsed.data };
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
  const project = schema.parse({ aliases: [], keywords: [], status: 'active', ...value });
  const vault = new Vault(config);
  return vault.withLock(async () => {
    if (!await vault.create(`10_projects/${project.id}/project.md`, markdown({ ...project }, `# ${project.title}\n\n人が保守するプロジェクト定義です。\n`))) throw new Error('プロジェクトは既に存在します');
    const {rebuildPoliciesLocked}=await import('./policies.js');await rebuildPoliciesLocked(config,vault);
    return project;
  });
}
