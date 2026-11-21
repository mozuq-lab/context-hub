import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { rebuildDashboard } from '../src/dashboard.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setItemSchedule } from '../src/item-schedules.js';
import { setProjectStatus } from '../src/project-status.js';
import { readProjectCatalog } from '../src/knowledge-scope.js';
import { CALENDAR_PATH, buildCalendar, foldLine } from '../src/calendar.js';
import { loadConfig } from '../src/config.js';
import type { HubConfig } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));
const summary = '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる, 感想; を聞く\n- [確認済み] 名前を決める\n## 未解決\n- 配布方法が決まっていない';

async function fixture(calendar: HubConfig['calendar'] = { enabled: true, reviewDates: false, titles: 'item' }) {
  const setup = await workflowSetup(roots), config = { ...setup.config, calendar }, vault = setup.vault;
  await addProject(config, { id: 'hub', title: '集約ツール' });
  await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', occurredAt: '2026-10-30T00:00:00Z', receivedAt: '2026-10-30T00:00:00Z', text: summary });
  await organize(config, new MockLlm());
  const items = (await readNowItems(vault, 'hub'))!.items;
  return { config, vault, items };
}
const events = (ics: string) => ics.split('BEGIN:VEVENT').length - 1;
/** 折り返した行を戻す。 */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

test('期日を終日の予定にし、項目のキーから決めたUIDで置き換わるように書き出す', async () => {
  const { config, vault, items } = await fixture();
  const [show, name, open] = items as [typeof items[0], typeof items[0], typeof items[0]];
  await rebuildDashboard(config);
  const empty = (await vault.read(CALENDAR_PATH))!;
  expect(empty).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
  expect(events(empty)).toBe(0);

  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: '2026-11-25', reviewAfter: '2026-11-22', source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: name.key, due: null, reviewAfter: '2026-11-23', source: 'cli' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: open.key, due: '2026-12-31', reviewAfter: null, source: 'cli' });
  await rebuildDashboard(config);
  const raw = (await vault.read(CALENDAR_PATH))!, ics = unfold(raw);
  // 見直す日だけの項目は、既定では予定にしない。
  expect(events(ics)).toBe(2);
  expect(ics).toContain('DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261126\r\n');
  expect(ics).toContain('DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n');
  expect(ics).toContain('SUMMARY:[期日] 集約ツール: 利用者に見せる\\, 感想\\; を聞く');
  expect(ics).toContain('見直す日: 2026-11-22');
  expect(ics).toContain('SUMMARY:[期日] 集約ツール: 未解決: 配布方法が決まっていない');
  for (const line of raw.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  const uid = /UID:(\S+)\r\n(?:.*\r\n){0,2}DTSTART;VALUE=DATE:20261125/.exec(ics)![1];

  // 日付を変えても同じUIDのまま、完了にした項目は予定から消える。
  await setItemSchedule(config, { projectId: 'hub', itemKey: show.key, due: '2026-11-27', reviewAfter: null, source: 'cli' });
  await setItemResolution(config, { projectId: 'hub', itemKey: open.key, action: 'resolve', source: 'cli' });
  await rebuildDashboard(config);
  const after = unfold((await vault.read(CALENDAR_PATH))!);
  expect(events(after)).toBe(1);
  expect(after).toContain(`UID:${uid}`);
  expect(after).toContain('DTSTART;VALUE=DATE:20261127');
  expect(after).not.toContain('配布方法');

  // 休止したプロジェクトの日付は、HOMEの次の一手と同じく出さない。
  const hash = (await readProjectCatalog(vault)).find(p => p.id === 'hub')!.hash;
  await setProjectStatus(config, { projectId: 'hub', status: 'paused', expectedHash: hash, source: 'cli' });
  await rebuildDashboard(config);
  expect(events((await vault.read(CALENDAR_PATH))!)).toBe(0);
});

test('見直す日を含める設定と、件名をプロジェクト名だけにする設定、伏せ字', async () => {
  const { config, vault, items } = await fixture({ enabled: true, reviewDates: true, titles: 'project' });
  await setItemSchedule(config, { projectId: 'hub', itemKey: items[0]!.key, due: '2026-11-25', reviewAfter: '2026-11-22', source: 'cli' });
  await rebuildDashboard(config);
  const ics = unfold((await vault.read(CALENDAR_PATH))!);
  expect(events(ics)).toBe(2);
  expect(ics).toContain('SUMMARY:[見直す日] 集約ツール: 次の一手');
  expect(ics).toContain('SUMMARY:[期日] 集約ツール: 次の一手');
  expect(ics).not.toContain('利用者に見せる');

  const secret = buildCalendar({ calendar: { enabled: true, reviewDates: false, titles: 'item' }, privacy: { redactSecrets: true, patterns: [] } },
    [{ projectId: 'hub', projectTitle: '集約ツール', itemKey: 'a'.repeat(64), section: 'next', text: 'APIキー sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 を差し替える', due: '2026-11-25', reviewAfter: null, scheduledAt: '2026-11-20T00:00:00Z' }]);
  expect(unfold(secret)).not.toContain('sk-ant-api03');
  expect(secret).toContain('伏せ字');
});

test('無効にすると以前に書いたファイルを消し、設定の既定は無効', async () => {
  const { config, vault, items } = await fixture();
  await setItemSchedule(config, { projectId: 'hub', itemKey: items[0]!.key, due: '2026-11-25', reviewAfter: null, source: 'cli' });
  await rebuildDashboard(config);
  expect(await vault.read(CALENDAR_PATH)).toBeDefined();
  await rebuildDashboard({ ...config, calendar: { enabled: false, reviewDates: false, titles: 'item' } });
  expect(await vault.read(CALENDAR_PATH)).toBeUndefined();
  const loaded = await loadConfig('/nonexistent/config.json', { vaultPath: config.vaultPath, statePath: config.statePath });
  expect(loaded.calendar).toEqual({ enabled: false, reviewDates: false, titles: 'item' });
});

test('長い行はUTF-8の文字の途中で切らずに75オクテットで折り返す', () => {
  const folded = foldLine('SUMMARY:' + 'あ'.repeat(40));
  const lines = folded.split('\r\n');
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  expect(lines.slice(1).every(l => l.startsWith(' '))).toBe(true);
  expect(lines.map((l, i) => i ? l.slice(1) : l).join('')).toBe('SUMMARY:' + 'あ'.repeat(40));
});
