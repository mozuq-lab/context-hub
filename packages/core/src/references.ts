import { clipText, listText } from './markdown-text.js';
import { z } from 'zod';
import { Vault, hash, parseMarkdown } from './storage.js';
import { mergeTargets, readProjects } from './projects.js';
import { associatedProjects, dateLabel, generatedMarkdown, isGeneratedIntact, readReceipts } from './views.js';
import { readEffectiveInputs, type EffectiveInput } from './effective-inputs.js';
import { redactText, secretSettings } from './secrets.js';
import { effectiveReferenceMarks, onReferenceShelf, readReferenceMarks, type ReferenceMark } from './reference-marks.js';
import type { HubConfig, Input, Project } from './types.js';

/**
 * プロジェクトの資料棚（10_projects/<id>/REFERENCES.md）。本人が資料にしたメモと、整理でAIが「参考資料（reference）」に分類したメモを、
 * モデルを使わずに新しい順へ並べる。本人が資料棚から外したメモは載せない（reference-marks.ts）。
 * URLは本文から文字列として取り出すだけで、取得・要約はしない。
 * NOWは「今」、経緯は流れを示すため、あとで読み返す記事・仕様・リポジトリなどを探す場所として使う。
 * アプリが資料ごとに名前を変える・外す・戻すための一覧は、90_system/references.jsonに書く。
 */
// AIの要約と名前は1行の文字として載せる。リンク・HTML・コメントとして解釈される文字は無害にする。
const plain = listText;
const clip = (s: string, n = 160) => clipText(s, n);
export const referencesPath = (projectId: string) => `10_projects/${projectId}/REFERENCES.md`;
/** アプリが読む資料の一覧（資料棚に載る資料と、本人が外した資料）。 */
export const referenceIndexPath = '90_system/references.json';
/** 一覧に載せる、本人が外した資料の上限（外した日時の新しい順）。 */
export const REMOVED_REFERENCES_MAX = 100;
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
  /** 資料棚に示す文。本人が付けた名前、なければAIの一行要約（未検証）、AIがまだ読み取っていなければ本文の1行目。 */ summary: string;
  /** 本人が付けた資料の名前。 */ title: string | null;
  /** AIの一行要約（未検証）。AIがまだ読み取っていなければnull。 */ aiSummary: string | null;
  /** 本人が資料棚に加えた（true）か、AIの分類で載った（false）か。 */ addedByPerson: boolean;
  /** AIがまだ読み取っていない（整理待ち）。本人が資料にしたメモだけがこの状態で載る。 */ unorganized: boolean;
  /** AIの読み取り（整理）に失敗している。本人が資料にしたメモだけがこの状態で載る。 */ failed: boolean;
  urls: string[];
  /** 載せなかったURL（長すぎる・伏せ字を含む）の数。 */ skippedUrls: number;
  /** メモに添えたファイル（Vault内の場所・名前・大きさ）。なければnull。 */ file: ReferenceFile | null;
  /** 本人がそのプロジェクトを指定した（true）か、AIが推定した関連か（false）。プロジェクト未定の資料ではfalse。 */ owned: boolean;
  corrected: boolean; pendingCorrection: boolean;
  projects: string[];
}

export interface ReferenceFile { path: string; name: string; bytes: number }
const fileOf = (input: Input): ReferenceFile | null => input.attachment ? { path: input.attachment.path, name: input.attachment.name, bytes: input.attachment.bytes } : null;
/** ファイルの大きさの表示（KB・MB）。 */
export function fileSizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
/** Markdownのリンク先を壊す文字（空白・括弧・#など）だけを符号化する。和文はそのまま残し、Obsidianでも開ける形にする。 */
const linkTarget = (path: string) => path.replace(/[%\s()[\]#^]/gu, c => c.charCodeAt(0) < 0x80 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}` : encodeURIComponent(c));
/** 本文の最初の空でない行（伏せ字にした後）。AIがまだ読み取っていない資料の表示に使う。 */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * 資料棚に載る入力を、発生日時の新しい順に返す。訂正がある入力は、最後に整理できた訂正の本文と分類を使う。
 * marksは本人の記録（メモごとに最後の判断）。本人が加えたメモは、AIがまだ読み取っていなくても載せる（本文は最新の訂正）。
 * failedは整理に失敗した入力のID。読み取り待ちと失敗を分けて示す。
 */
export function referenceEntries(config: HubConfig, units: EffectiveInput[], marks: ReadonlyMap<string, ReferenceMark> = new Map(), failedIds: ReadonlySet<string> = new Set()): ReferenceEntry[] {
  const settings = secretSettings(config), entries: ReferenceEntry[] = [];
  for (const unit of units) {
    const { chain, receipt } = unit, mark = marks.get(chain.root.id), result = receipt?.result ?? undefined;
    if (chain.root.kind !== 'memo' && chain.root.kind !== 'work-summary') continue;
    if (!onReferenceShelf(result?.category, mark)) continue;
    const evidence = [chain.root, ...chain.revisions], source = receipt && result ? evidence.find(i => i.id === receipt.input_id) ?? chain.root : chain.latest;
    const text = redactText(source.text, settings).text, { urls, skipped } = extractUrls(text);
    // AIの要約は、要約より後に足した秘密情報の検出でも伏せ字にして示す。
    const title = mark?.action === 'add' ? mark.title : null, aiSummary = result ? redactText(result.summary, settings).text : null;
    const failed = !result && failedIds.has(chain.latest.id);
    entries.push({
      input: chain.root, summary: title ?? aiSummary ?? firstLine(text), title, aiSummary, addedByPerson: mark?.action === 'add', unorganized: !result && !failed, failed,
      urls, skippedUrls: skipped, file: fileOf(chain.root), owned: false, corrected: chain.revisions.length > 0, pendingCorrection: unit.pendingCorrection,
      // AIがまだ読み取っていない資料は、本人が指定したプロジェクトにだけ載せる。
      projects: receipt && result ? associatedProjects(chain.root, receipt, config) : chain.root.project ? [chain.root.project] : [],
    });
  }
  return entries.sort((a, b) => Date.parse(b.input.occurred_at) - Date.parse(a.input.occurred_at) || b.input.id.localeCompare(a.input.id));
}

/** baseは、一覧のファイルからVaultの直下へのパス（プロジェクトの資料棚なら../../、HOMEなら空）。 */
function entryLines(entry: ReferenceEntry, day: string, base: string, seen: Set<string>): string[] {
  const link = `${base}${entry.input.path}`;
  const flags = [entry.addedByPerson ? '本人が追加' : '', entry.unorganized ? 'AIの読み取り待ち' : '', entry.failed ? 'AIの読み取りに失敗' : '', entry.corrected ? (entry.pendingCorrection ? '訂正未反映' : '訂正あり') : '', entry.owned ? '' : '関連候補（AI推定）'].filter(Boolean);
  const lines = [`- ${day} ${clip(entry.summary) || '（要約なし）'} — [${entry.input.id}](${link})${flags.length ? ` / ${flags.join(' / ')}` : ''}`];
  if (entry.file) lines.push(`  - ファイル: [${plain(entry.file.name)}](${linkTarget(base + entry.file.path)})（${fileSizeLabel(entry.file.bytes)}）`);
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
    `資料 ${mine.length}件 / URL ${new Set(mine.flatMap(e => e.urls)).size}件${mine.some(e => e.file) ? ` / ファイル ${mine.filter(e => e.file).length}件` : ''}`, '',
    '本人が資料にしたメモと、整理でAIが「参考資料」に分類したメモを、新しい順に並べた一覧です。名前は本人が付けたもの、それ以外の要約と分類はAI生成・未検証です。URLは本文に書かれた文字列をそのまま載せており、取得・確認はしていません。開く前にリンク先を確かめてください。資料を加える・外す・名前を変えるのはアプリか`ctx reference`で行います。今の状態は[NOW](NOW.md)を参照してください。', '',
  ];
  if (mergedInto) lines.push(`このプロジェクトは${plain(mergedInto.title)}（${mergedInto.id}）に統合済みです。資料は統合先の[REFERENCES.md](../${mergedInto.id}/REFERENCES.md)にまとめています（統合先に資料がなければ、まだ作られていません）。`, '');
  else if (!mine.length) lines.push('まだ資料はありません。メモを「資料として保存」するか、URLや「参考」と分かるメモを追加すると、ここに載ります。', '');
  let current: string | undefined;
  for (const entry of shown) {
    const key = month(entry.input.occurred_at);
    if (key !== current) { if (current !== undefined) lines.push(''); const [y, m] = key.split('-'); lines.push(`## ${y}年${Number(m)}月`); current = key; }
    lines.push(...entryLines(entry, day(entry.input.occurred_at), '../../', seen));
  }
  if (shown.length) lines.push('');
  if (mine.length > shown.length) lines.push(`ほか${mine.length - shown.length}件は載せていません（検索で種類を「資料」に絞り込めます）。`, '');
  return lines.join('\n');
}

/** HOMEに載せる、どのプロジェクトにも結び付いていない資料。なければ空文字。 */
export function unassignedReferenceSection(config: HubConfig, units: EffectiveInput[], marks: ReadonlyMap<string, ReferenceMark> = new Map(), failedIds: ReadonlySet<string> = new Set()): string {
  const loose = referenceEntries(config, units, marks, failedIds).filter(e => !e.projects.length);
  if (!loose.length) return '';
  const seen = new Set<string>(), rows = loose.slice(0, UNASSIGNED_ROWS).flatMap(e => entryLines({ ...e, owned: true }, dateLabel(e.input.occurred_at, config.timezone).slice(0, 10), '', seen));
  return `\n\n## プロジェクト未定の資料（${loose.length}件）\n本人が資料にしたメモと、AIが「参考資料」に分類したメモのうち、どのプロジェクトにも結び付いていないものです。プロジェクトに結び付いた資料は、各プロジェクトのREFERENCES.md（資料）に載ります。${loose.length > UNASSIGNED_ROWS ? `新しい${UNASSIGNED_ROWS}件を載せます。` : ''}\n${rows.join('\n')}`;
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
  const units = await readEffectiveInputs(config), records = (await readReferenceMarks(vault)).records, marks = effectiveReferenceMarks(records);
  const entries = referenceEntries(config, units, marks, await failedInputIds(config)), result: ReferencesWrite[] = [], merged = mergeTargets(projects);
  await writeReferenceIndexLocked(vault, buildReferenceIndex(config, units, entries, records, marks));
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
/** 整理に失敗した入力のID（処理記録の状態がfailed）。 */
export async function failedInputIds(config: HubConfig): Promise<Set<string>> {
  return new Set((await readReceipts(config)).filter(r => r.status === 'failed').map(r => r.input_id));
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
  const marks = effectiveReferenceMarks((await readReferenceMarks(new Vault(config))).records);
  return buildReferencesText(config, project, referenceEntries(config, await readEffectiveInputs(config), marks, await failedInputIds(config)), projects.find(p => p.id === mergeTargets(projects).get(projectId)));
}

const indexFileSchema = z.object({ path: z.string(), name: z.string(), bytes: z.number().int().min(0) }).strict();
const indexEntrySchema = z.object({
  input_id: z.string(), label: z.string(), title: z.string().nullable(), ai_summary: z.string().nullable(),
  added_by: z.enum(['person', 'ai']), mark_id: z.string().nullable(), unorganized: z.boolean(), failed: z.boolean(), urls: z.array(z.string()), skipped_urls: z.number().int().min(0), file: indexFileSchema.nullable(),
  projects: z.array(z.string()), project: z.string().nullable(), corrected: z.boolean(), pending_correction: z.boolean(), occurred_at: z.string(),
}).strict();
const removedEntrySchema = z.object({
  input_id: z.string(), label: z.string(), title: z.string().nullable(), mark_id: z.string(), file: indexFileSchema.nullable(), projects: z.array(z.string()), project: z.string().nullable(), removed_at: z.string(), occurred_at: z.string(),
}).strict();
export const referenceIndexSchema = z.object({
  schema_version: z.literal(1), generated_at: z.string().datetime({ offset: true }),
  /** 一覧に反映した資料の記録のうち、最も新しい作成日時（記録がなければnull）。 */ marks_through: z.string().datetime({ offset: true }).nullable(),
  entries: z.array(indexEntrySchema), removed: z.array(removedEntrySchema),
}).strict();
export type ReferenceIndex = z.infer<typeof referenceIndexSchema>;

/**
 * アプリが読む資料の一覧。entriesは資料棚に載る資料（新しい順、件数は打ち切らない）、removedは本人が外した資料（外した日時の新しい順）。
 * removedのtitleは外す前に本人が付けていた名前で、戻すときに同じ名前を送れるようにする。
 * projectは本人が指定したプロジェクト、projectsは資料が載るプロジェクト（AIの関連候補を含む）。
 * fileは、メモに添えたファイル（Vault内の場所・名前・大きさ。なければnull）。アプリは資料棚から開く。
 * mark_idは、いま効いている本人の記録（AIの分類だけで載った資料ではnull）。依頼がより新しい判断に覆されたかを、アプリが確かめられる。
 * marks_throughは反映した記録の最新の作成日時。後から届いた古い判断のように資料棚が変わらない記録でも一覧を書き直し、
 * アプリが「記録の作成より後に一覧を書いた」ことで依頼の反映を確かめられるようにする。
 */
export function buildReferenceIndex(config: HubConfig, units: EffectiveInput[], entries: ReferenceEntry[], records: ReferenceMark[], marks: ReadonlyMap<string, ReferenceMark>, now = new Date()): ReferenceIndex {
  const settings = secretSettings(config), byId = new Map(units.map(u => [u.chain.root.id, u]));
  const removed: ReferenceIndex['removed'] = [];
  for (const mark of marks.values()) {
    const unit = byId.get(mark.input_id);
    if (mark.action !== 'remove' || !unit || (unit.chain.root.kind !== 'memo' && unit.chain.root.kind !== 'work-summary')) continue;
    // 外す前に付けていた名前（外した記録より前の、最後の加える記録）。
    const before = records.filter(r => r.input_id === mark.input_id && r.action === 'add' && (Date.parse(r.decided_at) < Date.parse(mark.decided_at) || (r.decided_at === mark.decided_at && r.id < mark.id)))
      .sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at) || a.id.localeCompare(b.id)).at(-1);
    const result = unit.receipt?.result ?? undefined, title = before?.title ?? null;
    removed.push({
      input_id: mark.input_id, label: title ?? (result ? redactText(result.summary, settings).text : firstLine(redactText(unit.chain.latest.text, settings).text)), title, mark_id: mark.id, file: fileOf(unit.chain.root),
      projects: unit.receipt && result ? associatedProjects(unit.chain.root, unit.receipt, config) : unit.chain.root.project ? [unit.chain.root.project] : [],
      project: unit.chain.root.project ?? null, removed_at: mark.decided_at, occurred_at: unit.chain.root.occurred_at,
    });
  }
  removed.sort((a, b) => Date.parse(b.removed_at) - Date.parse(a.removed_at) || b.input_id.localeCompare(a.input_id));
  return {
    schema_version: 1, generated_at: now.toISOString(),
    marks_through: records.reduce<string | null>((latest, r) => latest === null || Date.parse(r.created_at) > Date.parse(latest) ? r.created_at : latest, null),
    entries: entries.map(e => ({
      input_id: e.input.id, label: e.summary, title: e.title, ai_summary: e.aiSummary, added_by: e.addedByPerson ? 'person' : 'ai', mark_id: marks.get(e.input.id)?.id ?? null,
      unorganized: e.unorganized, failed: e.failed,
      // 資料のページと同じく、1件に載せるURLは上限まで（残りは載せていない数に含め、原文で確かめる）。
      urls: e.urls.slice(0, REFERENCE_URLS_PER_INPUT), skipped_urls: e.skippedUrls + Math.max(0, e.urls.length - REFERENCE_URLS_PER_INPUT), file: e.file, projects: e.projects, project: e.input.project ?? null, corrected: e.corrected, pending_correction: e.pendingCorrection, occurred_at: e.input.occurred_at,
    })),
    removed: removed.slice(0, REMOVED_REFERENCES_MAX),
  };
}
/** 資料の一覧を読む。まだ作っていない・読めないときはundefined。 */
export async function readReferenceIndex(vault: Vault): Promise<ReferenceIndex | undefined> {
  const raw = await vault.read(referenceIndexPath);
  if (raw === undefined) return undefined;
  try { return referenceIndexSchema.parse(JSON.parse(raw)); } catch { return undefined; }
}
/** 内容が変わったときだけ書き、同期の無駄な変更を避ける（Writerロック内）。 */
async function writeReferenceIndexLocked(vault: Vault, index: ReferenceIndex): Promise<void> {
  const raw = await vault.read(referenceIndexPath);
  if (raw !== undefined) try { if (JSON.stringify({ ...JSON.parse(raw), generated_at: '' }) === JSON.stringify({ ...index, generated_at: '' })) return; } catch { /* 壊れた一覧は書き直す。 */ }
  // アプリが端末で読むファイルの大きさを抑えるため、整形せずに書く。
  await vault.write(referenceIndexPath, JSON.stringify(index) + '\n');
}
