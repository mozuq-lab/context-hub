import { Option, type Command } from 'commander';
import { ACTION_TEXT_CHARS } from '../actions.js';
import { rebuildDashboard } from '../dashboard.js';
import { setItemBlocks, readItemBlocks, ITEM_BLOCKS_MAX } from '../item-blocks.js';
import { setItemContexts, readItemContexts, CONTEXT_TAGS_MAX, CONTEXT_TAG_CHARS } from '../item-contexts.js';
import { setItemEffort, readItemEfforts, itemEfforts, itemEffortLabels, type ItemEffort } from '../item-efforts.js';
import { setItemProgress, readItemProgress, effectiveProgress, PROGRESS_NOTE_CHARS, PROGRESS_STALE_DAYS, type ItemProgress } from '../item-progress.js';
import { readNowItems, readItemResolutions, activeResolutions, UNASSIGNED_SCOPE } from '../item-resolutions.js';
import { setItemSchedule, readItemSchedules, activeSchedules, effectiveSchedules, completeOccurrence, readItemOccurrences, repeatLabel, todayIn, REPEAT_EVERY_MAX, type RepeatRule } from '../item-schedules.js';
import { setItemSomeday, readItemSomedays, effectiveSomedays, type ItemSomeday } from '../item-somedays.js';
import { setItemSteps, readItemSteps, stepsLabel, ITEM_STEPS_MIN, ITEM_STEPS_MAX } from '../item-steps.js';
import { setItemWait, readItemWaits, effectiveWaits, WAIT_WHO_CHARS, type ItemWaiting } from '../item-waits.js';
import { SOMEDAY_REVIEW_DAYS } from '../someday.js';
import { Vault, hash } from '../storage.js';
import { output, type LoadConfig } from '../cli-shared.js';

/**
 * itemの下の、本人が項目に付ける印（期日・手間の目安・札・手順・連絡待ち・取りかかり中・先に済ませること・いつかやる・定例の回）。
 * どの印も、直前の記録を受付IDに含め、直前がCLIの同じ内容なら同じ受付IDで再送して記録後の停止から回復する。
 */
export function registerItemMarkCommands(item: Command, config: LoadConfig): void {
  scheduleCommand(item, config);
  effortCommand(item, config);
  contextsCommand(item, config);
  stepsCommand(item, config);
  waitCommand(item, config);
  progressCommand(item, config);
  afterCommand(item, config);
  somedayCommand(item, config);
  roundCommands(item, config);
}

/** 定例の繰り返しの指定。daily・weekly・monthly、またはN日・N週・Nか月ごと（例: 14d・2w・3m）。noneで外す。 */
function parseRepeat(value: string): RepeatRule | null {
  if (value === 'none') return null;
  const named: Record<string, RepeatRule> = { daily: { unit: 'day', every: 1 }, weekly: { unit: 'week', every: 1 }, monthly: { unit: 'month', every: 1 } };
  if (named[value]) return named[value]!;
  const m = /^(\d{1,2})([dwm])$/.exec(value), every = m ? Number(m[1]) : 0;
  if (!m || every < 1 || every > REPEAT_EVERY_MAX) throw new Error(`繰り返しはdaily・weekly・monthly・none、または1〜${REPEAT_EVERY_MAX}の数とd・w・m（例: 14d・2w・3m）で指定してください`);
  return { unit: m[2] === 'd' ? 'day' : m[2] === 'w' ? 'week' : 'month', every };
}

function scheduleCommand(item: Command, config: LoadConfig): void {
  item.command('schedule <project> <key>').description('項目に期日・次に見直す日・繰り返しを付ける（noneで外す。指定しなかったものは今のものを保つ）')
    .option('--due <date>', '期日（YYYY-MM-DD、またはnone）')
    .option('--review <date>', '次に見直す日（YYYY-MM-DD、またはnone）。この日まではHOMEの一覧でたたむ')
    .option('--repeat <rule>', '定例の繰り返し（daily・weekly・monthly・14d・2w・3mなど、またはnone）。期日が必要')
    .option('--clear', '期日・見直す日・繰り返しをすべて外す')
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, opts) => {
      if (opts.clear && (opts.due !== undefined || opts.review !== undefined || opts.repeat !== undefined)) throw new Error('--clearと--due・--review・--repeatは同時に指定できません');
      if (!opts.clear && opts.due === undefined && opts.review === undefined && opts.repeat === undefined) throw new Error('--due・--review・--repeat・--clearのいずれかを指定してください');
      const rule = opts.repeat === undefined ? undefined : parseRepeat(opts.repeat);
      const c = await config(), vault = new Vault(c), records = (await readItemSchedules(vault)).records, list = (await readNowItems(vault, id))?.items ?? [];
      // 指定しなかった欄は、項目に今効いている日付（文面を直す前・引き継いだ記録を含む）から保つ。NOWから外れた記録はその記録から。
      const current = (list.some(i => i.key === key) ? effectiveSchedules(records, id, list, activeResolutions(await readItemResolutions(vault), id)).byKey.get(key) : undefined) ?? activeSchedules(records, id).get(key);
      const pick = (value: string | undefined, kept: string | null) => value === undefined ? kept : value === 'none' ? null : value;
      const due = opts.clear ? null : pick(opts.due, current?.due ?? null), reviewAfter = opts.clear ? null : pick(opts.review, current?.review_after ?? null);
      // 直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
      const tag = rule === undefined ? 'keep' : rule === null ? 'none' : `${rule.every}${rule.unit}`;
      const last = records.filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && last.due === due && last.review_after === reviewAfter && last.source_event_id?.endsWith(`:${tag}`) ? last.source_event_id : `cli:${key}:schedule:${due ?? '-'}:${reviewAfter ?? '-'}:${last?.id ?? 'none'}:${tag}`;
      const result = await setItemSchedule(c, { projectId: id, itemKey: key, due, reviewAfter, ...(opts.clear ? { repeat: null } : rule !== undefined ? { repeat: rule } : {}), source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      const saved = (await readItemSchedules(vault)).records.find(r => r.id === result.scheduleId);
      output({ ...result, due, review_after: reviewAfter, repeat: saved?.repeat ? repeatLabel(saved.repeat) : null });
    });
}

function effortCommand(item: Command, config: LoadConfig): void {
  item.command('effort <project> <key>').description(`項目に手間の目安を付ける（${itemEfforts.map(e => `${e}=${itemEffortLabels[e]}`).join('、')}。noneで外す）。空いた時間に合う項目を選ぶ手掛かりにする。AIは推測しない`)
    .addOption(new Option('--set <effort>', '手間の目安').choices([...itemEfforts, 'none']).makeOptionMandatory())
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, opts) => {
      const c = await config(), vault = new Vault(c);
      const effort = opts.set === 'none' ? null : opts.set as ItemEffort;
      // 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
      const last = (await readItemEfforts(vault)).records.filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && last.effort === effort && last.source_event_id ? last.source_event_id : `cli:${key}:effort:${effort ?? 'none'}:${last?.id ?? 'none'}`;
      const result = await setItemEffort(c, { projectId: id, itemKey: key, effort, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output({ ...result, effort });
    });
}

function contextsCommand(item: Command, config: LoadConfig): void {
  item.command('contexts <project> <key> [tags...]').description(`項目の場所・道具の札（例: 家・外出先・PC・電話）を、指定した札の全体に置き換える（${CONTEXT_TAGS_MAX}個まで・1つ${CONTEXT_TAG_CHARS}文字以内）。今いる場所や手元の道具でできる項目を選ぶ手掛かりにする。AIは付けない`)
    .option('--clear', '札をすべて外す')
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, tags: string[], opts) => {
      if (opts.clear && tags.length) throw new Error('--clearと札は同時に指定できません');
      if (!opts.clear && !tags.length) throw new Error('札か--clearを指定してください');
      const c = await config(), vault = new Vault(c), contexts = opts.clear ? null : tags;
      // 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
      const same = (a: string[] | null) => a === null ? contexts === null : contexts !== null && a.join('\n') === contexts.join('\n');
      const last = (await readItemContexts(vault)).records.filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && same(last.contexts) && last.source_event_id ? last.source_event_id : `cli:${key}:contexts:${last?.id ?? 'none'}:${contexts === null ? 'none' : hash(contexts.join('\n')).slice(0, 16)}`;
      const result = await setItemContexts(c, { projectId: id, itemKey: key, contexts, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output({ ...result, contexts: contexts ?? [] });
    });
}

function stepsCommand(item: Command, config: LoadConfig): void {
  item.command('steps <project> <key> [steps...]').description(`大きな次の一手を手順（${ITEM_STEPS_MIN}〜${ITEM_STEPS_MAX}個・1つ${ACTION_TEXT_CHARS}文字以内）に分ける。手順を指定すると全体を置き換えて最初からにし、--nextで今の手順を終えて次へ進め、--backで1つ戻す。NOW・HOMEには今の1歩だけが出る。AIは手順を作らない`)
    .option('--next', '今の手順を終えて次へ進める')
    .option('--back', '終えた手順を1つ戻す')
    .option('--clear', '手順を外す')
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, steps: string[], opts) => {
      const modes = [steps.length > 0, opts.next === true, opts.back === true, opts.clear === true].filter(Boolean).length;
      if (modes !== 1) throw new Error('手順・--next・--back・--clearのどれか1つを指定してください');
      const c = await config(), vault = new Vault(c), items = (await readNowItems(vault, id))?.items ?? [], current = items.find(i => i.key === key)?.steps;
      let value: { items: string[]; done: number } | null;
      if (opts.clear) value = null;
      else if (steps.length) value = { items: steps.map(s => s.trim()), done: 0 };
      else {
        if (!current) throw new Error('この項目には手順がありません。先に手順を指定してください');
        const done = current.done + (opts.next ? 1 : -1);
        if (done < 0) throw new Error('まだ手順を1つも終えていません');
        if (done > current.items.length) throw new Error('手順はすべて終えています。項目を完了にするか、手順を付け直してください');
        value = { items: current.items, done };
      }
      // 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
      const last = (await readItemSteps(vault)).records.filter(r => r.project_id === id && r.item_key === key).at(-1), same = JSON.stringify(last?.steps ?? null) === JSON.stringify(value);
      const event = last && last.source === 'cli' && same && last.source_event_id ? last.source_event_id : `cli:${key}:steps:${last?.id ?? 'none'}:${hash(JSON.stringify(value)).slice(0, 16)}`;
      const result = await setItemSteps(c, { projectId: id, itemKey: key, steps: value, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output({ ...result, steps: value, current: value ? stepsLabel(value) : null });
    });
}

function waitCommand(item: Command, config: LoadConfig): void {
  item.command('wait <project> <key>').description(`項目に「連絡待ち」の印を付ける（人に頼んだこと・返事を待っていること）。印を付けた項目はHOMEの「次の一手」から外れ、「連絡待ち」にまとまる。見直す日（schedule --review）が来ると「次の一手」の先頭に確認として出る。AIは付けない`)
    .option('--who <name>', `待っている相手（任意・${WAIT_WHO_CHARS}文字以内。HOMEとアプリにだけ示し、NOWとモデルへ渡す資料には載せない）`)
    .option('--no-who', '相手を外す')
    .option('--since <date>', '頼んだ日（YYYY-MM-DD。既定は、印が付いていれば今の頼んだ日、なければ今日）')
    .option('--clear', '印を外して元の欄へ戻す')
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, opts) => {
      if (opts.clear && (opts.who !== undefined || opts.since !== undefined)) throw new Error('--clearと--who・--sinceは同時に指定できません');
      const c = await config(), vault = new Vault(c), records = (await readItemWaits(vault)).records;
      // 既に印が付いている項目では、省いた相手・頼んだ日は今の印のままにする（相手だけ変えても待った日数を数え直さない）。
      const list = (await readNowItems(vault, id))?.items ?? [], current = list.some(i => i.key === key) ? effectiveWaits(records, id, list, activeResolutions(await readItemResolutions(vault), id)).get(key) : undefined;
      const who = opts.who === false ? undefined : opts.who !== undefined ? String(opts.who) : current?.who;
      const waiting: ItemWaiting | null = opts.clear ? null : { ...(who !== undefined ? { who } : {}), since: opts.since ?? current?.since ?? todayIn(c.timezone) };
      // 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する（受付IDには相手の名前ではなく、内容の短いハッシュを入れる）。
      const tag = waiting ? hash(JSON.stringify(waiting)).slice(0, 16) : 'none';
      const last = records.filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && last.source_event_id?.startsWith(`cli:${key}:wait:${tag}:`) ? last.source_event_id : `cli:${key}:wait:${tag}:${last?.id ?? 'none'}`;
      const result = await setItemWait(c, { projectId: id, itemKey: key, waiting, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output({ ...result, waiting });
    });
}

function progressCommand(item: Command, config: LoadConfig): void {
  item.command('progress <project> <key>').description(`次の一手に「取りかかり中」の印を付ける（数日かけて進めている項目）。印を付けた項目はHOMEの「次の一手」の先頭の「取りかかり中」にまとまり、${PROGRESS_STALE_DAYS}日更新がないと週次レビューとふりかえりに出る。--noteでどこまで進んだかを書き直せる。AIは付けない`)
    .option('--note <text>', `どこまで進んだかのひとこと（任意・1行${PROGRESS_NOTE_CHARS}文字以内。HOMEとアプリにだけ示し、NOWとモデルへ渡す資料には載せない）`)
    .option('--no-note', 'ひとことを外す')
    .option('--since <date>', '始めた日（YYYY-MM-DD。既定は、印が付いていれば今の始めた日、なければ今日）')
    .option('--clear', '印を外して、ふつうの次の一手に戻す')
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, opts) => {
      if (opts.clear && (opts.note !== undefined || opts.since !== undefined)) throw new Error('--clearと--note・--sinceは同時に指定できません');
      const c = await config(), vault = new Vault(c), records = (await readItemProgress(vault)).records;
      // 既に印が付いている項目では、省いたひとこと・始めた日は今の印のままにする（ひとことだけ書き直しても始めた日を変えない）。
      const list = (await readNowItems(vault, id))?.items ?? [], current = list.some(i => i.key === key) ? effectiveProgress(records, id, list, activeResolutions(await readItemResolutions(vault), id), c.timezone).get(key) : undefined;
      const note = opts.note === false ? undefined : opts.note !== undefined ? String(opts.note).trim() : current?.note;
      if (typeof opts.note === 'string' && !note) throw new Error('ひとことが空です。ひとことを外すときは--no-noteを指定してください');
      const progress: ItemProgress | null = opts.clear ? null : { since: opts.since ?? current?.since ?? todayIn(c.timezone), ...(note ? { note } : {}) };
      // 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する（受付IDにはひとことではなく、内容の短いハッシュを入れる）。
      const tag = progress ? hash(JSON.stringify(progress)).slice(0, 16) : 'none';
      const last = records.filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && last.source_event_id?.startsWith(`cli:${key}:progress:${tag}:`) ? last.source_event_id : `cli:${key}:progress:${tag}:${last?.id ?? 'none'}`;
      const result = await setItemProgress(c, { projectId: id, itemKey: key, progress, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output({ ...result, progress });
    });
}

function afterCommand(item: Command, config: LoadConfig): void {
  item.command('after <project> <key>').description(`項目に「先に済ませること」を付ける（別の項目が済むまで手を付けられない）。先の項目が残っている間はHOMEの「次の一手」から外れて「先待ち」にまとまり、すべて片付くと「動けるようになった項目」に出る。付けられるのはプロジェクトの項目だけ。AIは付けない`)
    .option('--on <items...>', `先に済ませる項目（<置き場>:<キー>。置き場はプロジェクトIDか${UNASSIGNED_SCOPE}。1〜${ITEM_BLOCKS_MAX}件、ctx item listで確認）`)
    .option('--clear', '印を外して、ふつうの次の一手に戻す')
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, opts) => {
      if (!!opts.clear === !!opts.on?.length) throw new Error('--onか--clearのどちらか一方を指定してください');
      const after: { projectId: string; itemKey: string }[] | null = opts.clear ? null : (opts.on as string[]).map(ref => {
        const at = ref.lastIndexOf(':');
        if (at < 1) throw new Error(`先の項目は<置き場>:<キー>で指定してください: ${ref}`);
        return { projectId: ref.slice(0, at), itemKey: ref.slice(at + 1) };
      });
      const c = await config(), vault = new Vault(c), records = (await readItemBlocks(vault)).records;
      // 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
      const tag = after ? hash(JSON.stringify(after)).slice(0, 16) : 'none';
      const last = records.filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && last.source_event_id?.startsWith(`cli:${key}:after:${tag}:`) ? last.source_event_id : `cli:${key}:after:${tag}:${last?.id ?? 'none'}`;
      const result = await setItemBlocks(c, { projectId: id, itemKey: key, after, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output({ ...result, after });
    });
}

function somedayCommand(item: Command, config: LoadConfig): void {
  item.command('someday <project> <key>').description(`項目を「いつかやる」へ移す（今はやらないが残しておく）。移した項目はHOMEの「次の一手」の一覧・件数・期日の欄から外れ、「いつかやる」の一覧で${SOMEDAY_REVIEW_DAYS}日ごとに見直す。AIは移さない`)
    .option('--keep', '見直したが今は始めない（そのまま）。移した日は変えず、見直した日を今日にする')
    .option('--clear', '元の欄へ戻す（始める）')
    .requiredOption('--confirm', '項目を確認した本人による操作')
    .action(async (id, key, opts) => {
      if (opts.keep && opts.clear) throw new Error('--keepと--clearは同時に指定できません');
      const c = await config(), vault = new Vault(c), records = (await readItemSomedays(vault)).records, today = todayIn(c.timezone);
      const list = (await readNowItems(vault, id))?.items ?? [], current = list.some(i => i.key === key) ? effectiveSomedays(records, id, list, activeResolutions(await readItemResolutions(vault), id)).get(key) : undefined;
      if (opts.keep && !current) throw new Error('この項目は「いつかやる」にありません。item listで確かめてください');
      const someday: ItemSomeday | null = opts.clear ? null : opts.keep ? { since: current!.since, reviewed: today } : { since: today };
      // 直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
      const tag = someday ? `${someday.since}:${someday.reviewed ?? someday.since}` : 'none';
      const last = records.filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && last.source_event_id?.startsWith(`cli:${key}:someday:${tag}:`) ? last.source_event_id : `cli:${key}:someday:${tag}:${last?.id ?? 'none'}`;
      const result = await setItemSomeday(c, { projectId: id, itemKey: key, someday, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output({ ...result, someday });
    });
}

/** done-round・skip-round: 定例の項目の今回を完了・見送りにし、期日を次の回へ進める。 */
function roundCommands(item: Command, config: LoadConfig): void {
  for (const action of ['done', 'skip'] as const) {
    item.command(`${action}-round <project> <key>`).description(action === 'done' ? '定例の項目の今回を完了にし、期日を次の回へ進める（項目は残る）' : '定例の項目の今回だけを見送り、期日を次の回へ進める')
      .requiredOption('--confirm', '項目と期日を確認した本人による報告')
      .action(async (id, key) => {
        const c = await config(), vault = new Vault(c), list = (await readNowItems(vault, id))?.items ?? [];
        // 今の回はNOWではなく日付の記録から決める（次の回の記録を作った後、NOWの再生成の前に停止しても、記録どおりの回を示す）。
        const current = list.find(i => i.key === key) ? effectiveSchedules((await readItemSchedules(vault)).records, id, list, activeResolutions(await readItemResolutions(vault), id)).byKey.get(key) : undefined;
        if (!current?.due || !current.repeat) throw new Error('この項目には繰り返しが付いていません。item listで確かめてください');
        // 直前の回の記録がCLIの同じ回・同じ操作で、次の回の日付をまだ作れていなければ（記録後の停止）、同じ受付IDで再送して続きを作る。
        const due = current.due, last = (await readItemOccurrences(vault)).records.filter(o => o.project_id === id && o.item_key === key).at(-1);
        const resume = last && last.source === 'cli' && last.due === due && last.action === action && last.source_event_id && (await vault.read(`90_system/item-schedules/${last.schedule_id}.json`)) === undefined;
        const event = resume ? last.source_event_id! : `cli:${key}:round:${due}:${action}:${last?.id ?? 'none'}`;
        const result = await completeOccurrence(c, { projectId: id, itemKey: key, action, due, source: 'cli', sourceEventId: event });
        await rebuildDashboard(c);
        output(result);
      });
  }
}
