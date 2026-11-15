import { ZodError } from 'zod';
/** 本体が投げる既知の失敗コード（英字）と、本人へ示す日本語。 */
const knownCodes: Record<string, string> = {
  'infer:spawn': 'モデル実行のコマンドを起動できません。設定のorganize.llm.executableとOpenClawの導入を確認してください',
  'infer:exit': 'モデル実行のコマンドが失敗しました。OpenClaw（Gateway）の状態を確認してください',
  'infer:invalid-json': 'モデル実行の応答を読めません。OpenClawの版を確認してください',
  'infer:invalid-envelope': 'モデル実行の応答の形式が想定と違います。OpenClawの版を確認してください',
  'infer:output-limit': 'モデルの出力が上限を超えました。設定のorganize.llm.maxOutputCharsを確認してください',
  'infer:options': 'モデル実行の設定値が不正です。設定のorganizeを確認してください',
  timeout: 'モデルの応答が時間内に返りませんでした',
};
/**
 * 本体が書いた案内文の書き出し。日本語で始まるか、英字の語1つ（Vault・NOW・frontmatterなど）の直後か空白1つの後に日本語が続く。
 * JSON・YAMLの解析エラーやライブラリの英文は、例外の文に原文（Vaultの本文）の一部を含むことがあるため、この形に当たらない。
 */
const ownMessage = /^(?:[A-Za-z][\w.:-]* ?)?[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
// 絶対パス（/…、~/…、C:\…）らしい部分。
const absolutePath = /(?:^|[\s'"(（:：=])(?:\/|~\/|[A-Za-z]:\\)[^\s]/;
/** zodの項目の場所（値は含めない）。 */
export function issuePaths(error: ZodError, limit = 5): string[] {
  const paths = [...new Set(error.issues.flatMap(i => {
    const base = i.path.map(String).join('.');
    // 余分なキーは、そのキーの名前も場所として示す。
    return i.code === 'unrecognized_keys' ? i.keys.map(k => base ? `${base}.${k}` : k) : [base];
  }).filter(Boolean))].map(p => p.replace(/[\r\n]/g, ' ').slice(0, 100));
  return paths.length > limit ? [...paths.slice(0, limit), `ほか${paths.length - limit}件`] : paths;
}
/**
 * CLIで本人へ示すエラー文。パス・本文・外部プロセスのstderrを例外から転記しない。
 * 本体が書いた日本語の1行（先頭が英字の語1つでも可）と、既知の失敗コード・形式の誤り（項目の場所だけ）を示し、それ以外は一般的な案内にする。
 */
export function userFacingError(error: unknown): string {
  const fallback = '処理に失敗しました。設定・引数とctx doctorを確認してください';
  if (error instanceof ZodError) { const paths = issuePaths(error); return `引数・記録の形式が正しくありません${paths.length ? `（${paths.join('、')}）` : ''}`; }
  const message = error instanceof Error ? error.message : '';
  if (knownCodes[message]) return knownCodes[message]!;
  // 解析エラー（JSON.parseのSyntaxErrorなど）とOS・ライブラリのエラー（codeを持つ）は、本文や場所を含みうるため常に一般的な案内にする。
  if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && (error as { code?: unknown }).code !== undefined)) return fallback;
  if (!message || message.includes('\n') || message.length > 500 || !ownMessage.test(message) || absolutePath.test(message)) return fallback;
  return message;
}
