import { z } from 'zod';
import { ulid } from 'ulid';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { Vault, hash } from './storage.js';
import { capture, readInputs } from './capture.js';
import { projectIdSchema, readProjects } from './projects.js';
import { lifecycleOf } from './project-status.js';
import { lastEvidenceAt } from './dashboard.js';
import type { HubConfig } from './types.js';

/**
 * 本人が設定したローカルリポジトリのコミット履歴から、作業記録の下書きを作る。
 * 下書きは入力ではなく、本人が確認して入力にしたもの（meta.git_draft付き）だけが根拠になる。
 */
const draftIdSchema = z.string().regex(/^GDR-[0-9A-HJKMNP-TV-Z]{26}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/), committed_at: z.string().datetime({ offset: true }), subject: z.string().max(200) }).strict();
export const gitDraftSchema = z.object({
  schema_version: z.literal(1), id: draftIdSchema, project_id: projectIdSchema, repo: z.string().min(1).max(100),
  commits: z.array(commitSchema).min(1).max(200), text: z.string().min(1).max(20_000), created_at: z.string().datetime({ offset: true }),
}).strict();
export type GitDraft = z.infer<typeof gitDraftSchema>;
export const gitDraftDismissalSchema = z.object({
  schema_version: z.literal(1), draft_id: draftIdSchema, draft_hash: digest, source: z.string().min(1).max(200),
  source_event_id: z.string().min(1).max(200).optional(), dismissed_at: z.string().datetime({ offset: true }),
}).strict();
export type GitDraftStatus = 'pending' | 'used' | 'dismissed';
export interface GitDraftView extends GitDraft { path: string; hash: string; status: GitDraftStatus; inputId?: string }
const draftDir = '90_system/git-drafts';
const dismissalPath = (id: string) => `${draftDir}/dismissed/${id}.json`;
export const gitDraftIdSchema = draftIdSchema;

export async function readGitDrafts(config: HubConfig): Promise<GitDraftView[]> {
  const vault = new Vault(config), inputs = await readInputs(config), result: GitDraftView[] = [];
  for (const path of await vault.files(draftDir)) {
    if (!/^90_system\/git-drafts\/GDR-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    const raw = (await vault.read(path))!;
    let draft: GitDraft;
    try { draft = gitDraftSchema.parse(JSON.parse(raw)); } catch { throw new Error(`作業記録の下書きが不正です: ${path}`); }
    if (path !== `${draftDir}/${draft.id}.json`) throw new Error(`作業記録の下書きとパスが一致しません: ${path}`);
    const used = inputs.find(i => i.meta?.git_draft === draft.id);
    const dismissed = await vault.read(dismissalPath(draft.id));
    if (dismissed !== undefined) {
      const d = gitDraftDismissalSchema.parse(JSON.parse(dismissed));
      if (d.draft_id !== draft.id) throw new Error(`下書きの見送り記録が一致しません: ${draft.id}`);
    }
    result.push({ ...draft, path, hash: hash(raw), status: used ? 'used' : dismissed !== undefined ? 'dismissed' : 'pending', ...(used ? { inputId: used.id } : {}) });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

const clean = (s: string) => Array.from(s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 200).join('');
/** シェルを介さず固定引数でgit logだけを実行する。フック・ページャ・fsmonitorは使わない。 */
export function gitLog(path: string, since: string, max: number, timeoutMs = 10_000): Promise<{ sha: string; committed_at: string; subject: string }[]> {
  const args = ['--no-pager', '-C', path, '-c', 'core.fsmonitor=false', 'log', '--no-merges', '--no-color', `--since=${since}`, '-n', String(max), '--format=%H%x1f%cI%x1f%s'];
  return new Promise((resolve, reject) => execFile('git', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }, (error, stdout) => {
    if (error) return reject(new Error('コミット履歴を読み取れません'));
    const rows = stdout.split('\n').filter(Boolean).map(line => { const [sha, at, ...rest] = line.split('\u001f'); return { sha: sha ?? '', committed_at: at ?? '', subject: clean(rest.join(' ')) }; });
    resolve(rows.filter(r => /^[a-f0-9]{40,64}$/.test(r.sha) && Number.isFinite(Date.parse(r.committed_at))).map(r => ({ ...r, committed_at: new Date(r.committed_at).toISOString() })));
  }));
}

function draftText(repo: string, commits: GitDraft['commits'], timezone: string): string {
  const day = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const ordered = [...commits].sort((a, b) => Date.parse(a.committed_at) - Date.parse(b.committed_at));
  return [`${repo}のコミット履歴（${day(ordered[0]!.committed_at)}〜${day(ordered.at(-1)!.committed_at)}、${ordered.length}件）から作った作業記録の下書きです。`, '',
    ...ordered.map(c => `- ${day(c.committed_at)} ${c.subject || '（件名なし）'} (${c.sha.slice(0, 7)})`)].join('\n');
}

export interface CollectOutcome { created: string[]; skipped: { projectId: string; repo: string; reason: string }[]; errors: { projectId: string; repo: string; error: string }[] }
/**
 * 進行中のプロジェクトに設定したリポジトリごとに、まだ下書きにしていないコミットから下書きを1件作る。
 * 未確認の下書きが残っているリポジトリは、確認されるまで新しい下書きを作らない。
 */
export async function collectGitDrafts(config: HubConfig, options: { now?: Date; log?: typeof gitLog } = {}): Promise<CollectOutcome> {
  const outcome: CollectOutcome = { created: [], skipped: [], errors: [] };
  if (!config.git.enabled || !config.git.repos.length) return outcome;
  const now = options.now ?? new Date(), log = options.log ?? gitLog, vault = new Vault(config);
  const projects = await readProjects(config), drafts = await readGitDrafts(config);
  for (const entry of config.git.repos) {
    const repo = entry.name ?? basename(entry.path), project = projects.find(p => p.id === entry.projectId);
    if (!project) { outcome.skipped.push({ projectId: entry.projectId, repo, reason: 'プロジェクトが見つかりません' }); continue; }
    if (lifecycleOf(project) !== 'active') { outcome.skipped.push({ projectId: entry.projectId, repo, reason: '休止・完了のプロジェクトです' }); continue; }
    const mine = drafts.filter(d => d.project_id === entry.projectId && d.repo === repo);
    if (mine.some(d => d.status === 'pending')) { outcome.skipped.push({ projectId: entry.projectId, repo, reason: '未確認の下書きがあります' }); continue; }
    // 前回の下書き以降、なければ最後の根拠以降。どちらも遡りの上限日数までにする。
    const floor = now.getTime() - config.git.lookbackDays * 86_400_000;
    const covered = mine.flatMap(d => d.commits.map(c => Date.parse(c.committed_at))), evidence = await lastEvidenceAt(vault, entry.projectId);
    const since = Math.max(floor, covered.length ? Math.max(...covered) : evidence ? Date.parse(evidence) : floor);
    let commits;
    try { commits = await log(entry.path, new Date(since).toISOString(), config.git.maxCommits); }
    catch (error) { outcome.errors.push({ projectId: entry.projectId, repo, error: error instanceof Error ? error.message : String(error) }); continue; }
    const seen = new Set(mine.flatMap(d => d.commits.map(c => c.sha)));
    const fresh = commits.filter(c => !seen.has(c.sha) && Date.parse(c.committed_at) <= now.getTime());
    if (!fresh.length) continue;
    const draft: GitDraft = { schema_version: 1, id: `GDR-${ulid()}`, project_id: entry.projectId, repo, commits: fresh, text: draftText(repo, fresh, config.timezone), created_at: now.toISOString() };
    const created = await vault.withLock(() => vault.create(`${draftDir}/${draft.id}.json`, JSON.stringify(draft, null, 2) + '\n'));
    if (!created) throw new Error('作業記録の下書きが競合しました');
    outcome.created.push(draft.id);
  }
  return outcome;
}

async function findDraft(config: HubConfig, draftId: string, expectedHash: string): Promise<GitDraftView> {
  const draft = (await readGitDrafts(config)).find(d => d.id === draftIdSchema.parse(draftId));
  if (!draft) throw new Error('作業記録の下書きが見つかりません');
  if (draft.hash !== digest.parse(expectedHash)) throw new Error('作業記録の下書きが変更されています。再確認してください');
  return draft;
}
/** CLI用。下書きの本文をそのまま入力にする。アプリでは本文を編集してから通常の入力として保存する。 */
export async function useGitDraft(config: HubConfig, request: { draftId: string; expectedHash: string; kind: 'memo' | 'work-summary'; source: string }): Promise<{ draftId: string; inputId: string; deduped: boolean }> {
  const draft = await findDraft(config, request.draftId, request.expectedHash);
  if (draft.status === 'dismissed') throw new Error('見送った下書きです');
  if (draft.status === 'used') return { draftId: draft.id, inputId: draft.inputId!, deduped: true };
  const result = await capture(config, { source: request.source, sourceEventId: `git-draft:${draft.id}`, text: draft.text, kind: request.kind, project: draft.project_id, tool: 'git', occurredAt: draft.commits.map(c => c.committed_at).sort().at(-1)!, meta: { git_draft: draft.id, repo: draft.repo } });
  return { draftId: draft.id, inputId: result.inputId, deduped: result.deduped };
}
export async function dismissGitDraft(config: HubConfig, request: { draftId: string; expectedHash: string; source: string; sourceEventId?: string }): Promise<{ draftId: string; dismissed: true; deduped: boolean }> {
  const vault = new Vault(config);
  return vault.withLock(async () => {
    const draft = await findDraft(config, request.draftId, request.expectedHash);
    const existing = await vault.read(dismissalPath(draft.id));
    if (existing !== undefined) {
      const d = gitDraftDismissalSchema.parse(JSON.parse(existing));
      if (d.draft_hash !== draft.hash) throw new Error('見送り記録が一致しません');
      return { draftId: draft.id, dismissed: true as const, deduped: true };
    }
    if (draft.status === 'used') throw new Error('入力にした下書きは見送れません');
    const record = { schema_version: 1, draft_id: draft.id, draft_hash: draft.hash, source: request.source, ...(request.sourceEventId ? { source_event_id: request.sourceEventId } : {}), dismissed_at: new Date().toISOString() };
    if (!await vault.create(dismissalPath(draft.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('見送り記録が競合しました');
    return { draftId: draft.id, dismissed: true as const, deduped: false };
  });
}
