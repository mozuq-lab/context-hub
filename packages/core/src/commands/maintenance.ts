import { rebuildDashboard } from '../dashboard.js';
import { doctor } from '../doctor.js';
import { userFacingError } from '../error-message.js';
import { verifyBackup, readBackupChecks, backupStatus } from '../backup-check.js';
import { listConflicts, resolveConflict } from '../conflicts.js';
import { Vault, unlockVault, LOCK_SCOPES } from '../storage.js';
import { output, type RegisterCommand } from '../cli-shared.js';

/** conflict: 手で書き換えた生成物（NOW・HOME・REVIEW）の競合を確かめ、生成版へ戻す。 */
export const registerConflict: RegisterCommand = (program, config) => {
  const conflict = program.command('conflict').description('生成物の競合（手で書き換えたNOW・HOME・REVIEW）を確認し、生成版へ戻す');
  conflict.command('list').description('対象ごとの退避・手で変えた行・確認用ハッシュを表示')
    .action(async () => output(await listConflicts(await config())));
  conflict.command('resolve <target>').description('手で変えた行をメモとして残し、最新の入力から作り直して退避を片付ける（例: 10_projects/<id>/NOW.md）')
    .requiredOption('--hash <sha256>', 'conflict listで確認した対象のハッシュ')
    .option('--no-memo', 'NOWの手で変えた行をメモとして保存しない（置き換えた全文は記録に残る）')
    .requiredOption('--confirm', '差分を確認した本人による操作')
    .action(async (target, opts) => {
      const c = await config();
      const result = await resolveConflict(c, { target, expectedHash: opts.hash, source: 'cli', sourceEventId: `cli:conflict:${target}:${opts.hash}`, saveManualAsMemo: opts.memo });
      await rebuildDashboard(c);
      output(result);
    });
};

/** backup: バックアップから復元できるかを確かめる。 */
export const registerBackup: RegisterCommand = (program, config) => {
  const backup = program.command('backup').description('バックアップから復元できるかを確かめる（元のVaultは読むだけで、書き換えない）');
  backup.command('verify').description('最新（または指定）のアーカイブをVault外の一時フォルダーへ展開して確かめ、結果を記録してHOMEを更新')
    .option('--archive <path>', '確かめるアーカイブ（省略時は設定のbackup.dirでいちばん新しいもの）')
    .option('--work-dir <path>', '展開先の親フォルダー（省略時はOSの一時フォルダー。Vaultと同期フォルダーの外にする）')
    .option('--keep', '確認後も展開先を残す（中身を自分で確かめるとき）')
    .action(async opts => {
      const c = await config();
      const result = await verifyBackup(c, { archive: opts.archive, workDir: opts.workDir, keep: opts.keep });
      await rebuildDashboard(c);
      output(result);
      if (result.check.status !== 'ok') process.exitCode = 1;
    });
  backup.command('status').description('最後の確認結果と、確かめた復元点')
    .action(async () => {
      const c = await config(), checks = await readBackupChecks(new Vault(c)), status = backupStatus(c, checks.records);
      output({
        restore_point: status.restorePoint ? { archive: status.restorePoint.archive, created_at: status.restorePoint.archive_created_at, age_days: status.restorePointAgeDays, checked_at: status.restorePoint.checked_at } : null,
        latest: status.latest ?? null,
        warnings: status.warnings,
        problems: checks.problems,
      });
    });
};

/** doctor: Vaultと処理記録を検査する。 */
export const registerDoctor: RegisterCommand = (program, config) => {
  program.command('doctor').description('Vaultと処理記録を検査')
    .option('--unlock', '全Writer・整理の停止後、死亡PIDのロック残骸のみ回収')
    .action(async opts => {
      const c = await config();
      if (opts.unlock) {
        for (const scope of LOCK_SCOPES) {
          try {
            await unlockVault(c, scope);
          } catch (error) {
            /* 稼働中・判断不能なロックは回収せず、下のdoctorの検査結果で報告する。 */
            process.stderr.write(`警告: ${scope === 'organize' ? '整理' : 'Writer'}ロックを回収しませんでした: ${userFacingError(error)}\n`);
            process.exitCode = 1;
          }
        }
      }
      const result = await doctor(c);
      output(result);
      if (result.issues.length) process.exitCode = 1;
    });
};
