import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { satisfiesPluginApiRange, VERIFIED_HOST_VERSIONS } from '../scripts/plugin-api-range.mjs';

describe('プラグインAPIの互換範囲', () => {
  test('空白区切りの比較子を数値で判定し、未対応の書式は拒否する', () => {
    expect(satisfiesPluginApiRange('2026.9.6', '>=2026.9.4 <2027.0.0')).toBe(true);
    expect(satisfiesPluginApiRange('2026.9.4', '>=2026.9.4 <2027.0.0')).toBe(true);
    expect(satisfiesPluginApiRange('2026.10.0', '>=2026.9.4 <2027.0.0')).toBe(true);
    expect(satisfiesPluginApiRange('2026.9.3', '>=2026.9.4 <2027.0.0')).toBe(false);
    expect(satisfiesPluginApiRange('2027.0.0', '>=2026.9.4 <2027.0.0')).toBe(false);
    expect(satisfiesPluginApiRange('2026.9.6', '2026.9.4')).toBe(false);
    expect(satisfiesPluginApiRange('2026.9.4', '2026.9.4')).toBe(true);
    expect(() => satisfiesPluginApiRange('2026.9.6', '')).toThrow();
    expect(() => satisfiesPluginApiRange('x', '>=1.0.0')).toThrow();
    expect(() => satisfiesPluginApiRange('2026.9.6', '~2026.9')).toThrow();
    expect(() => satisfiesPluginApiRange('2026.9.6', '>=2026.9.4 || <1.0.0')).toThrow();
  });
  test('package.jsonの宣言は検証済みホスト版をすべて含む範囲で、固定ピンではない', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const range: string = pkg.openclaw.compat.pluginApi;
    expect(range).toMatch(/^>=/);
    for (const version of VERIFIED_HOST_VERSIONS) expect(satisfiesPluginApiRange(version, range)).toBe(true);
    expect(satisfiesPluginApiRange('2027.0.0', range)).toBe(false);
    expect(pkg.peerDependencies.openclaw).toBe(range);
    expect(VERIFIED_HOST_VERSIONS).toContain(pkg.openclaw.build.openclawVersion);
    expect(pkg.openclaw.build.pluginSdkVersion).toBe(pkg.openclaw.build.openclawVersion);
  });
});
