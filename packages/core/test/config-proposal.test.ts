import { expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { proposeOpenClaw } from '../../../scripts/openclaw-proposal.mjs';

const options = {
  repo: '/repo', home: '/home/example', configPath: '/custom/context-hub.json',
  guildId: '200000000000000001', channelId: '200000000000000002',
  allowedSenderIds: ['200000000000000003', '200000000000000004']
};
const otherChannel = '200000000000000005';
const originalConfig = () => ({
  gateway: { auth: { token: 'SAMPLE_SECRET' } },
  agents: { entries: { main: { model: 'existing' } } },
  channels: { discord: { enabled: true, groupPolicy: 'allowlist', guilds: {
    [options.guildId]: { requireMention: true, channels: {
      [otherChannel]: { enabled: true, requireMention: true }
    } }
  } } },
  plugins: { entries: { discord: { enabled: true } } }, bindings: []
});

test('明示した別の有効IDを反映し既存main・別channel・認証・他pluginを保持する', () => {
  const original = originalConfig(), before = structuredClone(original);
  const result = proposeOpenClaw(original, options);
  expect(original).toEqual(before);
  expect(result.config.bindings).toContainEqual({
    agentId: 'hub', match: { channel: 'discord', accountId: 'default', peer: { kind: 'channel', id: options.channelId } }
  });
  expect(result.config.agents.entries.main).toEqual(original.agents.entries.main);
  expect(result.config.gateway).toEqual(original.gateway);
  expect(result.config.plugins.entries.discord).toEqual(original.plugins.entries.discord);
  expect(result.config.channels.discord.guilds[options.guildId].channels[otherChannel]).toEqual({ enabled: true, requireMention: true });
  expect(result.config.channels.discord.guilds[options.guildId].channels[options.channelId].users).toEqual(options.allowedSenderIds);
  expect(result.config.plugins.entries['context-hub'].config).toMatchObject({
    configPath: options.configPath, guildId: options.guildId, channelIds: [options.channelId], allowedSenderIds: options.allowedSenderIds
  });
  expect(result.diff).not.toContain('SAMPLE_SECRET');
  expect(result.diff).toContain(options.channelId);
  expect(proposeOpenClaw(result.config, options).changes).toHaveLength(0);
});

test('別の利用者の設定を独立して生成し以前のIDへフォールバックしない', () => {
  const changed = { ...options, guildId: '300000000000000001', channelId: '300000000000000002', allowedSenderIds: ['300000000000000003'] };
  const result = proposeOpenClaw(originalConfig(), changed);
  expect(result.diff).toContain(changed.guildId);
  expect(result.diff).toContain(changed.channelId);
  expect(result.diff).toContain(changed.allowedSenderIds[0]);
  expect(result.diff).not.toContain(options.channelId);
});

test('IDの不足・型違い・桁数不正・空の許可リストを拒否する', () => {
  for (const key of ['configPath', 'guildId', 'channelId', 'allowedSenderIds'] as const) {
    const missing: any = { ...options }; delete missing[key];
    expect(() => proposeOpenClaw(originalConfig(), missing)).toThrow();
  }
  for (const guildId of ['', '123', '200000000000000001 ', '__proto__', 200000000000000001]) {
    expect(() => proposeOpenClaw(originalConfig(), { ...options, guildId } as any)).toThrow();
  }
  for (const channelId of ['abc', '200000000000000002\n', null]) {
    expect(() => proposeOpenClaw(originalConfig(), { ...options, channelId } as any)).toThrow();
  }
  for (const allowedSenderIds of [[], ['bad'], '200000000000000003', [123], null]) {
    expect(() => proposeOpenClaw(originalConfig(), { ...options, allowedSenderIds } as any)).toThrow();
  }
});

test('既存hub・対象チャンネル・bindingの競合は上書きしない', () => {
  const hub = originalConfig();
  (hub.agents.entries as any).hub = { name: 'other' };
  const channel = originalConfig();
  (channel.channels.discord.guilds[options.guildId].channels as any)[options.channelId] = { enabled: false };
  const binding = originalConfig();
  (binding.bindings as any[]).push({ agentId: 'other', match: { channel: 'discord', accountId: 'default', peer: { kind: 'channel', id: options.channelId } } });
  for (const original of [hub, channel, binding]) {
    const before = structuredClone(original);
    expect(() => proposeOpenClaw(original, options)).toThrow();
    expect(original).toEqual(before);
  }
});

test('単独mainのDiscord経路と常駐処理の所有者を保持する', () => {
  const { config } = proposeOpenClaw({ ...originalConfig(), agents: { entries: { main: { workspace: '/main' } } } }, options);
  expect(config.agents.ownership).toBe('explicit');
  expect(config.agents.defaults.heartbeat.agentId).toBe('main');
  expect(config.agents.defaults.systemAgent.agentId).toBe('main');
  expect(config.bindings).toEqual([
    { agentId: 'hub', match: { channel: 'discord', accountId: 'default', peer: { kind: 'channel', id: options.channelId } } },
    { agentId: 'main', match: { channel: 'discord', accountId: 'default' } }
  ]);
});

test('未知のエージェント構成や競合する所有者を割り当て直さない', () => {
  for (const agents of [
    { entries: { main: {}, other: {} } },
    { entries: { main: { default: true } } },
    { entries: { main: {} }, defaults: { systemAgent: { agentId: 'other' } } }
  ]) expect(() => proposeOpenClaw({ ...originalConfig(), agents }, options)).toThrow();
});

test('有効なDiscord allowlistがない既存設定を変更せず拒否する', () => {
  for (const discord of [undefined, null, { enabled: false, groupPolicy: 'allowlist' }, { enabled: true, groupPolicy: 'open' }, { enabled: true }]) {
    const original = { ...originalConfig(), channels: { discord } };
    const before = structuredClone(original);
    expect(() => proposeOpenClaw(original, options)).toThrow(/Discord.*allowlist/);
    expect(original).toEqual(before);
  }
});

test('CLIは明示した設定と複数の許可ユーザーから差分だけを生成する', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'context-hub-proposal-'));
  try {
    const file = join(folder, 'input.json'), input = JSON.stringify(originalConfig());
    await writeFile(file, input);
    const script = fileURLToPath(new URL('../../../scripts/openclaw-proposal.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, file,
      '--hub-config', options.configPath, '--guild-id', options.guildId, '--channel-id', options.channelId,
      ...options.allowedSenderIds.flatMap(id => ['--allowed-sender-id', id])
    ], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(options.channelId);
    expect(run.stdout).toContain(options.allowedSenderIds[1]);
    expect(run.stdout).toContain(options.configPath);
    expect(run.stdout).not.toContain('SAMPLE_SECRET');
    expect(await readFile(file, 'utf8')).toBe(input);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('CLIは設定ファイルやIDの不足で差分を出力しない', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'context-hub-proposal-'));
  try {
    const file = join(folder, 'input.json');
    await writeFile(file, JSON.stringify(originalConfig()));
    const script = fileURLToPath(new URL('../../../scripts/openclaw-proposal.mjs', import.meta.url));
    for (const args of [
      ['--guild-id', options.guildId, '--channel-id', options.channelId, '--allowed-sender-id', options.allowedSenderIds[0]],
      [file],
      [file, '--guild-id', 'bad', '--channel-id', options.channelId, '--allowed-sender-id', options.allowedSenderIds[0]]
    ]) {
      const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).not.toContain('SAMPLE_SECRET');
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
