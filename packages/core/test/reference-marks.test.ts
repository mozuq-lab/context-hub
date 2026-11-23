import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture, readInputs } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { runCycle } from '../src/cycle.js';
import { find } from '../src/retrieve.js';
import { doctor } from '../src/doctor.js';
import { ingest, intakeFeatures } from '../src/intake.js';
import { readReceipts } from '../src/views.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { buildReferences, rebuildReferences, readReferenceIndex, referenceIndexPath } from '../src/references.js';
import { ReferenceMarkError, readReferenceMarks, setReferenceMark } from '../src/reference-marks.js';
import { Vault } from '../src/storage.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

const at = (iso: string) => ({ occurredAt: iso, receivedAt: iso });
async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール', keywords: ['集約'] });
  return { config, vault };
}

test('資料として保存したメモは、AIが読み取る前から名前付きで資料棚に載り、整理後もAIの分類に関係なく資料として扱う', async () => {
  const { config, vault } = await fixture();
  // MockLlmは「試したい」をアイデアに分類する。資料として保存したので、アイデアのファイルは作らない。
  const saved = await capture(config, { source: 'cli', project: 'hub', ...at('2026-11-01T01:00:00Z'), text: '同期の手法を試したい\n詳しくは https://example.com/sync', reference: true, referenceTitle: '同期の手法の記事' });
  await rebuildReferences(config);
  let text = await buildReferences(config, 'hub');
  expect(text).toContain('同期の手法の記事');
  expect(text).toContain('本人が追加');
  expect(text).toContain('AIの読み取り待ち');
  expect(text).toContain('<https://example.com/sync>');
  let index = (await readReferenceIndex(vault))!;
  expect(index.entries).toEqual([expect.objectContaining({ input_id: saved.inputId, label: '同期の手法の記事', title: '同期の手法の記事', ai_summary: null, added_by: 'person', unorganized: true, projects: ['hub'], project: 'hub' })]);

  await organize(config, new MockLlm());
  const receipt = (await readReceipts(config)).find(r => r.input_id === saved.inputId)!;
  expect(receipt.result?.category).toBe('reference');
  expect(await vault.files('20_ideas')).toEqual([]);
  await rebuildReferences(config);
  text = await buildReferences(config, 'hub');
  expect(text).not.toContain('AIの読み取り待ち');
  index = (await readReferenceIndex(vault))!;
  expect(index.entries[0]).toMatchObject({ label: '同期の手法の記事', ai_summary: expect.stringContaining('同期の手法を試したい'), unorganized: false });
  // 検索の「資料」の絞り込みにも入る。
  expect(await find(config, '', { kinds: ['reference'] })).toContain(saved.inputId);
});

test('保存済みのメモを資料に加え、名前を変え、AIが分類した資料も外せる。外した資料は前の名前と一緒に一覧に残り、戻せる', async () => {
  const { config, vault } = await fixture();
  const plain = await capture(config, { source: 'cli', project: 'hub', ...at('2026-11-01T01:00:00Z'), text: '集約の設計メモ' });
  const article = await capture(config, { source: 'cli', project: 'hub', ...at('2026-11-02T01:00:00Z'), text: '集約の参考 https://example.org/a' });
  await organize(config, new MockLlm());
  await rebuildReferences(config);
  expect((await readReferenceIndex(vault))!.entries.map(e => e.input_id)).toEqual([article.inputId]);

  await setReferenceMark(config, { inputId: plain.inputId, action: 'add', source: 'test', decidedAt: '2026-11-03T00:00:00Z' });
  await setReferenceMark(config, { inputId: plain.inputId, action: 'add', title: '設計の基準', source: 'test', decidedAt: '2026-11-04T00:00:00Z' });
  await setReferenceMark(config, { inputId: article.inputId, action: 'remove', source: 'test', decidedAt: '2026-11-04T00:00:00Z' });
  await rebuildReferences(config);
  let index = (await readReferenceIndex(vault))!;
  expect(index.entries).toEqual([expect.objectContaining({ input_id: plain.inputId, label: '設計の基準', added_by: 'person', unorganized: false })]);
  expect(index.removed).toEqual([expect.objectContaining({ input_id: article.inputId, title: null, label: '集約の参考 https://example.org/a', removed_at: '2026-11-04T00:00:00.000Z' })]);
  const text = await buildReferences(config, 'hub');
  expect(text).toContain('設計の基準');
  expect(text).not.toContain('example.org/a');
  expect(await find(config, '', { kinds: ['reference'] })).not.toContain(article.inputId);

  // 名前を付けた資料を外すと、外す前の名前が一覧に残る。戻すと載り直す。
  await setReferenceMark(config, { inputId: plain.inputId, action: 'remove', source: 'test', decidedAt: '2026-11-05T00:00:00Z' });
  await setReferenceMark(config, { inputId: article.inputId, action: 'add', title: '参考記事', source: 'test', decidedAt: '2026-11-05T00:00:00Z' });
  await rebuildReferences(config);
  index = (await readReferenceIndex(vault))!;
  expect(index.entries.map(e => [e.input_id, e.label])).toEqual([[article.inputId, '参考記事']]);
  expect(index.removed.map(e => [e.input_id, e.title])).toEqual([[plain.inputId, '設計の基準']]);
});

test('同じメモの記録は判断した日時の順で最後のものが効く（届いた順ではない）', async () => {
  const { config, vault } = await fixture();
  const memo = await capture(config, { source: 'cli', project: 'hub', ...at('2026-11-01T01:00:00Z'), text: '集約の設計メモ' });
  await setReferenceMark(config, { inputId: memo.inputId, action: 'add', title: '後の判断', source: 'test', decidedAt: '2026-11-05T00:00:00Z' });
  await setReferenceMark(config, { inputId: memo.inputId, action: 'remove', source: 'test', decidedAt: '2026-11-04T00:00:00Z' });
  await rebuildReferences(config);
  expect((await readReferenceIndex(vault))!.entries.map(e => e.label)).toEqual(['後の判断']);
});

test('見つからないメモと、行動・訂正は資料にできない。同じ受付IDの再送は記録を重ねない', async () => {
  const { config, vault } = await fixture();
  const action = await capture(config, { source: 'cli', project: 'hub', kind: 'action', ...at('2026-11-01T01:00:00Z'), text: '資料を探す' });
  const memo = await capture(config, { source: 'cli', project: 'hub', ...at('2026-11-01T02:00:00Z'), text: '集約の設計メモ' });
  const fix = await correctInput(config, memo.inputId, { text: '集約の設計メモ（直した）', source: 'cli', occurredAt: '2026-11-01T03:00:00Z' });
  await expect(setReferenceMark(config, { inputId: 'IN-01JZZZZZZZZZZZZZZZZZZZZZZZ', action: 'add', source: 'test' })).rejects.toMatchObject({ reason: { code: 'reference-refused', cause: 'missing' } });
  await expect(setReferenceMark(config, { inputId: action.inputId, action: 'add', source: 'test' })).rejects.toBeInstanceOf(ReferenceMarkError);
  await expect(setReferenceMark(config, { inputId: fix.inputId, action: 'add', source: 'test' })).rejects.toMatchObject({ reason: { cause: 'kind' } });
  const first = await setReferenceMark(config, { inputId: memo.inputId, action: 'add', title: '名前', source: 'app', sourceEventId: 'REQ-1' });
  const again = await setReferenceMark(config, { inputId: memo.inputId, action: 'add', title: '名前', source: 'app', sourceEventId: 'REQ-1' });
  expect(again).toEqual({ ...first, deduped: true });
  await expect(setReferenceMark(config, { inputId: memo.inputId, action: 'remove', source: 'app', sourceEventId: 'REQ-1' })).rejects.toThrow('同じ受付ID');
  expect((await readReferenceMarks(vault)).records).toHaveLength(1);
  // 訂正したメモは、資料棚に最新の訂正の本文のURLを載せる。
  await expect(setReferenceMark(config, { inputId: memo.inputId, action: 'add', title: ' 前後に空白 ', source: 'test' })).rejects.toThrow();
  await expect(setReferenceMark(config, { inputId: memo.inputId, action: 'add', title: '改行\nあり', source: 'test' })).rejects.toThrow();
  await expect(setReferenceMark(config, { inputId: memo.inputId, action: 'add', title: 'あ'.repeat(101), source: 'test' })).rejects.toThrow();
});

test('アプリの依頼で資料として保存し、保存済みのメモを加える・外す。対応する欄と依頼を端末へ知らせる', async () => {
  const { config, vault } = await fixture();
  const saved = await packet(config, { project: 'hub', reference: true, reference_title: 'アプリの資料' }, 'あとで読む記事のメモ');
  await ingest(config);
  const [input] = await readInputs(config);
  expect(input!.text).toBe('あとで読む記事のメモ');
  expect((await readReferenceMarks(vault)).records).toEqual([expect.objectContaining({ input_id: input!.id, action: 'add', title: 'アプリの資料', source: 'quickadd', source_event_id: saved.requestId, decided_at: '2026-10-03T10:00:00.000Z' })]);
  const removal = await packet(config, { operation: 'reference-mark', input_id: input!.id, action: 'remove', confirmed: true }, '');
  await ingest(config);
  expect(JSON.parse((await vault.read(`90_system/intake/${removal.requestId}.json`))!).result).toMatchObject({ inputId: input!.id, action: 'remove', deduped: false });
  await runCycle(config, new MockLlm());
  expect((await readReferenceIndex(vault))!.removed.map(e => [e.input_id, e.title])).toEqual([[input!.id, 'アプリの資料']]);
  // 外したメモは、HOMEのプロジェクト未定の資料にも載らない（プロジェクトの資料棚からも外れる）。
  expect(await buildReferences(config, 'hub')).not.toContain('アプリの資料');

  // 理由付きの拒否（見つからないメモ）と、形式の誤り（行動を資料に・名前だけ・外すのに名前）。
  const missing = await packet(config, { operation: 'reference-mark', input_id: 'IN-01JZZZZZZZZZZZZZZZZZZZZZZZ', action: 'add', confirmed: true }, '');
  await packet(config, { kind: 'action', reference: true }, '行動');
  await packet(config, { reference_title: '名前だけ' }, '名前だけのメモ');
  await packet(config, { operation: 'reference-mark', input_id: input!.id, action: 'remove', title: '名前', confirmed: true }, '');
  const run = await ingest(config);
  expect(run.rejected).toBe(4);
  const errors = await Promise.all((await vault.files('90_system/intake-errors')).map(async p => JSON.parse((await vault.read(p))!)));
  expect(errors.find(e => e.path === missing.path)?.reason).toEqual({ code: 'reference-refused', cause: 'missing' });
  expect(await readInputs(config)).toHaveLength(1);

  const features = intakeFeatures(config);
  expect(features.operations).toContain('reference-mark');
  expect(features.capture_fields).toEqual(expect.arrayContaining(['reference', 'reference_title']));
  expect(features.references).toEqual({ title_max_chars: 100 });
});

test('不正な資料の記録は無いものとして資料棚を作り、HOMEとdoctorで示す。一覧は内容が変わったときだけ書く', async () => {
  const { config, vault } = await fixture();
  await capture(config, { source: 'cli', project: 'hub', ...at('2026-11-01T01:00:00Z'), text: '集約の参考 https://example.org/a' });
  await organize(config, new MockLlm());
  await vault.write('90_system/reference-marks/REFM-01JZZZZZZZZZZZZZZZZZZZZZZZ.json', '{"broken":true}\n');
  await rebuildReferences(config);
  expect((await readReferenceIndex(vault))!.entries).toHaveLength(1);
  expect((await doctor(config)).issues.join('\n')).toContain('資料の記録が不正です');
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('資料の記録が不正です');
  const before = await vault.read(referenceIndexPath);
  await rebuildReferences(config);
  expect(await vault.read(referenceIndexPath)).toBe(before);
  expect(new Vault(config)).toBeDefined();
});
