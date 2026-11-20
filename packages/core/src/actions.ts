import { z } from 'zod';
import type { Input } from './types.js';

/**
 * 本人が直接「次の一手」に載せる行動（入力の種類 action）。
 * 本人の言葉のまま原文として保存し、モデルの整理には回さない。指定したプロジェクトのNOWに「本人が追加」として載せ、
 * 本人が完了・誤りとして外すと報告するまで、新しい作業要約が届いても残す。完了報告・期日は既存のNOW項目の操作をそのまま使う。
 */
export const ACTION_TEXT_CHARS = 200;
export const ACTION_LABEL = '本人が追加: ';
/**
 * 行動1件の文面。1行・200文字以内（UTF-16の単位で数える）で、制御文字・行区切り・段落区切り・文字の向きを変える制御と前後の空白を含めない
 * （NOWの1行と項目一覧に本人の言葉のまま載せるため。向きの制御は、見た目と中身を食い違わせるため）。
 */
export const actionTextSchema = z.string().min(1, '行動の文面が空です').max(ACTION_TEXT_CHARS, `行動の文面は${ACTION_TEXT_CHARS}文字以内にしてください`)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+$/u, '行動の文面は1行で書いてください（制御文字は使えません）').refine(v => v.trim() === v, '行動の文面の前後に空白は付けられません');

/**
 * AIが読み取った行（NOWの提案・作業要約の次の一手など）を行動にしたときの、元の行への参照。入力のmetaに文字列で残す。
 * - action_from_input: 元の行の根拠の入力ID
 * - action_from_text: 元の行の本文（ラベルを除く。本人が直す前の文面）
 * - action_from_key: 元の行がNOW項目（キー付き）だったときの項目キー
 */
export const actionFromKeys = ['action_from_input', 'action_from_text', 'action_from_key'] as const;
export interface ActionSource { input_id: string; text: string; key?: string }
// capture.tsから読むため、ほかのモジュールに依存しない（循環を避ける）。
const fromSchema = z.object({ action_from_input: z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/), action_from_text: z.string().min(1).max(2000), action_from_key: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

/** 行動のmetaを検証する。元の行への参照は、入力IDと本文の組でだけ付けられる（キーは任意）。それ以外のキーは付けられない。 */
export function assertActionMeta(meta: Record<string, string> | undefined): void {
  if (meta === undefined) return;
  if (!fromSchema.safeParse(meta).success) throw new Error('行動の元の行の参照が不正です（action_from_input・action_from_text・任意のaction_from_keyだけを指定します）');
}
/** 行動の入力から、元の行への参照を読む。参照がない・形式が合わないときはundefined。 */
export function actionSource(input: Pick<Input, 'kind' | 'meta'>): ActionSource | undefined {
  if (input.kind !== 'action') return undefined;
  const parsed = fromSchema.safeParse(input.meta ?? {});
  if (!parsed.success) return undefined;
  return { input_id: parsed.data.action_from_input, text: parsed.data.action_from_text, ...(parsed.data.action_from_key ? { key: parsed.data.action_from_key } : {}) };
}
/** 元の行と同じ行か（根拠の入力IDと本文の組）。 */
export const sourceRef = (inputId: string, text: string) => `${inputId}\n${text}`;
