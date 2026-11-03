import { z } from 'zod';
import { ulid } from 'ulid';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { Vault, hash, parseMarkdown } from './storage.js';
import { capture, readInputs } from './capture.js';
import { projectIdSchema, readProjects } from './projects.js';
import { lifecycleOf } from './project-status.js';
import type { HubConfig, Input } from './types.js';

/**
 * 本人が設定したローカルリポジトリのコミット履歴から、作業記録の下書きを作る。
 * 下書きは入力ではなく、本人が確認して入力にしたもの（meta.git_draftと下書きhash付き）だけが根拠になる。
 */
const draftIdSchema = z.string().regex(/^GDR-[0-9A-HJKMNP-TV-Z]{26}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/), committed_at: z.string().datetime({ offset: true }), subject: z.string().max(200) }).strict();
export const gitDraftSchema = z.object({
  schema_version: z.literal(1), id: draftIdSchema, project_id: projectIdSchema, repo: z.string().min(1).max(100), repo_path: z.string().min(1).max(4096),
  commits: z.array(commitSchema).min(1).max(200), omitted: z.number().int().min(0), text: z.string().min(1).max(20_000), created_at: z.string().datetime({ offset: true }),
}).strict();
export type GitDraft = z.infer<typeof gitDraftSchema>;
export const gitDraftDismissalSchema = z.object({
  schema_version: z.literal(1), draft_id: draftIdSchema, draft_hash: digest, source: z.string().min(1).max(200),
  source_event_id: z.string().min(1).max(200).optional(), dismissed_at: z.string().datetime({ offset: true }),
}).strict();
const statusSchema = z.object({ schema_version: z.literal(1), checked_at: z.string().datetime({ offset: true }), problems: z.array(z.object({ projectId: z.string().max(100), repo: z.string().max(100), error: z.string().max(500) }).strict()).max(200) }).strict();
export type GitDraftStatus = 'pending' | 'used' | 'dismissed';
export interface GitDraftView extends GitDraft { path: string; hash: string; status: GitDraftStatus; inputId?: string }
const draftDir = '90_system/git-drafts';
const dismissalPath = (id: string) => `${draftDir}/dismissed/${id}.json`;
const statusPath = `${draftDir}/status.json`;

/** 本人が確認した下書き（同じプロジェクト・同じhash）から作った入力か。 */
function usedBy(draft: GitDraft, rawHash: string, input: Input): boolean {
  return input.meta?.git_draft === draft.id && input.meta?.git_draft_hash === rawHash && input.project === draft.project_id;
}

/** 下書きを読む。読めない記録は一覧から除き、problemsに返す（HOMEやcycleを止めない）。 */
export async function readGitDraftRecords(config: HubConfig): Promise<{ drafts: GitDraftView[]; problems: string[] }> {
  const vault = new Vault(config), inputs = await readInputs(config), drafts: GitDraftView[] = [], problems: string[] = [];
  for (const path of await vault.files(draftDir)) {
    if (!/^90_system\/git-drafts\/GDR-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const raw = (await vault.read(path))!, draft = gitDraftSchema.parse(JSON.parse(raw)), rawHash = hash(raw);
      if (path !== `${draftDir}/${draft.id}.json`) throw new Error();
      const used = inputs.find(i => usedBy(draft, rawHash, i)), dismissed = await vault.read(dismissalPath(draft.id));
      if (dismissed !== undefined) {
        const d = gitDraftDismissalSchema.parse(JSON.parse(dismissed));
        if (d.draft_id !== draft.id || d.draft_hash !== rawHash) throw new Error();
      }
      drafts.push({ ...draft, path, hash: rawHash, status: used ? 'used' : dismissed !== undefined ? 'dismissed' : 'pending', ...(used ? { inputId: used.id } : {}) });
    } catch { problems.push(path); }
  }
  return { drafts: drafts.sort((a, b) => a.id.localeCompare(b.id)), problems };
}
export async function readGitDrafts(config: HubConfig): Promise<GitDraftView[]> { return (await readGitDraftRecords(config)).drafts; }
/** 直近の収集で読めなかったリポジトリや設定の問題。HOMEの「失敗と競合」に表示する。 */
export async function readGitCollectProblems(vault: Vault): Promise<z.infer<typeof statusSchema>['problems']> {
  const raw = await vault.read(statusPath);
  if (raw === undefined) return [];
  try { return statusSchema.parse(JSON.parse(raw)).problems; } catch { return [{ projectId: '*', repo: '*', error: '収集状況の記録が不正です' }]; }
}

/** 件名は制御文字を除き、UTF-16で200単位以内に収める。 */
const clean = (s: string) => { let out = ''; for (const ch of s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()) { if (out.length + ch.length > 200) break; out += ch; } return out; };
/** 継承した環境のGIT_*（GIT_DIRなど）が-Cの指定を上書きしないよう取り除く。 */
const gitEnv = () => Object.fromEntries([...Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')), ['GIT_TERMINAL_PROMPT', '0'], ['GIT_OPTIONAL_LOCKS', '0'], ['LC_ALL', 'C']]);
/**
 * シェルを介さず固定引数でgit logだけを実行する。ページャ・fsmonitor・署名検証（外部プログラム）は使わない。
 * range（`<sha>..HEAD`）を優先し、使えなければsince以降を読む。古い順に返す。
 */
export function gitLog(path: string, options: { since: string; after?: string; max: number }, timeoutMs = 10_000): Promise<{ sha: string; committed_at: string; subject: string }[]> {
  const run = (selector: string[]) => new Promise<string>((resolve, reject) => execFile('git', ['--no-pager', '-C', path, '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', 'log', '--no-merges', '--no-color', '--no-show-signature', ...selector, '-n', String(options.max), '--format=%H%x1f%cI%x1f%s', '--'],
    { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: gitEnv() }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const parse = (stdout: string) => stdout.split('\n').filter(Boolean).map(line => { const [sha, at, ...rest] = line.split('\u001f'); return { sha: sha ?? '', committed_at: at ?? '', subject: clean(rest.join(' ')) }; })
    .filter(r => /^[a-f0-9]{40,64}$/.test(r.sha) && Number.isFinite(Date.parse(r.committed_at))).map(r => ({ ...r, committed_at: new Date(r.committed_at).toISOString() })).reverse();
  const bySince = () => run([`--since=${options.since}`]).then(parse, () => { throw new Error('コミット履歴を読み取れません'); });
  if (!options.after || !/^[a-f0-9]{40,64}$/.test(options.after)) return bySince();
  // 前回の下書きのコミットが履歴から消えた（rebase等）場合だけ、日時で読み直す。
  return run([`${options.after}..HEAD`]).then(parse, bySince);
}

/** 本文が入力の上限に収まるよう、古いコミットから順に入れる。入らなかった分は次の下書きに回す。 */
function draftText(repo: string, commits: GitDraft['commits'], total: number, timezone: string, limit: number): { text: string; included: GitDraft['commits'] } {
  const day = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const line = (c: GitDraft['commits'][number]) => `- ${day(c.committed_at)} ${c.subject || '（件名なし）'} (${c.sha.slice(0, 7)})`;
  const head = (n: number, rest: number) => `${repo}のコミット履歴（${day(commits[0]!.committed_at)}〜${day(commits[n - 1]!.committed_at)}、${n}件）から作った作業記録の下書きです。${rest ? `ほか${rest}件は次の下書きに回します。` : ''}`;
  let n = 0, size = head(commits.length, total).length + 40;
  while (n < commits.length && size + line(commits[n]!).length + 1 <= limit) { size += line(commits[n]!).length + 1; n++; }
  n = Math.max(1, n);
  const included = commits.slice(0, n);
  return { text: [head(n, total - n), '', ...included.map(line)].join('\n').slice(0, limit), included };
}

async function lastEvidence(vault: Vault, projectId: string): Promise<string | undefined> {
  const raw = await vault.read(`10_projects/${projectId}/NOW.md`);
  if (raw === undefined) return undefined;
  try { const v = parseMarkdown(raw).meta.last_evidence_at; return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined; } catch { return undefined; }
}

export interface CollectOutcome { created: string[]; skipped: { projectId: string; repo: string; reason: string }[]; errors: { projectId: string; repo: string; error: string }[] }
/**
 * 進行中のプロジェクトに設定したリポジトリごとに、まだ下書きにしていないコミットから下書きを1件作る。
 * 未確認の下書きが残っているリポジトリは、確認されるまで新しい下書きを作らない。
 */
export async function collectGitDrafts(config: HubConfig, options: { now?: Date; log?: typeof gitLog } = {}): Promise<CollectOutcome> {
  const outcome: CollectOutcome = { created: [], skipped: [], errors: [] };
  if (!config.git.enabled) return outcome;
  const now = options.now ?? new Date(), log = options.log ?? gitLog, vault = new Vault(config), projects = await readProjects(config);
  const limit = Math.min(20_000, config.capture.maxInputChars);
  const mineOf = (drafts: GitDraftView[], path: string, projectId: string) => drafts.filter(d => d.repo_path === path && d.project_id === projectId);
  for (const entry of config.git.repos) {
    const repo = entry.name ?? basename(entry.path), project = projects.find(p => p.id === entry.projectId);
    if (!project) { outcome.errors.push({ projectId: entry.projectId, repo, error: '設定したプロジェクトが見つかりません' }); continue; }
    if (lifecycleOf(project) !== 'active') { outcome.skipped.push({ projectId: entry.projectId, repo, reason: '休止・完了のプロジェクトです' }); continue; }
    const mine = mineOf(await readGitDrafts(config), entry.path, entry.projectId);
    if (mine.some(d => d.status === 'pending')) { outcome.skipped.push({ projectId: entry.projectId, repo, reason: '未確認の下書きがあります' }); continue; }
    // 前回の下書きの最新コミット以降。なければ最後の根拠以降。日時で読むときは遡りの上限日数までにする。
    const floor = now.getTime() - config.git.lookbackDays * 86_400_000, evidence = await lastEvidence(vault, entry.projectId);
    const covered = mine.flatMap(d => d.commits).sort((a, b) => Date.parse(a.committed_at) - Date.parse(b.committed_at)), last = covered.at(-1);
    const since = Math.max(floor, last ? Date.parse(last.committed_at) : evidence ? Date.parse(evidence) : floor);
    let commits;
    try { commits = await log(entry.path, { since: new Date(since).toISOString(), after: last?.sha, max: 1000 }); }
    catch (error) { outcome.errors.push({ projectId: entry.projectId, repo, error: error instanceof Error ? error.message : String(error) }); continue; }
    const seen = new Set(covered.map(c => c.sha));
    const fresh = commits.filter(c => !seen.has(c.sha) && Date.parse(c.committed_at) <= now.getTime());
    if (!fresh.length) continue;
    const selected = fresh.slice(0, config.git.maxCommits), { text, included } = draftText(repo, selected, fresh.length, config.timezone, limit);
    const draft = gitDraftSchema.parse({ schema_version: 1, id: `GDR-${ulid()}`, project_id: entry.projectId, repo, repo_path: entry.path, commits: included, omitted: fresh.length - included.length, text, created_at: now.toISOString() });
    // 同時に動いたcycleと手動の収集が同じコミットで重ねて作らないよう、ロック内で確認し直す。
    const created = await vault.withLock(async () => {
      const current = mineOf(await readGitDrafts(config), entry.path, entry.projectId);
      if (current.some(d => d.status === 'pending') || current.some(d => d.commits.some(c => included.some(i => i.sha === c.sha)))) return false;
      if (!await vault.create(`${draftDir}/${draft.id}.json`, JSON.stringify(draft, null, 2) + '\n')) throw new Error('作業記録の下書きが競合しました');
      return true;
    });
    if (created) outcome.created.push(draft.id);
    else outcome.skipped.push({ projectId: entry.projectId, repo, reason: '同時に作られた下書きがあります' });
  }
  const problems = outcome.errors.map(e => ({ projectId: e.projectId.slice(0, 100), repo: e.repo.slice(0, 100), error: e.error.slice(0, 500) }));
  await vault.withLock(async () => {
    const previous = await readGitCollectProblems(vault);
    if (JSON.stringify(previous) !== JSON.stringify(problems)) await vault.write(statusPath, JSON.stringify({ schema_version: 1, checked_at: now.toISOString(), problems }, null, 2) + '\n');
  });
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
  const result = await capture(config, { source: request.source, sourceEventId: `git-draft:${draft.id}`, text: draft.text, kind: request.kind, project: draft.project_id, tool: 'git', occurredAt: draft.commits.map(c => c.committed_at).sort().at(-1)!, meta: { git_draft: draft.id, git_draft_hash: draft.hash, repo: draft.repo } });
  return { draftId: draft.id, inputId: result.inputId, deduped: result.deduped };
}
export async function dismissGitDraft(config: HubConfig, request: { draftId: string; expectedHash: string; source: string; sourceEventId?: string }): Promise<{ draftId: string; dismissed: true; deduped: boolean }> {
  const vault = new Vault(config);
  return vault.withLock(async () => {
    const draft = await findDraft(config, request.draftId, request.expectedHash);
    if (draft.status === 'dismissed') return { draftId: draft.id, dismissed: true as const, deduped: true };
    if (draft.status === 'used') throw new Error('入力にした下書きは見送れません');
    const record = { schema_version: 1, draft_id: draft.id, draft_hash: draft.hash, source: request.source, ...(request.sourceEventId ? { source_event_id: request.sourceEventId } : {}), dismissed_at: new Date().toISOString() };
    if (!await vault.create(dismissalPath(draft.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('見送り記録が競合しました');
    return { draftId: draft.id, dismissed: true as const, deduped: false };
  });
}
