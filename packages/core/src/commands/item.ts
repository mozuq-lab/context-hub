import { Option, type Command } from 'commander';
import { ACTION_TEXT_CHARS } from '../actions.js';
import { moveAction } from '../action-moves.js';
import { capture, readInputs } from '../capture.js';
import { rebuildDashboard } from '../dashboard.js';
import { CONTEXT_TAGS_MAX } from '../item-contexts.js';
import { itemEfforts, type ItemEffort } from '../item-efforts.js';
import { setItemResolution, readNowItems, readItemResolutions, exclusionReasons, exclusionReasonLabels, itemKey, UNASSIGNED_SCOPE } from '../item-resolutions.js';
import { repeatLabel } from '../item-schedules.js';
import { stepsLabel } from '../item-steps.js';
import { dismissResolutionHint } from '../resolution-hints.js';
import { Vault } from '../storage.js';
import { output, type LoadConfig, type RegisterCommand } from '../cli-shared.js';
import { registerItemMarkCommands } from './item-marks.js';

/** item: NOWの次の一手・未解決を、本人の確認で完了・解決にする、誤りとして外す、未解決へ戻す。印（期日・手間の目安など）はitem-marks.ts。 */
export const registerItem: RegisterCommand = (program, config) => {
  const item = program.command('item').description('NOWの次の一手・未解決を、本人の確認で完了・解決にする、誤りとして外す、または未解決へ戻す');
  listCommand(item, config);
  resolveCommands(item, config);
  excludeCommand(item, config);
  addCommand(item, config);
  moveCommand(item, config);
  dismissHintCommand(item, config);
  registerItemMarkCommands(item, config);
};

function listCommand(item: Command, config: LoadConfig): void {
  item.command('list <project>').description('直近に生成したNOWの項目とキーを表示')
    .action(async id => {
      const items = await readNowItems(new Vault(await config()), id);
      if (!items) throw new Error('NOW項目の記録がありません。cycleを実行してください');
      output(items.items.map(i => ({
        key: i.key,
        section: i.section,
        text: `${i.label}${i.text}`,
        input_id: i.input_id,
        resolved: i.resolution && i.resolution.action !== 'exclude' ? i.resolution.id : null,
        ...(i.resolution?.action === 'exclude' ? { excluded: { id: i.resolution.id, reason: i.resolution.reason, note: i.resolution.note ?? null } } : {}),
        due: i.schedule?.due ?? null,
        review_after: i.schedule?.review_after ?? null,
        repeat: i.schedule?.repeat ? repeatLabel(i.schedule.repeat) : null,
        effort: i.effort ?? null,
        contexts: i.contexts ?? [],
        steps: i.steps ? { items: i.steps.items, done: i.steps.done, current: stepsLabel(i.steps) } : null,
        waiting: i.waiting ? { since: i.waiting.since, who: i.waiting.who ?? null } : null,
        progress: i.progress ? { since: i.progress.since, updated: i.progress.updated, note: i.progress.note ?? null } : null,
        someday: i.someday ? { since: i.someday.since, reviewed: i.someday.reviewed } : null,
        ...(i.hints?.length ? { maybe_done: i.hints.map(h => ({ input_id: h.input_id, quote: h.quote })) } : {}),
        ...(i.action ? { added_by_person: true, ...(i.action.from ? { from: i.action.from } : {}) } : {}),
      })));
    });
}

function resolveCommands(item: Command, config: LoadConfig): void {
  for (const action of ['resolve', 'reopen'] as const) {
    item.command(`${action} <project> <key>`).description(action === 'resolve' ? '項目を完了・解決にする' : '解決済み、または誤りとして外した項目を未解決へ戻す')
      .requiredOption('--confirm', '項目を確認した本人による報告')
      .action(async (id, key, _opts) => {
        const c = await config(), vault = new Vault(c);
        // 直前の記録を含めて受付IDにする。直前がCLIの同じ操作なら同じ受付IDで再送し、記録後の停止から回復する。
        const last = (await readItemResolutions(vault)).filter(r => r.project_id === id && r.item_key === key).at(-1);
        const event = last && last.source === 'cli' && last.action === action && last.source_event_id ? last.source_event_id : `cli:${key}:${action}:${last?.id ?? 'none'}`;
        const result = await setItemResolution(c, { projectId: id, itemKey: key, action, source: 'cli', sourceEventId: event });
        await rebuildDashboard(c);
        output(result);
      });
  }
}

function excludeCommand(item: Command, config: LoadConfig): void {
  item.command('exclude <project> <key>').description(`AIの読み違いなどの誤りとして項目を外す（完了・解決とは数えない）。理由: ${exclusionReasons.map(r => `${r}=${exclusionReasonLabels[r]}`).join('、')}。読み違いと、AIが推定した帰属への「別のプロジェクトの話」は、次のcycleで元のメモを読み直す`)
    .addOption(new Option('--reason <reason>', '外す理由').choices([...exclusionReasons]).makeOptionMandatory())
    .option('--note <text>', '一言（200文字以内・1行。次からの整理でAIへ渡す）')
    .requiredOption('--confirm', '項目を確認した本人による報告')
    .action(async (id, key, opts) => {
      const c = await config(), vault = new Vault(c);
      // 完了報告と同じく、直前の記録を含めて受付IDにする。直前がCLIの同じ内容なら同じ受付IDで再送し、記録後の停止から回復する。
      const last = (await readItemResolutions(vault)).filter(r => r.project_id === id && r.item_key === key).at(-1);
      const event = last && last.source === 'cli' && last.action === 'exclude' && last.reason === opts.reason && last.note === opts.note && last.source_event_id ? last.source_event_id : `cli:${key}:exclude:${last?.id ?? 'none'}`;
      const result = await setItemResolution(c, { projectId: id, itemKey: key, action: 'exclude', reason: opts.reason, note: opts.note, source: 'cli', sourceEventId: event });
      await rebuildDashboard(c);
      output(result);
    });
}

// 本人が決めた行動を、モデルを通さずにNOWの次の一手へ載せる。AIが読み取った行を行動にするときは、元の行を--from-key（キー付きの項目）か--fromと--from-text（提案）で示す。
function addCommand(item: Command, config: LoadConfig): void {
  item.command('add <project> [text]').description(`本人が決めた行動を次の一手に追加する（1行・${ACTION_TEXT_CHARS}文字以内。モデルを使わない）。projectを${UNASSIGNED_SCOPE}にすると、プロジェクト未定の次の一手に追加する。AIが読み取った行を行動にするときは元の行を指定し、textを省くと元の本文のまま追加する`)
    .option('--from-key <key>', '行動にするNOWの項目のキー（item listで確認）')
    .option('--from <input-id>', '行動にする提案の根拠の入力ID')
    .option('--from-text <text>', '行動にする提案の本文（ラベルを除く）')
    .addOption(new Option('--effort <effort>', '一緒に付ける手間の目安').choices([...itemEfforts]))
    .option('--context <tag>', `一緒に付ける場所・道具の札（1つずつ指定。繰り返して複数可・${CONTEXT_TAGS_MAX}個まで。同じ受付IDの再送では最初の札のまま）`, (v: string, p: string[] | undefined) => [...(p ?? []), v])
    .option('--event-id <id>', '再送判定用ID（付けると、途中で止まった追加を同じIDで再送しても重複しない）')
    .requiredOption('--confirm', '文面を確認した本人による追加')
    .action(async (id, text, opts) => {
      const c = await config(), vault = new Vault(c);
      if (opts.fromKey !== undefined && (opts.from !== undefined || opts.fromText !== undefined)) throw new Error('--from-keyと--from・--from-textは同時に指定できません');
      if ((opts.from === undefined) !== (opts.fromText === undefined)) throw new Error('--fromと--from-textは組で指定してください');
      let from: { input_id: string; text: string; key?: string } | undefined = opts.from !== undefined ? { input_id: opts.from, text: opts.fromText } : undefined;
      if (opts.fromKey !== undefined) {
        const found = (await readNowItems(vault, id))?.items.find(i => i.key === opts.fromKey);
        if (!found) throw new Error('NOWに該当する項目がありません。item listで確認してください');
        if (found.action) throw new Error('この項目は既に本人が追加した行動です');
        if (found.section !== 'next') throw new Error('行動にできるのは次の一手の項目です（未解決は行動にできません）');
        if (found.resolution) throw new Error('この項目は既に完了・解決か、誤りとして外しています');
        from = { input_id: found.input_id, text: found.text, key: found.key };
      }
      const body = text ?? from?.text;
      if (body === undefined) throw new Error('行動の文面を指定してください');
      // プロジェクト未定の置き場を指定したときは、プロジェクトを付けずに保存する（項目キーは置き場のもの）。
      const unassigned = id === UNASSIGNED_SCOPE;
      const result = await capture(c, {
        text: body,
        kind: 'action',
        project: unassigned ? undefined : id,
        source: 'cli',
        sourceEventId: opts.eventId,
        occurredAt: new Date().toISOString(),
        ...(from ? { meta: { action_from_input: from.input_id, action_from_text: from.text, ...(from.key ? { action_from_key: from.key } : {}) } } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort as ItemEffort } : {}),
        ...(opts.context !== undefined ? { contexts: opts.context as string[] } : {}),
      });
      // 同じ受付IDの再送で、別の内容の入力が記録されていれば項目キーを示さない（--event-idを付けて再送すると重複しない）。
      const saved = (await readInputs(c)).find(i => i.id === result.inputId);
      if (saved?.kind !== 'action' || saved.text !== body || saved.project !== (unassigned ? undefined : id)) throw new Error('同じ受付IDで別の内容が記録されています。--event-idを確認してください');
      const key = itemKey(id, 'next', result.inputId, body);
      await rebuildDashboard(c);
      output({ ...result, projectId: id, itemKey: key });
    });
}

// 本人が追加した行動を、別のプロジェクト・プロジェクト未定へ移す。期日・手間の目安などの記録は移した先の行動へ写り、元の行動は元の一覧から外れる。
function moveCommand(item: Command, config: LoadConfig): void {
  item.command('move <project> <key> <to>').description(`本人が追加した行動を別の置き場へ移す（projectとtoはプロジェクトのIDか${UNASSIGNED_SCOPE}）。期日・見直す日・繰り返し・手間の目安・連絡待ち・「いつかやる」は移した先の行動に引き継ぐ。戻すときは、移した先の行動をもう一度移す`)
    .option('--event-id <id>', '再送判定用ID（付けると、途中で止まった移動を同じIDで再送しても重複しない）')
    .requiredOption('--confirm', '行動と移す先を確認した本人による移動')
    .action(async (id, key, to, opts) => {
      const c = await config();
      const result = await moveAction(c, { from: id, itemKey: key, to, source: 'cli', sourceEventId: opts.eventId, occurredAt: new Date().toISOString() });
      await rebuildDashboard(c);
      output(result);
    });
}

function dismissHintCommand(item: Command, config: LoadConfig): void {
  item.command('dismiss-hint <project> <key> <input-id>').description('「片付いたかも」が違うとき、そのメモからの候補を見送る（項目は未解決のまま）')
    .requiredOption('--confirm', '候補と引用を確認した本人による見送り')
    .action(async (id, key, inputId, _opts) => {
      const c = await config();
      const result = await dismissResolutionHint(c, { projectId: id, itemKey: key, inputId, source: 'cli', sourceEventId: `cli:${key}:${inputId}:dismiss-hint` });
      await rebuildDashboard(c);
      output(result);
    });
}
