import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { HubConfig } from './types.js';

export function expandPath(value: string): string {
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}
export function defaultConfig(vaultPath: string, statePath = join(homedir(), 'Library/Application Support/context-hub')): HubConfig {
  return {
    schema_version: 1, vaultPath: expandPath(vaultPath), statePath: expandPath(statePath), timezone: 'Asia/Tokyo',
    capture: { maxInputChars: 8000, allowedSenderIds: [] },
    organize: { maxItemsPerRun: 20, maxAttempts: 3, timeoutSec: 60, projectThreshold: 0.7, lockStaleSec: 3600,
      llm: { provider: 'mock', model: null, maxOutputChars: 4000, executable: 'openclaw' } },
    retrieve: { contextMaxChars: 6000, discordMaxChars: 1900 },
    logging: { dir: join(expandPath(statePath), 'logs'), retentionDays: 14 },
  };
}
const positive = z.number().int().min(1).max(1_000_000);
const configSchema = z.object({
  schema_version: z.literal(1), vaultPath: z.string().min(1), statePath: z.string().min(1), timezone: z.literal('Asia/Tokyo'),
  capture: z.object({ maxInputChars: positive.max(100_000), allowedSenderIds: z.array(z.string()) }).strict(),
  organize: z.object({ maxItemsPerRun: positive.max(1000), maxAttempts: positive.max(10), timeoutSec: positive.max(600), projectThreshold: z.number().min(0).max(1), lockStaleSec: positive,
    llm: z.object({ provider: z.enum(['mock', 'openclaw-infer']), model: z.string().min(1).nullable(), maxOutputChars: positive.max(100_000), executable: z.string().min(1), agent: z.string().regex(/^[a-z0-9_-]+$/).optional(), thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high']).optional() }).strict() }).strict(),
  retrieve: z.object({ contextMaxChars: positive.min(200), discordMaxChars: positive.min(100).max(2000) }).strict(),
  logging: z.object({ dir: z.string().min(1), retentionDays: positive.max(3650) }).strict(),
}).strict();
export function validateConfig(value: unknown): HubConfig {
  const c = configSchema.parse(value);
  c.vaultPath = expandPath(c.vaultPath); c.statePath = expandPath(c.statePath); c.logging.dir = expandPath(c.logging.dir);
  for (const outside of [c.statePath, c.logging.dir]) {
    const rel = relative(c.vaultPath, outside);
    if (!rel || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel))) throw new Error('ローカル状態・ログはVaultの外へ設定してください');
  }
  return c;
}
/** 設定ファイルへ上書きする値。入れ子は部分指定でよい。 */
export type ConfigOverrides = Partial<Omit<HubConfig, 'capture' | 'organize' | 'retrieve' | 'logging'>> & {
  capture?: Partial<HubConfig['capture']>; retrieve?: Partial<HubConfig['retrieve']>; logging?: Partial<HubConfig['logging']>;
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
  };
  try { return validateConfig(c); } catch { throw new Error('設定のキー・型・値、またはVaultと状態ディレクトリの分離を確認してください'); }
}
