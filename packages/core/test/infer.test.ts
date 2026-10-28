import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawInferLlm } from '../src/infer.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const opts = { timeoutSec: 2, maxOutputChars: 4000, model: null };
async function fixture(code: string) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-infer-'));
  roots.push(root);
  const executable = join(root, 'infer fixture');
  await writeFile(executable, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
  return new OpenClawInferLlm({ provider: 'openclaw-infer', executable, model: null, maxOutputChars: 4000, agent: 'hub' });
}
describe('OpenClaw推論の子プロセス境界', () => {
  it('配布する実AI設定例は未作成のhubを要求せずホストの既定を使える', async () => {
    const example = JSON.parse(await readFile(new URL('../../../examples/config.production.openclaw-infer.json', import.meta.url), 'utf8'));
    const root = await mkdtemp(join(tmpdir(), 'ctx-infer-'));
    roots.push(root);
    const executable = join(root, 'infer fixture');
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ok:true,capability:'model.run',outputs:[{text:JSON.stringify(process.argv.slice(2))}]}));\n`, { mode: 0o700 });
    const client = new OpenClawInferLlm({ ...example.organize.llm, executable });
    const { text } = await client.complete('架空のメモ', opts);
    expect(JSON.parse(text)).toEqual(['infer', 'model', 'run', '--prompt', '架空のメモ', '--json', '--gateway']);
  });
  it('2026.9.4のenvelopeから本文を取り出し、引数の命令文字をそのまま渡す', async () => {
    const client = await fixture(`const a = process.argv.slice(2); process.stdout.write(JSON.stringify({ok:true,capability:'model.run',transport:'gateway',outputs:[{text:JSON.stringify(a)}]}));`);
    const prompt = '原文\n$(touch /tmp/ctx-should-never-execute) `echo secret`';
    const { text } = await client.complete(prompt, { ...opts, model: 'openai/test' });
    expect(JSON.parse(text)).toEqual(['infer', 'model', 'run', '--prompt', prompt, '--json', '--gateway', '--agent', 'hub', '--model', 'openai/test']);
  });
  it('設定のthinkingを--thinkingとして末尾に渡す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctx-infer-'));
    roots.push(root);
    const executable = join(root, 'infer fixture');
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ok:true,capability:'model.run',outputs:[{text:JSON.stringify(process.argv.slice(2))}]}));\n`, { mode: 0o700 });
    const client = new OpenClawInferLlm({ provider: 'openclaw-infer', executable, model: null, maxOutputChars: 4000, agent: 'hub', thinking: 'low' });
    const { text } = await client.complete('原文', opts);
    expect(JSON.parse(text)).toEqual(['infer', 'model', 'run', '--prompt', '原文', '--json', '--gateway', '--agent', 'hub', '--thinking', 'low']);
  });
  it('envelopeのprovider/modelを実行モデルとして返し、欠けていれば返さない', async () => {
    const reported = await fixture(`console.log(JSON.stringify({ok:true,capability:'model.run',transport:'gateway',provider:'openai',model:'gpt-6-astra',attempts:[],outputs:[{text:'本文'}]}));`);
    expect(await reported.complete('原文', opts)).toEqual({ text: '本文', model: 'openai/gpt-6-astra' });
    const missing = await fixture(`console.log(JSON.stringify({ok:true,capability:'model.run',outputs:[{text:'本文'}]}));`);
    expect(await missing.complete('原文', opts)).toEqual({ text: '本文' });
    const malformed = await fixture(`console.log(JSON.stringify({ok:true,capability:'model.run',provider:'openai',model:'x/'.repeat(200),outputs:[{text:'本文'}]}));`);
    expect((await malformed.complete('原文', opts)).model).toBeUndefined();
  });
  it('複数のtext出力を改行で結合する', async () => {
    const client = await fixture(`console.log(JSON.stringify({ok:true,capability:'model.run',outputs:[{text:'一行目'},{text:'二行目'}]}));`);
    expect((await client.complete('原文', opts)).text).toBe('一行目\n二行目');
  });
  it.each([
    [`console.log('本文と秘密');`, 'invalid-json'],
    [`console.log(JSON.stringify({ok:false,capability:'model.run',outputs:[{text:'秘密'}]}));`, 'invalid-envelope'],
    [`console.log(JSON.stringify({ok:true,capability:'model.run',outputs:[{mediaUrl:'秘密'}]}));`, 'invalid-envelope'],
    [`process.stderr.write('本文と秘密'); process.exit(3);`, 'exit'],
    [`console.log(JSON.stringify({ok:true,capability:'model.run',outputs:[{text:'秘密'.repeat(5000)}]}));`, 'output-limit'],
    [`process.stdout.write('秘密'.repeat(500000));`, 'output-limit'],
    [`process.stderr.write('秘密'.repeat(500000));`, 'output-limit']
  ])('失敗の本文やstderrをエラーへ混ぜない (%s)', async (code, kind) => {
    const client = await fixture(code);
    await expect(client.complete('原文', opts)).rejects.toThrow(`infer:${kind}`);
    await expect(client.complete('原文', opts)).rejects.not.toThrow('秘密');
  });
  it('時間上限で子プロセスを停止する', async () => {
    const client = await fixture('setInterval(() => {}, 1000);');
    await expect(client.complete('原文', { ...opts, timeoutSec: 0.05 })).rejects.toThrow('infer:timeout');
  });
  it('実行ファイル不在でも環境情報を露出しない', async () => {
    const client = new OpenClawInferLlm({ provider: 'openclaw-infer', executable: '/missing/secret-binary', model: null, maxOutputChars: 4000 });
    await expect(client.complete('原文', opts)).rejects.toThrow('infer:spawn');
  });
  it('OSが起動前に引数を拒否しても本文を例外へ出さない', async () => {
    const client = await fixture('process.exit(0);');
    await expect(client.complete('秘密\0本文', opts)).rejects.toThrow('infer:spawn');
  });
});
