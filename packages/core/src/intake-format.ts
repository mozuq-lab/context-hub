import { z } from 'zod';
import { inputIdSchema } from './capture.js';
import { projectIdSchema } from './projects.js';
import { PROJECT_TERMS_MAX, PROJECT_TERM_CHARS, PROJECT_TITLE_CHARS } from './project-definition.js';
import { projectStatusSchema } from './project-status.js';
import { exclusionNoteSchema, exclusionReasonSchema, itemActionSchema, itemKeySchema, itemScopeSchema, UNASSIGNED_EXCLUSION_REASON, UNASSIGNED_SCOPE } from './item-resolutions.js';
import { occurrenceActionSchema, repeatRuleSchema, scheduleDateSchema } from './item-schedules.js';
import { calendarDateSchema } from './happened.js';
import { itemEffortSchema } from './item-efforts.js';
import { parseMarkdown } from './storage.js';
import { ASK_QUESTION_CHARS } from './ask.js';
import { parsePreferencesPayload } from './client-preferences.js';
import { newProjectIdSchema, projectCreateFieldsSchema } from './project-creations.js';
import { resolvableTargetSchema } from './conflicts.js';
import { ideaIdSchema, ideaLinkActionSchema } from './idea-links.js';
import { PROJECT_COVERS_MAX } from './project-proposals.js';
import { insightItemKeySchema, insightReactionValueSchema, insightRunIdSchema } from './insight-feedback.js';
import { PERSON_ALIASES_MAX, PERSON_NAME_CHARS, personActions, personIdSchema } from './people.js';

export const requestIdSchema = z.string().regex(/^REQ-[A-Za-z0-9]{32}$/);
export const intakeTimestamp = z.string().refine(s => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)), 'タイムゾーン付き日時が必要です');
const base = { schema_version: z.literal(1), request_id: requestIdSchema, source: z.string().min(1).max(200), occurred_at: intakeTimestamp };
// kind: actionは本人が直接追加する次の一手。projectを省くとプロジェクト未定の次の一手に載る。本文は1行・200文字以内（本体のcaptureが検証する）。
// happened_onは本人が後から記録した出来事の日付。occurred_atは実際に書いた日時のまま送る（actionには付けられない）。
// continuesは続きとして書いたときの前のメモの入力ID（actionには付けられない）。projectを省くと前のメモで指定したプロジェクトを引き継ぐ。
const captureSchema = z.object({ ...base, operation: z.literal('capture'), kind: z.enum(['memo','work-summary','action']), project: projectIdSchema.optional(), tool: z.string().max(100).optional(), meta: z.record(z.string().max(100),z.string().max(2000)).optional(), happened_on: calendarDateSchema.optional(), continues: inputIdSchema.optional(), text: z.string() }).strict().refine(v => v.kind !== 'action' || v.continues === undefined, '行動には前のメモを指定できません');
const correctionSchema = z.object({ ...base, operation: z.literal('correct'), target_id: inputIdSchema, text: z.string() }).strict();
// cover_idsは、同じ対象の案として同じ判断にまとめる確認待ちの案。cover_hashesは同じ順で、本人が確認した内容のハッシュ。本体が同じ組の案かを検証する。
const decisionSchema = z.object({ ...base, operation: z.enum(['project-approve','project-reject']), candidate_id: z.string().regex(/^PCAN-[0-9A-HJKMNP-TV-Z]{26}$/), candidate_hash: z.string().regex(/^[a-f0-9]{64}$/), confirmation_token: z.string().regex(/^[a-f0-9]{64}$/), cover_ids: z.array(z.string().regex(/^PCAN-[0-9A-HJKMNP-TV-Z]{26}$/)).min(1).max(PROJECT_COVERS_MAX).optional(), cover_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(PROJECT_COVERS_MAX).optional(), confirmed: z.literal(true), text: z.string() }).strict().refine(v => (v.cover_ids?.length ?? 0) === (v.cover_hashes?.length ?? 0), 'まとめる案のIDとハッシュの数が一致しません');
const knowledgeBase={...base,candidate_id:z.string().regex(/^CAN-[0-9A-HJKMNP-TV-Z]{26}$/),candidate_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()};
const knowledgeApprove=z.union([
 z.object({...knowledgeBase,operation:z.literal('knowledge-approve'),scope:z.literal('global')}).strict(),
 z.object({...knowledgeBase,operation:z.literal('knowledge-approve'),scope:z.literal('project'),project_id:projectIdSchema,project_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
const knowledgeReject=z.object({...knowledgeBase,operation:z.literal('knowledge-reject')}).strict();
const knowledgeRetire=z.object({...base,operation:z.literal('knowledge-retire'),target_id:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/),target_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()}).strict();
const projectStatus=z.object({...base,operation:z.literal('project-status'),project_id:projectIdSchema,project_hash:z.string().regex(/^[a-f0-9]{64}$/),status:projectStatusSchema,confirmed:z.literal(true),text:z.string()}).strict();
// 誤りとして外す（exclude）ときだけ理由が必須で、一言を添えられる。承認操作の本文は空のままにするため、一言はfrontmatterで送る。
const itemResolution=z.object({...base,operation:z.literal('item-resolution'),project_id:itemScopeSchema,item_key:itemKeySchema,action:itemActionSchema,reason:exclusionReasonSchema.optional(),note:exclusionNoteSchema.optional(),confirmed:z.literal(true),text:z.string()}).strict().refine(v=>v.action==='exclude'?v.reason!==undefined:v.reason===undefined&&v.note===undefined,'理由は誤りとして外すときだけ指定します').refine(v=>v.project_id!==UNASSIGNED_SCOPE||v.action!=='exclude'||v.reason===UNASSIGNED_EXCLUSION_REASON,'プロジェクト未定の行は、「もう古い」としてだけ外せます');
// 期日と見直す日は変更後の全体を送る。両方nullは日付を外す依頼。
// repeat（定例の繰り返し）は省略すると今の繰り返しを保ち、nullで外す。繰り返しを知らない版のアプリの依頼で定例を外さないため。
const itemSchedule=z.object({...base,operation:z.literal('item-schedule'),project_id:projectIdSchema,item_key:itemKeySchema,due:scheduleDateSchema.nullable(),review_after:scheduleDateSchema.nullable(),repeat:repeatRuleSchema.nullable().optional(),confirmed:z.literal(true),text:z.string()}).strict().refine(v=>!v.repeat||v.due!==null,'繰り返しには期日が必要です');
// 定例の今回を完了（done）・見送り（skip）。dueは本人が確認した回の期日で、今の期日と違えば受け付けない。
const itemOccurrence=z.object({...base,operation:z.literal('item-occurrence'),project_id:projectIdSchema,item_key:itemKeySchema,action:occurrenceActionSchema,due:scheduleDateSchema,confirmed:z.literal(true),text:z.string()}).strict();
// 手間の目安。effortは変更後の目安で、nullは外す依頼。
const itemEffort=z.object({...base,operation:z.literal('item-effort'),project_id:projectIdSchema,item_key:itemKeySchema,effort:itemEffortSchema.nullable(),confirmed:z.literal(true),text:z.string()}).strict();
const itemHintDismiss=z.object({...base,operation:z.literal('item-hint-dismiss'),project_id:projectIdSchema,item_key:itemKeySchema,input_id:inputIdSchema,confirmed:z.literal(true),text:z.string()}).strict();
const gitDraftDismiss=z.object({...base,operation:z.literal('git-draft-dismiss'),draft_id:z.string().regex(/^GDR-[0-9A-HJKMNP-TV-Z]{26}$/),draft_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()}).strict();
// 名前・別名・キーワードは変更後の全体を送る。上限と重複の整理は本体が検証する。
const projectDefinition=z.object({...base,operation:z.literal('project-definition'),project_id:projectIdSchema,project_hash:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().max(PROJECT_TITLE_CHARS),aliases:z.array(z.string().max(PROJECT_TERM_CHARS)).max(PROJECT_TERMS_MAX),keywords:z.array(z.string().max(PROJECT_TERM_CHARS)).max(PROJECT_TERMS_MAX),confirmed:z.literal(true),text:z.string()}).strict();
// 本文は任意の最初のメモ。空なら作成だけを行う。
const projectCreate=z.object({...base,operation:z.literal('project-create'),project_id:newProjectIdSchema,title:z.string(),aliases:z.array(z.string()),keywords:z.array(z.string()),confirmed:z.literal(true),text:z.string()}).strict().superRefine((value,ctx)=>{const result=projectCreateFieldsSchema.safeParse({title:value.title,aliases:value.aliases,keywords:value.keywords});if(!result.success)ctx.addIssue({code:z.ZodIssueCode.custom,message:'プロジェクトの名前・別名・キーワードが不正です'});});
const conflictResolve=z.object({...base,operation:z.literal('conflict-resolve'),target:resolvableTargetSchema,target_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()}).strict();
// 2件のアイデアを束ねる（link）か、別の話とする（separate）。ハッシュは索引で確認した内容のもので、束ねるときだけ一致を確かめる。
const ideaLink=z.object({...base,operation:z.literal('idea-link'),idea_ids:z.tuple([ideaIdSchema,ideaIdSchema]).refine(([a,b])=>a!==b,'異なる2件のアイデアを指定してください'),idea_hashes:z.tuple([z.string().regex(/^[a-f0-9]{64}$/),z.string().regex(/^[a-f0-9]{64}$/)]),action:ideaLinkActionSchema,confirmed:z.literal(true),text:z.string()}).strict();
// 統合元（project_id）を統合先（into_id）へまとめる、またはその統合を取り消す。ハッシュは確認した時点の2つのproject.mdのもの。
const projectMerge=z.object({...base,operation:z.enum(['project-merge','project-unmerge']),project_id:projectIdSchema,project_hash:z.string().regex(/^[a-f0-9]{64}$/),into_id:projectIdSchema,into_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()}).strict();
// 今週の気づきの項目への反応。noneは前の反応を外す。問いへの答えは、反応ではなくmeta付きのcaptureで送る。
const insightReaction=z.object({...base,operation:z.literal('insight-reaction'),run_id:insightRunIdSchema,item_key:insightItemKeySchema,reaction:insightReactionValueSchema,confirmed:z.literal(true),text:z.string()}).strict();
// 人の登録（add）・名前と呼び名の変更（edit）・外す（remove）。変更と外すは、本人が確認したperson.mdのハッシュに結び付ける。
const personDefinition=z.object({...base,operation:z.literal('person-definition'),person_id:personIdSchema,action:z.enum(personActions),person_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),name:z.string().max(PERSON_NAME_CHARS).optional(),aliases:z.array(z.string().max(PERSON_NAME_CHARS)).max(PERSON_ALIASES_MAX).optional(),confirmed:z.literal(true),text:z.string()}).strict()
 .refine(v=>v.action==='add'?v.person_hash===undefined&&v.name!==undefined:v.person_hash!==undefined&&(v.action==='edit'?v.name!==undefined&&v.aliases!==undefined:v.name===undefined&&v.aliases===undefined),'人の定義の依頼の項目が操作と合いません');
// 記録に聞く。本文が問い。projectを付けると、そのプロジェクトに帰属・関連する記録から答える。答えはcycleで作る。
const askSchema=z.object({...base,operation:z.literal('ask'),project:projectIdSchema.optional(),text:z.string()}).strict();
// アプリの好みを端末間でそろえる。本文が好みのJSON（変えたまとまりだけ）。
const preferencesSchema=z.object({...base,operation:z.literal('client-preferences'),confirmed:z.literal(true),text:z.string()}).strict();
// 採用した方針を本人が「まだ有効」と確かめた。ハッシュは確かめた時点の知識のファイルのもの。
const policyKeep=z.object({...base,operation:z.literal('policy-keep'),knowledge_id:z.string().regex(/^KNW-[0-9A-HJKMNP-TV-Z]{26}$/),knowledge_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),text:z.string()}).strict();
const schema = z.union([captureSchema, correctionSchema, decisionSchema, knowledgeApprove, knowledgeReject, knowledgeRetire, projectStatus, projectDefinition, projectMerge, itemResolution, itemHintDismiss, itemSchedule, itemOccurrence, itemEffort, gitDraftDismiss, projectCreate, conflictResolve, ideaLink, insightReaction, askSchema, preferencesSchema, policyKeep, personDefinition]);
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
  } else if (packet.operation === 'ask') {
    if (!text.trim() || text.length > ASK_QUESTION_CHARS) throw new Error(`問いは1〜${ASK_QUESTION_CHARS}文字にしてください`);
  } else if (packet.operation === 'client-preferences') {
    parsePreferencesPayload(text);
  } else if (packet.operation === 'project-create') {
    if (text.length > maxInputChars) throw new Error('最初のメモが文字数上限を超えています');
  } else if (text.trim()) throw new Error('承認操作に本文は指定できません');
  return packet;
}
