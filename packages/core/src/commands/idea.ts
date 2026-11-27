import type { Command } from 'commander';
import { rebuildDashboard } from '../dashboard.js';
import { rebuildIdeaIndexLocked, setIdeaLink } from '../idea-links.js';
import { Vault } from '../storage.js';
import { output, type LoadConfig, type RegisterCommand } from '../cli-shared.js';

/** idea: 似ているアイデアを確認し、本人の判断で束ねる・別の話にする。 */
export const registerIdea: RegisterCommand = (program, config) => {
  const idea = program.command('idea').description('似ているアイデアを確認し、本人の判断で束ねる・別の話にする（AIは使わない）');
  // 一覧を見るたびに、今のアイデアから似ている組と束を作り直す。
  const ideaIndex = async () => {
    const c = await config(), vault = new Vault(c);
    return vault.withLock(() => rebuildIdeaIndexLocked(c, vault));
  };
  similarCommand(idea, ideaIndex);
  groupsCommand(idea, ideaIndex);
  linkCommand(idea, config);
  separateCommand(idea, config);
};

type IdeaIndex = () => ReturnType<typeof rebuildIdeaIndexLocked>;

function similarCommand(idea: Command, ideaIndex: IdeaIndex): void {
  idea.command('similar').description('未確認の似ているアイデアの組と、束ねるときに指定するハッシュ')
    .action(async () => {
      const index = await ideaIndex();
      output({ total: index.total_candidates, candidates: index.candidates.map(x => ({ ideas: x.ideas, score: x.score, hashes: x.hashes, summaries: x.ideas.map(id => index.summaries[id] ?? '') })) });
    });
}

function groupsCommand(idea: Command, ideaIndex: IdeaIndex): void {
  idea.command('groups').description('束ねたアイデアの一覧（先頭が代表）。linksは直接束ねた組で、束から外すにはこの組をseparateする')
    .action(async () => {
      const index = await ideaIndex();
      output(index.groups.map(g => ({ representative: g.representative, ideas: g.ideas.map(id => ({ id, summary: index.summaries[id] ?? '' })), links: g.links })));
    });
}

function linkCommand(idea: Command, config: LoadConfig): void {
  idea.command('link <a> <b>').description('2件のアイデアを同じ話として束ねる')
    .requiredOption('--hash-a <sha256>', 'idea similarで確認した1件目のハッシュ')
    .requiredOption('--hash-b <sha256>', 'idea similarで確認した2件目のハッシュ')
    .requiredOption('--confirm', '内容を確認した本人による判断')
    .action(async (a, b, opts) => {
      const c = await config();
      const result = await setIdeaLink(c, { ideas: [a, b], hashes: [opts.hashA, opts.hashB], action: 'link', source: 'cli' });
      await rebuildDashboard(c);
      output(result);
    });
}

function separateCommand(idea: Command, config: LoadConfig): void {
  idea.command('separate <a> <b>').description('2件のアイデアを別の話として候補から外す（直接束ねた組なら束から外す）')
    .requiredOption('--confirm', '内容を確認した本人による判断')
    .action(async (a, b) => {
      const c = await config();
      const result = await setIdeaLink(c, { ideas: [a, b], action: 'separate', source: 'cli' });
      await rebuildDashboard(c);
      output(result);
    });
}
