import type { CaptureRequest, CaptureResult, HubConfig } from '@context-hub/core';
import type { TSchema } from 'typebox';

// OpenClaw 2026.9.4 の公開APIから、このアダプターが使う部分だけを表す構造互換型。
export interface DispatchEvent {
  content: string; body?: string; channel?: string; sessionKey?: string; messageId?: string;
  senderId?: string; isGroup?: boolean; timestamp?: number;
}
export interface DispatchContext {
  channelId?: string; accountId?: string; conversationId?: string; sessionKey?: string;
  senderId?: string; messageId?: string;
}
export interface DispatchResult { handled: boolean; text?: string }
export interface ToolContext {
  messageChannel?: string; nativeChannelId?: string; requesterSenderId?: string; agentAccountId?: string;
}
export interface ToolResult { content: { type: 'text'; text: string }[]; details: { ok: boolean } }
export interface HubTool {
  name: string; label: string; description: string; parameters: TSchema;
  execute(id: string, params: unknown): Promise<ToolResult>;
}
export interface PluginLogger { info(message: string): void; warn(message: string): void }
export interface PluginApi {
  config: unknown; pluginConfig?: Record<string, unknown>; logger?: PluginLogger;
  on(name: 'before_dispatch', handler: (event: DispatchEvent, ctx: DispatchContext) => Promise<DispatchResult | undefined>): void;
  registerTool(factory: (ctx: ToolContext) => HubTool | null, opts: { name: string; optional: boolean }): void;
}
export interface HubDependencies {
  loadConfig(path?: string): Promise<HubConfig>;
  capture(config: HubConfig, request: CaptureRequest): Promise<CaptureResult>;
  find(config: HubConfig, query: string): Promise<string>;
  resume(config: HubConfig, project: string): Promise<string>;
  recent(config: HubConfig, n?: number): Promise<string>;
  pending(config: HubConfig): Promise<string>;
}
