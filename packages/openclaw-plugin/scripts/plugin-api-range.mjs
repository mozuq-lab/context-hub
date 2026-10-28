// OpenClawホストの版が package.json の openclaw.compat.pluginApi に収まるかを判定する。
// ホストは semver の比較子で評価する。ここでは数値3要素と >= > <= < = の空白区切りAND だけを扱い、他の書式は拒否する。
export const VERIFIED_HOST_VERSIONS = Object.freeze(['2026.9.4', '2026.9.6', '2026.9.8', '2026.9.9']);

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text).trim());
  if (!match) throw new Error(`版の形式が不正です: ${text}`);
  return match.slice(1).map(Number);
}
function compare(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function satisfiesPluginApiRange(version, range) {
  const parsed = parseVersion(version);
  const tokens = String(range).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('互換範囲が空です');
  return tokens.every((token) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
    if (!match) throw new Error(`対応していない比較子です: ${token}`);
    const order = compare(parsed, parseVersion(match[2]));
    switch (match[1] ?? '=') {
      case '>=': return order >= 0;
      case '<=': return order <= 0;
      case '>': return order > 0;
      case '<': return order < 0;
      default: return order === 0;
    }
  });
}
