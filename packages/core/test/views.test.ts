import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { capture } from '../src/capture.js';
import { Vault, markdown, parseMarkdown } from '../src/storage.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { rebuildNow } from '../src/views.js';
import type { HubConfig, OrganizeResult } from '../src/types.js';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function setup(): Promise<HubConfig> {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-views-')); roots.push(root); const config = defaultConfig(path.join(root, 'vault'), path.join(root, 'state')); const vault = new Vault(config); await vault.init();
  await vault.write('10_projects/context-hub/project.md', markdown({ id: 'context-hub', title: 'コンテキスト集約', aliases: [], keywords: ['集約'], status: 'active' }, '# プロジェクト\n')); return config;
}
function summary(current: string): OrganizeResult { return { category: 'project-update', summary: current, project_candidates: [], next_action_suggestions: [], extracted: { current: [{ text: current, status: 'confirmed' }], next: [{ text: 'ローカルでテストする', status: 'confirmed' }], open: [{ text: '実接続は未確認', status: 'unverified' }] }, knowledge_candidate: null, new_project_hint: null }; }
async function add(config: HubConfig, occurredAt: string, text: string, project: string | undefined = 'context-hub') { return capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', project, occurredAt, text }); }

describe('出典から再生成するNOW', () => {
  test('原文の提案と未確認をモデルがconfirmedにしても現在地や合意済み作業へ昇格しない', async () => {
    const config = await setup(); const vault = new Vault(config);
    const saved = await add(config, '2026-09-14T12:00:00+09:00', '## 現在地\n- [提案] 公開済みと扱う\n- [確認済み] ローカルテスト完了\n## 次の一手\n- [提案] 本番公開する\n- [未確認] 本番接続する\n- [確認済み] 仕様書を更新する');
    const result: OrganizeResult = { ...summary('原文の提案を誤読'), extracted: {
      current: [{ text: '公開済みと扱う', status: 'confirmed' }, { text: 'ローカルテスト完了', status: 'confirmed' }, { text: '書いていない完了', status: 'confirmed' }],
      next: [{ text: '本番公開する', status: 'confirmed' }, { text: '本番接続する', status: 'confirmed' }, { text: '仕様書を更新する', status: 'confirmed' }, { text: 'ローカルテスト完了', status: 'confirmed' }], open: [],
    } };
    await organize(config, new MockLlm([result]));
    const receiptPath = `90_system/receipts/${saved.inputId}.json`; const receipt = JSON.parse((await vault.read(receiptPath))!);
    expect(receipt.result.extracted.current.map((item: { status: string }) => item.status)).toEqual(['proposal', 'confirmed', 'unverified']);
    expect(receipt.result.extracted.next.map((item: { status: string }) => item.status)).toEqual(['proposal', 'unverified', 'confirmed', 'unverified']);
    // 以前のバージョンで誤ったconfirmedを保存したreceiptも、再生成時に原文へ照合する。
    receipt.result = result; await vault.write(receiptPath, JSON.stringify(receipt)); await rebuildNow(config, 'context-hub');
    const now = (await vault.read('10_projects/context-hub/NOW.md'))!;
    const current = now.split('# 現在地')[1]!.split('# 次の一手')[0]!; const next = now.split('# 次の一手')[1]!.split('## 提案')[0]!;
    expect(current).toContain('ローカルテスト完了'); expect(current).not.toContain('公開済みと扱う'); expect(current).not.toContain('書いていない完了');
    expect(next).toContain('仕様書を更新する'); expect(next).not.toContain('本番公開する'); expect(next).not.toContain('本番接続する'); expect(next).not.toContain('ローカルテスト完了');
    expect(now.split('## 提案')[1]!.split('# 未解決')[0]).toContain('本番公開する'); expect(now.split('# 未解決')[1]).toContain('本番接続する');
  });
  test('遅れて届いた古い作業要約で現在地を巻き戻さず差異も残す', async () => {
    const config = await setup(); const recent = await add(config, '2026-09-14T12:00:00+09:00', '## 現在地\n- [確認済み] 実装済み'); await organize(config, new MockLlm([summary('実装済み')]));
    const older = await add(config, '2026-09-12T12:00:00+09:00', '## 現在地\n- [確認済み] 未着手'); await organize(config, new MockLlm([summary('未着手')]));
    const now = parseMarkdown((await new Vault(config).read('10_projects/context-hub/NOW.md'))!);
    const current = now.text.split('# 現在地')[1]!.split('# 次の一手')[0]!;
    expect(current).toContain('実装済み'); expect(current).not.toContain('未着手'); expect(current).toContain(recent.inputId); expect(current).toContain(`](../../${recent.path})`);
    expect(now.text).toContain('未着手'); expect(now.text).toContain(older.inputId); expect(now.text).toContain('差異');
    expect(now.text).toContain('ai-self-report'); expect(now.text).toContain('未検証'); expect(now.text).toContain('出典:file'); expect(now.meta.last_evidence_at).toBe('2026-09-14T12:00:00+09:00');
  });
  test('手動領域を保持し自動領域が編集された場合は新版だけを退避する', async () => {
    const config = await setup(); await add(config, '2026-09-14T12:00:00+09:00', '原文'); await organize(config, new MockLlm([summary('実装済み')]));
    const vault = new Vault(config); const nowPath = '10_projects/context-hub/NOW.md'; let content = (await vault.read(nowPath))!;
    content = content.replace('<!-- ctx:auto:start -->', '手動メモ: 消さない\n\n<!-- ctx:auto:start -->'); await vault.write(nowPath, content); await rebuildNow(config, 'context-hub');
    expect(await vault.read(nowPath)).toContain('手動メモ: 消さない');
    const edited = (await vault.read(nowPath))!.replace('実装済み', '人が修正'); await vault.write(nowPath, edited);
    const result = await rebuildNow(config, 'context-hub'); expect(result.conflict).toBeTruthy(); expect(await vault.read(nowPath)).toBe(edited); expect(await vault.read(result.conflict!)).toContain('実装済み');
  });
  test('推定帰属を候補と表示し確定的な帰属に変えない', async () => {
    const config = await setup(); await capture(config, { source: 'file', kind: 'work-summary', tool: 'codex', occurredAt: '2026-09-14T12:00:00+09:00', text: 'プロジェクト未指定' });
    await organize(config, new MockLlm([{ ...summary('集約の検討'), project_candidates: [{ id: 'context-hub', confidence: 0.9 }] }]));
    expect(await new Vault(config).read('10_projects/context-hub/NOW.md')).toContain('帰属候補');
  });
  test('タスク分類だけでは合意済みの次作業へ昇格せず提案欄に置く', async () => {
    const config = await setup(); await capture(config, { source: 'cli', project: 'context-hub', text: 'タスク: 実接続を試す', occurredAt: '2026-09-14T12:00:00+09:00' });
    await organize(config, new MockLlm()); const now = (await new Vault(config).read('10_projects/context-hub/NOW.md'))!;
    expect(now.split('# 次の一手')[1]!.split('## 提案')[0]).not.toContain('実接続を試す'); expect(now.split('## 提案')[1]).toContain('実接続を試す');
  });
  test('閾値未満の帰属はreceiptだけに残しNOWを自動作成しない', async () => {
    const config = await setup(); await capture(config, { source: 'cli', text: '曖昧な帰属', occurredAt: '2026-09-14T12:00:00+09:00' });
    await organize(config, new MockLlm([{ ...summary('候補'), project_candidates: [{ id: 'context-hub', confidence: 0.69 }] }]));
    expect(await new Vault(config).read('10_projects/context-hub/NOW.md')).toBeUndefined();
  });
  test('根拠がないと不明を表示しAIの案を確定作業へ混ぜない', async () => {
    const config = await setup(); await rebuildNow(config, 'context-hub'); const vault = new Vault(config); expect(await vault.read('10_projects/context-hub/NOW.md')).toContain('不明');
    await add(config, '2026-09-14T12:00:00+09:00', '## 現在地\n- [確認済み] 集約設計を書いた\n## 次の一手\n- [提案] いつか自動化する\n## 未解決\n- [未確認] 実機では動くか');
    await organize(config, new MockLlm()); const now = (await vault.read('10_projects/context-hub/NOW.md'))!;
    expect(now).toContain('集約設計を書いた'); const next = now.split('# 次の一手')[1]!.split('## 提案')[0]!; expect(next).not.toContain('いつか自動化する'); expect(now.split('## 提案')[1]).toContain('いつか自動化する');
  });
});
