import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { capture, readInputs } from '../src/capture.js';
import { addProject } from '../src/projects.js';
import { ingest } from '../src/intake.js';
import { organize } from '../src/organize.js';
import { MockLlm, buildOrganizePrompt } from '../src/llm.js';
import { readNowItems } from '../src/item-resolutions.js';
import { buildHistory } from '../src/history.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { find } from '../src/retrieve.js';
import { HappenedOnError, evidenceBound, localNoon } from '../src/happened.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

test('出来事の日付は発生日時をその日の正午にし、書いた日時を記録日時に残す', async () => {
  const { config } = await workflowSetup(roots);
  const result = await capture(config, { source: 'cli', occurredAt: '2026-11-20T03:00:00Z', happenedOn: '2026-11-18', text: '昨日の会議のメモ' });
  const [input] = await readInputs(config);
  expect(input).toMatchObject({ happened_on: '2026-11-18', recorded_at: '2026-11-20T03:00:00Z', occurred_at: '2026-11-18T03:00:00.000Z' });
  expect(result.path).toMatch(/^00_inbox\/2026-11-18_IN-/);
  expect(localNoon('2026-11-18', 'Asia/Tokyo')).toBe('2026-11-18T03:00:00.000Z');
  // 記録した日（設定のタイムゾーン）と同じ日付は指定がないのと同じに扱う。2026-11-19T20:00Zは東京では11-20。
  await capture(config, { source: 'cli', sourceEventId: 'same-day', occurredAt: '2026-11-19T20:00:00Z', happenedOn: '2026-11-20', text: '今日のメモ' });
  const same = (await readInputs(config)).find(i => i.text === '今日のメモ')!;
  expect(same.happened_on).toBeUndefined();
  expect(same.recorded_at).toBeUndefined();
  expect(same.occurred_at).toBe('2026-11-19T20:00:00Z');
});

test('記録した日より後と、上限より古い出来事の日付を拒否する', async () => {
  const { config } = await workflowSetup(roots);
  await expect(capture(config, { source: 'cli', occurredAt: '2026-11-20T03:00:00Z', happenedOn: '2026-11-21', text: '未来' })).rejects.toBeInstanceOf(HappenedOnError);
  await expect(capture(config, { source: 'cli', occurredAt: '2026-11-20T03:00:00Z', happenedOn: '2025-11-19', text: '古い' })).rejects.toThrow('365日前まで');
  await capture(config, { source: 'cli', occurredAt: '2026-11-20T03:00:00Z', happenedOn: '2025-11-20', text: 'ちょうど1年前' });
  const narrow = { ...config, capture: { ...config.capture, maxBackdateDays: 7 } };
  await expect(capture(narrow, { source: 'cli', occurredAt: '2026-11-20T03:00:00Z', happenedOn: '2026-11-12', text: '8日前' })).rejects.toThrow('7日前まで');
  expect((await readInputs(config)).map(i => i.text)).toEqual(['ちょうど1年前']);
});

test('受付の出来事の日付を原文に残し、誤った日付は理由付きで拒否して再試行しない', async () => {
  const { config, vault } = await workflowSetup(roots);
  const good = await packet(config, { happened_on: '2026-10-01' }, '先週の打ち合わせ');
  const bad = await packet(config, { happened_on: '2026-10-04' }, '未来の日付');
  const result = await ingest(config);
  expect(result.accepted).toBe(1);
  expect(result.rejected).toBe(1);
  const [input] = await readInputs(config);
  expect(input).toMatchObject({ text: '先週の打ち合わせ', happened_on: '2026-10-01', recorded_at: '2026-10-03T10:00:00Z' });
  expect(await vault.read(`90_system/intake/${good.requestId}.json`)).toContain('accepted');
  const [errorPath] = await vault.files('90_system/intake-errors'), record = JSON.parse((await vault.read(errorPath!))!);
  expect(record.reason).toEqual({ code: 'happened-on-invalid', cause: 'future', max_days: 365 });
  expect(record.code).toContain('記録した日より後');
  expect(await vault.read(`90_system/intake/${bad.requestId}.json`)).toBeUndefined();
  expect((await ingest(config)).rejected).toBe(0);
  await rebuildDashboard(config);
  expect(await vault.read('HOME.md')).toContain('出来事の日付が記録した日より後です');
  // 受付済みの依頼の再受付でも、出来事の日付を付けた原文を依頼と一致すると判断する。
  expect((await ingest(config)).accepted).toBe(0);
  expect(await readInputs(config)).toHaveLength(1);
});

test('後から書いた古い作業要約は新しい作業要約の現在地を押しのけず、経緯ではその月に並ぶ', async () => {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-10-05T01:00:00Z', receivedAt: '2026-10-05T01:00:00Z', text: '## 現在地\n- [確認済み] 新しい現在地\n## 次の一手\n- [確認済み] 次の作業' });
  const late = await capture(config, { source: 'file', kind: 'work-summary', project: 'hub', occurredAt: '2026-10-06T01:00:00Z', receivedAt: '2026-10-06T01:00:00Z', happenedOn: '2026-09-28', text: '## 現在地\n- [確認済み] 古い現在地\n## 次の一手\n- [確認済み] 古い作業' });
  await organize(config, new MockLlm());
  const now = (await vault.read('10_projects/hub/NOW.md'))!;
  const current = now.slice(now.indexOf('# 現在地'), now.indexOf('# 次の一手'));
  expect(current).toContain('新しい現在地');
  expect(current).not.toContain('古い現在地');
  expect(now).toContain('2026-09-28のこと（記録 2026-10-06 10:00 Asia/Tokyo）');
  expect((await readNowItems(vault, 'hub'))!.items.map(i => i.text)).not.toContain('古い作業');
  const history = await buildHistory(config, 'hub');
  const september = history.slice(history.indexOf('## 2026年9月'), history.indexOf('## 2026年10月'));
  expect(september).toContain(`[${late.inputId}]`);
  expect(september).toContain('2026-09-28');
  const found = await find(config, '古い現在地');
  expect(found).toContain('2026-09-28のこと（記録 ');
});

test('整理のプロンプトに出来事の日付を渡し、相対的な日付をその日基準で読ませる', async () => {
  const { config } = await workflowSetup(roots);
  await capture(config, { source: 'cli', occurredAt: '2026-11-20T03:00:00Z', happenedOn: '2026-11-18', text: '明日までに資料を送る' });
  const [input] = await readInputs(config);
  const prompt = buildOrganizePrompt(input!, []);
  expect(prompt).toContain('"happened_on":"2026-11-18"');
  expect(prompt).toContain('happened_onを基準に読む');
  await capture(config, { source: 'cli', sourceEventId: 'plain', occurredAt: '2026-11-20T03:00:00Z', text: '普通のメモ' });
  const plain = (await readInputs(config)).find(i => i.text === '普通のメモ')!;
  expect(buildOrganizePrompt(plain, [])).not.toContain('happened_on');
});

test('端末が出来事の日付と方針の見直しに対応した本体かを知る一覧を書く', async () => {
  const { config, vault } = await workflowSetup(roots);
  await rebuildDashboard(config);
  const features = JSON.parse((await vault.read('90_system/intake-features.json'))!);
  expect(features.schema_version).toBe(1);
  expect(features.capture_fields).toContain('happened_on');
  expect(features.operations).toEqual(expect.arrayContaining(['capture', 'policy-keep', 'item-schedule']));
  expect(features).toMatchObject({ max_backdate_days: 365, calendar_titles: 'item' });
  // 端末が本体の設定に合わせられるよう、さかのぼれる日数と予定の件名の設定も書く。
  await rebuildDashboard({ ...config, capture: { ...config.capture, maxBackdateDays: 30 }, calendar: { enabled: false, reviewDates: false, titles: 'project' } });
  expect(JSON.parse((await vault.read('90_system/intake-features.json'))!)).toMatchObject({ max_backdate_days: 30, calendar_titles: 'project' });
});

test('出来事の日付は同じ日の夕方の根拠より後として比べ、検索とふりかえりでは時刻を出さない', async () => {
  const { config } = await workflowSetup(roots);
  await capture(config, { source: 'cli', occurredAt: '2026-11-20T03:00:00Z', happenedOn: '2026-11-18', text: '昨日の会議で配布方法を決めた' });
  const [input] = await readInputs(config);
  // 2026-11-18 18:00 JST（09:00Z）の根拠は、11-18の出来事より前として扱う。
  expect(evidenceBound(input!)).toBeGreaterThan(Date.parse('2026-11-18T09:00:00Z'));
  expect(evidenceBound(input!)).toBeLessThan(Date.parse('2026-11-18T15:00:00Z'));
  expect(evidenceBound({ occurred_at: '2026-11-18T09:00:00Z' })).toBe(Date.parse('2026-11-18T09:00:00Z'));
  const found = await find(config, '配布方法');
  expect(found).toContain('2026-11-18のこと（記録');
  expect(found).not.toContain('2026-11-18 12:00');
});
