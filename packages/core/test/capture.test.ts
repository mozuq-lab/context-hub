import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, symlink, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, readInputs } from '../src/capture.js';
import { defaultConfig } from '../src/config.js';
import { Vault, parseMarkdown } from '../src/storage.js';
import { addProject } from '../src/projects.js';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-test-')); roots.push(root);
  const config = defaultConfig(join(root, 'vault'), join(root, 'state'));
  await new Vault(config).init();
  return { config, vault: new Vault(config), root };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const base = { source: 'android-voice', sourceEventId: 'capture:one', occurredAt: '2026-09-14T01:00:00Z' };

describe('原文の耐久保存', () => {
  test('日本語・CRLF・URL・frontmatterに似た本文を一字も変えない', async () => {
    const { config, vault } = await setup();
    const text = '考えたこと\r\nhttps://example.com/a?q=b\n---\n# 本文\n';
    const saved = await capture(config, { ...base, text });
    expect(saved.inputId).toMatch(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(saved.deduped).toBe(false);
    expect(parseMarkdown((await vault.read(saved.path))!).text).toBe(text);
    expect((await readInputs(config))[0]).toMatchObject({ source: 'android-voice', source_event_id: 'capture:one', text, origin: 'user-note' });
  });
  test('再送は既存IDを返し、別イベントの同じ本文は残す', async () => {
    const { config } = await setup();
    const first = await capture(config, { ...base, text: '面白そう' });
    expect(await capture(config, { ...base, text: '再送で変化' })).toMatchObject({ inputId: first.inputId, deduped: true, receivedAt: first.receivedAt });
    const other = await capture(config, { ...base, sourceEventId: 'two', text: '面白そう' });
    expect(other.inputId).not.toBe(first.inputId);
    expect(await readInputs(config)).toHaveLength(2);
  });
  test('同時に同じイベントを保存しても原文は1件', async () => {
    const { config } = await setup();
    const saved = await Promise.all(Array.from({ length: 8 }, () => capture(config, { ...base, text: '競合' })));
    expect(new Set(saved.map(s => s.inputId)).size).toBe(1);
    expect(await readInputs(config)).toHaveLength(1);
  });
  test('原文保存後・マーカー作成前の停止を再送で回復', async () => {
    const { config, vault } = await setup();
    const saved = await capture(config, { ...base, text: '保持される' });
    for (const file of await vault.files('90_system/receipts/events')) await rm(join(config.vaultPath, file));
    const retried = await capture(config, { ...base, text: '再送本文' });
    expect(retried).toMatchObject({ inputId: saved.inputId, deduped: true });
    expect(await readInputs(config)).toHaveLength(1);
    expect(await vault.files('90_system/receipts/events')).toHaveLength(1);
  });
  test('孤立マーカーで成功を返さない', async () => {
    const { config } = await setup();
    const saved = await capture(config, { ...base, text: '原文' });
    await rm(join(config.vaultPath, saved.path));
    await expect(capture(config, { ...base, text: '再送' })).rejects.toThrow();
  });
  test.each(['', '  \n', 'x'.repeat(8001)])('空・上限外の入力を拒否 %s', async text => {
    const { config } = await setup();
    await expect(capture(config, { ...base, text })).rejects.toThrow();
    expect(await readInputs(config)).toHaveLength(0);
  });
  test('AI作業報告の出典・発生時刻を保持し、未知projectは作らない', async () => {
    const { config } = await setup();
    await addProject(config, { id: 'context-hub', title: 'Context Hub' });
    await capture(config, { ...base, text: '[確認済み] テストした', kind: 'work-summary', tool: 'codex', project: 'context-hub', meta: { session: 'local:sample' } });
    expect((await readInputs(config))[0]).toMatchObject({ origin: 'ai-self-report', tool: 'codex', occurred_at: base.occurredAt, project: 'context-hub' });
    await expect(capture(config, { ...base, sourceEventId: 'unknown', text: 'memo', project: 'unknown' })).rejects.toThrow();
  });
  test('sourceとeventにパス文字を含んでもルート外に出ない', async () => {
    const { config, vault } = await setup();
    await capture(config, { ...base, source: '../../outside', sourceEventId: '/../../escape', text: '安全' });
    expect(await vault.files('90_system/receipts/events')).toHaveLength(1);
    await expect(vault.write('../escape', 'bad')).rejects.toThrow();
    await expect(vault.write('/tmp/escape', 'bad')).rejects.toThrow();
  });
  test('Vault内ディレクトリ・最終ファイルのsymlinkを拒否', async () => {
    const { config, vault, root } = await setup();
    const outside = join(root, 'outside'); await mkdir(outside);
    await rm(join(config.vaultPath, '00_inbox'), { recursive: true });
    await symlink(outside, join(config.vaultPath, '00_inbox'));
    await expect(capture(config, { ...base, text: '漏らさない' })).rejects.toThrow();
    expect(await readdir(outside)).toHaveLength(0);
    await writeFile(join(outside, 'target'), 'original');
    await symlink(join(outside, 'target'), join(config.vaultPath, '20_ideas', 'evil.md'));
    await expect(vault.write('20_ideas/evil.md', 'bad')).rejects.toThrow();
  });
});
