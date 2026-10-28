import { z } from 'zod';
import { Vault, markdown, parseMarkdown } from './storage.js';
import type { HubConfig, Project } from './types.js';
export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
export const projectSchema = z.object({ id: projectIdSchema, title: z.string().min(1).max(200), aliases: z.array(z.string().max(100)).max(50), keywords: z.array(z.string().max(100)).max(50), status: z.string().max(100) });
const schema=projectSchema;
export async function readProjects(config: HubConfig): Promise<Project[]> {
  const vault = new Vault(config), result: Project[] = [];
  for (const path of await vault.files('10_projects')) {
    if (!/^10_projects\/[^/]+\/project\.md$/.test(path)) continue;
    const { meta } = parseMarkdown((await vault.read(path))!);
    const project = schema.parse(meta);
    if (path !== `10_projects/${project.id}/project.md`) throw new Error('プロジェクトIDとパスが一致しません');
    result.push(project);
  }
  return result;
}
export async function addProject(config: HubConfig, value: Pick<Project, 'id' | 'title'> & Partial<Project>): Promise<Project> {
  const project = schema.parse({ aliases: [], keywords: [], status: 'active', ...value });
  const vault = new Vault(config);
  return vault.withLock(async () => {
    if (!await vault.create(`10_projects/${project.id}/project.md`, markdown({ ...project }, `# ${project.title}\n\n人が保守するプロジェクト定義です。\n`))) throw new Error('プロジェクトは既に存在します');
    return project;
  });
}
