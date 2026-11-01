import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultConfig, loadConfig, validateConfig } from '../src/config.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function written() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-config-')); roots.push(root);
  const file = join(root, 'config.json');
  await writeFile(file, JSON.stringify(defaultConfig(join(root, 'vault'), join(root, 'state'))));
  return file;
}
describe('整理モデルのthinking設定', () => {
  test('既知の水準だけを受け付け、未指定を許す', () => {
    const base = defaultConfig('/tmp/ctx-vault', '/tmp/ctx-state');
    expect(validateConfig(base).organize.llm.thinking).toBeUndefined();
    for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
      expect(validateConfig({ ...base, organize: { ...base.organize, llm: { ...base.organize.llm, thinking: level } } }).organize.llm.thinking).toBe(level);
    }
    for (const level of ['max', 'xhigh', 'adaptive', '', 'LOW']) {
      expect(() => validateConfig({ ...base, organize: { ...base.organize, llm: { ...base.organize.llm, thinking: level } } })).toThrow();
    }
  });
  test('読み込み時の上書きでthinkingだけを差し込める', async () => {
    const file = await written();
    expect((await loadConfig(file)).organize.llm.thinking).toBeUndefined();
    const loaded = await loadConfig(file, { organize: { llm: { thinking: 'low' } } });
    expect(loaded.organize.llm.thinking).toBe('low');
    expect(loaded.organize.llm.provider).toBe('mock');
    expect(loaded.organize.maxItemsPerRun).toBe(20);
  });
});
describe('廃止したlockStaleSec', () => {
  test('既定値に含めず、旧設定に残っていても読み込める', () => {
    const base = defaultConfig('/tmp/ctx-vault', '/tmp/ctx-state');
    expect('lockStaleSec' in base.organize).toBe(false);
    expect(() => validateConfig({ ...base, organize: { ...base.organize, lockStaleSec: 3600 } })).not.toThrow();
  });
});
