import { ulid } from 'ulid';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logOperation } from './logger.js';
import { z } from 'zod';
import { Vault, hash, markdown, parseMarkdown, readOncePerLock } from './storage.js';
import { readProjects, projectIdSchema } from './projects.js';
import { DEFAULT_MAX_BACKDATE_DAYS, HappenedOnError, calendarDateSchema, effectiveHappenedOn, happenedOnProblem, localNoon } from './happened.js';
import type { CaptureRequest, CaptureResult, HubConfig, Input } from './types.js';
export const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
const timestamp = z.string().refine(s => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)), 'タイムゾーン付き日時が必要です');
export const inputSchema = z.object({ schema_version: z.literal(1), id: inputIdSchema, kind: z.enum(['memo', 'work-summary', 'correction']), corrects_input_id: inputIdSchema.optional(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(1000), occurred_at: timestamp, received_at: timestamp,
  project: projectIdSchema.optional(), tool: z.string().max(100).optional(), meta: z.record(z.string().max(100), z.string().max(2000)).optional(),
  origin: z.enum(['user-note', 'ai-self-report']), text: z.string().min(1), path: z.string(),
  // 本人が後から記録した出来事の日付と、実際に書いた日時。両方そろっているときだけ有効（occurred_atはその日の正午）。
  happened_on: calendarDateSchema.optional(), recorded_at: timestamp.optional(),
}).strict();
export function parseInput(path: string, content: string): Input {
  const { meta, text } = parseMarkdown(content);
  const input = inputSchema.parse({ ...meta, origin: meta.origin ?? (meta.kind === 'work-summary' ? 'ai-self-report' : 'user-note'), text, path });
  if ((input.kind === 'correction') !== (input.corrects_input_id !== undefined)) throw new Error('訂正の参照と種別が一致しません');
  if ((input.happened_on === undefined) !== (input.recorded_at === undefined) || (input.happened_on !== undefined && input.kind === 'correction')) throw new Error('出来事の日付と記録日時が一致しません');
  if (!path.endsWith(`_${input.id}.md`)) throw new Error('入力IDとファイル名が一致しません');
  return input;
}
/** 原文を1回だけ読み、解釈と原文のハッシュを組にして返す。Writerロックの1区間では読み直さない。 */
export async function readInputRecords(config: HubConfig): Promise<{ input: Input; rawHash: string }[]> {
  return readOncePerLock(config, 'inputs', ['00_inbox'], async () => {
    const vault = new Vault(config), result: { input: Input; rawHash: string }[] = [];
    for (const path of await vault.files('00_inbox')) {
      if (!isInputPath(path)) continue;
      // 原文1件ごとの解釈も区間内で使い回す。新しい原文を足した後の読み直しでも、既にある原文は読み直さない。
      result.push(await readOncePerLock(config, `input:${path}`, [path], async () => { const raw = (await vault.read(path))!; return { input: parseInput(path, raw), rawHash: hash(raw) }; }));
    }
    return result.sort((a,b) => Date.parse(a.input.occurred_at)-Date.parse(b.input.occurred_at) || a.input.id.localeCompare(b.input.id));
  });
}
const isInputPath = (path: string) => path.endsWith('.md') && !path.includes('.sync-conflict-');
export async function readInputs(config: HubConfig): Promise<Input[]> {
  return (await readInputRecords(config)).map(r => r.input);
}
const eventMarkerPath = /^90_system\/receipts\/events\/[0-9a-f]{64}\/[0-9a-f]{64}$/;
/**
 * イベント記録が指す入力IDの集合。Writerロック内で使う。
 * イベント記録は作るだけで書き換えないため、読んだ内容を状態ディレクトリ（Vaultの外・同期しない）に覚え、一覧にある新しい記録だけを読む。
 * 一覧から消えた記録は忘れる。覚えを読めない・書けないときは、すべて読み直すだけで結果は変わらない。
 */
async function markedInputIds(config: HubConfig, vault: Vault): Promise<Set<string>> {
  const file = join(config.statePath, 'event-markers.json'), owner = resolve(config.vaultPath);
  const paths = (await vault.files('90_system/receipts/events')).filter(p => eventMarkerPath.test(p));
  let cached: Record<string, unknown> = {};
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as { schema_version?: unknown; vault?: unknown; entries?: unknown };
    if (saved.schema_version === 1 && saved.vault === owner && saved.entries && typeof saved.entries === 'object') cached = saved.entries as Record<string, unknown>;
  } catch { /* 覚えがなければすべて読む。 */ }
  const entries: Record<string, string> = {}; let changed = Object.keys(cached).length !== paths.length;
  for (const path of paths) {
    const known = cached[path];
    if (typeof known === 'string' && inputIdSchema.safeParse(known).success) { entries[path] = known; continue; }
    changed = true;
    const id = (await vault.read(path))?.trim();
    if (id !== undefined && inputIdSchema.safeParse(id).success) entries[path] = id;
  }
  if (changed) {
    const temp = `${file}.${process.pid}.tmp`;
    try { await writeFile(temp, JSON.stringify({ schema_version: 1, vault: owner, entries }), { mode: 0o600 }); await rename(temp, file); }
    catch { await rm(temp, { force: true }).catch(() => {}); /* 覚えられなくても、次回に読み直すだけ。 */ }
  }
  return new Set(Object.values(entries));
}
export function eventMarker(source: string, eventId: string): string { return `90_system/receipts/events/${hash(source)}/${hash(eventId)}`; }
/** Writerロックを持つ呼び出し元から使う原文保存。同じ出典・イベントIDの再送では既存の入力を返す。 */
export async function captureLocked(config: HubConfig, vault: Vault, request: CaptureRequest): Promise<CaptureResult> {
  if (!request.text?.trim() || request.text.length > config.capture.maxInputChars) throw new Error('本文が空か文字数上限を超えています');
  if (request.happenedOn !== undefined) calendarDateSchema.parse(request.happenedOn);
  const happenedOn = effectiveHappenedOn(request.happenedOn, request.occurredAt, config.timezone);
  const meta = inputSchema.omit({ text: true, path: true }).parse({ schema_version: 1, id: `IN-${ulid()}`,
    source: request.source, source_event_id: request.sourceEventId ?? ulid(), occurred_at: happenedOn !== undefined ? localNoon(happenedOn, config.timezone) : request.occurredAt,
    received_at: request.receivedAt ?? new Date().toISOString(), kind: request.kind ?? 'memo', project: request.project,
    tool: request.tool, meta: request.meta, origin: request.kind === 'work-summary' ? 'ai-self-report' : 'user-note',
    ...(happenedOn !== undefined ? { happened_on: happenedOn, recorded_at: request.occurredAt } : {}) });
  {
    const marker = eventMarker(meta.source, meta.source_event_id), existing = await vault.read(marker);
    // 再送の判定は、先にイベント記録を見て、その原文1件だけを読む（通常の経路で全原文を読まない）。
    const inbox = (await vault.files('00_inbox')).filter(isInputPath);
    if (existing !== undefined) {
      const id = existing.trim(), path = inputIdSchema.safeParse(id).success ? inbox.find(p => p.endsWith(`_${id}.md`)) : undefined;
      const found = path === undefined ? undefined : parseInput(path, (await vault.read(path))!);
      if (!found || found.source !== meta.source || found.source_event_id !== meta.source_event_id) throw new Error('イベント記録と原文が一致しません。doctorで確認してください');
      return { inputId: found.id, deduped: true, path: found.path, receivedAt: found.received_at };
    }
    // イベント記録がないとき、このイベントの原文がありうるのは、イベント記録が指していない原文（原文の保存後・記録の作成前に停止した場合など）だけ。
    // イベント記録（小さな1行）が指す入力IDの集合と、原文のファイル名の入力IDの集合を比べ、指されていない原文だけを読んで再送で記録を回復する。
    // 件数だけで比べると、無関係なファイルや原文のないイベント記録（途中の状態からの復元など）で数が合い、見落とす。
    const marked = await markedInputIds(config, vault);
    const unmarked = inbox.filter(p => !marked.has(p.slice(p.lastIndexOf('_') + 1, -'.md'.length)));
    const inputs: Input[] = [];
    for (const path of unmarked) inputs.push(parseInput(path, (await vault.read(path))!));
    const matching = inputs.filter(x => x.source === meta.source && x.source_event_id === meta.source_event_id);
    if (matching.length > 1) throw new Error('イベントが重複しています。doctorで確認してください');
    if (matching.length) {
      const found = matching[0];
      await vault.create(marker, `${found.id}\n`);
      return { inputId: found.id, deduped: true, path: found.path, receivedAt: found.received_at };
    }
    // 出来事の日付は、記録した日より後と、上限より古いものを理由付きで拒否する。記録した日と同じなら指定がないのと同じに扱う。
    // 再送の判定の後で確かめ、保存済みの原文の再送を、後から変えた設定で拒否しない。
    if (request.happenedOn !== undefined) {
      const maxDays = config.capture.maxBackdateDays ?? DEFAULT_MAX_BACKDATE_DAYS, cause = happenedOnProblem(request.happenedOn, request.occurredAt, config.timezone, maxDays);
      if (cause) throw new HappenedOnError({ code: 'happened-on-invalid', cause, max_days: maxDays });
    }
    if (request.project && !(await readProjects(config)).some(p => p.id === request.project)) throw new Error('指定プロジェクトがありません。先にproject addを実行してください');
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(meta.occurred_at));
    const path = `00_inbox/${date}_${meta.id}.md`;
    if (!await vault.create(path, markdown(meta, request.text))) throw new Error('入力IDが競合しました。再送してください');
    if (!await vault.create(marker, `${meta.id}\n`)) throw new Error('イベント記録が競合しました。再送してください');
    return { inputId: meta.id, deduped: false, path, receivedAt: meta.received_at };
  }
}
export async function capture(config: HubConfig, request: CaptureRequest): Promise<CaptureResult> {
  const vault = new Vault(config);
  const started = Date.now();
  const result = await vault.withLock(() => captureLocked(config, vault, request));
  if (!await logOperation(config, { op: 'capture', input_id: result.inputId, ms: Date.now() - started, counts: { deduped: Number(result.deduped) } })) process.stderr.write('警告: 運用ログを書き込めませんでした。原文は保存済みです。\n');
  return result;
}
