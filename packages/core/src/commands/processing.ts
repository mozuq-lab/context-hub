import { Option } from 'commander';
import { runCycle } from '../cycle.js';
import { rebuildDashboard } from '../dashboard.js';
import { rebuildDigest } from '../digest.js';
import { ingest } from '../intake.js';
import { organize } from '../organize.js';
import { requestOrganizeRetry } from '../organize-retries.js';
import { previewSynthesis, runSynthesis } from '../synthesis.js';
import { readReceipts } from '../views.js';
import { organizeClient, output, positive, synthesisClient, type RegisterCommand } from '../cli-shared.js';

/** organize: 未処理の入力をモデルで整理する。 */
export const registerOrganize: RegisterCommand = (program, config) => {
  program.command('organize').description('未処理入力を整理')
    .option('--limit <n>', '処理上限', positive)
    .option('--dry-run', '対象一覧のみ。モデル/書き込みなし')
    .option('--retry-failed', '失敗分を再処理')
    .option('--id <id>', '指定入力を処理')
    .option('--quiet-empty', '0件時にNO_REPLYを返す')
    .addOption(new Option('--thinking <level>', '推論の思考水準。設定organize.llm.thinkingを上書き').choices(['off', 'minimal', 'low', 'medium', 'high']))
    .action(async opts => {
      const c = await config(opts.thinking ? { organize: { llm: { thinking: opts.thinking } } } : {});
      const result = await organize(c, organizeClient(c), { limit: opts.limit, dryRun: opts.dryRun, retryFailed: opts.retryFailed, id: opts.id });
      output(opts.quietEmpty && result.processed === 0 && result.failed === 0 ? 'NO_REPLY' : result);
      if (result.failed > 0) process.exitCode = 1;
    });
};

/** retry-organize: 整理に失敗したメモ1件のやり直しを頼む。 */
export const registerRetryOrganize: RegisterCommand = (program, config) => {
  program.command('retry-organize <input-id>').description('整理（AIの読み取り）に失敗したメモ1件のやり直しを頼み、次の整理（cycle）で1回だけ試す。organize --retry-failedと違い、選んだ1件だけを対象にし、organize.maxAttemptsには縛られない')
    .requiredOption('--confirm', '失敗したメモを確認した本人による依頼')
    .action(async (id) => {
      const c = await config();
      const receipt = (await readReceipts(c)).find(r => r.input_id === id);
      const result = await requestOrganizeRetry(c, { inputId: id, attempts: receipt?.attempts ?? 1, source: 'cli' });
      await rebuildDashboard(c);
      output(result);
    });
};

/** ingest: 同期受付ファイルを正式に保存する。 */
export const registerIngest: RegisterCommand = (program, config) => {
  program.command('ingest').description('同期受付ファイルを正式保存')
    .option('--limit <n>', '受付操作の上限', positive)
    .option('--dry-run', '書き込みなし')
    .action(async opts => {
      const result = await ingest(await config(), { limit: opts.limit, dryRun: opts.dryRun });
      output(result);
      if (result.rejected) process.exitCode = 1;
    });
};

/** digest: 直近の期間のふりかえりREVIEW.mdを作る。 */
export const registerDigest: RegisterCommand = (program, config) => {
  program.command('digest').description('直近の期間のふりかえりREVIEW.mdを生成')
    .option('--days <n>', '集計日数（既定は設定のretrieve.digestDays）', positive)
    .action(async opts => output(await rebuildDigest(await config(), opts.days ? { days: opts.days } : {})));
};

/** dashboard: HOMEを作る。 */
export const registerDashboard: RegisterCommand = (program, config) => {
  program.command('dashboard').description('プロジェクト一覧と処理状況のHOMEを生成')
    .action(async () => output(await rebuildDashboard(await config())));
};

/** synthesize: 週次の統合を実行する。 */
export const registerSynthesize: RegisterCommand = (program, config) => {
  program.command('synthesize').description('週次の統合を実行（たまったメモをまとめて読み直し、気づきをふりかえりとHOMEへ出す）。設定のsynthesis.enabledが必要')
    .option('--force', '間隔・新しい入力の有無にかかわらず実行')
    .option('--dry-run', '渡す件数と送る量だけを表示。モデル/書き込みなし')
    .addOption(new Option('--thinking <level>', '思考の深さ。設定synthesis.thinkingを上書き').choices(['off', 'minimal', 'low', 'medium', 'high']))
    .action(async opts => {
      const c = await config(opts.thinking ? { synthesis: { thinking: opts.thinking } } : {});
      if (opts.dryRun) {
        output(await previewSynthesis(c, { force: opts.force === true }));
        return;
      }
      if (!c.synthesis.enabled) throw new Error('週次の統合は無効です。設定のsynthesis.enabledをtrueにしてから実行してください');
      const result = await runSynthesis(c, synthesisClient(c), { force: opts.force === true });
      if (result.ran) {
        await rebuildDigest(c);
        await rebuildDashboard(c);
      }
      output(result);
      if (result.ran && result.status === 'failed') process.exitCode = 1;
    });
};

/** cycle: 受付・整理・再関連付け・HOME生成をまとめて行う（定期実行の入口）。 */
export const registerCycle: RegisterCommand = (program, config) => {
  program.command('cycle').description('受付・整理・再関連付け・HOME生成')
    .option('--limit <n>', '整理と回復の合計上限', positive)
    .option('--dry-run', '書き込みとモデル呼び出しなし')
    .option('--retry-failed', '失敗分を再試行')
    .option('--quiet-empty', '新規処理と失敗がない場合NO_REPLY')
    .addOption(new Option('--thinking <level>', '思考水準').choices(['off', 'minimal', 'low', 'medium', 'high']))
    .action(async opts => {
      const c = await config(opts.thinking ? { organize: { llm: { thinking: opts.thinking } } } : {});
      const result = await runCycle(c, organizeClient(c), { limit: opts.limit, dryRun: opts.dryRun, retryFailed: opts.retryFailed }, { synthesisLlm: synthesisClient(c) });
      const synthesized = result.synthesis !== undefined && ('error' in result.synthesis || result.synthesis.ran);
      const synthesisFailed = result.synthesis !== undefined && ('error' in result.synthesis || (result.synthesis.ran && result.synthesis.status === 'failed'));
      const empty = !result.intake.accepted && !result.intake.rejected && !result.organize.processed && !result.organize.failed
        && !result.intake.conflicts.length && !result.dashboard?.conflict && !result.digest?.conflict && !result.git?.created.length && !synthesized;
      output(opts.quietEmpty && empty ? 'NO_REPLY' : result);
      if (result.intake.rejected || result.organize.failed || synthesisFailed) process.exitCode = 1;
    });
};
