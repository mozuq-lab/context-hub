/**
 * 生成するMarkdownの1行へ、本文・出典・ツール名など外から来た文字列を埋め込むときの無害化。
 * どの出力でも改行を空白にし、HTMLコメントの開始（`<!--`。NOWの自動領域の印など）を無効にする。
 * - table: 表の列区切り（|）も空白にする（HOME・経緯・アイデアの一覧など、表や1行の一覧に使う）。
 * - brackets: リンクの角括弧を無効にする。
 * - angle: `<` をすべて無効にする（資料棚。HTMLとして読まれないようにする）。
 * - collapse: 連続する改行を1つの空白にまとめる（NOW）。
 */
export function inlineText(text: string, options: { table?: boolean; brackets?: boolean; angle?: boolean; collapse?: boolean } = {}): string {
  let out = text.replace(options.table ? (options.collapse ? /[\r\n|]+/g : /[\r\n|]/g) : (options.collapse ? /[\r\n]+/g : /[\r\n]/g), ' ');
  if (options.brackets) out = out.replaceAll('[', '\\[').replaceAll(']', '\\]');
  return options.angle ? out.replaceAll('<', '&lt;') : out.replaceAll('<!--', '&lt;!--');
}
/** 一覧の行に使う既定の無害化（改行・表の区切り・角括弧・HTMLコメント）。 */
export const listText = (text: string): string => inlineText(text, { table: true, brackets: true });
/** NOWの行に使う無害化（改行をまとめ、HTMLコメントを無効にする）。 */
export const nowText = (text: string): string => inlineText(text, { collapse: true });
