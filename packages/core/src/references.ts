import { inlineText } from './markdown-text.js';
import { z } from 'zod';
import { Vault, hash, parseMarkdown } from './storage.js';
import { mergeTargets, readProjects } from './projects.js';
import { associatedProjects, dateLabel, generatedMarkdown, isGeneratedIntact } from './views.js';
import { readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { redactText, secretSettings } from './secrets.js';
import type { HubConfig, Input, Project } from './types.js';

/**
 * プロジェクトの資料棚（10_projects/<id>/REFERENCES.md）。整理でAIが「参考資料（reference）」に分類したメモを、
 * モデルを使わずに新しい順へ並べる。URLは本文から文字列として取り出すだけで、取得・要約はしない。
 * NOWは「今」、経緯は流れを示すため、あとで読み返す記事・仕様・リポジトリなどを探す場所として使う。
 */
// AIの要約と名前は1行の文字として載せる。リンク・HTML・コメントとして解釈される文字は無害にする。
const plain = (s: string) => inlineText(s, { table: true, brackets: true, angle: true });
const clip = (s: string, n = 160) => { const a = Array.from(plain(s)); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
export const referencesPath = (projectId: string) => `10_projects/${projectId}/REFERENCES.md`;
/** 1件の資料から載せるURLの上限。超えた分は件数だけ示す。 */
export const REFERENCE_URLS_PER_INPUT = 10;
/** 載せるURLの長さの上限。超えるURLは載せず、原文で確認してもらう。 */
export const REFERENCE_URL_CHARS = 500;
/** 1つの資料棚に載せる資料の上限。超えた分は件数だけ示す（検索で絞り込める）。 */
export const REFERENCES_PER_PROJECT = 200;
/** HOMEに載せる、プロジェクト未定の資料の上限。 */
const UNASSIGNED_ROWS = 10;

// URLに使える半角の文字だけを取り出し、空白・引用符・山括弧と、和文などの半角でない文字で切る。
// 和文はURLの直後に空白なしで続くことが多い（「https://example.com/specを読んだ」）。日本語を含むURLは、
// ブラウザーからコピーした形（%で符号化した形）なら全体を取り出せる。Markdownの `<URL>` を壊す文字は含めない。
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/g;
/** 文末の句読点と、対応する開き括弧のない閉じ括弧を落とす（`[題](URL)` や「(URL)。」の形）。 */
function trimUrl(url: string): string {
  let value = url;
  for (;;) {
    const last = value.at(-1);
    if (last === undefined) break;
    if ('.,;:!?*_~'.includes(last)) { value = value.slice(0, -1); continue; }
    const open = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : undefined;
    if (open && value.split(last).length > value.split(open).length) { value = value.slice(0, -1); continue; }
    break;
  }
  return value;
}
/**
 * 本文に書かれたURLを、出てきた順に重複なく返す。http・httpsだけを対象にし、載せないもの（長すぎる・伏せ字を含む）は数だけ返す。
 * 秘密情報らしい文字列（URLに埋めたパスワードやクエリのトークン）は、呼び出し側が先に伏せた本文を渡す。
 */
export function extractUrls(text: string): { urls: string[]; skipped: number } {
  const urls: string[] = []; let skipped = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    // 伏せ字（[伏せ字:種類]）で途切れたURLはそのままでは開けないので載せず、原文での確認に回す。
    const redacted = match[0].endsWith('[') && text.startsWith('伏せ字:', match.index + match[0].length);
    if (!/^https?:\/\/[^/?#]+/.test(url) || redacted || url.length > REFERENCE_URL_CHARS) { skipped++; continue; }
    if (!urls.includes(url)) urls.push(url);
  }
  return { urls, skipped };
}

export interface ReferenceEntry {
  /** 元のメモ（訂正があっても最初の入力）。 */ input: Input;
  /** AIの一行要約（未検証）。 */ summary: string;
  urls: string[];
  /** 載せなかったURL（長すぎる・伏せ字を含む）の数。 */ skippedUrls: number;
  /** 本人がそのプロジェクトを指定した（true）か、AIが推定した関連か（false）。プロジェクト未定の資料ではfalse。 */ owned: boolean;
  corrected: boolean; pendingCorrection: boolean;
  projects: string[];
}

/** 参考資料に分類された入力を、発生日時の新しい順に返す。訂正がある入力は、最後に整理できた訂正の本文と分類を使う。 */
export function referenceEntries(config: HubConfig, units: EffectiveInput[]): ReferenceEntry[] {
  const settings = secretSettings(config), entries: ReferenceEntry[] = [];
  for (const unit of units) {
    const { chain, receipt } = unit;
    if (!receipt?.result || receipt.result.category !== 'reference') continue;
    const evidence = [chain.root, ...chain.revisions], source = evidence.find(i => i.id === receipt.input_id) ?? chain.root;
    const { urls, skipped } = extractUrls(redactText(source.text, settings).text);
    entries.push({
      input: chain.root, summary: receipt.result.summary, urls, skippedUrls: skipped, owned: false,
      corrected: chain.revisions.length > 0, pendingCorrection: unit.pendingCorrection, projects: associatedProjects(chain.root, receipt, config),
    });
  }
  return entries.sort((a, b) => Date.parse(b.input.occurred_at) - Date.parse(a.input.occurred_at) || b.input.id.localeCompare(a.input.id));
}

function entryLines(entry: ReferenceEntry, day: string, link: string, seen: Set<string>): string[] {
  const flags = [entry.corrected ? (entry.pendingCorrection ? '訂正未反映' : '訂正あり') : '', entry.owned ? '' : '関連候補（AI推定）'].filter(Boolean);
  const lines = [`- ${day} ${clip(entry.summary) || '（要約なし）'} — [${entry.input.id}](${link})${flags.length ? ` / ${flags.join(' / ')}` : ''}`];
  // 同じURLは新しい資料にだけ載せる。
  const fresh = entry.urls.filter(u => !seen.has(u)), repeated = entry.urls.length - fresh.length;
  // 上限を超えて載せなかったURLは、古い資料に同じURLがあればそちらに載せる。
  for (const url of fresh.slice(0, REFERENCE_URLS_PER_INPUT)) { seen.add(url); lines.push(`  - <${url}>`); }
  const notes = [
    fresh.length > REFERENCE_URLS_PER_INPUT ? `ほかURL ${fresh.length - REFERENCE_URLS_PER_INPUT}件` : '',
    repeated ? `新しい資料と同じURL ${repeated}件` : '',
    entry.skippedUrls ? `載せていないURL ${entry.skippedUrls}件（長すぎる、または秘密情報らしい文字列を含む）` : '',
  ].filter(Boolean);
  if (notes.length) lines.push(`  - ${notes.join(' / ')}（原文で確認）`);
  return lines;
}

/** 資料棚の本文。日時は設定のタイムゾーンで表示し、生成時点に依存する表現は使わない。 */
export function buildReferencesText(config: HubConfig, project: Project, all: ReferenceEntry[], mergedInto?: Project): string {
  const tz = config.timezone, id = project.id;
  const mine = all.filter(e => e.projects.includes(id)).map(e => ({ ...e, owned: e.input.project === id }));
  const shown = mine.slice(0, REFERENCES_PER_PROJECT), seen = new Set<string>();
  const month = (iso: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date(iso)).slice(0, 7);
  const day = (iso: string) => dateLabel(iso, tz).slice(0, 10);
  const lines = [
    `# ${plain(project.title)}の資料`, '',
    `資料 ${mine.length}件 / URL ${new Set(mine.flatMap(e => e.urls)).size}件`, '',
    '整理でAIが「参考資料」に分類したメモを、新しい順に並べた一覧です。分類と要約はAI生成・未検証です。URLは本文に書かれた文字列をそのまま載せており、取得・確認はしていません。開く前にリンク先を確かめてください。今の状態は[NOW](NOW.md)を参照してください。', '',
  ];
  if (mergedInto) lines.push(`このプロジェクトは${plain(mergedInto.title)}（${mergedInto.id}）に統合済みです。資料は統合先の[REFERENCES.md](../${mergedInto.id}/REFERENCES.md)にまとめています（統合先に資料がなければ、まだ作られていません）。`, '');
  else if (!mine.length) lines.push('まだ資料はありません。URLや「参考」と分かるメモを追加すると、次の整理でここに載ります。', '');
  let current: string | undefined;
  for (const entry of shown) {
    const key = month(entry.input.occurred_at);
    if (key !== current) { if (current !== undefined) lines.push(''); const [y, m] = key.split('-'); lines.push(`## ${y}年${Number(m)}月`); current = key; }
    lines.push(...entryLines(entry, day(entry.input.occurred_at), `../../${entry.input.path}`, seen));
  }
  if (shown.length) lines.push('');
  if (mine.length > shown.length) lines.push(`ほか${mine.length - shown.length}件は載せていません（検索で種類を「資料」に絞り込めます）。`, '');
  return lines.join('\n');
}

/** HOMEに載せる、どのプロジェクトにも結び付いていない資料。なければ空文字。 */
export function unassignedReferenceSection(config: HubConfig, units: EffectiveInput[]): string {
  const loose = referenceEntries(config, units).filter(e => !e.projects.length);
  if (!loose.length) return '';
  const seen = new Set<string>(), rows = loose.slice(0, UNASSIGNED_ROWS).flatMap(e => entryLines({ ...e, owned: true }, dateLabel(e.input.occurred_at, config.timezone).slice(0, 10), e.input.path, seen));
  return `\n\n## プロジェクト未定の資料（${loose.length}件）\nAIが「参考資料」に分類したメモのうち、どのプロジェクトにも結び付いていないものです。プロジェクトに結び付いた資料は、各プロジェクトのREFERENCES.md（資料）に載ります。${loose.length > UNASSIGNED_ROWS ? `新しい${UNASSIGNED_ROWS}件を載せます。` : ''}\n${rows.join('\n')}`;
}

const optionsSchema = z.object({ projectId: z.string().optional() }).strict();
export interface ReferencesWrite { projectId: string; path: string; written: boolean; stopped?: boolean }

/**
 * 資料棚を作り直す。本文が前回と同じなら書き込まず、同期のたびに差分を作らない。
 * 資料が1件もなく、ファイルもまだないプロジェクトには作らない（空のファイルを全プロジェクトへ増やさない）。
 * 手で書き換えたREFERENCES.mdは上書きも退避もせず、更新を止める（HOMEの「失敗と競合」に示す。消すと次のcycleで作り直す）。
 */
export async function rebuildReferencesLocked(config: HubConfig, vault: Vault, options: { projectId?: string } = {}): Promise<ReferencesWrite[]> {
  optionsSchema.parse(options);
  const projects = await readProjects(config), targets = options.projectId ? projects.filter(p => p.id === options.projectId) : projects;
  if (options.projectId && !targets.length) throw new Error('プロジェクトが見つかりません');
  const entries = referenceEntries(config, await readEffectiveInputs(config)), result: ReferencesWrite[] = [], merged = mergeTargets(projects);
  for (const project of targets) {
    const path = referencesPath(project.id), existing = await vault.read(path);
    if (existing !== undefined && !isGeneratedIntact(existing)) { result.push({ projectId: project.id, path, written: false, stopped: true }); continue; }
    if (existing === undefined && !entries.some(e => e.projects.includes(project.id))) { result.push({ projectId: project.id, path, written: false }); continue; }
    const text = buildReferencesText(config, project, entries, projects.find(p => p.id === merged.get(project.id))), sourceHash = `sha256:${hash(text)}`;
    let same = false;
    if (existing !== undefined) try { same = parseMarkdown(existing).meta.source_hash === sourceHash; } catch { same = false; }
    if (same) { result.push({ projectId: project.id, path, written: false }); continue; }
    await vault.write(path, generatedMarkdown({ schema_version: 1, project: project.id, generated_by: { model: 'deterministic-writer', prompt_version: 1 }, generated_at: new Date().toISOString(), source_hash: sourceHash, verified: false }, text));
    result.push({ projectId: project.id, path, written: true });
  }
  return result;
}
/** REFERENCES.mdが手で書き換えられ、更新を止めているか。HOMEとdoctorの表示に使う。 */
export async function referencesStopped(vault: Vault, projectId: string): Promise<boolean> {
  const raw = await vault.read(referencesPath(projectId));
  return raw !== undefined && !isGeneratedIntact(raw);
}
export async function rebuildReferences(config: HubConfig, options: { projectId?: string } = {}): Promise<ReferencesWrite[]> {
  const vault = new Vault(config);
  return vault.withLock(() => rebuildReferencesLocked(config, vault, options));
}
/** テスト・CLI向け: 書き込まずに本文だけを組み立てる。 */
export async function buildReferences(config: HubConfig, projectId: string): Promise<string> {
  const projects = await readProjects(config), project = projects.find(p => p.id === projectId);
  if (!project) throw new Error('プロジェクトが見つかりません');
  return buildReferencesText(config, project, referenceEntries(config, await readEffectiveInputs(config)), projects.find(p => p.id === mergeTargets(projects).get(projectId)));
}
