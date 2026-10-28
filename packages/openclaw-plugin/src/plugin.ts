import { Type } from 'typebox';
import type { HubDependencies, PluginApi, ToolResult } from './api.js';

interface PluginSettings {
  configPath: string; guildId: string; channelIds: string[]; allowedSenderIds: string[]; accountId: string;
}
const snowflake = /^\d{17,20}$/u;
const help = '/ctx_find <キーワード> — 検索\n/ctx_resume <プロジェクトID> — 再開\n/ctx_recent [件数] — 最近の入力\n/ctx_pending — 未整理・失敗\n/ctx_help — この案内\n普通の文章はメモとして保存します。全文はCLIで取得できます。';
const descriptions: Record<string, string> = {
  ctx_find: '指定キーワードでContext Hubを検索する', ctx_resume: '指定プロジェクトの現在地・次の一手・未解決を表示する',
  ctx_recent: '最近の入力を表示する（件数は1〜50、省略時10）', ctx_pending: '未整理と整理失敗の入力を表示する', ctx_help: 'Context Hubの操作案内を表示する'
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function settings(raw: unknown): PluginSettings {
  const value = record(raw);
  if (typeof value.configPath !== 'string' || !value.configPath.trim() || typeof value.guildId !== 'string' || !snowflake.test(value.guildId)
    || !Array.isArray(value.channelIds) || value.channelIds.length === 0 || !value.channelIds.every((id) => typeof id === 'string' && snowflake.test(id))
    || !Array.isArray(value.allowedSenderIds) || value.allowedSenderIds.length === 0 || !value.allowedSenderIds.every((id) => typeof id === 'string' && snowflake.test(id))
    || (value.accountId !== undefined && value.accountId !== 'default')) throw new Error('context-hub: プラグイン設定が不正です');
  return { configPath: value.configPath, guildId: value.guildId, channelIds: value.channelIds, allowedSenderIds: value.allowedSenderIds, accountId: 'default' };
}
function output(text: string, ok = true): ToolResult { return { content: [{ type: 'text', text }], details: { ok } }; }
function channelIdFromConversation(value: string | undefined): string | undefined {
  // 通常のDiscord会話はchannel:<id>。数字だけのIDも同じ保存キーに正規化する。
  // user:等の別種の宛先や任意の接頭辞は受け付けない。
  return value?.match(/^(?:channel:)?(\d{17,20})$/u)?.[1];
}
function clipped(text: string, configuredMax: number): string {
  const max = Math.max(100, Math.min(1900, configuredMax));
  if (text.length <= max) return text;
  const suffix = '\n…全文はCLIで取得してください。';
  let prefix = text.slice(0, max - suffix.length);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}
function commandArg(params: unknown, name: string): string | undefined {
  const value = record(params);
  if (Object.keys(value).some((key) => !['command', 'commandName', 'skillName'].includes(key))) return undefined;
  if (value.commandName !== undefined && value.commandName !== name) return undefined;
  if (value.skillName !== undefined && value.skillName !== name) return undefined;
  if (value.command !== undefined && typeof value.command !== 'string') return undefined;
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  return command.length <= 1000 ? command : undefined;
}

// 会話IDの形だけを残す（数字をNへ置換）。ID・本文はログへ出さない。
function conversationShape(value: string | undefined): string {
  return value === undefined ? '(none)' : value.replace(/\d+/gu, 'N').slice(0, 40);
}

export function registerHub(api: PluginApi, deps: HubDependencies): void {
  const config = settings(api.pluginConfig);
  function failures(channel: string | undefined, conversation: string | undefined, sender: string | undefined, account: string | undefined): string[] {
    const failed: string[] = [];
    if (channel !== 'discord') failed.push('channel');
    if (account !== config.accountId) failed.push('account');
    if (!conversation || !config.channelIds.includes(conversation)) failed.push('conversation');
    if (!sender || !config.allowedSenderIds.includes(sender)) failed.push('sender');
    if (failed.length) return failed;
    // before_dispatchにguild IDは無い。Discordの認可後フックと、ホスト設定上の正確なguild/channel対応を組み合わせる。
    const discord = record(record(record(api.config).channels).discord);
    const guild = record(record(discord.guilds)[config.guildId]);
    const entry = record(record(guild.channels)[conversation!]);
    if (!(discord.enabled === true && discord.groupPolicy === 'allowlist' && entry.enabled === true
      && Array.isArray(entry.users) && entry.users.includes(sender))) failed.push('hostConfig');
    return failed;
  }
  const allowed = (...args: Parameters<typeof failures>): boolean => failures(...args).length === 0;

  api.on('before_dispatch', async (event, ctx) => {
    const conversationId = channelIdFromConversation(ctx.conversationId);
    if (event.content.trimStart().startsWith('/')) return undefined;
    const failed = failures(ctx.channelId, conversationId, ctx.senderId, ctx.accountId);
    if (event.channel !== ctx.channelId) failed.push('eventChannel');
    if (event.senderId !== ctx.senderId) failed.push('eventSender');
    if (event.isGroup !== true) failed.push('isGroup');
    if (failed.length) {
      // 専用チャンネル宛て（形式違いを含む）の辞退だけを記録し、他チャンネルの通常会話では何も出さない。
      if (config.channelIds.some((id) => (ctx.conversationId ?? '').includes(id) || (ctx.sessionKey ?? '').includes(id))) {
        api.logger?.warn(`context-hub: before_dispatch declined hub-channel message: failed=[${failed.join(',')}] conversation=${conversationShape(ctx.conversationId)} channel=${ctx.channelId ?? '(none)'} isGroup=${String(event.isGroup)}`);
      }
      return undefined;
    }
    const refuse = (reason: string) => ({ handled: true, text: `❌ 保存できませんでした: ${reason}。再送してください` });
    try {
      const hubConfig = await deps.loadConfig(config.configPath);
      if (!hubConfig.capture.allowedSenderIds.includes(ctx.senderId!)) return refuse('送信者の許可設定を確認してください');
      if (!event.content.trim() || event.content.length > hubConfig.capture.maxInputChars) return refuse('本文が空か文字数上限を超えています');
      if (!event.messageId || event.messageId !== ctx.messageId || !snowflake.test(event.messageId)) return refuse('メッセージIDを確認できません');
      const receivedAt = new Date().toISOString();
      const timestamp = event.timestamp !== undefined && Number.isFinite(event.timestamp) ? new Date(event.timestamp) : undefined;
      const occurredAt = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : receivedAt;
      const saved = await deps.capture(hubConfig, {
        source: 'discord', sourceEventId: `discord:${conversationId}:${event.messageId}`, text: event.content,
        occurredAt, receivedAt, kind: 'memo',
        meta: { sender_id: ctx.senderId!, channel_id: conversationId!, configured_guild_id: config.guildId,
          source_url: `https://discord.com/channels/${config.guildId}/${conversationId}/${event.messageId}`,
          occurred_at_basis: timestamp ? 'message-timestamp' : 'received-at' }
      });
      const time = new Intl.DateTimeFormat('ja-JP', { timeZone: hubConfig.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(saved.receivedAt));
      return { handled: true, text: `✅ 保存 ${saved.inputId} (${time})${saved.deduped ? '（保存済み）' : ''}` };
    } catch { return refuse('保存先または設定を確認してください'); }
  });
  api.logger?.info('context-hub: before_dispatch registered');

  for (const [name, description] of Object.entries(descriptions)) {
    api.registerTool((ctx) => {
      if (!allowed(ctx.messageChannel, ctx.nativeChannelId, ctx.requesterSenderId, ctx.agentAccountId)) return null;
      return {
        name, label: name, description,
        parameters: Type.Object({ command: Type.Optional(Type.String({ description: 'スラッシュコマンドの引数' })), commandName: Type.Optional(Type.String()), skillName: Type.Optional(Type.String()) }, { additionalProperties: false }),
        async execute(_id, params) {
          const command = commandArg(params, name);
          if (command === undefined) return output('引数が不正です。/ctx_help を参照してください。', false);
          try {
            const hubConfig = await deps.loadConfig(config.configPath);
            if (!hubConfig.capture.allowedSenderIds.includes(ctx.requesterSenderId!)) return output('送信者の許可設定を確認してください。', false);
            let text: string;
            if (name === 'ctx_find' && command) text = await deps.find(hubConfig, command);
            else if (name === 'ctx_resume' && /^[a-z0-9][a-z0-9-]{1,40}$/u.test(command)) text = await deps.resume(hubConfig, command);
            else if (name === 'ctx_recent' && (command === '' || (/^\d{1,2}$/u.test(command) && Number(command) >= 1 && Number(command) <= 50))) text = await deps.recent(hubConfig, command ? Number(command) : undefined);
            else if (name === 'ctx_pending' && command === '') text = await deps.pending(hubConfig);
            else if (name === 'ctx_help' && command === '') text = help;
            else return output('引数が不正です。/ctx_help を参照してください。', false);
            return output(clipped(text, hubConfig.retrieve.discordMaxChars));
          } catch { return output('取得できませんでした。設定と保存先を確認してください。', false); }
        }
      };
    }, { name, optional: true });
  }
}
