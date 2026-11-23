import { z } from 'zod';
import { ulid } from 'ulid';
import { parse } from 'yaml';
import { frontmatterParts, keyLine, replaceKeyLine, withFrontmatterBody } from './frontmatter-lines.js';
import { Vault, hash, parseMarkdown } from './storage.js';
import { assertNotMerged, inspectProjects, projectIdSchema, projectSchema } from './projects.js';
import { areaSchema, invalidArea, readArea } from './areas.js';
import type { HubConfig } from './types.js';

const changeIdSchema = z.string().regex(/^PAREA-[0-9A-HJKMNP-TV-Z]{26}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const projectAreaChangeSchema = z.object({
  schema_version: z.literal(1), id: changeIdSchema, project_id: projectIdSchema,
  // fromは変更前に読めた領域（無い・読めない値はnull）。toは変更後で、nullは外した記録。
  from: z.string().max(200).nullable(), to: areaSchema.nullable(),
  before_hash: digest, after_hash: digest, source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(),
  changed_at: z.string().datetime({ offset: true }),
}).strict();
export type ProjectAreaChange = z.infer<typeof projectAreaChangeSchema>;
const changeDir = '90_system/project-areas';

export async function readProjectAreaChanges(vault: Vault): Promise<{ records: ProjectAreaChange[]; problems: string[] }> {
  const records: ProjectAreaChange[] = [], problems: string[] = [];
  for (const path of await vault.files(changeDir)) {
    if (!/^90_system\/project-areas\/PAREA-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const change = projectAreaChangeSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== `${changeDir}/${change.id}.json`) throw new Error();
      records.push(change);
    } catch { problems.push(path); }
  }
  return { records: records.sort((a, b) => a.id.localeCompare(b.id)), problems };
}

/** YAMLとして元の値に戻る、なるべく素の書き方。戻らなければJSON（YAMLの二重引用符）で書く。 */
function areaText(area: string): string {
  try { if ((parse(`k: ${area}`) as Record<string, unknown> | null)?.k === area) return area; } catch { /* 引用符で書く */ }
  return JSON.stringify(area);
}
/** 人が保守するfrontmatterのコメント・書式・改行を保つため、area行だけを置き換える（nullなら行ごと外す、無ければ末尾に足す）。 */
export function withArea(raw: string, area: string | null): string {
  const parts = frontmatterParts(raw), lines = parts.body.split(/\r?\n/);
  const next = area === null ? lines.filter(l => !keyLine('area').test(l)) : replaceKeyLine(lines, 'area', `area: ${areaText(area)}`);
  const result = withFrontmatterBody(parts, next.join(parts.eol));
  const parsed = projectSchema.parse(parseMarkdown(result).meta);
  if ((readArea(parsed.area) ?? null) !== area) throw new Error('領域を書き換えられません');
  // 手で複数行に書いた領域（続きの行・ブロック）を1行だけ外すと、残った行がほかの欄に混ざる。領域以外の欄が変わるなら書かない。
  const others = (meta: Record<string, unknown>) => JSON.stringify(Object.entries(meta).filter(([k]) => k !== 'area'));
  if (others(parseMarkdown(raw).meta) !== others(parseMarkdown(result).meta)) throw new Error('領域の行を書き換えられません。project.mdの領域（area）を1行に直してから、もう一度操作してください');
  return result;
}

export interface ProjectAreaRequest { projectId: string; area: string | null; expectedHash: string; source: string; sourceEventId?: string }
export interface ProjectAreaResult { projectId: string; area: string | null; changeId: string; deduped: boolean }
const requestSchema = z.object({ projectId: projectIdSchema, area: areaSchema.nullable(), expectedHash: digest, source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional() }).strict();

/**
 * 本人が確認したproject.mdのハッシュに結び付けて、領域だけを書き換える（nullで外す）。
 * 記録を先に作り、定義の書き込み前に停止した場合は同じ受付IDの再送で回復する。
 * 領域はAIへ渡さず、登録簿のハッシュにも含めないため、変えてもメモの再関連付け（モデル呼び出し）は起きない。
 */
export async function setProjectArea(config: HubConfig, request: ProjectAreaRequest): Promise<ProjectAreaResult> {
  const r = requestSchema.parse(request), vault = new Vault(config), path = `10_projects/${r.projectId}/project.md`;
  return vault.withLock(async () => {
    const raw = await vault.read(path);
    if (raw === undefined) throw new Error('プロジェクトが見つかりません');
    const project = projectSchema.parse(parseMarkdown(raw).meta);
    if (project.id !== r.projectId) throw new Error('プロジェクトIDとパスが一致しません');
    const current = hash(raw);
    if (r.sourceEventId) {
      const previous = (await readProjectAreaChanges(vault)).records.find(c => c.source === r.source && c.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || previous.to !== r.area || previous.before_hash !== r.expectedHash) throw new Error('同じ受付IDで別の領域の変更が記録されています');
        if (current === previous.after_hash) return { projectId: r.projectId, area: r.area, changeId: previous.id, deduped: true };
        if (current !== previous.before_hash || hash(withArea(raw, r.area)) !== previous.after_hash) throw new Error('プロジェクト定義が変更されています。再確認してください');
        await vault.write(path, withArea(raw, r.area));
        return { projectId: r.projectId, area: r.area, changeId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトは統合先として読むため、領域も統合先で付ける。
    if (project.merged_into) assertNotMerged((await inspectProjects(config)).projects, r.projectId);
    const before = readArea(project.area) ?? null, unchanged = before === r.area && !invalidArea(project.area);
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の領域と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      // 再試行し続けないよう、この領域にした最後の記録を返す（手で書いた領域で記録がなければ、下で断る）。
      const latest = (await readProjectAreaChanges(vault)).records.filter(c => c.project_id === r.projectId && c.to === r.area).at(-1);
      if (latest) return { projectId: r.projectId, area: r.area, changeId: latest.id, deduped: true };
    }
    if (current !== r.expectedHash) throw new Error('プロジェクト定義が変更されています。再確認してください');
    if (unchanged) throw new Error(r.area === null ? 'このプロジェクトに外す領域はありません' : `既に領域「${r.area}」です`);
    const next = withArea(raw, r.area);
    const change: ProjectAreaChange = {
      schema_version: 1, id: `PAREA-${ulid()}`, project_id: r.projectId, from: typeof project.area === 'string' ? project.area.slice(0, 200) : null, to: r.area,
      before_hash: current, after_hash: hash(next), source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), changed_at: new Date().toISOString(),
    };
    if (!await vault.create(`${changeDir}/${change.id}.json`, JSON.stringify(change, null, 2) + '\n')) throw new Error('領域の変更の記録が競合しました');
    await vault.write(path, next);
    return { projectId: r.projectId, area: r.area, changeId: change.id, deduped: false };
  });
}
