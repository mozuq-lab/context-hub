import type { Command } from 'commander';
import { rebuildDashboard } from '../dashboard.js';
import { userFacingError } from '../error-message.js';
import { setPerson, inspectPeople, buildPerson, rebuildPeople } from '../people.js';
import { Vault, hash } from '../storage.js';
import type { HubConfig } from '../types.js';
import { collect, output, type LoadConfig, type RegisterCommand } from '../cli-shared.js';

/** person: 人ごとの見返し。本人が登録した人の名前・呼び名が出てくる記録と未完了の項目を40_people/に集める。 */
export const registerPerson: RegisterCommand = (program, config) => {
  const person = program.command('person').description('人ごとの見返し: 本人が登録した人の名前・呼び名が出てくる記録と未完了の項目を40_people/に集める（AIは使わない）');
  addCommand(person, config);
  listCommand(person, config);
  showCommand(person, config);
  editCommand(person, config);
  removeCommand(person, config);
};

// 変更は保存済みなので、一覧を作り直せなくても失敗にしない（次のcycleで作り直す）。
async function peopleChanged(c: HubConfig): Promise<void> {
  try {
    await rebuildPeople(c);
    await rebuildDashboard(c);
  } catch (error) {
    process.stderr.write(`警告: 変更は保存しましたが、一覧を作り直せませんでした（次のcycleで作り直します）: ${userFacingError(error)}\n`);
  }
}

function addCommand(person: Command, config: LoadConfig): void {
  person.command('add <id>').description('人を登録する（IDは英小文字・数字・ハイフン）')
    .requiredOption('--name <text>', '名前')
    .option('--aliases <csv>', '呼び名、カンマ区切り')
    .action(async (id, opts) => {
      const c = await config();
      const result = await setPerson(c, { personId: id, action: 'add', name: opts.name, aliases: opts.aliases?.split(',') ?? [], source: 'cli' });
      await peopleChanged(c);
      output(result);
    });
}

function listCommand(person: Command, config: LoadConfig): void {
  person.command('list').description('登録した人と確認用ハッシュを一覧')
    .action(async () => {
      const c = await config(), { people, issues, hashes } = await inspectPeople(new Vault(c));
      output({ people: people.map(p => ({ ...p, hash: hashes.get(p.id) })), issues });
    });
}

function showCommand(person: Command, config: LoadConfig): void {
  person.command('show <id>').description('人ごとの見返しの本文を表示（書き込まない）')
    .action(async id => output(await buildPerson(await config(), id)));
}

function editCommand(person: Command, config: LoadConfig): void {
  person.command('edit <id>').description('本人の確認で名前・呼び名を書き換える')
    .option('--name <text>', '新しい名前')
    .option('--add-alias <text>', '追加する呼び名（複数指定可）', collect, [])
    .option('--remove-alias <text>', '削除する呼び名（複数指定可）', collect, [])
    .requiredOption('--hash <sha256>', 'person listで確認したperson.mdのハッシュ')
    .requiredOption('--confirm', '定義を確認した本人による変更')
    .action(async (id, opts) => {
      const c = await config(), current = (await inspectPeople(new Vault(c))).people.find(p => p.id === id);
      if (!current) throw new Error('人が見つかりません');
      const key = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim();
      const removing = new Set((opts.removeAlias as string[]).map(key)), missing = (opts.removeAlias as string[]).filter(r => !current.aliases.some(a => key(a) === key(r)));
      if (missing.length) throw new Error(`削除する呼び名が定義にありません: ${missing.join('、')}`);
      // 同じ確認内容の再実行は、記録後・定義書込前の停止からの回復として扱う。
      const name = opts.name ?? current.name, aliases = [...current.aliases.filter(a => !removing.has(key(a))), ...opts.addAlias];
      const result = await setPerson(c, { personId: id, action: 'edit', name, aliases, expectedHash: opts.hash, source: 'cli', sourceEventId: `cli:${id}:${opts.hash}:edit:${hash(JSON.stringify([name, aliases]))}` });
      await peopleChanged(c);
      output(result);
    });
}

function removeCommand(person: Command, config: LoadConfig): void {
  person.command('remove <id>').description('人の登録を外す（記録は消さず、手で変えていないSUMMARY.mdを消す）')
    .requiredOption('--hash <sha256>', 'person listで確認したperson.mdのハッシュ')
    .requiredOption('--confirm', '定義を確認した本人による変更')
    .action(async (id, opts) => {
      const c = await config();
      const result = await setPerson(c, { personId: id, action: 'remove', expectedHash: opts.hash, source: 'cli', sourceEventId: `cli:${id}:${opts.hash}:remove` });
      await peopleChanged(c);
      output(result);
    });
}
