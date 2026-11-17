import type { CorrectionChain } from './corrections.js';

/** この文字数以下のメモは、AIの要約ではなく本人の言葉をそのまま見せる。 */
export const SHORT_MEMO_CHARS = 100;

/**
 * 訂正のない短いメモの本文を、空白と改行をまとめた1行で返す。短いメモでなければundefined。
 * 短いメモをAIが言い換えても情報は増えず、本人の言葉が失われるだけなので、要約の代わりに使う。
 * 作業要約は抽出が、訂正のあるメモは訂正を重ねた解釈が要るので対象にしない。
 * 上限は文字数（コードポイント）で数える。要約の上限（UTF-16で200）を超えない。
 */
export function shortMemoText(chain: Pick<CorrectionChain, 'root' | 'revisions'>): string | undefined {
  if (chain.root.kind !== 'memo' || chain.revisions.length) return undefined;
  const text = chain.root.text.trim().replace(/\s+/g, ' ');
  return text && [...text].length <= SHORT_MEMO_CHARS ? text : undefined;
}
