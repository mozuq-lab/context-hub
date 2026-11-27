import { Command } from 'commander';
import { loadConfig } from './config.js';
import type { LoadConfig, RegisterCommand } from './cli-shared.js';
import { registerInit, registerAdd, registerCorrect } from './commands/capture.js';
import { registerProject } from './commands/project.js';
import { registerItem } from './commands/item.js';
import { registerHistory, registerReferences, registerReference } from './commands/references.js';
import { registerGit } from './commands/git.js';
import { registerPerson } from './commands/person.js';
import { registerIdea } from './commands/idea.js';
import { registerSomeday, registerWeeklyReview, registerDay } from './commands/reviews.js';
import { registerConflict, registerBackup, registerDoctor } from './commands/maintenance.js';
import { registerOrganize, registerRetryOrganize, registerIngest, registerDigest, registerDashboard, registerSynthesize, registerCycle } from './commands/processing.js';
import { registerFind, registerAsk, registerRecent, registerPending, registerResume, registerContext, registerBundle } from './commands/retrieval.js';
import { registerPolicies, registerPolicy, registerRetire, registerCandidates, registerApprove, registerReject, registerPropose } from './commands/knowledge.js';

/**
 * `ctx --help`に並ぶ順。コマンドは群ごとのファイル（commands/）に置き、ここでは並び順だけを決める。
 * 並びを変えると`--help`の文面が変わる（test/cli-help.test.tsのスナップショットで確かめる）。
 */
const commands: RegisterCommand[] = [
  registerInit, registerAdd, registerProject, registerCorrect, registerItem,
  registerHistory, registerReferences, registerReference, registerGit, registerPerson, registerIdea,
  registerSomeday, registerWeeklyReview, registerDay, registerConflict,
  registerOrganize, registerFind, registerAsk, registerRetryOrganize, registerIngest, registerDigest, registerDashboard, registerSynthesize, registerCycle,
  registerRecent, registerPending, registerResume, registerContext, registerBundle,
  registerPolicies, registerPolicy, registerRetire, registerCandidates, registerApprove, registerReject, registerPropose,
  registerBackup, registerDoctor,
];

/** ctxのコマンド全体を組み立てる（解析・実行はcli.ts）。 */
export function createProgram(): Command {
  const program = new Command().name('ctx').description('Markdownを正本とする個人用AI Context Hub').version('0.1.0')
    .option('--config <path>', '設定ファイル')
    .option('--vault <path>', '明示的な保存先')
    .option('--state <path>', 'Vault外のローカル状態');
  const config: LoadConfig = async (overrides = {}) => {
    const opts = program.opts();
    return loadConfig(opts.config, { ...(opts.vault ? { vaultPath: opts.vault } : {}), ...(opts.state ? { statePath: opts.state } : {}), ...overrides });
  };
  for (const register of commands) register(program, config);
  return program;
}
