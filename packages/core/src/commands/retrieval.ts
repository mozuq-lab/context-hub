import { Option } from 'commander';
import { answerQuestion, askSourcesFrom, formatAnswer, selectAskSources } from '../ask.js';
import { readEffectiveInputs } from '../effective-inputs.js';
import { readProjects, resolveProject } from '../projects.js';
import { find, findKinds, recent, pending, resume, context, bundle, bundleMaxIds, type FindKind } from '../retrieve.js';
import { organizeClient, output, positive, type RegisterCommand } from '../cli-shared.js';

/** find: 原文・アイデア・知識・NOWを検索する。 */
export const registerFind: RegisterCommand = (program, config) => {
  program.command('find [query]').description('原文・アイデア・知識・NOWを検索。絞り込み条件があれば検索語は省略可')
    .option('--project <id>', 'このプロジェクトに帰属・関連する記録だけ（AI推定は区別して表示）')
    .option('--kind <kinds>', `種類、カンマ区切り（${findKinds.join(', ')}）`)
    .option('--since <date>', 'この日付（YYYY-MM-DD、JST）または日時以降')
    .option('--until <date>', 'この日付（YYYY-MM-DD、JST）または日時以前')
    .addOption(new Option('--sort <order>', '並び順。検索語がなければnewest').choices(['relevance', 'newest']))
    .option('--limit <n>', '表示件数（1〜200、既定50）', positive)
    .option('--offset <n>', '先頭から飛ばす件数', (v: string) => {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('開始位置は0以上の整数にしてください');
      return n;
    })
    .action(async (query, opts) => output(await find(await config(), query ?? '', {
      project: opts.project,
      kinds: opts.kind?.split(',').map((k: string) => k.trim()).filter(Boolean) as FindKind[] | undefined,
      since: opts.since,
      until: opts.until,
      sort: opts.sort,
      limit: opts.limit,
      offset: opts.offset,
      pagingHint: true,
    })));
};

/** ask: 記録だけを根拠に、問いへ引用付きで答える。 */
export const registerAsk: RegisterCommand = (program, config) => {
  program.command('ask <question...>').description('記録だけを根拠に、問いへ引用付きで答える（AI生成・未検証。引用は記録と一致するものだけを残す）。整理と同じモデルを1回呼ぶ')
    .option('--project <id>', 'このプロジェクトに帰属・関連する記録から答える')
    .option('--dry-run', '根拠の候補として渡す記録だけを表示。モデルは呼ばない')
    .option('--json', 'JSONで出力')
    .action(async (words: string[], opts) => {
      const c = await config(), question = words.join(' ');
      if (opts.dryRun) {
        let project = opts.project as string | undefined;
        if (project !== undefined) {
          const projects = await readProjects(c);
          if (!projects.some(p => p.id === project)) throw new Error('プロジェクトが見つかりません');
          project = resolveProject(projects, project);
        }
        const chosen = selectAskSources(question, askSourcesFrom(await readEffectiveInputs(c), c), { project, limit: c.ask.maxSources });
        output(chosen.length ? chosen.map(s => `- ${s.ref} ${s.inputId} | ${s.occurredAt} | ${s.text.slice(0, 80).replace(/\r?\n/g, ' ')}`).join('\n') : '問いに近い記録が見つかりません');
        return;
      }
      if (!c.ask.enabled) throw new Error('記録に聞くは無効です。設定のask.enabledをtrueにしてください');
      const answer = await answerQuestion(c, organizeClient(c), question, opts.project ? { project: opts.project } : {});
      if (opts.json) {
        output({ question, ...answer });
      } else {
        const paths = new Map((await readEffectiveInputs(c)).flatMap(u => [u.chain.root, ...u.chain.revisions].map(i => [i.id, i.path] as [string, string])));
        output(formatAnswer(question, answer, paths));
      }
      if (answer.status === 'failed') process.exitCode = 1;
    });
};

/** recent: 最近受け付けた入力の一覧。 */
export const registerRecent: RegisterCommand = (program, config) => {
  program.command('recent').option('--n <n>', '表示件数', positive, 10)
    .action(async opts => output(await recent(await config(), opts.n)));
};

/** pending: まだ整理済みになっていない入力の一覧。 */
export const registerPending: RegisterCommand = (program, config) => {
  program.command('pending').action(async () => output(await pending(await config())));
};

/** resume: プロジェクトのNOWを、作業を再開するときに読む形で出す。 */
export const registerResume: RegisterCommand = (program, config) => {
  program.command('resume <project>').action(async id => output(await resume(await config(), id)));
};

/** context: プロジェクトの文脈を、最大文字数までにまとめて出す。 */
export const registerContext: RegisterCommand = (program, config) => {
  program.command('context <project>').option('--max-chars <n>', '最大文字数', positive)
    .action(async (id, opts) => output(await context(await config(), id, opts.maxChars)));
};

/** bundle: 選んだ記録を出典付きの1つの資料にする。 */
export const registerBundle: RegisterCommand = (program, config) => {
  program.command('bundle <ids...>').description(`選んだ記録（IN・IDEA・KNWのID、NOWはプロジェクトID。最大${bundleMaxIds}件）を、出典・訂正の注意・方針付きの1つの資料にする`)
    .option('--max-chars <n>', '最大文字数', positive)
    .action(async (ids, opts) => output(await bundle(await config(), ids, opts.maxChars)));
};
