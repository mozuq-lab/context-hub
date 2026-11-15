import type { HubConfig, LlmClient, LlmCompletion, LlmOptions } from './types.js';
import type { Vault } from './storage.js';

/**
 * メモに紛れたAPIキー・トークン・パスワード・秘密鍵らしい文字列を、決まった規則で見つけて伏せる。
 * 原文（00_inbox）は書き換えない。モデルへ渡すプロンプト、モデルの出力、別AI向けのcontextだけを伏せる。
 * 規則はFlutterクライアントと共有する試験データ（test/fixtures/secret-cases.json）で一致を確かめる。
 */
export interface SecretRule {
  /** 規則の識別子。記録と試験で使う。 */
  id: string;
  /** 伏せ字に出す種類名。 */
  label: string;
  pattern: RegExp;
  /** 値だけを伏せる場合の捕捉グループ番号。省略時は一致全体を伏せる。値は一致の末尾に置く（Dart側も同じ前提で位置を求める）。 */
  group?: number;
}
export interface SecretFinding { rule: string; label: string; start: number; end: number }

/** 伏せ字の形。規則に二度一致しないよう、角括弧と全角の語で書く。 */
export const placeholder = (label: string): string => `[伏せ字:${label}]`;
const PLACEHOLDER_HEAD = '[伏せ字:';

/**
 * 代入の形で値を伏せる鍵の名前。英数字に続く位置では始めないため、DB_PASSWORDやAWS_SECRET_ACCESS_KEYのように
 * 前に語が付いた環境変数名にも当たり、passwordlessのような語の途中には当たらない。
 */
const SECRET_KEYS = '(?:(?<![A-Za-z0-9])(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|signature|sig)(?![A-Za-z0-9])|パスワード|暗証番号|合言葉)';
/**
 * 鍵の名前と区切り（: = ：）の間。空白、続けて（あれば）引用符1つとその後の空白、最後に区切りを認める（password" = のような書き方）。
 * 「空白*・引用符?・空白*」と書くと引用符がないときに空白の分け方が二乗に増えて後戻りするため、引用符の後の空白を引用符と組にする。
 */
const KEY_GAP = `[ \\t]*(?:["'][ \\t]*)?[:=：]`;
/** 代入の値の1文字。空白・引用符・バッククォート・半角のカンマとセミコロン・読点・句点・閉じ括弧で値が終わる（120,000 や a,user=b を値に含めない）。 */
const VALUE_CHAR = `[^\\s"'\`,;、。，；）」』]`;
/**
 * 「パスワードは …」と英語の pass の値。語の続き（GoogleDriveに置いた、refactoring）と区別するため、
 * 英数字・記号の6文字以上で、数字か記号を含む値だけを伏せる。
 */
const PARTICLE_VALUE = `(?=[A-Za-z]*[0-9!#$%&*+?@^_~-])[A-Za-z0-9!#$%&*+.?@^_~-]{6,}`;
// 既知の形式を先に並べる。重なった場合は先に見つかった（開始位置が早い、同じなら長い）一致を採る。
export const builtinSecretRules: readonly SecretRule[] = [
  { id: 'private-key', label: '秘密鍵', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g },
  { id: 'anthropic', label: 'APIキー', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai', label: 'APIキー', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'github', label: 'トークン', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: 'gitlab', label: 'トークン', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'aws-access-key', label: 'アクセスキー', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', label: 'APIキー', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'slack', label: 'トークン', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe', label: 'APIキー', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { id: 'jwt', label: 'トークン', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'bearer', label: 'トークン', pattern: /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
  // URLに埋め込んだ利用者名とパスワード（scheme://user:pass@host）。パスワードだけを伏せる。
  { id: 'url-credential', label: 'パスワード', pattern: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)(?=@)/g, group: 1 },
  // password="..." のように引用符で囲んだ値。空白を含む値も伏せる。
  { id: 'assignment-quoted', label: 'パスワード等', pattern: new RegExp(`${SECRET_KEYS}${KEY_GAP}[ \\t]*["'](?!\\[伏せ字)([^"'\\r\\n]{4,})(?=["'])`, 'gi'), group: 1 },
  // password=... や パスワード: ... のような代入。値だけを伏せる。既に伏せた値と短すぎる値は除く。
  { id: 'assignment', label: 'パスワード等', pattern: new RegExp(`${SECRET_KEYS}${KEY_GAP}[ \\t]*["']?(?!\\[伏せ字)(${VALUE_CHAR}{6,})`, 'gi'), group: 1 },
  // pass: … / pass=…。「First pass: refactoring」「CI pass: succeeded」のような英語の文と区別するため、値は数字か記号を含むものだけ。
  { id: 'assignment-pass', label: 'パスワード等', pattern: new RegExp(`(?<![A-Za-z0-9])pass${KEY_GAP}[ \\t]*["']?(?!\\[伏せ字)(${PARTICLE_VALUE})`, 'gi'), group: 1 },
  // パスワードは hunter2… のように、日本語の鍵の後に「は」で値を続ける書き方。全角空白と「 を挟んでもよい。
  { id: 'assignment-particle', label: 'パスワード等', pattern: new RegExp(`(?:パスワード|暗証番号|合言葉)は[ \\t　]*「?(?!\\[伏せ字)(${PARTICLE_VALUE})`, 'g'), group: 1 },
];

/** 高エントロピーの長い文字列。英大文字・小文字・数字をすべて含む32文字以上で、URLのパスの一部は除く。 */
const HIGH_ENTROPY = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const MIN_ENTROPY_BITS = 4.0;
const VAULT_ID = /^[A-Z]{2,6}-[A-Za-z0-9]+$/;
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) { const p = n / value.length; bits -= p * Math.log2(p); }
  return bits;
}
function highEntropyFindings(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const m of text.matchAll(HIGH_ENTROPY)) {
    const value = m[0], start = m.index!;
    // URLのパス（/…/）の一部は文書IDなどが多いので伏せない。クエリの値（?sig=…）は伏せる。
    if (text[start - 1] === '/') continue;
    // REQ-やIN-のようなContextHubの記録IDは伏せない。
    if (VAULT_ID.test(value)) continue;
    if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) continue;
    if (entropy(value) < MIN_ENTROPY_BITS) continue;
    found.push({ rule: 'high-entropy', label: '秘密情報らしい文字列', start, end: start + value.length });
  }
  return found;
}

export interface SecretSettings { enabled: boolean; rules: SecretRule[] }
/** 設定から規則を組み立てる。無効なら規則なし。 */
export function secretSettings(config: Pick<HubConfig, 'privacy'>): SecretSettings {
  const privacy = config.privacy ?? { redactSecrets: true, patterns: [] };
  if (!privacy.redactSecrets) return { enabled: false, rules: [] };
  const extra = privacy.patterns.map((p, i): SecretRule => ({ id: `custom-${i + 1}`, label: p.label, pattern: new RegExp(p.pattern, 'gu') }));
  return { enabled: true, rules: [...builtinSecretRules, ...extra] };
}

/** 重ならない一致を、開始位置の順に返す。 */
export function findSecrets(text: string, settings: SecretSettings): SecretFinding[] {
  if (!settings.enabled || !text) return [];
  const all: SecretFinding[] = [];
  for (const rule of settings.rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    for (const m of text.matchAll(pattern)) {
      if (!m[0]) continue;
      let start = m.index!, end = start + m[0].length;
      if (rule.group !== undefined) {
        const value = m[rule.group];
        if (!value) continue;
        // 値は一致の末尾にある（どの規則も値で終わるように書く）。
        if (!m[0].endsWith(value)) continue;
        start = end - value.length;
      }
      all.push({ rule: rule.id, label: rule.label, start, end });
    }
  }
  all.push(...highEntropyFindings(text));
  // 開始位置が早い順、同じなら長い順、さらに同じなら規則の順（Dart側と同じ順序になるよう明示する）。
  const order = new Map(all.map((f, i) => [f, i]));
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || order.get(a)! - order.get(b)!);
  const result: SecretFinding[] = [];
  let last = -1;
  for (const f of all) {
    if (f.start < last) {
      // 重なった一致は、先に採った箇所を後ろへ広げて1つの伏せ字にする（後ろの部分を平文に残さない）。
      const prev = result.at(-1);
      if (prev && f.end > prev.end) { prev.end = f.end; last = f.end; }
      continue;
    }
    // 既に伏せ字になった箇所は数えない。
    if (text.startsWith(PLACEHOLDER_HEAD, f.start)) continue;
    result.push({ ...f }); last = f.end;
  }
  return result;
}

export interface SecretSummary { label: string; count: number }
export function summarizeFindings(findings: SecretFinding[]): SecretSummary[] {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }));
}
export function describeFindings(findings: SecretFinding[]): string {
  return summarizeFindings(findings).map(s => s.count > 1 ? `${s.label}×${s.count}` : s.label).join('、');
}

export function redactText(text: string, settings: SecretSettings): { text: string; findings: SecretFinding[] } {
  const findings = findSecrets(text, settings);
  if (!findings.length) return { text, findings };
  let out = '', at = 0;
  for (const f of findings) { out += text.slice(at, f.start) + placeholder(f.label); at = f.end; }
  return { text: out + text.slice(at), findings };
}

function redactValue(value: unknown, settings: SecretSettings, findings: SecretFinding[]): unknown {
  if (typeof value === 'string') { const r = redactText(value, settings); findings.push(...r.findings); return r.text; }
  if (Array.isArray(value)) return value.map(v => redactValue(v, settings, findings));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, settings, findings)]));
  return value;
}

const DATA_MARKER = '入力データ(JSON):\n';
/**
 * プロンプトを伏せる。末尾のJSONは文字列の値ごとに伏せて組み立て直し、エスケープを壊さない。
 * JSONとして読めない場合は全体を文字列として伏せる。
 */
export function redactPrompt(prompt: string, settings: SecretSettings): { text: string; findings: SecretFinding[] } {
  if (!settings.enabled) return { text: prompt, findings: [] };
  const at = prompt.lastIndexOf(DATA_MARKER);
  if (at >= 0) {
    const head = prompt.slice(0, at + DATA_MARKER.length), tail = prompt.slice(at + DATA_MARKER.length);
    let data: unknown;
    try { data = JSON.parse(tail); } catch { data = undefined; }
    if (data !== undefined) {
      const findings: SecretFinding[] = [];
      const redactedHead = redactText(head, settings); findings.push(...redactedHead.findings);
      const redactedData = redactValue(data, settings, findings);
      return { text: findings.length ? redactedHead.text + JSON.stringify(redactedData) : prompt, findings };
    }
  }
  return redactText(prompt, settings);
}

/** モデルの出力（JSON）に秘密情報らしい文字列が残っていれば伏せる。JSONとして読めなければそのまま返し、形式の検証に任せる。 */
export function redactCompletion(text: string, settings: SecretSettings): string {
  if (!settings.enabled) return text;
  let data: unknown;
  try { data = JSON.parse(text); } catch { return text; }
  const findings: SecretFinding[] = [];
  const redacted = redactValue(data, settings, findings);
  return findings.length ? JSON.stringify(redacted) : text;
}

/** モデルへ送る直前と、応答を受け取った直後に伏せる。整理・再関連付けの呼び出しはすべてここを通す。 */
export async function completeRedacted(config: Pick<HubConfig, 'privacy'>, llm: LlmClient, prompt: string, opts: LlmOptions): Promise<LlmCompletion> {
  const settings = secretSettings(config);
  const completion = await llm.complete(redactPrompt(prompt, settings).text, opts);
  if (!completion || typeof completion !== 'object' || typeof completion.text !== 'string') return completion;
  return { ...completion, text: redactCompletion(completion.text, settings) };
}

/** 設定の追加規則をアプリへ渡すファイル。形式はFlutterクライアントと共有する取り決め（変えない）。 */
export const privacyPatternsPath = '90_system/privacy/patterns.json';
/** 有効な設定から、アプリと共有する追加規則のファイルの本文を作る。生成日時を入れず、同じ設定なら同じ本文にする。 */
export function privacyPatternsDocument(config: Pick<HubConfig, 'privacy'>): string {
  const privacy = config.privacy ?? { redactSecrets: true, patterns: [] };
  return JSON.stringify({ schema_version: 1, redact_secrets: privacy.redactSecrets, patterns: privacy.patterns.map(p => ({ label: p.label, pattern: p.pattern })) }, null, 2) + '\n';
}
/**
 * Writerロック内で使う。追加規則のファイルを、内容が変わったときだけ書く（同期を無駄に走らせない）。
 * アプリはこのファイルがあれば組み込み規則に加えて適用し、Claude APIへ送る内容を伏せる。
 */
export async function writePrivacyPatternsLocked(config: Pick<HubConfig, 'privacy'>, vault: Vault): Promise<boolean> {
  const text = privacyPatternsDocument(config);
  if (await vault.read(privacyPatternsPath) === text) return false;
  await vault.write(privacyPatternsPath, text);
  return true;
}
