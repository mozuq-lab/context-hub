import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash, parseMarkdown } from './storage.js';
import { projectIdSchema, projectSchema } from './projects.js';
import { rebuildPoliciesLocked } from './policies.js';
import type { HubConfig, Project } from './types.js';

/** 人が切り替えるプロジェクトの状態。旧版の自由記述は進行中として扱う。 */
export const projectStatuses = ['active', 'paused', 'done'] as const;
export type ProjectStatus = typeof projectStatuses[number];
export const projectStatusSchema = z.enum(projectStatuses);
export const projectStatusLabels: Record<ProjectStatus, string> = { active: '進行中', paused: '休止', done: '完了' };
export function lifecycleOf(project: Pick<Project, 'status'>): ProjectStatus {
  return project.status === 'paused' || project.status === 'done' ? project.status : 'active';
}
/** AIへ帰属候補として渡すプロジェクト。休止・完了は除き、人が明示したプロジェクトだけは状態にかかわらず残す。 */
export function candidateProjects(projects: Project[], keep?: string): Project[] {
  return projects.filter(p => lifecycleOf(p) === 'active' || p.id === keep);
}

const changeIdSchema = z.string().regex(/^PST-[0-9A-HJKMNP-TV-Z]{26}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const projectStatusChangeSchema = z.object({
  schema_version: z.literal(1), id: changeIdSchema, project_id: projectIdSchema, from: z.string().max(100), to: projectStatusSchema,
  before_hash: digest, after_hash: digest, source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(),
  changed_at: z.string().datetime({ offset: true }),
}).strict();
export type ProjectStatusChange = z.infer<typeof projectStatusChangeSchema>;
export interface ProjectStatusRequest { projectId: string; status: ProjectStatus; expectedHash: string; source: string; sourceEventId?: string }
export interface ProjectStatusResult { projectId: string; status: ProjectStatus; changeId: string; deduped: boolean }
const requestSchema = z.object({ projectId: projectIdSchema, status: projectStatusSchema, expectedHash: digest, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional() }).strict();
const changeDir = '90_system/project-status';

export async function readProjectStatusChanges(vault: Vault): Promise<ProjectStatusChange[]> {
  const result: ProjectStatusChange[] = [];
  for (const path of await vault.files(changeDir)) {
    if (!/^90_system\/project-status\/PST-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    const change = projectStatusChangeSchema.parse(JSON.parse((await vault.read(path))!));
    if (path !== `${changeDir}/${change.id}.json`) throw new Error('状態変更の記録とパスが一致しません');
    result.push(change);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
/** 人が保守するfrontmatterのコメント・書式・改行を保つため、status行だけを置き換える。 */
export function withStatus(raw: string, status: ProjectStatus): string {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('プロジェクト定義のfrontmatterを確認できません');
  const eol = match[1], body = match[2], line = `status: ${status}`;
  const next = /^status:.*$/m.test(body) ? body.replace(/^status:.*$/m, line) : `${body}${eol}${line}`;
  const result = `---${eol}${next}${raw.slice(3 + eol.length + body.length)}`;
  if (projectSchema.parse(parseMarkdown(result).meta).status !== status) throw new Error('状態を書き換えられません');
  return result;
}

/**
 * 本人が確認したproject.mdのハッシュに結び付けて状態だけを書き換える。
 * 記録を先に作り、定義の書き込み前に停止した場合は同じ受付IDの再送で回復する。
 */
export async function setProjectStatus(config: HubConfig, request: ProjectStatusRequest): Promise<ProjectStatusResult> {
  const r = requestSchema.parse(request), vault = new Vault(config), path = `10_projects/${r.projectId}/project.md`;
  return vault.withLock(async () => {
    const raw = await vault.read(path);
    if (raw === undefined) throw new Error('プロジェクトが見つかりません');
    const project = projectSchema.parse(parseMarkdown(raw).meta);
    if (project.id !== r.projectId) throw new Error('プロジェクトIDとパスが一致しません');
    const current = hash(raw);
    if (r.sourceEventId) {
      const previous = (await readProjectStatusChanges(vault)).find(c => c.source === r.source && c.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.to !== r.status || previous.before_hash !== r.expectedHash) throw new Error('同じ受付IDで別の状態変更が記録されています');
        if (current === previous.after_hash) return { projectId: r.projectId, status: r.status, changeId: previous.id, deduped: true };
        if (current !== previous.before_hash || hash(withStatus(raw, r.status)) !== previous.after_hash) throw new Error('プロジェクト定義が変更されています。再確認してください');
        await vault.write(path, withStatus(raw, r.status)); await rebuildPoliciesLocked(config, vault);
        return { projectId: r.projectId, status: r.status, changeId: previous.id, deduped: true };
      }
    }
    if (current !== r.expectedHash) throw new Error('プロジェクト定義が変更されています。再確認してください');
    if (project.status === r.status) throw new Error(`既に${projectStatusLabels[r.status]}です`);
    const next = withStatus(raw, r.status);
    const change: ProjectStatusChange = {
      schema_version: 1, id: `PST-${ulid()}`, project_id: r.projectId, from: project.status, to: r.status,
      before_hash: current, after_hash: hash(next), source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), changed_at: new Date().toISOString(),
    };
    if (!await vault.create(`${changeDir}/${change.id}.json`, JSON.stringify(change, null, 2) + '\n')) throw new Error('状態変更の記録が競合しました');
    await vault.write(path, next);
    await rebuildPoliciesLocked(config, vault);
    return { projectId: r.projectId, status: r.status, changeId: change.id, deduped: false };
  });
}
