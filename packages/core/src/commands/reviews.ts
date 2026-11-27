import type { Command } from 'commander';
import { rebuildDashboard } from '../dashboard.js';
import { setDayClose, readDayCloses, currentDayNote, dayClosesByDate, DAY_NOTE_CHARS, DAY_NOTE_LINES, DAY_CLOSE_BACK_DAYS } from '../day-closes.js';
import { rebuildDigest } from '../digest.js';
import { todayIn } from '../item-schedules.js';
import { buildSomedayList, setSomedayReview, somedayStale, readSomedayReviews, SOMEDAY_REVIEW_DAYS, type SomedayReviewAction } from '../someday.js';
import { Vault, hash } from '../storage.js';
import { buildWeeklyReview, daysSinceWeeklyReview, setWeeklyReview, WEEKLY_REVIEW_INTERVAL_DAYS } from '../weekly-review.js';
import { output, type LoadConfig, type RegisterCommand } from '../cli-shared.js';

/** someday: 「いつかやる」の一覧を見直す。 */
export const registerSomeday: RegisterCommand = (program, config) => {
  const someday = program.command('someday').description(`「いつかやる」の一覧（移した項目・休止中のプロジェクト・置いたアイデア）を見直す。最後に見直した日の古い順に並び、${SOMEDAY_REVIEW_DAYS}日以上見直していないものに印が付く。AIは置きも始めもしない`);
  someday.command('list').description('「いつかやる」の一覧（最後に見直した日の古い順）')
    .action(async () => {
      const c = await config(), today = todayIn(c.timezone), list = await buildSomedayList(c, new Vault(c));
      output(list.entries.map(e => ({ ...e, stale: somedayStale(e, today) })));
    });
  somedayReviewCommands(someday, config);
};

function somedayReviewCommands(someday: Command, config: LoadConfig): void {
  // 直前の記録を含めて受付IDにする。直前がCLIの同じ判断なら同じ受付IDで再送し、記録後の停止から回復する。
  const somedayReview = async (target: 'idea' | 'project', id: string, action: SomedayReviewAction) => {
    const c = await config(), vault = new Vault(c), on = todayIn(c.timezone), last = (await readSomedayReviews(vault)).records.filter(r => r.target === target && r.target_id === id).at(-1);
    const event = last && last.source === 'cli' && last.action === action && last.on === on && last.source_event_id ? last.source_event_id : `cli:someday:${target}:${id}:${action}:${on}:${last?.id ?? 'none'}`;
    const result = await setSomedayReview(c, { target, targetId: id, action, on, source: 'cli', sourceEventId: event });
    await rebuildDashboard(c);
    output(result);
  };
  someday.command('idea <idea-id> <action>').description('アイデアを「いつかやる」に置く（add）・見直したが今は始めない（keep）・始めたので外す（start。プロジェクトか行動は別に作る）・やめて外す（drop）。アイデアのファイルは書き換えない')
    .requiredOption('--confirm', 'アイデアを確認した本人による判断')
    .action(async (id, action) => {
      if (!['add', 'keep', 'start', 'drop'].includes(action)) throw new Error('actionはadd・keep・start・dropのどれかです');
      await somedayReview('idea', id, action);
    });
  someday.command('keep-project <project>').description('休止中のプロジェクトを見直し、今は再開しない（そのまま）と記録する。再開・完了はproject statusで切り替える')
    .requiredOption('--confirm', 'プロジェクトを確認した本人による判断')
    .action(async id => somedayReview('project', id, 'keep'));
}

/** weekly-review: 週次レビューの点検の一覧と、見直した記録。 */
export const registerWeeklyReview: RegisterCommand = (program, config) => {
  const weekly = program.command('weekly-review').description(`週次レビュー: 確認待ち・プロジェクト未定の行動・進行中のプロジェクト・停滞・連絡待ち・期日・いつかやるを順に点検する。${WEEKLY_REVIEW_INTERVAL_DAYS}日以上見直していなければHOMEで促す。見直した記録は本人の報告だけで作る`);
  weekly.command('show').description('点検の一覧（モデルを使わずに作る。アプリとREVIEW.mdの「週次レビューの点検」と同じ）')
    .action(async () => {
      const c = await config(), list = await buildWeeklyReview(c, new Vault(c));
      output({ ...list, days_since_last_review: daysSinceWeeklyReview(list, todayIn(c.timezone)) });
    });
  weekly.command('done').description('週次レビューを終えた（見直した）と記録し、HOMEとふりかえりを作り直す。同じ日の記録が既にあれば増やさない')
    .option('--on <date>', '見直した日（YYYY-MM-DD。既定は今日）')
    .requiredOption('--confirm', '点検を終えた本人による報告')
    .action(async opts => {
      const c = await config(), on = opts.on ?? todayIn(c.timezone);
      const result = await setWeeklyReview(c, { on, source: 'cli', sourceEventId: `cli:weekly-review:${on}` });
      await rebuildDigest(c);
      await rebuildDashboard(c);
      output(result);
    });
};

/** day: 1日の締めと、明日へのひとこと。 */
export const registerDay: RegisterCommand = (program, config) => {
  const day = program.command('day').description(`1日の締め: その日を締め、明日へのひとこと（任意・${DAY_NOTE_LINES}行・${DAY_NOTE_CHARS}文字以内）を残す。ひとことは次に締めるか消すまでHOMEの先頭に出て、ふりかえりにも載る。整理用のモデルへは渡さない`);
  dayCloseCommand(day, config);
  dayDismissCommand(day, config);
  dayListCommand(day, config);
};

function dayCloseCommand(day: Command, config: LoadConfig): void {
  day.command('close').description(`その日を締める。同じ日を締め直すと、最後の締めがその日の締めになる（${DAY_CLOSE_BACK_DAYS}日前までさかのぼれる）`)
    .option('--on <date>', '締める日（YYYY-MM-DD。既定は今日）')
    .option('--note <text>', '明日へのひとこと（改行は\\nではなく、実際の改行で書く）')
    .requiredOption('--confirm', 'その日を締めた本人による報告')
    .action(async opts => {
      const c = await config(), vault = new Vault(c), on = opts.on ?? todayIn(c.timezone), note = opts.note === undefined ? null : String(opts.note), last = (await readDayCloses(vault)).records.at(-1);
      // 直前の記録を含めて受付IDにする。同じ内容の再実行は同じ受付IDになり、記録を増やさない。
      const tag = `cli:day-close:${on}:${hash(JSON.stringify(note)).slice(0, 16)}:`, event = last?.source === 'cli' && last.source_event_id?.startsWith(tag) ? last.source_event_id : `${tag}${last?.id ?? 'none'}`;
      const result = await setDayClose(c, { action: 'close', on, note, source: 'cli', sourceEventId: event });
      await rebuildDigest(c);
      await rebuildDashboard(c);
      output(result);
    });
}

function dayDismissCommand(day: Command, config: LoadConfig): void {
  day.command('dismiss').description('表示中の明日へのひとことを消す（HOMEの先頭から外す。締めの記録は残る）')
    .requiredOption('--confirm', 'ひとことを読んだ本人による操作')
    .action(async () => {
      const c = await config(), current = currentDayNote((await readDayCloses(new Vault(c))).records);
      if (!current) throw new Error('消す明日へのひとことはありません');
      const result = await setDayClose(c, { action: 'dismiss', closeId: current.id, source: 'cli', sourceEventId: `cli:day-dismiss:${current.id}` });
      await rebuildDashboard(c);
      output(result);
    });
}

function dayListCommand(day: Command, config: LoadConfig): void {
  day.command('list').description('締めた日とひとことの一覧（新しい順）と、いまHOMEに出ているひとこと')
    .option('--limit <n>', '件数（既定14）', '14')
    .action(async opts => {
      const c = await config(), records = (await readDayCloses(new Vault(c))).records, limit = Math.max(1, Number(opts.limit) || 14);
      output({ current: currentDayNote(records) ?? null, closes: dayClosesByDate(records).reverse().slice(0, limit) });
    });
}
