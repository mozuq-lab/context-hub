import { Option } from 'commander';
import { listCandidates, approve, reject, propose } from '../approvals.js';
import { readInputs } from '../capture.js';
import { rebuildDashboard } from '../dashboard.js';
import { retireKnowledge } from '../knowledge-retirement.js';
import { readPolicies, formatPolicies, resolvePolicyProject, policyProjectFor } from '../policies.js';
import { keepPolicy, policyReviewItems, policyReviewDays } from '../policy-reviews.js';
import { Vault } from '../storage.js';
import { output, type RegisterCommand } from '../cli-shared.js';

/** policies: 同期版の有効方針を読み取り専用で出す。 */
export const registerPolicies: RegisterCommand = (program, config) => {
  program.command('policies').description('同期版の有効方針を読取専用で取得')
    .option('--project <id>', 'ContextHubプロジェクト')
    .option('--cwd <path>', '対応付ける作業フォルダー')
    .option('--json', 'JSON出力')
    .action(async opts => {
      const c = await config();
      const id = opts.project ? await policyProjectFor(c, opts.project) : (opts.cwd ? await resolvePolicyProject(c, opts.cwd) : undefined), b = await readPolicies(c, id);
      output(opts.json ? b : formatPolicies(b));
    });
};

/** policy: 採用した方針を本人が定期的に見直す。 */
export const registerPolicy: RegisterCommand = (program, config) => {
  const policy = program.command('policy').description('採用した方針（判断・好み）を、本人が定期的に見直す');
  policy.command('review').description('有効な方針と、採用（または前回「まだ有効」と確かめて）からの日数。見直す時期の方針が先頭')
    .option('--all', '見直す時期でない方針も表示')
    .action(async opts => {
      const c = await config(), vault = new Vault(c);
      const { items, problems } = await policyReviewItems(c, vault, { inputs: await readInputs(c) });
      output({
        review_days: policyReviewDays(c),
        policies: items.filter(i => opts.all || i.due).map(i => ({
          id: i.knowledgeId,
          hash: i.hash,
          kind: i.kind,
          scope: i.projectId ?? 'global',
          claim: i.claim,
          approved_at: i.approvedAt,
          confirmed_at: i.confirmedAt ?? null,
          days: i.days,
          due: i.due,
          ...(i.newInputs !== undefined ? { new_inputs: i.newInputs } : {}),
        })),
        problems,
      });
    });
  policy.command('keep <id>').description('方針がまだ有効だと確かめた記録を残す（見直しの日数をここから数え直す）。止めるときは retire を使う')
    .requiredOption('--hash <sha256>', 'policy reviewで確認した方針のハッシュ')
    .requiredOption('--confirm', '方針を確認した本人による操作')
    .action(async (id, opts) => {
      const c = await config();
      const result = await keepPolicy(c, { knowledgeId: id, expectedHash: opts.hash, source: 'cli' });
      await rebuildDashboard(c);
      output(result);
    });
};

/** retire: 正式知識の適用を本人が止める。 */
export const registerRetire: RegisterCommand = (program, config) => {
  program.command('retire <id>')
    .requiredOption('--hash <sha256>', '確認した正式知識のハッシュ')
    .requiredOption('--confirm', '本人による適用停止')
    .action(async (id, opts) => output(await retireKnowledge(await config(), id, opts.hash)));
};

/** candidates: 知識の候補の一覧。 */
export const registerCandidates: RegisterCommand = (program, config) => {
  program.command('candidates').action(async () => output(await listCandidates(await config())));
};

/** approve: 知識の候補を採用する。 */
export const registerApprove: RegisterCommand = (program, config) => {
  program.command('approve <id>')
    .requiredOption('--hash <sha256>', '候補一覧で確認した内容ハッシュ')
    .requiredOption('--scope <scope>', 'global または project')
    .option('--project <id>', '採用先ContextHubプロジェクト')
    .option('--project-hash <sha256>', '確認したproject.mdのハッシュ')
    .action(async (id, opts) => output(await approve(await config(), id, opts.hash, opts.scope === 'project' ? { scope: 'project', projectId: opts.project, projectHash: opts.projectHash } : { scope: opts.scope })));
};

/** reject: 知識の候補を見送る。 */
export const registerReject: RegisterCommand = (program, config) => {
  program.command('reject <id>')
    .requiredOption('--hash <sha256>', '候補一覧で確認した内容ハッシュ')
    .action(async (id, opts) => output(await reject(await config(), id, opts.hash)));
};

/** propose: 人が知識の候補を作る。 */
export const registerPropose: RegisterCommand = (program, config) => {
  program.command('propose <claim>')
    .addOption(new Option('--kind <kind>', '候補の種別').choices(['knowledge', 'decision', 'preference']).default('knowledge'))
    .option('--rationale <text>', '根拠', '人による候補作成')
    .option('--supersedes <id>', '置き換えるKNW-ID')
    .action(async (claim, opts) => output(await propose(await config(), { claim, kind: opts.kind, rationale: opts.rationale, supersedes: opts.supersedes })));
};
