import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault } from '../src/storage.js';
import { capture, readInputs } from '../src/capture.js';
import { correctInput, readCorrectionChains } from '../src/corrections.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() { const root = await mkdtemp(join(tmpdir(),'ctx-correct-')); roots.push(root); const config = defaultConfig(join(root,'vault'),join(root,'state')); await new Vault(config).init(); return { config, vault: new Vault(config) }; }
const base = { source: 'cli', occurredAt: '2026-10-03T10:00:00Z' };
test('同時訂正は一本の履歴となり古い対象を拒否する', async () => {
  const { config, vault } = await setup(); const original = await capture(config,{ ...base, text: '原文', kind: 'work-summary', tool: 'codex' });
  const raw = await vault.read(original.path);
  const results = await Promise.allSettled(['訂正A','訂正B'].map(text => correctInput(config,original.inputId,{ ...base, text })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const [chain] = await readCorrectionChains(config); expect(chain.revisions).toHaveLength(1); expect(chain.latest.origin).toBe('ai-self-report');
  expect(await vault.read(original.path)).toBe(raw);
  await expect(correctInput(config, original.inputId,{ ...base, text:'別訂正' })).rejects.toThrow();
  await correctInput(config,chain.latest.id,{ ...base, text:'最新への訂正' }); expect((await readCorrectionChains(config))[0].revisions).toHaveLength(2);
});
test('同じ訂正の再送は後続訂正を巻き戻さない', async () => {
  const { config } = await setup(); const root = await capture(config,{ ...base, text:'最初' });
  const first = await correctInput(config,root.inputId,{ ...base, sourceEventId:'event-1', text:'訂正1' });
  const latest = await correctInput(config,first.inputId,{ ...base, text:'訂正2' });
  expect(await correctInput(config,root.inputId,{ ...base, sourceEventId:'event-1', text:'訂正1' })).toMatchObject({ inputId:first.inputId, deduped:true });
  expect(await correctInput(config,root.inputId,{ ...base, text:'訂正1' })).toMatchObject({ inputId:first.inputId, deduped:true });
  expect((await readCorrectionChains(config))[0].latest.id).toBe(latest.inputId);
  await expect(correctInput(config,root.inputId,{ ...base, sourceEventId:'event-1',text:'違う本文' })).rejects.toThrow();
});
test('訂正件数と合計本文の上限を超える操作を拒否する', async () => {
  const { config } = await setup(); let saved = await capture(config,{ ...base,text:'原文' });
  for (let i=0;i<32;i++) saved = await correctInput(config,saved.inputId,{ ...base,text:`訂正${i}` });
  await expect(correctInput(config,saved.inputId,{ ...base,text:'33番目' })).rejects.toThrow();
  expect(await readInputs(config)).toHaveLength(33);
  const other = await capture(config,{ ...base,text:'x'.repeat(8000) }); let target=other;
  for (let i=0;i<3;i++) target=await correctInput(config,target.inputId,{ ...base,text:'y'.repeat(8000) });
  await expect(correctInput(config,target.inputId,{ ...base,text:'z' })).rejects.toThrow();
});
