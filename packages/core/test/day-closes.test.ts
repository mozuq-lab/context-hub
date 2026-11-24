import { afterEach, expect, test } from 'vitest';
import { rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { ingest, intakeErrorMessage, intakeErrorSchema, intakeFeatures, readIntakeReceipts } from '../src/intake.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { buildDigest } from '../src/digest.js';
import { doctor } from '../src/doctor.js';
import { hash } from '../src/storage.js';
import { DayCloseError, currentDayNote, dayClosesByDate, normalizeDayNote, readDayCloses, setDayClose } from '../src/day-closes.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const clock = new Date('2026-11-24T12:00:00Z');

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  return { config, vault, home: async () => (await vault.read('HOME.md')) ?? '' };
}

test('締めたひとことは次に締めるか消すまでHOMEの先頭に出て、ふりかえりに日付順で載る', async () => {
  const { config, vault, home } = await fixture();
  const first = await setDayClose(config, { action: 'close', on: '2026-11-23', note: '  見積もりの返事を確かめる\n\n発注は午後\n', source: 'cli', now: clock });
  expect(first).toMatchObject({ action: 'close', deduped: false });
  expect(currentDayNote((await readDayCloses(vault)).records)).toMatchObject({ on: '2026-11-23', note: '  見積もりの返事を確かめる\n\n発注は午後' });
  await rebuildDashboard(config, { now: clock });
  let shown = await home();
  expect(shown).toContain('## 前回の締め（2026-11-23・昨日）\n明日へのひとこと:\n>   見積もりの返事を確かめる\n> \n> 発注は午後\n');
  // 先頭（次の一手より前）に置く。
  expect(shown.indexOf('## 前回の締め')).toBeLessThan(shown.indexOf('## プロジェクト一覧'));

  // 同じ日を締め直すと、最後の締めがその日の締めになる。ひとことなしで締めると、前のひとことは出さない。
  await setDayClose(config, { action: 'close', on: '2026-11-23', note: '発注は明日', source: 'cli', now: clock });
  expect(dayClosesByDate((await readDayCloses(vault)).records).map(c => c.note)).toEqual(['発注は明日']);
  await setDayClose(config, { action: 'close', on: '2026-11-24', note: null, source: 'cli', now: clock });
  await rebuildDashboard(config, { now: clock });
  expect(await home()).not.toContain('## 前回の締め');

  // 消すと出さない（締めの記録は残る）。
  const latest = await setDayClose(config, { action: 'close', on: '2026-11-24', note: 'テストを書く', source: 'cli', now: clock });
  await rebuildDashboard(config, { now: clock });
  expect(await home()).toContain('## 前回の締め（2026-11-24・今日）');
  await setDayClose(config, { action: 'dismiss', closeId: latest.dayCloseId, source: 'cli' });
  await rebuildDashboard(config, { now: clock });
  shown = await home();
  expect(shown).not.toContain('## 前回の締め');
  // 既に消したひとことをもう一度消しても、記録は増えない。
  expect((await setDayClose(config, { action: 'dismiss', closeId: latest.dayCloseId, source: 'cli' })).deduped).toBe(true);
  const digest = await buildDigest(config, { now: clock });
  expect(digest).toContain('## 1日の締め\n- 締めた日: 2日（直近7日のうち）\n- 2026-11-23: 発注は明日\n- 2026-11-24: テストを書く\n');
});

test('締める日の範囲・ひとことの上限・消す対象を確かめる', async () => {
  const { config } = await fixture();
  const refuse = async (on: string) => {
    const error = await setDayClose(config, { action: 'close', on, note: null, source: 'cli', now: clock }).catch(e => e);
    expect(error).toBeInstanceOf(DayCloseError);
  };
  await refuse('2026-11-26');
  await refuse('2026-11-16');
  await setDayClose(config, { action: 'close', on: '2026-11-17', note: null, source: 'cli', now: clock });
  await expect(setDayClose(config, { action: 'close', on: '2026-11-24', note: 'あ'.repeat(301), source: 'cli', now: clock })).rejects.toThrow('300文字');
  await expect(setDayClose(config, { action: 'close', on: '2026-11-24', note: '1\n2\n3\n4', source: 'cli', now: clock })).rejects.toThrow('3行');
  await expect(setDayClose(config, { action: 'close', on: '2026-11-24', note: 'タブ\tは不可', source: 'cli', now: clock })).rejects.toThrow('使えない文字');
  expect(normalizeDayNote('\r\n \r\n')).toBeNull();
  const error = await setDayClose(config, { action: 'dismiss', closeId: 'DAY-01JZZZZZZZZZZZZZZZZZZZZZZZ', source: 'cli' }).catch(e => e);
  expect((error as DayCloseError).reason.cause).toBe('missing');
});

test('受付から締め・消すができ、同じ依頼の再送は記録を増やさず、断った理由を残す', async () => {
  const { config, vault, home } = await fixture();
  expect(intakeFeatures(config).operations).toContain('day-close');
  expect(intakeFeatures(config).day_close).toEqual({ max_chars: 300, max_lines: 3, back_days: 7 });
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone }).format(new Date());
  await packet(config, { operation: 'day-close', action: 'close', confirmed: true }, 'ひとこと'); expect((await ingest(config)).rejected).toBe(1);
  await packet(config, { operation: 'day-close', action: 'dismiss', close_id: 'DAY-01JZZZZZZZZZZZZZZZZZZZZZZZ', confirmed: true }, '本文は不可'); expect((await ingest(config)).rejected).toBe(1);
  const p = await packet(config, { operation: 'day-close', action: 'close', on: today, confirmed: true }, '請求書を出す');
  expect((await ingest(config)).accepted).toBe(1);
  expect((await ingest(config)).accepted).toBe(0);
  const receipt = (await readIntakeReceipts(config)).find(r => r.request_id === p.requestId)!;
  expect(receipt.result).toMatchObject({ action: 'close', deduped: false });
  const close = (await readDayCloses(vault)).records.at(-1)!;
  expect(close).toMatchObject({ action: 'close', on: today, note: '請求書を出す', source_event_id: p.requestId });
  await rebuildDashboard(config);
  expect(await home()).toContain('> 請求書を出す');
  await packet(config, { operation: 'day-close', action: 'dismiss', close_id: close.id, confirmed: true }, '');
  expect((await ingest(config)).accepted).toBe(1);
  await rebuildDashboard(config);
  expect(await home()).not.toContain('## 前回の締め');
  const refused = await packet(config, { operation: 'day-close', action: 'close', on: '2026-01-01', confirmed: true }, '');
  expect((await ingest(config)).rejected).toBe(1);
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(refused.path)}.json`))!));
  expect(error.reason).toEqual({ code: 'day-close-refused', cause: 'out-of-range' });
  expect(intakeErrorMessage(error)).toContain('7日前まで');
  // 壊れた記録はHOMEとdoctorで示す。
  await vault.write('90_system/day-closes/DAY-01JZZZZZZZZZZZZZZZZZZZZZZZ.json', '{');
  await rebuildDashboard(config);
  expect(await home()).toContain('1日の締めの記録が不正です');
  expect((await doctor(config)).issues.join('\n')).toContain('1日の締めの記録が不正です');
});

test('受け付ける前に取り下げた（消した）依頼は、失敗として示し続けない', async () => {
  const { config, vault } = await fixture();
  // 内容の不正で断った依頼を、端末が後から取り下げた。
  const bad = await packet(config, { operation: 'day-close', action: 'close', confirmed: true }, '');
  expect((await ingest(config)).rejected).toBe(1);
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain(bad.path);
  expect((await doctor(config)).issues.join('\n')).toContain(bad.path);
  await unlink(join(config.vaultPath, bad.path));
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md') ?? '').not.toContain(bad.path);
  expect((await doctor(config)).issues.join('\n')).not.toContain(bad.path);
  // 取り下げた依頼は受け付けない（受付記録を作らない）。
  const withdrawn = await packet(config, { operation: 'day-close', action: 'close', on: new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone }).format(new Date()), confirmed: true }, '');
  await unlink(join(config.vaultPath, withdrawn.path));
  expect(await ingest(config)).toMatchObject({ accepted: 0, rejected: 0 });
  expect((await readIntakeReceipts(config)).some(r => r.request_id === withdrawn.requestId)).toBe(false);
});
