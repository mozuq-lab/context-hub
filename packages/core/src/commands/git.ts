import { Option, type Command } from 'commander';
import { rebuildDashboard } from '../dashboard.js';
import { collectGitDrafts, readGitDrafts, useGitDraft, dismissGitDraft } from '../git-drafts.js';
import { output, type LoadConfig, type RegisterCommand } from '../cli-shared.js';

/** git: 設定したローカルリポジトリのコミット履歴から作業記録の下書きを作り、本人が使うか見送る。 */
export const registerGit: RegisterCommand = (program, config) => {
  const git = program.command('git').description('設定したローカルリポジトリのコミット履歴から作業記録の下書きを作る（既定は無効）');
  collectCommand(git, config);
  draftsCommand(git, config);
  useCommand(git, config);
  dismissCommand(git, config);
};

function collectCommand(git: Command, config: LoadConfig): void {
  git.command('collect').description('下書きを作ってHOMEを更新')
    .action(async () => {
      const c = await config();
      if (!c.git.enabled) throw new Error('設定のgit.enabledが無効です');
      const result = await collectGitDrafts(c);
      await rebuildDashboard(c);
      output(result);
      if (result.errors.length) process.exitCode = 1;
    });
}

function draftsCommand(git: Command, config: LoadConfig): void {
  git.command('drafts').description('下書きの一覧')
    .option('--all', '入力済み・見送り済みも表示')
    .action(async opts => output((await readGitDrafts(await config()))
      .filter(d => opts.all || d.status === 'pending')
      .map(d => ({ id: d.id, hash: d.hash, status: d.status, project: d.project_id, repo: d.repo, commits: d.commits.length, text: d.text, inputId: d.inputId ?? null }))));
}

function useCommand(git: Command, config: LoadConfig): void {
  git.command('use <id>').description('下書きの本文をそのまま入力にする')
    .requiredOption('--hash <sha256>', 'git draftsで確認したハッシュ')
    .addOption(new Option('--kind <kind>', '入力の種類').choices(['memo', 'work-summary']).default('memo'))
    .requiredOption('--confirm', '本文を確認した本人による保存')
    .action(async (id, opts) => {
      const c = await config();
      const result = await useGitDraft(c, { draftId: id, expectedHash: opts.hash, kind: opts.kind, source: 'cli' });
      await rebuildDashboard(c);
      output(result);
    });
}

function dismissCommand(git: Command, config: LoadConfig): void {
  git.command('dismiss <id>').description('下書きを見送る')
    .requiredOption('--hash <sha256>', 'git draftsで確認したハッシュ')
    .requiredOption('--confirm', '本文を確認した本人による見送り')
    .action(async (id, opts) => {
      const c = await config();
      const result = await dismissGitDraft(c, { draftId: id, expectedHash: opts.hash, source: 'cli', sourceEventId: `cli:${id}:dismiss` });
      await rebuildDashboard(c);
      output(result);
    });
}
