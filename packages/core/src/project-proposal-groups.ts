import { normalizeName } from './projects.js';
import type { ProjectProposal } from './types.js';

/** 名前の一部が含まれるだけで同じ対象と見なすときの、含まれる側の名前の最小の長さ（文字数）。短い語の偶然の一致ではまとめない。 */
export const RELATED_NAME_MIN_CHARS = 4;
type Names = Pick<ProjectProposal, 'title' | 'aliases'>;
const namesOf = (proposal: Names) => [...new Set([proposal.title, ...proposal.aliases].map(normalizeName).filter(Boolean))];

/**
 * 2つのプロジェクト案が同じ対象を指すと見なせるか。
 * 名前・別名のどれかが一致するか、一方の名前・別名（RELATED_NAME_MIN_CHARS文字以上）がもう一方の名前・別名に含まれるときに同じ対象とする。
 * キーワードは使わない（広い語が多く、別の取り組みをまとめてしまうため）。
 */
export function relatedProposals(a: Names, b: Names): boolean {
  const left = namesOf(a), right = namesOf(b);
  const within = (part: string, whole: string) => [...part].length >= RELATED_NAME_MIN_CHARS && whole.includes(part);
  return left.some(x => right.some(y => x === y || within(x, y) || within(y, x)));
}

export interface ProposalGroup<T> { representative: T; duplicates: T[] }
/**
 * 同じ対象を指す案を、つながっている案どうしで1組にまとめる（AとB、BとCが同じ対象なら、A・B・Cを1組にする）。
 * 代表は、組の中でほかの案と最も多くつながる案。同数なら名前の短い案、次に古い案、最後にIDの順で決める。
 * まとめた案（duplicates）は古い順に並べ、組は最も古い案が古い順に返す。
 */
export function groupProposals<T extends { id: string; proposal: Names; generatedAt: string }>(items: T[]): ProposalGroup<T>[] {
  const related = items.map((a, i) => items.map((b, j) => i !== j && relatedProposals(a.proposal, b.proposal)));
  const age = (item: T) => Date.parse(item.generatedAt) || 0, older = (a: T, b: T) => age(a) - age(b) || a.id.localeCompare(b.id);
  const seen = new Set<number>(), groups: (ProposalGroup<T> & { oldest: T })[] = [];
  for (let start = 0; start < items.length; start++) {
    if (seen.has(start)) continue;
    const members: number[] = [], queue = [start]; seen.add(start);
    while (queue.length) {
      const i = queue.shift()!; members.push(i);
      related[i]!.forEach((linked, j) => { if (linked && !seen.has(j)) { seen.add(j); queue.push(j); } });
    }
    const links = (i: number) => members.filter(j => related[i]![j]).length, length = (i: number) => [...normalizeName(items[i]!.proposal.title)].length;
    const lead = [...members].sort((i, j) => links(j) - links(i) || length(i) - length(j) || older(items[i]!, items[j]!))[0]!;
    const sorted = members.map(i => items[i]!).sort(older);
    groups.push({ representative: items[lead]!, duplicates: sorted.filter(item => item !== items[lead]), oldest: sorted[0]! });
  }
  return groups.sort((a, b) => older(a.oldest, b.oldest)).map(({ representative, duplicates }) => ({ representative, duplicates }));
}
