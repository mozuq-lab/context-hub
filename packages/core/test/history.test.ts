import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { workflowSetup } from './workflow-fixtures.js';
import { addProject } from '../src/projects.js';
import { capture } from '../src/capture.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { runCycle } from '../src/cycle.js';
import { hash } from '../src/storage.js';
import { readNowItems, setItemResolution } from '../src/item-resolutions.js';
import { setProjectStatus } from '../src/project-status.js';
import { buildHistory, historyPath, rebuildHistories } from '../src/history.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))));

async function fixture() {
  const { config, vault } = await workflowSetup(roots);
  await addProject(config, { id: 'hub', title: '集約ツール' });
  const at = (iso: string) => ({ occurredAt: iso, receivedAt: iso });
  const first = await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', ...at('2026-09-10T01:00:00Z'), text: '## 現在地\n- [確認済み] 試作が動いた\n## 次の一手\n- [確認済み] 利用者に見せる\n## 未解決\n- 配布方法が決まっていない' });
  const memo = await capture(config, { source: 'cli', project: 'hub', ...at('2026-09-20T01:00:00Z'), text: '名前の候補を考えた' });
  const second = await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project: 'hub', ...at('2026-10-05T01:00:00Z'), text: '## 現在地\n- [確認済み] 利用者に見せた\n## 次の一手\n- [確認済み] 名前を決める' });
  await organize(config, new MockLlm());
  return { config, vault, first, memo, second };
}

test('月ごとに入力・現在地の移り変わり・完了報告・状態の切り替えを並べ、生成時点に依存しない', async () => {
  const { config, vault, first, memo, second } = await fixture();
  const open = (await readNowItems(vault, 'hub'))!.items.find(i => i.section === 'open')!;
  const resolution = await setItemResolution(config, { projectId: 'hub', itemKey: open.key, action: 'resolve', source: 'cli' });
  const text = await buildHistory(config, 'hub');
  expect(text).toContain('# 集約ツールの経緯');
  expect(text).toContain('状態: 進行中');
  expect(text).toContain('期間: 2026-09-10 〜 2026-10-05');
  expect(text).toMatch(/入力 3件 \/ 完了・解決の報告 1件/);
  const sep = text.slice(text.indexOf('## 2026年9月'), text.indexOf('## 2026年10月'));
  expect(sep).toMatch(new RegExp(`- 届いた入力: 2件（作業要約 1 / メモ 1）\\n {2}- 2026-09-10 作業要約 \\[${first.inputId}\\]\\(\\.\\./\\.\\./00_inbox/[^)]+\\) `));
  expect(sep).toContain(`[${memo.inputId}]`);
  expect(sep).toMatch(new RegExp(`- 2026-09-10 現在地（最初の作業要約 \\[${first.inputId}\\][^)]+\\)）: 試作が動いた`));
  const oct = text.slice(text.indexOf('## 2026年10月'), text.indexOf('## 2026年11月') > 0 ? text.indexOf('## 2026年11月') : undefined);
  expect(oct).toMatch(new RegExp(`- 2026-10-05 現在地が変わった（\\[${second.inputId}\\][^\\n]+\\n {2}- 追加: 利用者に見せた\\n {2}- 外れた: 試作が動いた`));
  // 報告日は実行時刻なので月は固定できない。本文と記録IDだけを確かめる。
  expect(text).toContain(`解決: 配布方法が決まっていない（本人報告 ${resolution.resolutionId}）`);
  expect(text).not.toMatch(/日前/);
  expect(text).not.toContain('時点で残っているもの');
  // 同じ根拠からは同じ本文になる。
  expect(await buildHistory(config, 'hub')).toBe(text);
});

test('休止・完了では残っている次の一手と未解決をまとめ、状態の切り替えを経緯に載せる', async () => {
  const { config, vault } = await fixture();
  const raw = (await vault.read('10_projects/hub/project.md'))!;
  const change = await setProjectStatus(config, { projectId: 'hub', status: 'done', expectedHash: hash(raw), source: 'cli' });
  const text = await buildHistory(config, 'hub');
  expect(text).toContain('状態: 完了');
  expect(text).toContain(`状態: 進行中 → 完了（${change.changeId}）`);
  const tail = text.slice(text.indexOf('## 完了にした時点で残っているもの'));
  expect(tail).toMatch(/- 最後の現在地（\[IN-[^\]]+\][^)]+\)）: 利用者に見せた/);
  expect(tail).toMatch(/- 残っている次の一手: 1件\n {2}- 名前を決める/);
  expect(tail).toMatch(/- 残っている未解決: 2件\n {2}- 未解決: 配布方法が決まっていない\n {2}- 過去の報告との差異/);
});

test('cycleで経緯を書き、本文が変わらなければ書き直さず、手で変えたものは止めてHOMEに示す', async () => {
  const { config, vault } = await fixture();
  await addProject(config, { id: 'empty', title: '空のプロジェクト' });
  const result = await runCycle(config, new MockLlm());
  expect(result.history?.map(h => h.projectId).sort()).toEqual(['empty', 'hub']);
  const written = (await vault.read(historyPath('hub')))!;
  expect(written).toMatch(/^---\n[\s\S]*source_hash: sha256:[a-f0-9]{64}[\s\S]*verified: false/);
  expect(await vault.read(historyPath('empty'))).toContain('まだ記録はありません。');
  // 変化がなければ書き込まない（同期の差分を作らない）。
  expect((await runCycle(config, new MockLlm())).history).toEqual([]);
  expect(await vault.read(historyPath('hub'))).toBe(written);
  expect(await rebuildHistories(config, { projectId: 'hub' })).toEqual([{ projectId: 'hub', path: historyPath('hub'), written: false }]);
  await expect(rebuildHistories(config, { projectId: 'missing' })).rejects.toThrow('見つかりません');

  await vault.write(historyPath('hub'), written.replace('# 集約ツールの経緯', '# 手で直した経緯'));
  await capture(config, { source: 'cli', project: 'hub', occurredAt: '2026-10-06T01:00:00Z', text: '追加のメモ' });
  const next = await runCycle(config, new MockLlm());
  expect(next.history).toEqual([{ projectId: 'hub', path: historyPath('hub'), written: false, stopped: true }]);
  expect(await vault.read(historyPath('hub'))).toContain('# 手で直した経緯');
  expect(await vault.read('HOME.md')).toContain('[経緯の更新が止まっています](10_projects/hub/HISTORY.md): 集約ツール — HISTORY.mdが手で変更されています');
  // 消せば次のcycleで作り直す。
  await vault.remove(historyPath('hub'));
  expect((await runCycle(config, new MockLlm())).history).toEqual([{ projectId: 'hub', path: historyPath('hub'), written: true }]);
  expect(await vault.read(historyPath('hub'))).toContain('追加のメモ');
  expect(await vault.read('HOME.md')).not.toContain('経緯の更新が止まっています');
});
