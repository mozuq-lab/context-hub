import { ulid } from 'ulid';
import { logOperation } from './logger.js';
import { z } from 'zod';
import { Vault, hash, markdown, parseMarkdown } from './storage.js';
import { readProjects, projectIdSchema } from './projects.js';
import type { CaptureRequest, CaptureResult, HubConfig, Input } from './types.js';
export const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
const timestamp = z.string().refine(s => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)), 'タイムゾーン付き日時が必要です');
export const inputSchema = z.object({ schema_version: z.literal(1), id: inputIdSchema, kind: z.enum(['memo', 'work-summary', 'correction']), corrects_input_id: inputIdSchema.optional(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(1000), occurred_at: timestamp, received_at: timestamp,
  project: projectIdSchema.optional(), tool: z.string().max(100).optional(), meta: z.record(z.string().max(100), z.string().max(2000)).optional(),
  origin: z.enum(['user-note', 'ai-self-report']), text: z.string().min(1), path: z.string(),
}).strict();
export function parseInput(path: string, content: string): Input {
  const { meta, text } = parseMarkdown(content);
  const input = inputSchema.parse({ ...meta, origin: meta.origin ?? (meta.kind === 'work-summary' ? 'ai-self-report' : 'user-note'), text, path });
  if ((input.kind === 'correction') !== (input.corrects_input_id !== undefined)) throw new Error('訂正の参照と種別が一致しません');
  if (!path.endsWith(`_${input.id}.md`)) throw new Error('入力IDとファイル名が一致しません');
  return input;
}
export async function readInputs(config: HubConfig): Promise<Input[]> {
  const vault = new Vault(config), result: Input[] = [];
  for (const path of await vault.files('00_inbox')) {
    if (!path.endsWith('.md') || path.includes('.sync-conflict-')) continue;
    result.push(parseInput(path, (await vault.read(path))!));
  }
  return result.sort((a,b) => Date.parse(a.occurred_at)-Date.parse(b.occurred_at) || a.id.localeCompare(b.id));
}
export function eventMarker(source: string, eventId: string): string { return `90_system/receipts/events/${hash(source)}/${hash(eventId)}`; }
export async function capture(config: HubConfig, request: CaptureRequest): Promise<CaptureResult> {
  if (!request.text?.trim() || request.text.length > config.capture.maxInputChars) throw new Error('本文が空か文字数上限を超えています');
  const meta = inputSchema.omit({ text: true, path: true }).parse({ schema_version: 1, id: `IN-${ulid()}`,
    source: request.source, source_event_id: request.sourceEventId ?? ulid(), occurred_at: request.occurredAt,
    received_at: request.receivedAt ?? new Date().toISOString(), kind: request.kind ?? 'memo', project: request.project,
    tool: request.tool, meta: request.meta, origin: request.kind === 'work-summary' ? 'ai-self-report' : 'user-note' });
  const vault = new Vault(config);
  const started = Date.now();
  const result = await vault.withLock(async () => {
    const marker = eventMarker(meta.source, meta.source_event_id), existing = await vault.read(marker);
    const inputs = await readInputs(config);
    const matching = inputs.filter(x => x.source === meta.source && x.source_event_id === meta.source_event_id);
    if (matching.length > 1) throw new Error('イベントが重複しています。doctorで確認してください');
    if (existing && (!matching.length || existing.trim() !== matching[0].id)) throw new Error('イベント記録と原文が一致しません。doctorで確認してください');
    if (matching.length) {
      const found = matching[0];
      if (!existing) await vault.create(marker, `${found.id}\n`);
      return { inputId: found.id, deduped: true, path: found.path, receivedAt: found.received_at };
    }
    if (request.project && !(await readProjects(config)).some(p => p.id === request.project)) throw new Error('指定プロジェクトがありません。先にproject addを実行してください');
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(meta.occurred_at));
    const path = `00_inbox/${date}_${meta.id}.md`;
    if (!await vault.create(path, markdown(meta, request.text))) throw new Error('入力IDが競合しました。再送してください');
    if (!await vault.create(marker, `${meta.id}\n`)) throw new Error('イベント記録が競合しました。再送してください');
    return { inputId: meta.id, deduped: false, path, receivedAt: meta.received_at };
  });
  if (!await logOperation(config, { op: 'capture', input_id: result.inputId, ms: Date.now() - started, counts: { deduped: Number(result.deduped) } })) process.stderr.write('警告: 運用ログを書き込めませんでした。原文は保存済みです。\n');
  return result;
}
