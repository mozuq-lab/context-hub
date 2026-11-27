import { Option } from 'commander';
import { basename, resolve as resolvePath } from 'node:path';
import { sanitizeFileName } from '../attachments.js';
import { capture } from '../capture.js';
import { correctInput } from '../corrections.js';
import { rebuildPoliciesLocked } from '../policies.js';
import { writeIntakeFeaturesLocked } from '../intake.js';
import { writePrivacyPatternsLocked } from '../secrets.js';
import { Vault } from '../storage.js';
import { inputText, output, type RegisterCommand } from '../cli-shared.js';

/** init: 保存先を初期化する。 */
export const registerInit: RegisterCommand = (program, config) => {
  program.command('init').description('保存先を初期化（既存ノートは保持）')
    .action(async () => {
      const c = await config();
      const vault = new Vault(c);
      await vault.init();
      await vault.withLock(async () => {
        await rebuildPoliciesLocked(c, vault);
        await writePrivacyPatternsLocked(c, vault);
        await writeIntakeFeaturesLocked(c, vault);
      });
      output({ vaultPath: c.vaultPath, initialized: true });
    });
};

/** add: 原文（メモ・作業要約）を保存する。 */
export const registerAdd: RegisterCommand = (program, config) => {
  program.command('add [text]').description('原文を保存')
    .option('--file <path>', 'Markdown/テキストファイル')
    .option('--event-id <id>', '再送判定用ID')
    .option('--source <name>', '出典名')
    .option('--occurred-at <iso>', 'タイムゾーン付き発生日時')
    .option('--happened-on <date>', '後から記録する出来事の日付（YYYY-MM-DD。記録した日から設定のcapture.maxBackdateDays日前まで）')
    .addOption(new Option('--kind <kind>', '入力の種別').choices(['memo', 'work-summary']).default('memo'))
    .option('--project <id>', '人が指定する既存プロジェクト')
    .option('--tool <name>', '作業したAI/ツール')
    .option('--session <reference>', '元セッションの参照先')
    .option('--continues <input-id>', '続きとして書く前のメモの入力ID（--projectを省くと、前のメモで指定したプロジェクトを引き継ぐ）')
    .option('--reference', '資料として保存する（AIの分類に関係なく資料棚に載せる）')
    .option('--reference-title <text>', '資料の名前（--referenceと一緒に指定。1行・100文字以内）')
    .option('--attach <path>', 'メモに添えるファイル（PDF・画像など）。Vaultの05_filesに複製し、資料として保存する。本文を省くとファイル名を本文にする')
    .action(async (text, opts) => {
      const c = await config();
      // ファイルを添えるメモは資料として保存する。本文がなければファイル名を本文にする（標準入力は待たない）。
      const attach = opts.attach === undefined ? undefined : { file: resolvePath(String(opts.attach)), name: sanitizeFileName(basename(String(opts.attach))) };
      if (attach && opts.kind !== 'memo') throw new Error('--attachはメモ（--kind memo）にだけ使えます');
      const body = attach && text === undefined && !opts.file ? attach.name : await inputText(text, opts.file, c.capture.maxInputChars);
      output(await capture(c, {
        text: body,
        source: opts.source ?? (opts.file ? 'file' : text !== undefined ? 'cli' : 'stdin'),
        sourceEventId: opts.eventId,
        occurredAt: opts.occurredAt ?? new Date().toISOString(),
        kind: opts.kind,
        project: opts.project,
        tool: opts.tool,
        meta: opts.session ? { session: opts.session } : undefined,
        happenedOn: opts.happenedOn,
        ...(opts.continues !== undefined ? { continues: opts.continues } : {}),
        ...(opts.reference || attach ? { reference: true } : {}),
        ...(opts.referenceTitle !== undefined ? { referenceTitle: opts.referenceTitle } : {}),
        ...(attach ? { attachment: attach } : {}),
      }));
    });
};

/** correct: 元の原文を保持したまま、最新の入力を訂正する。 */
export const registerCorrect: RegisterCommand = (program, config) => {
  program.command('correct <id> [text]').description('元原文を保持して最新入力を訂正')
    .option('--file <path>', '訂正文ファイル')
    .option('--event-id <id>', '再送判定ID')
    .option('--source <name>', '出典名', 'cli-correction')
    .action(async (id, text, opts) => {
      const c = await config();
      output(await correctInput(c, id, {
        text: await inputText(text, opts.file, c.capture.maxInputChars),
        source: opts.source,
        sourceEventId: opts.eventId,
        occurredAt: new Date().toISOString(),
      }));
    });
};
