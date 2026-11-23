import { z } from 'zod';
import { lstat } from 'node:fs/promises';
import { findSecrets, secretSettings } from './secrets.js';
import { hash } from './storage.js';
import type { HubConfig } from './types.js';

/**
 * メモに添えるファイル（PDF・画像など、Markdown以外の資料）。
 * - 本体はファイルをVaultの`05_files/<年-月>/<キー>/<ファイル名>`に複製し、メモのfrontmatterの`attachment`に場所・名前・大きさ・SHA-256を書く。
 *   キーは出典と受付IDから決まり、同じ依頼の再送では同じ場所になる（途中で止まっても、ファイルを二重に置かない）。
 * - ファイルを添えたメモは資料として保存する（資料の記録を一緒に書く）。中身はAIへ渡さず、メモの本文（本人の説明）だけを整理する。
 * - 端末は、ファイルを`Input/files/<受付ID>`に置いてから、`attachment`（名前・大きさ・SHA-256）を付けたcaptureの依頼を書く。
 *   本体はファイルが届いて大きさがそろうまで依頼を保留し、受け付けた（または理由付きで断った）後に`Input/files`の写しを消す。
 */
export const ATTACHMENTS_DIR = '05_files';
/** 端末がファイルを置く場所。依頼と同じ受付IDの名前にする。 */
export const ATTACHMENT_TRANSPORT_DIR = 'Input/files';
export const attachmentTransportPath = (requestId: string) => `${ATTACHMENT_TRANSPORT_DIR}/${requestId}`;
/** 添えられるファイルの大きさの既定の上限（設定のcapture.maxFileBytesで変えられる）と、設定できる上限。 */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_BYTES_LIMIT = 200 * 1024 * 1024;
/** ファイル名の上限（UTF-8のバイト数）。Androidの保存先（1つの名前が255バイトまで）でも同期できる長さにする。 */
export const FILE_NAME_BYTES = 200;

// 使えない文字: 制御文字・改行類・単独のサロゲート・幅のない文字と書字方向の制御、パスの区切り、Windows・exFATで使えない記号。
const FORBIDDEN = '\\p{Cc}\\p{Cs}\\p{Zl}\\p{Zp}\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF/\\\\:*?"<>|';
const forbidden = new RegExp(`[${FORBIDDEN}]`, 'u'), forbiddenAll = new RegExp(`[${FORBIDDEN}]`, 'gu');
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** 本体が受け付けるファイル名。sanitizeFileNameで整えた名前は必ず通る。 */
export const fileNameSchema = z.string().min(1, 'ファイル名が空です')
  .refine(s => utf8Bytes(s) <= FILE_NAME_BYTES, `ファイル名は${FILE_NAME_BYTES}バイト以内にしてください`)
  .refine(s => !forbidden.test(s) && s === s.normalize('NFC') && s.trim() === s && !s.startsWith('.') && !s.endsWith('.') && !s.includes('.sync-conflict-'),
    'ファイル名に使えない文字があります（先頭・末尾の点と空白、/ \\ : * ? " < > |、制御文字は使えません）');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const fileBytesSchema = z.number().int().min(1, '空のファイルは添えられません').max(MAX_FILE_BYTES_LIMIT);
/** 依頼に付ける、端末が置いたファイルの名前・大きさ・SHA-256。 */
export const attachmentRequestSchema = z.object({ name: fileNameSchema, bytes: fileBytesSchema, sha256: sha256Schema }).strict();
export type AttachmentRequest = z.infer<typeof attachmentRequestSchema>;
const attachmentPathPattern = /^05_files\/\d{4}-(?:0[1-9]|1[0-2])\/[0-9a-f]{24}\/[^/]+$/;
/** メモのfrontmatterに書く、Vault内のファイル。 */
export const attachmentSchema = z.object({ path: z.string().regex(attachmentPathPattern), name: fileNameSchema, bytes: fileBytesSchema, sha256: sha256Schema }).strict()
  .refine(v => v.path.endsWith(`/${v.name}`), 'ファイルの場所と名前が一致しません');
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * 手元のファイル名を、本体が受け付ける名前に整える（使えない文字は「_」に置き換え、長すぎる名前は拡張子を残して切る）。
 * アプリも同じ規則で整えてから送る。
 */
export function sanitizeFileName(raw: string): string {
  let name = (raw.split(/[\\/]/).pop() ?? '').normalize('NFC').replace(forbiddenAll, '_').replaceAll('.sync-conflict-', '.sync_conflict-');
  name = name.trim().replace(/^\.+/, '_').replace(/[.\s]+$/u, '');
  const dot = name.lastIndexOf('.'), ext = dot > 0 && /^\.[A-Za-z0-9]{1,16}$/.test(name.slice(dot)) ? name.slice(dot) : '';
  let stem = Array.from(ext ? name.slice(0, dot) : name);
  while (stem.length && utf8Bytes(stem.join('') + ext) > FILE_NAME_BYTES) stem.pop();
  const cut = stem.join('').replace(/[.\s]+$/u, '').trimStart();
  return ((cut || 'file') + ext).normalize('NFC');
}

/** 依頼の受付IDと出典から決まる、Vault内の置き場所。monthは原文と同じ日付（設定のタイムゾーン）の年-月。 */
export function attachmentPath(source: string, eventId: string, month: string, name: string): string {
  return `${ATTACHMENTS_DIR}/${month}/${hash(`${source}\n${eventId}`).slice(0, 24)}/${name}`;
}
export function maxFileBytes(config: Pick<HubConfig, 'capture'>): number {
  return config.capture.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
}

export const attachmentRefusalCauses = ['too-large', 'mismatch', 'secret'] as const;
export type AttachmentRefusalCause = typeof attachmentRefusalCauses[number];
export type AttachmentReason = { code: 'attachment-refused'; cause: AttachmentRefusalCause; max_bytes?: number };
/** 上限の表示（MB・KB・バイト）。 */
function limitText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Number((bytes / 1024 / 1024).toFixed(1))}MB` : bytes >= 1024 ? `${Math.floor(bytes / 1024)}KB` : `${bytes}バイト`;
}
export function attachmentMessage(reason: { cause: AttachmentRefusalCause; max_bytes?: number }): string {
  if (reason.cause === 'too-large') return `ファイルが大きすぎます（上限${limitText(reason.max_bytes ?? DEFAULT_MAX_FILE_BYTES)}）。小さくしてから保存し直してください。`;
  if (reason.cause === 'secret') return 'ファイル名に秘密情報らしい文字列があります。名前を変えてから保存し直してください。';
  return '届いたファイルが依頼の内容（大きさ・SHA-256）と一致しません。もう一度保存し直してください。';
}
export class AttachmentError extends Error {
  constructor(readonly reason: AttachmentReason) {
    super(attachmentMessage(reason));
    this.name = 'AttachmentError';
  }
}
/** ファイル名は資料棚・HOMEにそのまま載るため、秘密情報らしい文字列があれば断る（秘密情報の検出を止める設定では調べない）。 */
export function assertFileNameSafe(config: HubConfig, name: string): void {
  const settings = secretSettings(config);
  if (settings.enabled && findSecrets(name, settings).length) throw new AttachmentError({ code: 'attachment-refused', cause: 'secret' });
}

/**
 * 端末が置いたファイルが受け付けられる状態か。まだ届いていない・届く途中（小さい・書いた直後）ならwaiting。
 * 大きさが依頼より大きいときは、受付で内容の不一致として断る（ready）。通常のファイルでなければ例外。
 */
export async function transportState(absolutePath: string, bytes: number, now = Date.now()): Promise<'waiting' | 'ready'> {
  let info;
  try { info = await lstat(absolutePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'waiting'; throw error; }
  if (!info.isFile()) throw new Error('添付ファイルが通常のファイルではありません');
  return info.size < bytes || now - info.mtimeMs < 2000 ? 'waiting' : 'ready';
}
