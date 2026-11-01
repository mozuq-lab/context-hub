import { z } from 'zod';
import { inputIdSchema } from './capture.js';
import { projectIdSchema } from './projects.js';
import { parseMarkdown } from './storage.js';

export const requestIdSchema = z.string().regex(/^REQ-[A-Za-z0-9]{32}$/);
export const intakeTimestamp = z.string().refine(s => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)), 'タイムゾーン付き日時が必要です');
const base = { schema_version: z.literal(1), request_id: requestIdSchema, source: z.string().min(1).max(200), occurred_at: intakeTimestamp };
const captureSchema = z.object({ ...base, operation: z.literal('capture'), kind: z.enum(['memo','work-summary']), project: projectIdSchema.optional(), tool: z.string().max(100).optional(), meta: z.record(z.string().max(100),z.string().max(2000)).optional(), text: z.string() }).strict();
const correctionSchema = z.object({ ...base, operation: z.literal('correct'), target_id: inputIdSchema, text: z.string() }).strict();
const decisionSchema = z.object({ ...base, operation: z.enum(['project-approve','project-reject']), candidate_id: z.string().regex(/^PCAN-[0-9A-HJKMNP-TV-Z]{26}$/), candidate_hash: z.string().regex(/^[a-f0-9]{64}$/), confirmation_token: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true), text: z.string() }).strict();
const knowledgeBase={...base,candidate_id:z.string().regex(/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/),candidate_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()};
const knowledgeApprove=z.union([
 z.object({...knowledgeBase,operation:z.literal('knowledge-approve'),scope:z.literal('global')}).strict(),
 z.object({...knowledgeBase,operation:z.literal('knowledge-approve'),scope:z.literal('project'),project_id:projectIdSchema,project_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
const knowledgeReject=z.object({...knowledgeBase,operation:z.literal('knowledge-reject')}).strict();
const knowledgeRetire=z.object({...base,operation:z.literal('knowledge-retire'),target_id:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/),target_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()}).strict();
const schema = z.union([captureSchema, correctionSchema, decisionSchema, knowledgeApprove, knowledgeReject, knowledgeRetire]);
export type IntakeRequest = z.infer<typeof schema>;
export function decodeIntake(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('受付ファイルはUTF-8で保存してください'); }
}
export function parseIntake(path: string, content: string, maxInputChars: number): IntakeRequest {
  if (Buffer.byteLength(content) > maxInputChars * 4 + 8192) throw new Error('受付ファイルの容量が上限を超えています');
  const { meta, text } = parseMarkdown(content);
  const packet = schema.parse({ ...meta, text });
  if (path !== `Input/${packet.request_id}.md`) throw new Error('受付IDとパスが一致しません');
  if (packet.operation === 'capture' || packet.operation === 'correct') {
    if (!text.trim() || text.length > maxInputChars) throw new Error('受付本文が空か文字数上限を超えています');
  } else if (text.trim()) throw new Error('承認操作に本文は指定できません');
  return packet;
}
