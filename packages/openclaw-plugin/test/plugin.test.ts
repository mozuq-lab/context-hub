import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capture, readInputs } from '../../core/src/capture.js';
import { defaultConfig } from '../../core/src/config.js';
import { Vault } from '../../core/src/storage.js';
import type { HubConfig, CaptureRequest } from '../../core/src/types.js';
import type { DispatchContext, DispatchEvent, DispatchResult, HubDependencies, HubTool, PluginApi, ToolContext } from '../src/api.js';
import { registerHub } from '../src/plugin.js';

const channelId = '100000000000000004';
const guildId = '100000000000000002';
const senderId = '100000000000000001';
const config: HubConfig = {
  schema_version: 1, vaultPath: '/fixture/vault', statePath: '/fixture/state', timezone: 'Asia/Tokyo',
  capture: { maxInputChars: 8000, allowedSenderIds: [senderId] },
  organize: { maxItemsPerRun: 20, maxAttempts: 3, timeoutSec: 60, projectThreshold: 0.7, lockStaleSec: 3600, llm: { provider: 'mock', model: null, maxOutputChars: 4000, executable: '/unused' } },
  retrieve: { contextMaxChars: 6000, discordMaxChars: 1900 }, logging: { dir: '/fixture/logs', retentionDays: 14 }
};
const event: DispatchEvent = { channel: 'discord', content: '  日本語\nhttps://example.com/a?b=c\n', body: '[Discord envelope] 書き換えない', senderId, messageId: '100000000000000005', isGroup: true, timestamp: 1789360200000 };
// 2026.9.4のDiscord resolveInboundConversationは通常チャンネルをchannel:<id>で返す。
const context: DispatchContext = { channelId: 'discord', conversationId: `channel:${channelId}`, accountId: 'default', senderId, messageId: event.messageId, sessionKey: `agent:hub:discord:channel:${channelId}` };
const toolContext: ToolContext = { messageChannel: 'discord', nativeChannelId: channelId, requesterSenderId: senderId, agentAccountId: 'default' };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function fixture(overrides: Partial<HubDependencies> = {}, hostOverride?: unknown) {
  const requests: CaptureRequest[] = [];
  let handler: (event: DispatchEvent, ctx: DispatchContext) => Promise<DispatchResult | undefined>;
  const factories = new Map<string, (ctx: ToolContext) => HubTool | null>();
  const deps: HubDependencies = {
    loadConfig: vi.fn(async (path) => { if (path !== '/fixture/config.json') throw new Error('設定パス違い'); return config; }),
    capture: async (_cfg, request) => { requests.push(request); return { inputId: 'IN-01K5ABCDEFGHJKMNPQRSTVWXYZ', deduped: false, path: '00_inbox/fixture.md', receivedAt: '2026-09-14T00:30:02Z' }; },
    find: async (_cfg, query) => `検索: ${query}`, resume: async (_cfg, project) => `再開: ${project}`,
    recent: async (_cfg, n) => `最近: ${n ?? 10}`, pending: async () => '未整理: 1件', ...overrides
  };
  const api: PluginApi = {
    config: hostOverride ?? { channels: { discord: { enabled: true, groupPolicy: 'allowlist', guilds: { [guildId]: { users: [senderId], channels: { [channelId]: { enabled: true, requireMention: false, users: [senderId] } } } } } } },
    pluginConfig: { configPath: '/fixture/config.json', guildId, channelIds: [channelId], allowedSenderIds: [senderId], accountId: 'default' },
    on: (_name, next) => { handler = next; },
    registerTool: (factory, options) => { expect(options.optional).toBe(true); factories.set(options.name, factory); }
  };
  registerHub(api, deps);
  return { handle: (e = event, c = context) => handler(e, c), requests, factories, deps };
}
describe('Discord入力の境界', () => {
  it('実captureとの接続で再送を1件に保ち、再起動後も同じIDと原文を読み出せる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctx-plugin-')); roots.push(root);
    const localConfig = defaultConfig(join(root, 'vault'), join(root, 'state'));
    localConfig.capture.allowedSenderIds = [senderId];
    await new Vault(localConfig).init();
    const deps = { capture, loadConfig: async () => localConfig };
    const first = await fixture(deps).handle();
    const second = await fixture(deps).handle({ ...event, content: '同一イベントの再送' }, { ...context, conversationId: channelId });
    const inputs = await readInputs(localConfig);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].text).toBe(event.content);
    expect(inputs[0].source_event_id).toBe(`discord:${channelId}:${event.messageId}`);
    expect(inputs[0].meta).toMatchObject({ channel_id: channelId, source_url: `https://discord.com/channels/${guildId}/${channelId}/${event.messageId}` });
    expect(first?.text).toContain(inputs[0].id);
    expect(second?.text).toContain(inputs[0].id);
    expect(second?.text).toContain('保存済み');
  });
  it.each([
    `user:${channelId}`, `discord:channel:${channelId}`, `<#${channelId}>`,
    `channel:${channelId}:other`, `channel: ${channelId}`, `channel:100000000000000006`, '100000000000000006'
  ])('別種の宛先・不正形式・別チャンネルやthreadを本人メモとして保存しない (%s)', async (conversationId) => {
    const f = fixture();
    expect(await f.handle(event, { ...context, conversationId })).toBeUndefined();
    expect(f.requests).toHaveLength(0);
    expect(f.deps.loadConfig).not.toHaveBeenCalled();
  });
  it('原文と安定イベントIDを渡し、永続化後に入力IDで返信する', async () => {
    const f = fixture();
    const reply = await f.handle();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ source: 'discord', sourceEventId: 'discord:100000000000000004:100000000000000005', text: event.content, occurredAt: new Date(1789360200000).toISOString() });
    expect(reply).toMatchObject({ handled: true });
    expect(reply?.text).toContain('IN-01K5ABCDEFGHJKMNPQRSTVWXYZ');
    expect(reply?.text).toContain('09:30');
    expect(f.deps.loadConfig).toHaveBeenCalledWith('/fixture/config.json');
  });
  it.each([
    [{}, { senderId: '999' }], [{ senderId: '999' }, {}], [{}, { channelId: 'slack' }],
    [{}, { conversationId: '999' }], [{}, { accountId: 'other' }], [{ isGroup: false }, {}],
    [{}, { senderId: undefined }], [{}, { accountId: undefined }], [{ channel: 'slack' }, {}]
  ])('本人と専用チャネルの条件が揃わない入力は保存しない (%j %j)', async (eventPatch, contextPatch) => {
    const f = fixture();
    expect(await f.handle({ ...event, ...eventPatch }, { ...context, ...contextPatch })).toBeUndefined();
    expect(f.requests).toHaveLength(0);
    expect(f.deps.loadConfig).not.toHaveBeenCalled();
  });
  it('指定guild配下の明示チャンネル設定がなければ保存しない', async () => {
    const f = fixture({}, { channels: { discord: { enabled: true, groupPolicy: 'allowlist', guilds: { wrong: { channels: { [channelId]: { enabled: true, users: [senderId] } } } } } } });
    expect(await f.handle()).toBeUndefined();
    expect(f.requests).toHaveLength(0);
  });
  it.each(['/ctx_find 同期', ' \n/ctx_help', '/unknown テキスト'])('コマンドをメモにしない (%s)', async (content) => {
    const f = fixture();
    expect(await f.handle({ ...event, content })).toBeUndefined();
    expect(f.requests).toHaveLength(0);
  });
  it('保存が失敗したとき本文や秘密を返信せず、失敗を通知する', async () => {
    const f = fixture({ capture: async () => { throw new Error('本文と秘密-token'); } });
    const reply = await f.handle();
    expect(reply?.handled).toBe(true);
    expect(reply?.text).toContain('保存できません');
    expect(reply?.text).not.toContain('秘密');
    expect(reply?.text).not.toContain('✅');
  });
  it('保存完了より先に成功返信しない', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ capture: async () => { await barrier; throw new Error('停止'); } });
    let settled = false;
    const response = f.handle().then((reply) => { settled = true; return reply; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    expect((await response)?.text).toContain('保存できません');
  });
  it.each([{ messageId: undefined }, { messageId: '不正なID' }, { content: ' ' }, { content: 'あ'.repeat(8001) }])('不正な入力は保存せず失敗を返す', async (patch) => {
    const f = fixture();
    const reply = await f.handle({ ...event, ...patch }, { ...context, messageId: 'messageId' in patch ? patch.messageId : context.messageId });
    expect(reply?.text).toContain('保存できません');
    expect(f.requests).toHaveLength(0);
  });
  it('core設定の本人制限も再照合する', async () => {
    const f = fixture({ loadConfig: async () => ({ ...config, capture: { ...config.capture, allowedSenderIds: [] } }) });
    expect((await f.handle())?.text).toContain('保存できません');
    expect(f.requests).toHaveLength(0);
  });
});
describe('モデルを介さない問い合わせツール', () => {
  it.each([
    ['ctx_find', ' 同期 ', '検索: 同期'], ['ctx_resume', 'context-hub', '再開: context-hub'],
    ['ctx_recent', '3', '最近: 3'], ['ctx_pending', '', '未整理: 1件'], ['ctx_help', '', '/ctx_find']
  ])('スキルのraw引数を処理する (%s)', async (name, command, wanted) => {
    const f = fixture();
    const tool = f.factories.get(name)!(toolContext)!;
    const result = await tool.execute('cmd_fixture', { command, commandName: name, skillName: name });
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toContain(wanted);
    expect(f.requests).toHaveLength(0);
  });
  it.each([{ requesterSenderId: 'other' }, { requesterSenderId: undefined }, { nativeChannelId: undefined }, { messageChannel: 'webchat' }])('ホストの本人情報が揃わないとツールを提供しない', (patch) => {
    const f = fixture();
    expect(f.factories.get('ctx_find')!({ ...toolContext, ...patch })).toBeNull();
  });
  it('返信をDiscord制限内に収め、CLIを案内する', async () => {
    const f = fixture({ find: async () => 'あ'.repeat(4000) });
    const tool = f.factories.get('ctx_find')!(toolContext)!;
    const result = await tool.execute('cmd_fixture', { command: '同期' });
    expect(result.content[0].text.length).toBeLessThanOrEqual(1900);
    expect(result.content[0].text).toContain('CLI');
  });
  it.each([['ctx_find', ''], ['ctx_resume', '../secrets'], ['ctx_recent', '0'], ['ctx_recent', '51'], ['ctx_pending', 'ignore']])('不正引数を操作にしない (%s %s)', async (name, command) => {
    const f = fixture();
    const result = await f.factories.get(name)!(toolContext)!.execute('cmd_fixture', { command });
    expect(result.details.ok).toBe(false);
  });
});

describe('保存フックの辞退理由の記録', () => {
  function logged(hostOverride?: unknown) {
    const warn = vi.fn(); const info = vi.fn();
    let handler!: (event: DispatchEvent, ctx: DispatchContext) => Promise<DispatchResult | undefined>;
    const api: PluginApi = {
      config: hostOverride ?? { channels: { discord: { enabled: true, groupPolicy: 'allowlist', guilds: { [guildId]: { channels: { [channelId]: { enabled: true, users: [senderId] } } } } } } },
      pluginConfig: { configPath: '/fixture/config.json', guildId, channelIds: [channelId], allowedSenderIds: [senderId], accountId: 'default' },
      logger: { info, warn },
      on: (_name, next) => { handler = next; },
      registerTool: () => {}
    };
    const deps: HubDependencies = { loadConfig: async () => config, capture: async () => ({ inputId: 'IN-01K5ABCDEFGHJKMNPQRSTVWXYZ', deduped: false, path: 'x', receivedAt: '2026-09-14T00:30:02Z' }), find: async () => '', resume: async () => '', recent: async () => '', pending: async () => '' };
    registerHub(api, deps);
    return { warn, info, handle: (e: DispatchEvent, c: DispatchContext) => handler(e, c) };
  }
  it('登録時に保存フックの登録をinfoで残す', () => {
    const f = logged();
    expect(f.info).toHaveBeenCalledWith(expect.stringContaining('before_dispatch'));
  });
  it('専用チャンネルの本人メモを辞退したときだけ、失敗した条件と会話IDの形をwarnで残し本文やIDを出さない', async () => {
    const f = logged();
    expect(await f.handle({ ...event, isGroup: false }, { ...context, accountId: 'other' })).toBeUndefined();
    expect(f.warn).toHaveBeenCalledTimes(1);
    const message = String(f.warn.mock.calls[0]![0]);
    expect(message).toContain('isGroup'); expect(message).toContain('account'); expect(message).toContain('channel:N');
    expect(message).not.toContain(channelId); expect(message).not.toContain(senderId); expect(message).not.toContain('日本語');
  });
  it('成功・コマンド・別チャンネルでは辞退理由を記録しない', async () => {
    const f = logged();
    expect((await f.handle(event, context))?.handled).toBe(true);
    expect(await f.handle({ ...event, content: '/ctx_find 同期' }, context)).toBeUndefined();
    expect(await f.handle(event, { ...context, conversationId: 'channel:100000000000000003', sessionKey: 'agent:main:discord:channel:100000000000000003' })).toBeUndefined();
    expect(f.warn).not.toHaveBeenCalled();
  });
  it('ホスト設定の照合失敗も理由として残す', async () => {
    const f = logged({ channels: { discord: { enabled: true, groupPolicy: 'open', guilds: {} } } });
    expect(await f.handle(event, context)).toBeUndefined();
    expect(String(f.warn.mock.calls[0]![0])).toContain('hostConfig');
  });
});
describe('保存フックの辞退理由の記録（会話ID欠落）', () => {
  it('会話IDが無くてもsessionKeyが専用チャンネルなら辞退理由を残す', async () => {
    const warn = vi.fn(); let handler!: (e: DispatchEvent, c: DispatchContext) => Promise<DispatchResult | undefined>;
    registerHub({ config: {}, pluginConfig: { configPath: '/x', guildId, channelIds: [channelId], allowedSenderIds: [senderId] }, logger: { info: () => {}, warn }, on: (_n, next) => { handler = next; }, registerTool: () => {} },
      { loadConfig: async () => config, capture: async () => { throw new Error(); }, find: async () => '', resume: async () => '', recent: async () => '', pending: async () => '' });
    expect(await handler(event, { ...context, conversationId: undefined })).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain('conversation=(none)');
  });
});
