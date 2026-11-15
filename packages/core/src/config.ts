import {projectIdSchema} from './projects.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { z, ZodError } from 'zod';
import { issuePaths } from './error-message.js';
import type { HubConfig } from './types.js';

export function expandPath(value: string): string {
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}
export function defaultConfig(vaultPath: string, statePath = join(homedir(), 'Library/Application Support/context-hub')): HubConfig {
  return {
    schema_version: 1, vaultPath: expandPath(vaultPath), statePath: expandPath(statePath), timezone: 'Asia/Tokyo',
    policy: {projectRoots:[]},
    capture: { maxInputChars: 8000, allowedSenderIds: [] },
    organize: { maxItemsPerRun: 20, maxAttempts: 3, timeoutSec: 60, projectThreshold: 0.7,
      llm: { provider: 'mock', model: null, maxOutputChars: 4000, executable: 'openclaw' } },
    retrieve: { contextMaxChars: 6000, discordMaxChars: 1900, staleDays: 14, digestDays: 7 },
    logging: { dir: join(expandPath(statePath), 'logs'), retentionDays: 14 },
    git: { enabled: false, repos: [], maxCommits: 30, lookbackDays: 14 },
    privacy: { redactSecrets: true, patterns: [] },
    backup: { dir: null, verifyMaxAgeDays: 7 },
  };
}
const positive = z.number().int().min(1).max(1_000_000);
const configSchema = z.object({
  schema_version: z.literal(1), vaultPath: z.string().min(1), statePath: z.string().min(1), timezone: z.literal('Asia/Tokyo'),
  policy: z.object({projectRoots:z.array(z.object({path:z.string().refine(isAbsolute,'絶対パスが必要です'),projectId:projectIdSchema}).strict()).max(1000)}).strict(),
  capture: z.object({ maxInputChars: positive.max(100_000), allowedSenderIds: z.array(z.string()) }).strict(),
  organize: z.object({ maxItemsPerRun: positive.max(1000), maxAttempts: positive.max(10), timeoutSec: positive.max(600), projectThreshold: z.number().min(0).max(1),
    // 旧版の設定を読めるよう受け付けるが使わない。ロックは自動回収せず、ctx doctor --unlock で明示的に回収する。
    lockStaleSec: positive.optional(),
    llm: z.object({ provider: z.enum(['mock', 'openclaw-infer']), model: z.string().min(1).nullable(), maxOutputChars: positive.max(100_000), executable: z.string().min(1), agent: z.string().regex(/^[a-z0-9_-]+$/).optional(), thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high']).optional() }).strict() }).strict(),
  retrieve: z.object({ contextMaxChars: positive.min(200), discordMaxChars: positive.min(100).max(2000), staleDays: positive.max(3650).default(14), digestDays: positive.max(366).default(7) }).strict(),
  logging: z.object({ dir: z.string().min(1), retentionDays: positive.max(3650) }).strict(),
  // 既定では無効。本人が明示したローカルリポジトリだけを読み取り専用で参照する。
  git: z.object({ enabled: z.boolean(), repos: z.array(z.object({ projectId: projectIdSchema, path: z.string().refine(v => isAbsolute(v) || v === '~' || v.startsWith('~/'), '絶対パスが必要です'), name: z.string().min(1).max(100).regex(/^[^\r\n]+$/).optional() }).strict()).max(100),
    maxCommits: positive.max(200), lookbackDays: positive.max(366) }).strict().refine(g => new Set(g.repos.map(r => expandPath(r.path))).size === g.repos.length, '同じリポジトリを重ねて設定できません').default({ enabled: false, repos: [], maxCommits: 30, lookbackDays: 14 }),
  // 既定で有効。追加の規則は読み込み時に正規表現として組み立てられることを確かめる。
  privacy: z.object({ redactSecrets: z.boolean(), patterns: z.array(z.object({ label: z.string().min(1).max(40).regex(/^[^\]\r\n]+$/), pattern: z.string().min(1).max(500).refine(v => { try { new RegExp(v, 'gu'); return true; } catch { return false; } }, '正規表現が不正です') }).strict()).max(50) }).strict().default({ redactSecrets: true, patterns: [] }),
  // 既定では未設定。バックアップ先を書くと、ctx backup verify が最新のアーカイブを確かめ、HOMEが復元点の古さを知らせる。
  backup: z.object({ dir: z.string().refine(v => isAbsolute(v) || v === '~' || v.startsWith('~/'), '絶対パスが必要です').nullable(), verifyMaxAgeDays: positive.max(3650) }).strict().default({ dir: null, verifyMaxAgeDays: 7 }),
}).strict();
export function validateConfig(value: unknown): HubConfig {
  const c = configSchema.parse(value);
  c.vaultPath = expandPath(c.vaultPath); c.statePath = expandPath(c.statePath); c.logging.dir = expandPath(c.logging.dir);
  c.git = { ...c.git, repos: c.git.repos.map(r => ({ ...r, path: expandPath(r.path) })) };
  if (c.backup.dir !== null) c.backup = { ...c.backup, dir: expandPath(c.backup.dir) };
  for (const outside of [c.statePath, c.logging.dir, ...(c.backup.dir !== null ? [c.backup.dir] : [])]) {
    const rel = relative(c.vaultPath, outside);
    if (!rel || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel))) throw new Error('ローカル状態・ログ・バックアップ先はVaultの外へ設定してください');
  }
  return c;
}
/** 設定ファイルへ上書きする値。入れ子は部分指定でよい。 */
export type ConfigOverrides = Partial<Omit<HubConfig, 'capture' | 'organize' | 'retrieve' | 'logging' | 'git' | 'privacy' | 'backup'>> & {
  backup?: Partial<NonNullable<HubConfig['backup']>>; capture?: Partial<HubConfig['capture']>; git?: Partial<HubConfig['git']>; privacy?: Partial<HubConfig['privacy']>; retrieve?: Partial<HubConfig['retrieve']>; logging?: Partial<HubConfig['logging']>;
  organize?: Partial<Omit<HubConfig['organize'], 'llm'>> & { llm?: Partial<HubConfig['organize']['llm']> };
};
export async function loadConfig(path?: string, overrides: ConfigOverrides = {}): Promise<HubConfig> {
  const filename = expandPath(path ?? process.env.CONTEXT_HUB_CONFIG ?? '~/.config/context-hub/config.json');
  let raw: Record<string, any> = {};
  try { raw = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('設定ファイルを読み取れません');
    if (!overrides.vaultPath) throw new Error('設定ファイル、または --vault で保存先を明示してください');
  }
  if (typeof (overrides.vaultPath ?? raw.vaultPath) !== 'string') throw new Error('vaultPath が必要です');
  const defaults = defaultConfig(overrides.vaultPath ?? raw.vaultPath, overrides.statePath ?? raw.statePath);
  const c = { ...defaults, ...raw, ...overrides,
    capture: { ...defaults.capture, ...raw.capture, ...overrides.capture },
    organize: { ...defaults.organize, ...raw.organize, ...overrides.organize,
      llm: { ...defaults.organize.llm, ...raw.organize?.llm, ...overrides.organize?.llm } },
    retrieve: { ...defaults.retrieve, ...raw.retrieve, ...overrides.retrieve },
    logging: { ...defaults.logging, ...raw.logging, ...overrides.logging },
    git: { ...defaults.git, ...raw.git, ...overrides.git },
    privacy: { ...defaults.privacy, ...raw.privacy, ...overrides.privacy },
    backup: { ...defaults.backup, ...raw.backup, ...overrides.backup },
  };
  // 値は秘密を含みうるので出さず、誤りのあるキーの場所だけを示す。
  try { return validateConfig(c); } catch (error) { throw new Error(error instanceof ZodError ? `設定のキー・型・値を確認してください: ${issuePaths(error).join('、')}` : error instanceof Error && error.message.startsWith('ローカル状態') ? error.message : '設定のキー・型・値、またはVaultと状態ディレクトリの分離を確認してください'); }
}
