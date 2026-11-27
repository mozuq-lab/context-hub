import type { Command } from 'commander';
import { rebuildDashboard } from '../dashboard.js';
import { rebuildHistories } from '../history.js';
import { setReferenceMark, readReferenceMarks } from '../reference-marks.js';
import { rebuildReferences, readReferenceIndex } from '../references.js';
import { Vault } from '../storage.js';
import type { HubConfig } from '../types.js';
import { output, type LoadConfig, type RegisterCommand } from '../cli-shared.js';

/** history: プロジェクトの経緯HISTORY.mdを作り直す。 */
export const registerHistory: RegisterCommand = (program, config) => {
  program.command('history [project]').description('プロジェクトの経緯HISTORY.mdを根拠と処理記録から作り直す（省略時は全プロジェクト）')
    .action(async id => output(await rebuildHistories(await config(), id ? { projectId: id } : {})));
};

/** references: プロジェクトの資料REFERENCES.mdを作り直す。 */
export const registerReferences: RegisterCommand = (program, config) => {
  program.command('references [project]').description('プロジェクトの資料REFERENCES.md（本人が資料にしたメモとAIが参考資料に分類したメモ、URLの一覧）を整理結果と資料の記録から作り直す（省略時は全プロジェクト）')
    .action(async id => output(await rebuildReferences(await config(), id ? { projectId: id } : {})));
};

/** reference: 資料棚に載せる資料を本人が決める。 */
export const registerReference: RegisterCommand = (program, config) => {
  const reference = program.command('reference').description('資料棚に載せる資料を本人が決める（AIの分類より優先する）。本文やURLを直すときはcorrectを使う');
  addCommand(reference, config);
  removeCommand(reference, config);
  listCommand(reference, config);
};

// 同じ操作を続けて実行しても記録を重ねない（前の記録がCLIの同じ操作・同じ名前なら、同じ受付IDで再送する）。
async function referenceEvent(c: HubConfig, inputId: string, action: 'add' | 'remove', title: string | null): Promise<string> {
  const last = (await readReferenceMarks(new Vault(c))).records
    .filter(r => r.input_id === inputId)
    .sort((a, b) => Date.parse(a.decided_at) - Date.parse(b.decided_at) || a.id.localeCompare(b.id))
    .at(-1);
  return last && last.source === 'cli' && last.action === action && last.title === title && last.source_event_id ? last.source_event_id : `cli:reference:${inputId}:${action}:${last?.id ?? 'none'}`;
}

function addCommand(reference: Command, config: LoadConfig): void {
  reference.command('add <input-id>').description('保存済みのメモ・作業要約を資料棚に載せる。名前を変える・外した資料を戻すのも同じ（--titleを省くと名前なしでAIの要約を示す）')
    .option('--title <text>', '資料の名前（1行・100文字以内）')
    .requiredOption('--confirm', 'メモを確認した本人による操作')
    .action(async (id, opts) => {
      const c = await config(), title = opts.title ?? null;
      const result = await setReferenceMark(c, { inputId: id, action: 'add', title, source: 'cli', sourceEventId: await referenceEvent(c, id, 'add', title) });
      await rebuildReferences(c);
      await rebuildDashboard(c);
      output(result);
    });
}

function removeCommand(reference: Command, config: LoadConfig): void {
  reference.command('remove <input-id>').description('資料棚から外す（AIが参考資料に分類したメモも外せる。メモと整理結果は変えない）')
    .requiredOption('--confirm', 'メモを確認した本人による操作')
    .action(async id => {
      const c = await config();
      // 資料棚にないメモを外すと「外した資料」に載り、戻すと本人が加えた資料になってしまうため、今の資料棚で確かめる（アプリと同じ）。
      const index = await readReferenceIndex(new Vault(c));
      if (index && !index.entries.some(e => e.input_id === id)) throw new Error('このメモは資料棚にありません。ctx reference listで確かめてください');
      const result = await setReferenceMark(c, { inputId: id, action: 'remove', source: 'cli', sourceEventId: await referenceEvent(c, id, 'remove', null) });
      await rebuildReferences(c);
      await rebuildDashboard(c);
      output(result);
    });
}

function listCommand(reference: Command, config: LoadConfig): void {
  reference.command('list').description('資料棚に載る資料と本人が外した資料（cycleかreferencesで作った一覧）')
    .option('--removed', '外した資料を表示')
    .action(async opts => {
      const c = await config(), index = await readReferenceIndex(new Vault(c));
      if (!index) throw new Error('資料の一覧がありません。cycleかreferencesを実行してください');
      output(opts.removed ? index.removed : index.entries);
    });
}
