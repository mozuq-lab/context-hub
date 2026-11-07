import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault, hash, markdown } from './storage.js';
import { capture } from './capture.js';
import { overlappingProject, projectSchema, readProjects } from './projects.js';
import { rebuildPoliciesLocked } from './policies.js';
import type { HubConfig } from './types.js';

/**
 * 本人がアプリ・Inputから依頼したプロジェクトの新規作成。IDは依頼側がプロジェクト案の採用と同じ形式で決め、
 * 名前・別名が既存のプロジェクトと重なる依頼は受け付けない。任意の最初のメモは作成後に同じプロジェクトの入力として保存する。
 */
export const newProjectIdSchema = z.string().regex(/^project-[0-9a-hjkmnp-tv-z]{26}$/);
export const projectCreationIdSchema = z.string().regex(/^PCR-[0-9A-HJKMNP-TV-Z]{26}$/);
const nameSchema = z.string().min(1).max(100).refine(s => s.trim() === s && !/[\r\n]/.test(s), '前後の空白と改行は使えません');
export const projectCreateFieldsSchema = z.object({
  title: z.string().min(1).max(200).refine(s => s.trim() === s && !/[\r\n]/.test(s), '前後の空白と改行は使えません'),
  aliases: z.array(nameSchema).max(50), keywords: z.array(nameSchema).max(50),
}).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const projectCreationSchema = z.object({
  schema_version: z.literal(1), id: projectCreationIdSchema, project_id: newProjectIdSchema, title: z.string(), aliases: z.array(z.string()), keywords: z.array(z.string()),
  project_hash: digest, first_memo_hash: digest.optional(), source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(1000).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ProjectCreation = z.infer<typeof projectCreationSchema>;
export interface ProjectCreateRequest { projectId: string; title: string; aliases: string[]; keywords: string[]; firstMemo?: string; occurredAt: string; source: string; sourceEventId?: string }
export interface ProjectCreateResult { projectId: string; creationId: string; firstMemoInputId?: string; deduped: boolean }
const creationDir = '90_system/project-creations';

/** 受付で理由付きに記録し、アプリとHOMEで次の操作を示すための失敗。 */
export class ProjectCreateError extends Error {
  constructor(readonly reason: { code: 'project-exists' } | { code: 'project-overlap'; project_id: string }) {
    super(reason.code === 'project-exists' ? '同じIDのプロジェクトが既にあります' : `名前・別名が既存のプロジェクト（${reason.project_id}）と重なります`);
  }
}

export async function readProjectCreations(vault: Vault): Promise<ProjectCreation[]> {
  const result: ProjectCreation[] = [];
  for (const path of await vault.files(creationDir)) {
    if (!/^90_system\/project-creations\/PCR-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    const record = projectCreationSchema.parse(JSON.parse((await vault.read(path))!));
    if (path !== `${creationDir}/${record.id}.json`) throw new Error('プロジェクト作成の記録とパスが一致しません');
    result.push(record);
  }
  return result;
}
function definition(id: string, fields: z.infer<typeof projectCreateFieldsSchema>): string {
  return markdown(projectSchema.parse({ id, ...fields, status: 'active' }), `# ${fields.title}\n\n人が保守するプロジェクト定義です。本人の作成依頼から作りました。\n`);
}

export async function createProject(config: HubConfig, request: ProjectCreateRequest): Promise<ProjectCreateResult> {
  const r = z.object({ projectId: newProjectIdSchema, title: z.string(), aliases: z.array(z.string()), keywords: z.array(z.string()), firstMemo: z.string().optional(), occurredAt: z.string(), source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(1000).optional() }).strict().parse(request);
  const fields = projectCreateFieldsSchema.parse({ title: r.title, aliases: r.aliases, keywords: r.keywords });
  const memo = r.firstMemo?.trim() ? r.firstMemo : undefined;
  if (memo !== undefined && memo.length > config.capture.maxInputChars) throw new Error('最初のメモが文字数上限を超えています');
  const vault = new Vault(config), path = `10_projects/${r.projectId}/project.md`, content = definition(r.projectId, fields);
  const created = await vault.withLock(async () => {
    const previous = r.sourceEventId ? (await readProjectCreations(vault)).find(c => c.source === r.source && c.source_event_id === r.sourceEventId) : undefined;
    if (previous) {
      if (previous.project_id !== r.projectId || previous.project_hash !== hash(content) || previous.first_memo_hash !== (memo === undefined ? undefined : hash(memo))) throw new Error('同じ受付IDで別のプロジェクト作成が記録されています');
      // 記録後・定義の書き込み前に止まった場合は、同じ内容で定義を作る。
      if (await vault.read(path) === undefined) { await vault.create(path, content); await rebuildPoliciesLocked(config, vault); }
      return { record: previous, deduped: true };
    }
    const projects = await readProjects(config);
    if (projects.some(p => p.id === r.projectId) || await vault.read(path) !== undefined) throw new ProjectCreateError({ code: 'project-exists' });
    const overlap = overlappingProject(fields, projects);
    if (overlap) throw new ProjectCreateError({ code: 'project-overlap', project_id: overlap.id });
    const record: ProjectCreation = { schema_version: 1, id: `PCR-${ulid()}`, project_id: r.projectId, ...fields, project_hash: hash(content), ...(memo !== undefined ? { first_memo_hash: hash(memo) } : {}), source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString() };
    if (!await vault.create(`${creationDir}/${record.id}.json`, JSON.stringify(record, null, 2) + '\n')) throw new Error('プロジェクト作成の記録が競合しました');
    if (!await vault.create(path, content)) throw new ProjectCreateError({ code: 'project-exists' });
    await rebuildPoliciesLocked(config, vault);
    return { record, deduped: false };
  });
  // 最初のメモは、作ったプロジェクトの入力として保存する。同じ受付の再送では同じ入力を返す。
  let inputId: string | undefined;
  if (memo !== undefined) inputId = (await capture(config, { source: r.source, sourceEventId: `${r.sourceEventId ?? created.record.id}:first-memo`, text: memo, kind: 'memo', occurredAt: r.occurredAt, project: r.projectId })).inputId;
  return { projectId: r.projectId, creationId: created.record.id, ...(inputId ? { firstMemoInputId: inputId } : {}), deduped: created.deduped };
}
