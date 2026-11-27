import { Option, type Command } from 'commander';
import { AREA_CHARS } from '../areas.js';
import { rebuildDashboard } from '../dashboard.js';
import { readProjectCatalog } from '../knowledge-scope.js';
import { setProjectArea } from '../project-areas.js';
import { setProjectDefinition, editDefinition, normalizeDefinition, definitionErrorMessage } from '../project-definition.js';
import { mergeProjects, unmergeProject, readProjectMerges } from '../project-merges.js';
import { listProjectCandidates, decideProject } from '../project-proposals.js';
import { setProjectStatus, projectStatuses, lifecycleOf } from '../project-status.js';
import { addProject, readProjects } from '../projects.js';
import { Vault, hash } from '../storage.js';
import type { HubConfig } from '../types.js';
import { collect, outcomeArg, output, type LoadConfig, type RegisterCommand } from '../cli-shared.js';

/** project: 人によるプロジェクト管理（作成・状態・領域・定義の編集・統合・候補の採否）。 */
export const registerProject: RegisterCommand = (program, config) => {
  const project = program.command('project').description('人によるプロジェクト管理');
  addCommand(project, config);
  listCommand(project, config);
  statusCommand(project, config);
  areaCommand(project, config);
  editCommand(project, config);
  mergeCommand(project, config);
  unmergeCommand(project, config);
  candidatesCommands(project, config);
};

function addCommand(project: Command, config: LoadConfig): void {
  project.command('add <id>')
    .requiredOption('--title <text>', 'プロジェクト名')
    .option('--aliases <csv>', '別名、カンマ区切り')
    .option('--keywords <csv>', '検索語、カンマ区切り')
    .option('--outcome <text>', '望む結果（何をもって完了か。改行は\\nで書けます）')
    .action(async (id, opts) => output(await addProject(await config(), {
      id,
      title: opts.title,
      aliases: opts.aliases?.split(',') ?? [],
      keywords: opts.keywords?.split(',') ?? [],
      ...(opts.outcome !== undefined ? { outcome: outcomeArg(opts.outcome) } : {}),
    })));
}

function listCommand(project: Command, config: LoadConfig): void {
  project.command('list').description('定義・状態・確認用ハッシュを一覧')
    .action(async () => {
      const c = await config();
      const projects = await readProjects(c), catalog = await readProjectCatalog(new Vault(c));
      output(projects.map(p => ({ ...p, lifecycle: lifecycleOf(p), hash: catalog.find(x => x.id === p.id)?.hash })));
    });
}

function statusCommand(project: Command, config: LoadConfig): void {
  project.command('status <id>').description('本人の判断でプロジェクトを進行中・休止・完了に切り替える')
    .addOption(new Option('--set <status>', '新しい状態').choices([...projectStatuses]).makeOptionMandatory())
    .requiredOption('--hash <sha256>', 'project listで確認したproject.mdのハッシュ')
    .requiredOption('--confirm', '定義を確認した本人による変更')
    .action(async (id, opts) => {
      const c = await config();
      // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
      const result = await setProjectStatus(c, { projectId: id, status: opts.set, expectedHash: opts.hash, source: 'cli', sourceEventId: `cli:${id}:${opts.hash}:${opts.set}` });
      await rebuildDashboard(c);
      output(result);
    });
}

function areaCommand(project: Command, config: LoadConfig): void {
  project.command('area <id>').description('本人の判断でプロジェクトに領域（責任範囲。例: 仕事・家）を付ける・外す。HOMEと週次レビューで領域ごとにまとめて見る。AIは付けず、帰属の推定にも使わない')
    .option('--set <area>', `領域（${AREA_CHARS}文字以内）`)
    .option('--clear', '領域を外す')
    .requiredOption('--hash <sha256>', 'project listで確認したproject.mdのハッシュ')
    .requiredOption('--confirm', '定義を確認した本人による変更')
    .action(async (id, opts) => {
      if ((opts.set === undefined) === (opts.clear !== true)) throw new Error('--setか--clearのどちらかを指定してください');
      const c = await config(), area = opts.clear ? null : String(opts.set).normalize('NFC');
      // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
      const result = await setProjectArea(c, { projectId: id, area, expectedHash: opts.hash, source: 'cli', sourceEventId: `cli:${id}:${opts.hash}:area:${area ?? ''}` });
      await rebuildDashboard(c);
      output(result);
    });
}

function editCommand(project: Command, config: LoadConfig): void {
  project.command('edit <id>').description('本人の確認でプロジェクトの名前・別名・キーワード・望む結果を書き換える（帰属未確定のメモは次のcycleで再関連付けの対象になる）')
    .option('--title <text>', '新しい名前')
    .option('--outcome <text>', '新しい望む結果（何をもって完了か。改行は\\nで書けます）')
    .option('--clear-outcome', '望む結果を外す')
    .option('--add-alias <text>', '追加する別名（複数指定可）', collect, [])
    .option('--remove-alias <text>', '削除する別名（複数指定可）', collect, [])
    .option('--add-keyword <text>', '追加するキーワード（複数指定可）', collect, [])
    .option('--remove-keyword <text>', '削除するキーワード（複数指定可）', collect, [])
    .requiredOption('--hash <sha256>', 'project listで確認したproject.mdのハッシュ')
    .requiredOption('--confirm', '定義を確認した本人による変更')
    .action(async (id, opts) => {
      const c = await config(), current = (await readProjects(c)).find(p => p.id === id);
      if (!current) throw new Error('プロジェクトが見つかりません');
      if (opts.outcome !== undefined && opts.clearOutcome) throw new Error('--outcomeと--clear-outcomeは同時に指定できません');
      const outcome = opts.clearOutcome ? '' : opts.outcome !== undefined ? outcomeArg(opts.outcome) : undefined;
      const edited = editDefinition(
        { title: current.title, aliases: current.aliases, keywords: current.keywords, ...(current.outcome !== undefined ? { outcome: current.outcome } : {}) },
        { title: opts.title, addAliases: opts.addAlias, removeAliases: opts.removeAlias, addKeywords: opts.addKeyword, removeKeywords: opts.removeKeyword, ...(outcome !== undefined ? { outcome } : {}) },
      );
      // 望む結果を指定しないときは送らない（手で書いた望む結果を正規化で書き換えない）。
      if (outcome === undefined) delete edited.outcome;
      let next;
      try {
        next = normalizeDefinition(edited);
      } catch (error) {
        throw new Error(definitionErrorMessage(error));
      }
      // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
      const result = await setProjectDefinition(c, { projectId: id, expectedHash: opts.hash, ...next, source: 'cli', sourceEventId: `cli:${id}:${opts.hash}:${hash(JSON.stringify(next))}` });
      await rebuildDashboard(c);
      output({ ...result, definition: next });
    });
}

// 同じ引数での再実行（途中で止まった操作の回復）には、最後の記録と同じ受付IDを使う。
// 取り消した後にもう一度統合するときは定義が同じhashへ戻るため、最後の記録のIDを含めて別の操作にする。
async function mergeEventId(c: HubConfig, action: 'merge' | 'unmerge', from: string, into: string, fromHash: string, intoHash: string): Promise<string> {
  const last = (await readProjectMerges(new Vault(c))).filter(m => m.from_id === from).at(-1);
  if (last && last.source === 'cli' && last.source_event_id && last.action === action && last.into_id === into && last.from_before_hash === fromHash && last.into_before_hash === intoHash) return last.source_event_id;
  return `cli:${action}:${hash(JSON.stringify([from, into, fromHash, intoHash, last?.id ?? 'none']))}`;
}

function mergeCommand(project: Command, config: LoadConfig): void {
  project.command('merge <from>').description('同じものを指すプロジェクトを、本人の確認で統合先へまとめる（統合元の入力・完了報告・日付は統合先のものとして読み替える。原文と記録は動かさない）')
    .requiredOption('--into <id>', '統合先のプロジェクト')
    .requiredOption('--hash <sha256>', 'project listで確認した統合元のproject.mdのハッシュ')
    .requiredOption('--into-hash <sha256>', 'project listで確認した統合先のproject.mdのハッシュ')
    .requiredOption('--confirm', '2つの定義を確認した本人による統合')
    // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
    .action(async (id, opts) => {
      const c = await config();
      const result = await mergeProjects(c, { fromId: id, intoId: opts.into, fromHash: opts.hash, intoHash: opts.intoHash, source: 'cli', sourceEventId: await mergeEventId(c, 'merge', id, opts.into, opts.hash, opts.intoHash) });
      await rebuildDashboard(c);
      output(result);
    });
}

function unmergeCommand(project: Command, config: LoadConfig): void {
  project.command('unmerge <from>').description('統合を取り消し、統合元を統合前の状態へ戻す（統合で統合先へ足した別名・キーワードのうち残っているものを外す）')
    .requiredOption('--hash <sha256>', 'project listで確認した統合元のproject.mdのハッシュ')
    .requiredOption('--into-hash <sha256>', 'project listで確認した統合先のproject.mdのハッシュ')
    .requiredOption('--confirm', '2つの定義を確認した本人による取り消し')
    .action(async (id, opts) => {
      const c = await config(), from = (await readProjects(c)).find(p => p.id === id);
      if (!from) throw new Error('プロジェクトが見つかりません');
      // 統合先は定義から読む。取り消しの途中で止まった後の再実行では定義から消えているので、最後の統合の記録から求める。
      const into = from.merged_into ?? (await readProjectMerges(new Vault(c))).filter(m => m.from_id === id).at(-1)?.into_id;
      if (!into) throw new Error('このプロジェクトは統合されていません');
      const result = await unmergeProject(c, { fromId: id, intoId: into, fromHash: opts.hash, intoHash: opts.intoHash, source: 'cli', sourceEventId: await mergeEventId(c, 'unmerge', id, into, opts.hash, opts.intoHash) });
      await rebuildDashboard(c);
      output(result);
    });
}

/** candidates・approve・reject: AIが出したプロジェクト候補を確かめて採否を決める。 */
function candidatesCommands(project: Command, config: LoadConfig): void {
  project.command('candidates').action(async () => output(await listProjectCandidates(await config())));
  for (const action of ['approve', 'reject'] as const) {
    const command = project.command(`${action} <id>`)
      .requiredOption('--hash <sha256>', '確認した候補のハッシュ')
      .requiredOption('--token <token>', '候補の確認トークン')
      .requiredOption('--confirm', '候補詳細を読んだ人の明示確認');
    // 採用するときは、望む結果を本人が書き添えられる（AIの案には含めない）。
    if (action === 'approve') command.option('--outcome <text>', '作るプロジェクトの望む結果（改行は\\nで書けます）');
    command.action(async (id, opts) => output(await decideProject(await config(), {
      candidateId: id,
      expectedHash: opts.hash,
      confirmationToken: opts.token,
      confirmed: opts.confirm,
      action,
      source: 'cli',
      sourceEventId: `cli:${id}:${action}`,
      ...(opts.outcome !== undefined ? { outcome: outcomeArg(opts.outcome) } : {}),
    })));
  }
}
