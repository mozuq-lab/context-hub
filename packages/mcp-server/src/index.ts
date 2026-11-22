#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, userFacingError } from '@context-hub/core';
import { createServer } from './server.js';

// 標準出力はMCPの通信に使うため、案内とエラーは標準エラーへ書く。
try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, vault: { type: 'string' }, state: { type: 'string' } }, strict: true });
  const config = await loadConfig(values.config, { ...(values.vault ? { vaultPath: values.vault } : {}), ...(values.state ? { statePath: values.state } : {}) });
  await createServer(config).connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`context-hub MCPサーバーを起動できません: ${userFacingError(error)}\n`);
  process.exitCode = 2;
}
