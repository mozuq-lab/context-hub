import { normalizeName } from './projects.js';
import type { ProjectProposal } from './types.js';

/** 名前がもう一方の名前に含まれるだけで同じ対象と見なすときの、含まれる側の名前の最小の長さ（文字数）。短い語の偶然の一致ではまとめない。 */
export const RELATED_NAME_MIN_CHARS = 4;
/** 1組にまとめる案の上限（代表を除く）。1回の判断でまとめられる案の上限と同じ。 */
export const PROPOSAL_GROUP_MAX = 20;
type Names = Pick<ProjectProposal, 'title' | 'aliases'>;

/**
 * 2つのプロジェクト案が同じ対象を指すと見なせるか。
 * - 名前・別名のどれかが一致する（承認済みのプロジェクトと重なるかどうかの判定と同じ）。
 * - 一方の名前（RELATED_NAME_MIN_CHARS文字以上）が、もう一方の名前に含まれる。
 * 別名は一致だけを見る。「アプリ開発」のような広い語の別名がほかの案の名前に含まれても、別の取り組みをまとめない。
 * キーワードは使わない（広い語が多いため）。
 */
export function relatedProposals(a: Names, b: Names): boolean {
  const names = (proposal: Names) => new Set([proposal.title, ...proposal.aliases].map(normalizeName).filter(Boolean));
  const left = names(a), right = names(b);
  for (const name of left) if (right.has(name)) return true;
  const x = normalizeName(a.title), y = normalizeName(b.title);
  const within = (part: string, whole: string) => [...part].length >= RELATED_NAME_MIN_CHARS && whole.includes(part);
  return within(x, y) || within(y, x);
}

export interface ProposalGroup<T> { representative: T; duplicates: T[] }
/**
 * 同じ対象を指す案を組にまとめる。
 * まだ組に入っていない案のうち、ほかの案と最も多く重なる案を代表にする。同数なら名前の短い案、次に古い案、最後にIDの順で決める。
 * 組に入れるのは、代表と直接重なる案だけ（AとB、BとCが重なっても、AとCが重ならなければ、Aを代表にする組へCを入れない）。
 * 重なりをたどってまとめると、広い名前の案を介して別の取り組みが1組になるため。
 * まとめた案（duplicates）は古い順にPROPOSAL_GROUP_MAX件までとし、残りは次の組で扱う。組は最も古い案が古い順に返す。
 * 結果は渡す順に依存しない。
 */
export function groupProposals<T extends { id: string; proposal: Names; generatedAt: string }>(items: T[]): ProposalGroup<T>[] {
  const related = items.map((a, i) => items.map((b, j) => i !== j && relatedProposals(a.proposal, b.proposal)));
  const age = (item: T) => Date.parse(item.generatedAt) || 0, older = (a: T, b: T) => age(a) - age(b) || a.id.localeCompare(b.id);
  const length = items.map(item => [...normalizeName(item.proposal.title)].length);
  // まだ組に入っていない案と、その案が重なる、まだ組に入っていない案の数。
  const free = new Set(items.keys()), links = related.map(row => row.filter(Boolean).length);
  const take = (i: number) => { free.delete(i); related[i]!.forEach((linked, j) => { if (linked) links[j]!--; }); };
  const groups: (ProposalGroup<T> & { oldest: T })[] = [];
  while (free.size) {
    const lead = [...free].sort((i, j) => links[j]! - links[i]! || length[i]! - length[j]! || older(items[i]!, items[j]!))[0]!;
    const members = [...free].filter(j => related[lead]![j]).sort((i, j) => older(items[i]!, items[j]!)).slice(0, PROPOSAL_GROUP_MAX);
    for (const i of [lead, ...members]) take(i);
    const duplicates = members.map(i => items[i]!);
    groups.push({ representative: items[lead]!, duplicates, oldest: [items[lead]!, ...duplicates].sort(older)[0]! });
  }
  return groups.sort((a, b) => older(a.oldest, b.oldest)).map(({ representative, duplicates }) => ({ representative, duplicates }));
}
