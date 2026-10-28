import type { HubConfig, LlmClient, LlmCompletion, LlmOptions } from './types.js';
import { spawn } from 'node:child_process';

function failure(kind: string): Error { return new Error(`infer:${kind}`); }
function startProcess(executable: string, args: string[]) {
  try { return spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw failure('spawn'); }
}

// envelopeのprovider/modelは記録用の表示名。想定外の値は採用せず未報告として扱う。
const modelPart = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/;
function reportedModel(value: Record<string, unknown>): string | undefined {
  const { provider, model } = value;
  if (typeof provider !== 'string' || typeof model !== 'string' || !modelPart.test(provider)) return undefined;
  const parts = model.split('/');
  return parts.every((part) => modelPart.test(part)) && parts.length <= 3 ? `${provider}/${model}` : undefined;
}

function extractCompletion(raw: string, maxChars: number): LlmCompletion {
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { throw failure('invalid-json'); }
  if (!envelope || typeof envelope !== 'object') throw failure('invalid-envelope');
  const value = envelope as Record<string, unknown>;
  if (value.ok !== true || value.capability !== 'model.run' || !Array.isArray(value.outputs) || value.outputs.length === 0) throw failure('invalid-envelope');
  const parts = value.outputs.map((output: unknown) => {
    if (!output || typeof output !== 'object' || !('text' in output) || typeof output.text !== 'string') throw failure('invalid-envelope');
    return output.text;
  });
  const text = parts.join('\n');
  if (!text.trim()) throw failure('invalid-envelope');
  if (text.length > maxChars) throw failure('output-limit');
  const model = reportedModel(value);
  return model ? { text, model } : { text };
}

export class OpenClawInferLlm implements LlmClient {
  constructor(private readonly config: HubConfig['organize']['llm']) {}
  async complete(prompt: string, opts: LlmOptions): Promise<LlmCompletion> {
    const maxChars = Math.min(opts.maxOutputChars, this.config.maxOutputChars);
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || !Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0 || opts.timeoutSec > 3600) throw failure('options');
    const args = ['infer', 'model', 'run', '--prompt', prompt, '--json', '--gateway'];
    if (this.config.agent) args.push('--agent', this.config.agent);
    const model = opts.model ?? this.config.model;
    if (model) args.push('--model', model);
    if (this.config.thinking) args.push('--thinking', this.config.thinking);
    return await new Promise<LlmCompletion>((resolve, reject) => {
      // 本文をシェルへ渡さず、stdout/stderrの生データを例外やログへ出さない。
      const child = startProcess(this.config.executable, args);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderrBytes = 0;
      let finished = false;
      const abort = (kind: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(failure(kind));
      };
      const timer = setTimeout(() => abort('timeout'), opts.timeoutSec * 1000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (finished) return;
        bytes += chunk.length;
        // JSONのエスケープと固定メタデータに余裕を持たせつつ、メモリ使用量を制限する。
        if (bytes > maxChars * 6 + 65_536) return abort('output-limit');
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 16_384) abort('output-limit');
      });
      child.once('error', () => abort('spawn'));
      child.once('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (code !== 0) return reject(failure('exit'));
        try { resolve(extractCompletion(Buffer.concat(chunks).toString('utf8'), maxChars)); }
        catch (error) { reject(error); }
      });
    });
  }
}
