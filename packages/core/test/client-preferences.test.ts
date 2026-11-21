import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup, packet } from './workflow-fixtures.js';
import { ingest, readIntakeReceipts, intakeErrorSchema, intakeErrorMessage } from '../src/intake.js';
import { hash } from '../src/storage.js';
import { clientPreferencesPath, readClientPreferences, setClientPreferences, PREFERENCES_MAX_BYTES } from '../src/client-preferences.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

const pins = (ids: string[], at: string) => ({ updated_at: at, value: { ids } });
const body = (device: string, groups: Record<string, unknown>) => JSON.stringify({ schema_version: 1, device, groups });

test('好みのまとまりごとに新しい方を残し、遅れて届いた古い変更で巻き戻さない', async () => {
  const { config, vault } = await workflowSetup(roots);
  const mac = await setClientPreferences(config, { payload: { schema_version: 1, device: 'mac', groups: { pins: pins(['hub', 'home'], '2026-11-21T01:00:00Z'), basket: { updated_at: '2026-11-21T01:00:00Z', value: { max_chars: 12000 } } } }, source: 'flutter', sourceEventId: 'REQ-1' });
  expect(mac).toEqual({ applied: ['pins', 'basket'], deduped: false });
  // Androidで後から変えたピン留めが勝ち、ひな形だけを足す。ひな形を送っていない端末はかごの上限を変えない。
  const android = await setClientPreferences(config, { payload: { schema_version: 1, device: 'android', groups: {
    pins: pins(['home'], '2026-11-21T02:00:00Z'),
    templates: { updated_at: '2026-11-21T02:00:00Z', value: { items: [{ id: 'default-meeting', name: '会議', body: '## 決まったこと\n', project: 'hub' }] } },
  } }, source: 'flutter', sourceEventId: 'REQ-2' });
  expect(android.applied).toEqual(['pins', 'templates']);
  // 遅れて届いた古い変更は反映しない。同じ受付IDの再送は同じ結果になる。
  expect(await setClientPreferences(config, { payload: { schema_version: 1, device: 'mac', groups: { pins: pins(['hub'], '2026-11-21T01:30:00Z') } }, source: 'flutter', sourceEventId: 'REQ-3' })).toEqual({ applied: [], deduped: false });
  expect(await setClientPreferences(config, { payload: { schema_version: 1, device: 'android', groups: { pins: pins(['home'], '2026-11-21T02:00:00Z') } }, source: 'flutter', sourceEventId: 'REQ-2' })).toEqual({ applied: ['pins', 'templates'], deduped: true });
  const stored = (await readClientPreferences(vault))!;
  expect(stored.groups.pins).toEqual({ updated_at: '2026-11-21T02:00:00.000Z', device: 'android', request_id: 'REQ-2', value: { ids: ['home'] } });
  expect(stored.groups.basket?.value).toEqual({ max_chars: 12000 });
  expect(stored.groups.templates?.value.items[0]).toMatchObject({ id: 'default-meeting', project: 'hub' });

  // 時計の進んだ端末の日時は、受け付けた時刻に丸める。
  const now = new Date('2026-11-21T03:00:00Z');
  await setClientPreferences(config, { payload: { schema_version: 1, device: 'fast', groups: { pins: pins(['hub'], '2030-01-01T00:00:00Z') } }, source: 'flutter', sourceEventId: 'REQ-4', now });
  expect((await readClientPreferences(vault))!.groups.pins?.updated_at).toBe(now.toISOString());
  // 停止の後の再送（受領記録の前に止まった）は書き直さず、丸め直した日時でほかの端末の後の変更に勝たない。
  expect(await setClientPreferences(config, { payload: { schema_version: 1, device: 'fast', groups: { pins: pins(['hub'], '2030-01-01T00:00:00Z') } }, source: 'flutter', sourceEventId: 'REQ-4', now: new Date('2026-11-21T03:10:00Z') })).toEqual({ applied: ['pins'], deduped: true });
  expect((await readClientPreferences(vault))!.groups.pins?.updated_at).toBe(now.toISOString());
  expect((await setClientPreferences(config, { payload: { schema_version: 1, device: 'mac', groups: { pins: pins(['home', 'hub'], '2026-11-21T03:05:00Z') } }, source: 'flutter', sourceEventId: 'REQ-4b', now: new Date('2026-11-21T03:06:00Z') })).applied).toEqual(['pins']);

  // 壊れた記録は、届いたまとまりだけで作り直す。
  await vault.write(clientPreferencesPath, '{broken');
  expect((await setClientPreferences(config, { payload: { schema_version: 1, device: 'mac', groups: { pins: pins(['hub'], '2026-11-21T04:00:00Z') } }, source: 'flutter', sourceEventId: 'REQ-5' })).applied).toEqual(['pins']);
  expect(Object.keys((await readClientPreferences(vault))!.groups)).toEqual(['pins']);
});

test('受付ファイルの本文の形と上限を確かめ、ひな形の秘密情報らしい文字列は理由付きで断る', async () => {
  const { config, vault } = await workflowSetup(roots);
  const base = { operation: 'client-preferences', source: 'flutter', confirmed: true };
  for (const bad of [
    '',
    'not json',
    body('mac', {}),
    body('mac', { pins: pins(['hub', 'hub'], '2026-11-21T01:00:00Z') }),
    body('mac', { basket: { updated_at: '2026-11-21T01:00:00Z', value: { max_chars: 5000 } } }),
    body('mac', { seen: { updated_at: '2026-11-21T01:00:00Z', value: {} } }),
    body('mac', { templates: { updated_at: '2026-11-21T01:00:00Z', value: { items: [{ id: 'x', name: '改行\nあり', body: '本文' }] } } }),
    body('mac/../', { pins: pins(['hub'], '2026-11-21T01:00:00Z') }),
    body('mac', { pins: { updated_at: '2026-11-21T01:00:00Z', value: { ids: ['hub'] }, api_key: 'x' } }),
  ]) {
    await packet(config, base, bad);
    expect((await ingest(config)).rejected).toBe(1);
  }
  const long = body('mac', { templates: { updated_at: '2026-11-21T01:00:00Z', value: { items: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, name: `ひな形${i}`, body: 'あ'.repeat(1000) })) } } });
  expect(Buffer.byteLength(long)).toBeGreaterThan(PREFERENCES_MAX_BYTES);
  await packet(config, base, long);
  expect((await ingest(config)).rejected).toBe(1);

  const ok = await packet(config, base, body('mac', { pins: pins(['hub'], '2026-11-21T01:00:00Z') }));
  expect((await ingest(config)).accepted).toBe(1);
  expect((await readIntakeReceipts(config)).find(r => r.request_id === ok.requestId)).toMatchObject({ operation: 'client-preferences', result: { applied: ['pins'], deduped: false } });
  expect((await readClientPreferences(vault))!.groups.pins).toMatchObject({ device: 'mac', request_id: ok.requestId });

  const secret = await packet(config, base, body('mac', { templates: { updated_at: '2026-11-21T02:00:00Z', value: { items: [{ id: 'keys', name: '鍵', body: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] } } }));
  expect((await ingest(config)).rejected).toBe(1);
  const error = intakeErrorSchema.parse(JSON.parse((await vault.read(`90_system/intake-errors/${hash(secret.path)}.json`))!));
  expect(error.reason?.code).toBe('preferences-secret');
  expect(intakeErrorMessage(error)).toContain('ほかの端末とそろえませんでした');
  expect((await readClientPreferences(vault))!.groups.templates).toBeUndefined();
});
