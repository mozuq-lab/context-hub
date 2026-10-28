import { capture, find, loadConfig, pending, recent, resume } from '@context-hub/core';
import type { PluginApi } from './api.js';
import { registerHub } from './plugin.js';

// ホストSDKの実行時ロードに依存しない、公開PluginDefinitionと構造互換のエントリー。
export default {
  id: 'context-hub', name: 'AI Context Hub', description: '専用Discordチャンネルのメモ保存と検索・再開支援',
  register(api: PluginApi) { registerHub(api, { capture, find, loadConfig, pending, recent, resume }); }
};
