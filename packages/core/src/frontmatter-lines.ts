/**
 * 人が保守するfrontmatter（project.mdなど）を、コメント・書式・改行・本文を保ったまま行単位で書き換えるための共通部品。
 * 解析し直した結果の検証は呼び出し側で行う。
 */
export interface FrontmatterParts { eol: string; body: string; rest: string }
export function frontmatterParts(raw: string): FrontmatterParts {
  const match = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('プロジェクト定義のfrontmatterを確認できません');
  const eol = match[1]!, body = match[2]!;
  return { eol, body, rest: raw.slice(3 + eol.length + body.length) };
}
export function withFrontmatterBody(parts: FrontmatterParts, body: string): string { return `---${parts.eol}${body}${parts.rest}`; }
/** 最上位のキーの行か（`status:`も`status :`も同じキー）。 */
export const keyLine = (key: string) => new RegExp(`^${key}\\s*:`);
/** 最上位のキーの行を1行で置き換える。無ければ末尾に足す。 */
export function replaceKeyLine(lines: string[], key: string, line: string): string[] {
  const at = lines.findIndex(l => keyLine(key).test(l)), next = [...lines];
  if (at >= 0) next[at] = line; else next.push(line);
  return next;
}
