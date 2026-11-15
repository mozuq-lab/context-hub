import { z } from 'zod';
import { ulid } from 'ulid';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Vault, VAULT_DIRS, hash } from './storage.js';
import { parseInput, readInputs } from './capture.js';
import { readProjects } from './projects.js';
import { readReceipts, dateLabel } from './views.js';
import { readEffectiveInputs } from './effective-inputs.js';
import { doctor } from './doctor.js';
import type { HubConfig, Input } from './types.js';

/**
 * バックアップのアーカイブから本当に復元できるかを確かめる。
 * アーカイブをVaultの外の一時フォルダーへ展開し、構造・原文・処理記録を読めること、原文が現在のVaultと一致することを確かめて、
 * 結果だけをVaultへ記録する（HOMEとアプリが「最後に確かめた復元点」を示す）。元のVaultは読むだけで、書き換えない。
 * 個人の絶対パスは記録に残さず、アーカイブのファイル名だけを書く。
 */
export const backupCheckIdSchema = z.string().regex(/^BKC-[0-9A-HJKMNP-TV-Z]{26}$/);
const counts = z.object({ files: z.number().int().min(0), inputs: z.number().int().min(0), projects: z.number().int().min(0), receipts: z.number().int().min(0) }).strict();
export const backupCheckSchema = z.object({
  schema_version: z.literal(1), id: backupCheckIdSchema, archive: z.string().min(1).max(200).regex(/^[^/\\\p{Cc}]+$/u),
  archive_created_at: z.string().datetime({ offset: true }), archive_bytes: z.number().int().min(0), checked_at: z.string().datetime({ offset: true }),
  status: z.enum(['ok', 'failed']),
  // 展開できた範囲の件数。展開の前に失敗した場合はnull。
  restored: counts.nullable(), live: z.object({ inputs: z.number().int().min(0), projects: z.number().int().min(0) }).strict(),
  // 確認したときの設定（backup.verifyMaxAgeDays）。設定を読めないアプリが、同じ目安で復元点の古さを知らせるために残す。
  verify_max_age_days: z.number().int().min(1).max(3650),
  // 復元できないと判断した理由。値・本文は含めない。
  issues: z.array(z.string().max(300)).max(50),
  // 判断には使わない参考（復元先でのdoctorの指摘、読み飛ばした付加メタデータなど）。
  notes: z.array(z.string().max(300)).max(50),
}).strict().refine(r => r.status === 'ok' ? r.issues.length === 0 : r.issues.length > 0);
export type BackupCheck = z.infer<typeof backupCheckSchema>;
const checkDir = '90_system/backup-checks';
export const backupCheckPath = (id: string) => `${checkDir}/${id}.json`;
/** 残す確認結果の件数。古いものから消す。 */
const KEEP_CHECKS = 30;
/** scripts/vault-backup.sh が作るアーカイブの名前。 */
const archiveName = /^vault-\d{8}-\d{6}\.tar\.gz$/;
const LIST_MAX = 50, TEXT_MAX = 300;
const clipText = (text: string) => { const a = Array.from(text.replace(/[\r\n]+/g, ' ')); return a.length > TEXT_MAX ? a.slice(0, TEXT_MAX - 1).join('') + '…' : a.join(''); };

export interface BackupSettings { dir: string | null; verifyMaxAgeDays: number }
export function backupSettings(config: HubConfig): BackupSettings { return config.backup ?? { dir: null, verifyMaxAgeDays: 7 }; }

export async function readBackupChecks(vault: Vault): Promise<{ records: BackupCheck[]; problems: string[] }> {
  const records: BackupCheck[] = [], problems: string[] = [];
  for (const path of await vault.files(checkDir)) {
    if (!path.endsWith('.json')) continue;
    try { const record = backupCheckSchema.parse(JSON.parse((await vault.read(path))!)); if (path !== backupCheckPath(record.id)) throw new Error(); records.push(record); }
    catch { problems.push(path); }
  }
  return { records: records.sort((a, b) => a.id.localeCompare(b.id)), problems };
}

export interface BackupStatus {
  /** 最後の確認。 */ latest?: BackupCheck; /** 最後に復元できた確認（確かめた復元点）。 */ restorePoint?: BackupCheck;
  /** 復元点が何日前のバックアップか。 */ restorePointAgeDays?: number;
  /** 本人に知らせる注意。バックアップ先を設定していない間は、確認結果がある場合だけ示す。 */ warnings: string[];
}
const DAY = 86_400_000;
export function backupStatus(config: HubConfig, records: BackupCheck[], now: Date = new Date()): BackupStatus {
  const settings = backupSettings(config), latest = records.at(-1), restorePoint = records.filter(r => r.status === 'ok').at(-1), warnings: string[] = [];
  const age = restorePoint ? Math.max(0, Math.floor((now.getTime() - Date.parse(restorePoint.archive_created_at)) / DAY)) : undefined;
  if (latest?.status === 'failed') warnings.push(`最後の確認でバックアップ（${latest.archive}）から復元できませんでした（${latest.issues.length}件の問題）。\`ctx backup status\`で内容を確かめ、バックアップを取り直してください`);
  if (settings.dir !== null || records.length) {
    if (!restorePoint) { if (latest?.status !== 'failed') warnings.push('復元できると確かめたバックアップがまだありません。`ctx backup verify`を実行してください'); }
    else if (age! > settings.verifyMaxAgeDays) warnings.push(`確かめた復元点が${age}日前のバックアップです（目安は${settings.verifyMaxAgeDays}日以内）。バックアップが続いているかを確認し、\`ctx backup verify\`を実行してください`);
  }
  return { ...(latest ? { latest } : {}), ...(restorePoint ? { restorePoint, restorePointAgeDays: age! } : {}), warnings };
}
/** HOMEの先頭に載せる1行。確認結果がなければ空。 */
export function backupHomeLine(config: HubConfig, status: BackupStatus, now: Date = new Date()): string {
  const point = status.restorePoint;
  if (!point) return '';
  const checkedDays = Math.max(0, Math.floor((now.getTime() - Date.parse(point.checked_at)) / DAY));
  return `\n最後に確かめた復元点: ${dateLabel(point.archive_created_at, config.timezone)}のバックアップ（${status.restorePointAgeDays}日前 / ${checkedDays === 0 ? '今日' : `${checkedDays}日前に`}復元できることを確認）`;
}

/** tarの1エントリー。展開するのは通常ファイルとディレクトリだけ。 */
interface TarHeader { path: string; size: number; type: string }
/** アーカイブとして読めない（途中で切れている・形式が違う）。 */
export class BackupArchiveError extends Error {}
function parseOctal(field: Buffer): number {
  // GNU形式の大きな数は先頭ビットを立てた2進数で入る。
  if (field[0]! & 0x80) { let n = 0; for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!; return n; }
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new BackupArchiveError('アーカイブの見出しを読めません');
  return Number.parseInt(text, 8);
}
const cstring = (field: Buffer) => { const end = field.indexOf(0); return field.subarray(0, end < 0 ? field.length : end).toString('utf8'); };
function parseHeader(block: Buffer): TarHeader {
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  if (sum !== parseOctal(block.subarray(148, 156))) throw new BackupArchiveError('アーカイブの見出しの検査値が一致しません');
  const prefix = block.subarray(257, 262).toString('latin1') === 'ustar' ? cstring(block.subarray(345, 500)) : '';
  const name = cstring(block.subarray(0, 100));
  return { path: prefix ? `${prefix}/${name}` : name, size: parseOctal(block.subarray(124, 136)), type: String.fromCharCode(block[156] || 48) };
}
function paxRecords(data: Buffer): Map<string, string> {
  const result = new Map<string, string>(); let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset); if (space < 0) break;
    const length = Number(data.subarray(offset, space).toString('latin1'));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.length) throw new BackupArchiveError('アーカイブの拡張見出しを読めません');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8'), eq = record.indexOf('=');
    if (eq > 0) result.set(record.slice(0, eq), record.slice(eq + 1));
    offset += length;
  }
  return result;
}
export interface ExtractOutcome { files: number; bytes: number; /** 展開しなかった危険なエントリー（絶対パス・親へ抜けるパス・リンク・特殊ファイル）。 */ rejected: string[]; /** macOSの付加メタデータ（._で始まるファイル）。原文と混同しないよう展開しない。 */ appleDouble: number }
export interface ExtractLimits { maxFiles: number; maxBytes: number }
/** 圧縮を解いた後の上限。バックアップ先の取り違えや壊れたアーカイブで一時フォルダーを埋めないための安全弁。 */
const defaultLimits: ExtractLimits = { maxFiles: 2_000_000, maxBytes: 64 * 1024 ** 3 };
const SPECIAL_MAX = 8 * 1024 * 1024;
/**
 * tar.gzを指定の空フォルダーへ展開する。外部のtarコマンドは使わず、通常ファイルとディレクトリだけを、
 * 展開先の中に収まるパスへ書く。リンク・特殊ファイル・展開先の外を指すパスは書かずに報告する。
 */
export async function extractArchive(archive: string, dest: string, limits: ExtractLimits = defaultLimits): Promise<ExtractOutcome> {
  const outcome: ExtractOutcome = { files: 0, bytes: 0, rejected: [], appleDouble: 0 };
  const reject = (path: string, why: string) => { if (outcome.rejected.length < LIST_MAX) outcome.rejected.push(clipText(`${why}: ${path}`)); else if (outcome.rejected.length === LIST_MAX) outcome.rejected.push('ほかにも展開しなかったエントリーがあります'); };
  const made = new Set<string>([dest]);
  const ensureDir = async (dir: string) => { if (made.has(dir)) return; await ensureDir(dirname(dir)); await mkdir(dir, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); made.add(dir); };
  /** 展開先の中のパスへ直す。収まらないものはundefined。 */
  const target = (path: string): string | undefined => {
    if (!path || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) return undefined;
    const parts = path.split('/').filter(p => p && p !== '.');
    if (parts.some(p => p === '..')) return undefined;
    return parts.length ? join(dest, ...parts) : dest;
  };
  let pending: Buffer = Buffer.alloc(0), zeroBlocks = 0, ended = false, entries = 0;
  // 読みかけのエントリー。remainingは本文の残り、paddingは512バイト境界までの詰め物。
  let current: { remaining: number; padding: number; handle?: Awaited<ReturnType<typeof open>>; collect?: Buffer[]; kind: 'file' | 'skip' | 'pax' | 'longname' } | undefined;
  let nextPath: string | undefined, nextSize: number | undefined;
  const finish = async () => {
    const entry = current!; current = undefined;
    if (entry.handle) await entry.handle.close();
    if (entry.kind === 'pax') { const records = paxRecords(Buffer.concat(entry.collect!)); if (records.has('path')) nextPath = records.get('path'); if (records.has('size')) { const size = Number(records.get('size')); if (!Number.isSafeInteger(size) || size < 0) throw new BackupArchiveError('アーカイブの拡張見出しを読めません'); nextSize = size; } }
    if (entry.kind === 'longname') nextPath = cstring(Buffer.concat(entry.collect!));
  };
  try {
    // 読み込み側の失敗も解凍側へ伝え、反復を止める。
    const gunzip = createGunzip(); pipeline(createReadStream(archive), gunzip, () => undefined);
    for await (const chunk of gunzip) {
      pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
      for (;;) {
        if (ended) { pending = Buffer.alloc(0); break; }
        if (current) {
          if (current.remaining > 0) {
            if (!pending.length) break;
            const part = pending.subarray(0, Math.min(current.remaining, pending.length));
            if (current.handle) { await current.handle.write(part); outcome.bytes += part.length; if (outcome.bytes > limits.maxBytes) throw new BackupArchiveError('展開後の大きさが上限を超えました'); }
            else if (current.collect) current.collect.push(Buffer.from(part));
            current.remaining -= part.length; pending = pending.subarray(part.length);
            if (current.remaining > 0) break;
          }
          if (pending.length < current.padding) break;
          pending = pending.subarray(current.padding);
          await finish();
          continue;
        }
        if (pending.length < 512) break;
        const block = pending.subarray(0, 512); pending = pending.subarray(512);
        if (block.every(b => b === 0)) { if (++zeroBlocks >= 2) ended = true; continue; }
        zeroBlocks = 0;
        const header = parseHeader(block), size = nextSize ?? header.size, padding = (512 - (size % 512)) % 512;
        if (!Number.isSafeInteger(size) || size < 0) throw new BackupArchiveError('アーカイブの見出しを読めません');
        // 拡張見出しは次のエントリーの名前・大きさを上書きする。全体への拡張見出しは使わない。
        if (header.type === 'x' || header.type === 'g' || header.type === 'L' || header.type === 'K') {
          if (size > SPECIAL_MAX) throw new BackupArchiveError('アーカイブの拡張見出しが大きすぎます');
          current = { remaining: size, padding, collect: [], kind: header.type === 'x' ? 'pax' : header.type === 'L' ? 'longname' : 'skip' };
          if (!size) { if (pending.length < padding) break; await finish(); }
          continue;
        }
        const path = nextPath ?? header.path; nextPath = undefined; nextSize = undefined;
        if (++entries > limits.maxFiles) throw new BackupArchiveError('アーカイブのエントリー数が上限を超えました');
        const where = target(path), name = path.split('/').filter(Boolean).at(-1) ?? '';
        if (header.type === '5') { if (!where) reject(path, '展開先の外を指すパス'); else await ensureDir(where); current = { remaining: size, padding, kind: 'skip' }; }
        else if (header.type === '0' || header.type === '7') {
          if (!where || where === dest) { reject(path, '展開先の外を指すパス'); current = { remaining: size, padding, kind: 'skip' }; }
          else if (name.startsWith('._')) { outcome.appleDouble++; current = { remaining: size, padding, kind: 'skip' }; }
          else {
            await ensureDir(dirname(where));
            // 同じパスが2回入っているアーカイブは、後のエントリーで上書きせずに報告する。
            let handle: Awaited<ReturnType<typeof open>> | undefined;
            try { handle = await open(where, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; reject(path, '同じパスが重複'); }
            if (handle) outcome.files++;
            current = { remaining: size, padding, kind: handle ? 'file' : 'skip', ...(handle ? { handle } : {}) };
          }
        } else { reject(path, header.type === '1' || header.type === '2' ? 'リンク' : '特殊ファイル'); current = { remaining: size, padding, kind: 'skip' }; }
        if (!size && !padding) await finish();
      }
    }
  } catch (error) {
    if (current?.handle) await current.handle.close().catch(() => undefined);
    if (error instanceof BackupArchiveError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    // 圧縮の破損・途中で切れたファイルはzlibのエラーになる。展開先への書き込みの失敗などはそのまま伝える。
    if (typeof code === 'string' && (code.startsWith('Z_') || code === 'ERR_BUFFER_TOO_LARGE')) throw new BackupArchiveError('アーカイブの圧縮を解けません（壊れているか、途中で切れています）');
    throw error;
  }
  if (current || pending.length || !ended) throw new BackupArchiveError('アーカイブが途中で終わっています');
  return outcome;
}

/** バックアップ先から、いちばん新しい所定名のアーカイブを選ぶ。 */
export async function latestArchive(dir: string): Promise<string | undefined> {
  let names: string[];
  try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const name = names.filter(n => archiveName.test(n)).sort().at(-1);
  return name ? join(dir, name) : undefined;
}
async function inside(parent: string, child: string): Promise<boolean> {
  const rel = relative(await realpath(parent), child);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface BackupVerifyOptions { /** 確かめるアーカイブ。省略時は設定のバックアップ先でいちばん新しいもの。 */ archive?: string; /** 展開先の親。省略時はOSの一時フォルダー。 */ workDir?: string; /** 確認後も展開先を残す。 */ keep?: boolean; now?: Date }
export interface BackupVerifyResult { check: BackupCheck; /** keepのときだけ、残した展開先。 */ restoredTo?: string }
/**
 * アーカイブを展開して確かめ、結果を記録する。展開先は確認が終わると消す。
 * 復元できないと判断するのは、アーカイブを最後まで読めない、危険なエントリーがある、Vaultの構造がない、原文・プロジェクト定義・処理記録を読めない、
 * 原文が現在のVaultと違う、バックアップより前に受け取った原文が入っていない、のいずれか。
 */
export async function verifyBackup(config: HubConfig, options: BackupVerifyOptions = {}): Promise<BackupVerifyResult> {
  const settings = backupSettings(config), now = options.now ?? new Date(), vault = new Vault(config);
  const archive = options.archive ? resolve(options.archive) : settings.dir ? await latestArchive(settings.dir) : undefined;
  if (!archive) throw new Error(options.archive || settings.dir ? '確かめるバックアップが見つかりません。バックアップ先とファイル名（vault-日付-時刻.tar.gz）を確認してください' : 'バックアップ先が設定されていません。設定のbackup.dirを指定するか、--archiveでアーカイブを指定してください');
  let info; try { info = await lstat(archive); } catch { throw new Error('確かめるバックアップを読めません'); }
  if (!info.isFile()) throw new Error('確かめるバックアップが通常のファイルではありません');
  const vaultRoot = await realpath(resolve(config.vaultPath));
  const parent = await realpath(resolve(options.workDir ?? tmpdir()));
  if (await inside(vaultRoot, parent)) throw new Error('展開先はVaultの外に指定してください');
  const work = await mkdtemp(join(parent, 'ctx-backup-verify-')), restoredRoot = join(work, 'vault');
  const issues: string[] = [], notes: string[] = [];
  const issue = (text: string) => { if (issues.length < LIST_MAX) issues.push(clipText(text)); };
  const note = (text: string) => { if (notes.length < LIST_MAX) notes.push(clipText(text)); };
  let restored: BackupCheck['restored'] = null;
  const liveInputs = await readInputs(config), liveProjects = await readProjects(config).catch(() => []);
  try {
    await mkdir(restoredRoot, { mode: 0o700 });
    let extracted: ExtractOutcome | undefined;
    try { extracted = await extractArchive(archive, restoredRoot); }
    catch (error) { if (!(error instanceof BackupArchiveError)) throw error; issue(error.message); }
    if (extracted) {
      for (const r of extracted.rejected) issue(`展開しなかったエントリー — ${r}`);
      if (extracted.appleDouble) note(`macOSの付加メタデータ（._で始まるファイル）${extracted.appleDouble}件は展開していません`);
      // 復元先は架空の設定で読む。モデル・Git・バックアップ先は使わず、状態とログは一時フォルダーに置く。
      const state = join(work, 'state');
      const copy: HubConfig = { ...config, vaultPath: restoredRoot, statePath: state, logging: { ...config.logging, dir: join(state, 'logs') }, organize: { ...config.organize, llm: { ...config.organize.llm, provider: 'mock', model: null } }, git: { ...config.git, enabled: false, repos: [] }, backup: { dir: null, verifyMaxAgeDays: settings.verifyMaxAgeDays } };
      const copyVault = new Vault(copy);
      for (const dir of VAULT_DIRS) { try { if (!(await lstat(join(restoredRoot, dir))).isDirectory()) issue(`Vaultの構造が不正です: ${dir}`); } catch { issue(`Vaultの構造がありません: ${dir}`); } }
      const inputs: Input[] = []; let badInputs = 0;
      try { for (const path of await copyVault.files('00_inbox')) { if (!path.endsWith('.md')) continue; try { inputs.push(parseInput(path, (await copyVault.read(path))!)); } catch { badInputs++; } } }
      catch { issue('原文のフォルダーを読めません'); }
      if (badInputs) issue(`読めない原文が${badInputs}件あります`);
      let projects = 0, receipts = 0;
      try { projects = (await readProjects(copy)).length; } catch { issue('プロジェクト定義を読めません'); }
      try { receipts = (await readReceipts(copy)).length; } catch { issue('処理記録を読めません'); }
      try { await readEffectiveInputs(copy); } catch { issue('訂正履歴・処理記録と原文の対応を確かめられません'); }
      restored = { files: extracted.files, inputs: inputs.length, projects, receipts };
      // 原文は不変なので、バックアップの原文は現在のVaultに同じ内容で残っているはず。
      let changed = 0, missing = 0;
      for (const input of inputs) {
        const live = await vault.read(input.path).catch(() => undefined), copyRaw = await copyVault.read(input.path);
        if (live === undefined) missing++; else if (copyRaw === undefined || hash(live) !== hash(copyRaw)) changed++;
      }
      if (changed) issue(`バックアップと現在のVaultで内容が違う原文が${changed}件あります`);
      if (missing) issue(`バックアップにあって現在のVaultにない原文が${missing}件あります`);
      // バックアップを作るより前（余裕を10分みる）に受け取った原文は、バックアップに入っているはず。
      const have = new Set(inputs.map(i => i.id)), before = info.mtimeMs - 10 * 60_000;
      const absent = liveInputs.filter(i => Date.parse(i.received_at) < before && !have.has(i.id)).length;
      if (absent) issue(`バックアップより前に受け取った原文が${absent}件入っていません`);
      if (!inputs.length && liveInputs.length) issue('バックアップに原文が1件も入っていません');
      // 復元先でのdoctorは参考として残す。現在のVaultにも同じ指摘があれば、バックアップの問題ではない。
      try { const result = await doctor(copy); if (result.issues.length) { note(`復元先でのdoctorの指摘: ${result.issues.length}件（現在のVaultにも同じ指摘があれば、バックアップの問題ではありません）`); for (const text of result.issues.slice(0, 10)) note(`doctor: ${text}`); } }
      catch { note('復元先でdoctorを実行できませんでした'); }
    }
  } finally { if (!options.keep) await rm(work, { recursive: true, force: true }); }
  const check: BackupCheck = backupCheckSchema.parse({
    schema_version: 1, id: `BKC-${ulid()}`, archive: basename(archive), archive_created_at: new Date(info.mtimeMs).toISOString(), archive_bytes: info.size, checked_at: now.toISOString(),
    status: issues.length ? 'failed' : 'ok', restored, live: { inputs: liveInputs.length, projects: liveProjects.length }, verify_max_age_days: backupSettings(config).verifyMaxAgeDays, issues, notes,
  });
  await vault.withLock(async () => {
    if (!await vault.create(backupCheckPath(check.id), JSON.stringify(check, null, 2) + '\n')) throw new Error('確認結果の記録が競合しました');
    const { records } = await readBackupChecks(vault);
    // 最後に復元できた確認は、古くても残す（確かめた復元点として示すため）。
    const lastOk = records.filter(r => r.status === 'ok').at(-1)?.id;
    for (const old of records.slice(0, Math.max(0, records.length - KEEP_CHECKS))) if (old.id !== lastOk) await vault.remove(backupCheckPath(old.id));
  });
  return { check, ...(options.keep ? { restoredTo: restoredRoot } : {}) };
}
