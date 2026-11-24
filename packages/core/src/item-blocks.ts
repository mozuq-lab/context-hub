import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { ItemTargetError, UNASSIGNED_SCOPE, activeResolutions, itemMergeTargets, itemScopeSchema, itemSections, readItemResolutions, readNowItems, retargetItemRecord, settleItemRecords, type ItemResolution, type ItemSection, type NowItem } from './item-resolutions.js';
import { effectiveItemRecords, itemRecordScope } from './item-schedules.js';
import { projectIdSchema } from './projects.js';
import type { HubConfig } from './types.js';

/**
 * 「先に済ませること」。プロジェクトの次の一手・未解決に、本人が別の項目（1〜3件。プロジェクトをまたいでもよい）を
 * 先に済ませる項目として付けた記録。先の項目が残っている間は、HOMEとアプリの次の一手から外して「先待ち」にまとめ、
 * 先の項目が完了・解決・誤りとして外されると「動けるようになった項目」として先頭に出す。
 * 手順（1つの項目の中の段階）・連絡待ち（人からの返事）とは別に、項目どうしの前後関係を表す。
 * 期日・連絡待ちと同じく、AIは付けず推測もしない。本人の指定だけを記録し、原文・整理結果・解決報告は変えない。
 * 付けられるのはプロジェクトの項目だけ（プロジェクト未定の行動はまだ対象にしない）。先の項目には、プロジェクト未定の行動も選べる。
 */
export const ITEM_BLOCKS_MAX = 3;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const blocksIdSchema = z.string().regex(/^BLK-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/**
 * 先の項目。付けた時点の置き場・キーと、統合や本文の引き継ぎで指し直すための欄・本文・根拠の入力を残す。
 * 本文はHOMEとアプリで「何を待っているか」を示すために使い、NOW.md（別AI向けのcontextの元）には載せない。
 */
export const blockRefSchema = z.object({
  project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections), text: z.string().max(4000), input_id: inputIdSchema,
}).strict();
export type BlockRef = z.infer<typeof blockRefSchema>;
/** 1件の記録は項目の先の項目の全体。afterがnullは印を外した記録。 */
export const itemBlockRecordSchema = z.object({
  schema_version: z.literal(1), id: blocksIdSchema, project_id: projectIdSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, after: z.array(blockRefSchema).min(1).max(ITEM_BLOCKS_MAX).nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemBlockRecord = z.infer<typeof itemBlockRecordSchema>;
export const blocksDir = '90_system/item-blocks';
export const blocksPath = (id: string) => `${blocksDir}/${id}.json`;
export const blocksCleared = (r: Pick<ItemBlockRecord, 'after'>) => r.after === null;

/** 項目一覧（now-items）に載せる先の項目。idは効いている記録。先の項目の今の状態は、読む側が先の項目の一覧から決める。 */
export interface NowItemAfter { id: string; items: { project_id: string; item_key: string; section: ItemSection; text: string }[] }

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、HOMEとdoctorで示す。
 * 統合元のプロジェクトで付けた印は、ほかの記録と同じく統合先の項目の記録として読み替える。先の項目も、統合元のものは統合先の項目として指し直す
 * （rawを指定すると記録のまま）。
 */
export async function readItemBlocks(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemBlockRecord[]; problems: string[] }> {
  const records: ItemBlockRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(blocksDir)) {
    if (!/^90_system\/item-blocks\/BLK-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemBlockRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== blocksPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  if (options.raw) return { records, problems };
  const targets = await itemMergeTargets(vault), settled = await settleItemRecords(vault, records);
  return { records: targets.size ? settled.map(r => r.after ? { ...r, after: r.after.map(ref => retargetItemRecord(ref, targets)) } : r) : settled, problems };
}

/**
 * 今のNOW項目に効く先の項目。引き継ぎの規則は期日・連絡待ちと同じ（作業要約が届いて根拠が変わっても、同じ欄・同じ本文なら引き継ぐ）。
 * 引き継ぎ先のない印は使わない（項目がNOWから外れたら、待つ理由も一緒に外れたため）。
 */
export function effectiveBlocks(records: ItemBlockRecord[], projectId: string, items: Parameters<typeof effectiveItemRecords>[2], resolvedKeys: { has(key: string): boolean }): Map<string, NowItemAfter> {
  const { byKey } = effectiveItemRecords(records, projectId, items, resolvedKeys, blocksCleared);
  return new Map([...byKey].flatMap(([key, r]) => r.after ? [[key, { id: r.id, items: r.after.map(a => ({ project_id: a.project_id, item_key: a.item_key, section: a.section, text: a.text })) }] as const] : []));
}

/** NOWの行末に付ける表示。先の項目の本文は載せない（別のプロジェクトの項目のことがあり、NOWは別AI向けの資料の元になるため）。 */
export const blockedLabel = (after: Pick<NowItemAfter, 'items'>): string => `先に済ませること ${after.items.length}件`;

/**
 * 先の項目の今の状態。open: まだ残っている（待つ） / done: 完了・解決した / dropped: 誤りとして外した /
 * missing: 一覧に見当たらない（本文が変わった・NOWから外れたなど。待たずに、付け直しを促す）。
 * 項目はキー、行動に引き取った元の行のキー、同じ欄・同じ本文の順に探す（本文が同じ項目が2件以上あれば決めない）。
 * 見当たらないときは、本人の完了・外す記録（resolutions。省略可）から決める。
 */
export type PrerequisiteState = 'open' | 'done' | 'dropped' | 'missing';
export function findPrerequisite(ref: Pick<BlockRef, 'item_key' | 'section' | 'text'>, items: readonly NowItem[] | undefined): NowItem | undefined {
  if (!items) return undefined;
  const direct = items.find(i => i.key === ref.item_key) ?? items.find(i => i.action?.from?.key === ref.item_key);
  if (direct) return direct;
  const same = items.filter(i => i.section === ref.section && i.text === ref.text);
  return same.length === 1 ? same[0] : undefined;
}
export function prerequisiteState(ref: Pick<BlockRef, 'project_id' | 'item_key' | 'section' | 'text'>, lists: ReadonlyMap<string, readonly NowItem[]>, resolutions?: ReadonlyMap<string, ReadonlyMap<string, ItemResolution>>): PrerequisiteState {
  const found = findPrerequisite(ref, lists.get(ref.project_id));
  const closed = found ? found.resolution : resolutions?.get(ref.project_id)?.get(ref.item_key);
  if (found && closed === null) return 'open';
  if (!closed) return 'missing';
  return closed.action === 'exclude' ? 'dropped' : 'done';
}
export const prerequisiteStateLabels: Record<Exclude<PrerequisiteState, 'open'>, string> = { done: '済み', dropped: '外した', missing: '見当たらない' };
/** 先の項目がすべて片付いた（残っているものがない）か。見当たらないものは待たない。 */
export const blockSettled = (states: readonly PrerequisiteState[]): boolean => states.every(s => s !== 'open');

/**
 * 先の項目を判断するための、置き場ごとの項目一覧と完了・外す記録。プロジェクトとプロジェクト未定の一覧を読む（読めない一覧は無いものとして扱う）。
 */
export async function prerequisiteLists(vault: Vault, scopes: Iterable<string>): Promise<{ lists: Map<string, NowItem[]>; resolutions: Map<string, Map<string, ItemResolution>> }> {
  const lists = new Map<string, NowItem[]>(), resolutions = new Map<string, Map<string, ItemResolution>>();
  let records: ItemResolution[] = [];
  try { records = await readItemResolutions(vault); } catch { /* 解決記録の不正はHOMEとdoctorで示す。 */ }
  for (const scope of new Set(scopes)) {
    try { const list = await readNowItems(vault, scope); if (list) lists.set(scope, list.items); } catch { /* 不正な一覧はHOMEで示す。 */ }
    resolutions.set(scope, activeResolutions(records, scope));
  }
  return { lists, resolutions };
}

/**
 * 先の項目にできない理由。self: 自分自身 / missing: 先の項目がNOWにない / closed: 先の項目が既に片付いている /
 * cycle: 先の項目が（ほかの項目を通して）この項目を待っている。
 */
export const itemBlocksRefusalCauses = ['self', 'missing', 'closed', 'cycle'] as const;
export type ItemBlocksReason = { code: 'blocks-refused'; cause: typeof itemBlocksRefusalCauses[number] };
export class ItemBlocksError extends Error {
  constructor(readonly reason: ItemBlocksReason) { super(itemBlocksMessage(reason)); this.name = 'ItemBlocksError'; }
}
export function itemBlocksMessage(reason: ItemBlocksReason): string {
  if (reason.cause === 'self') return '項目そのものは、先に済ませることにできません。';
  if (reason.cause === 'missing') return '先に済ませる項目が見つかりませんでした。同期してNOWを確かめ、選び直してください。';
  if (reason.cause === 'closed') return '先に済ませる項目は、既に完了・解決しているか外しています。残っている項目を選んでください。';
  return '先に済ませる項目が、この項目を先に済ませることとして待っています（互いに待つと、どちらも動けなくなります）。別の項目を選んでください。';
}

export interface ItemBlocksRequest { projectId: string; itemKey: string; after: { projectId: string; itemKey: string }[] | null; source: string; sourceEventId?: string }
export interface ItemBlocksResult { projectId: string; itemKey: string; blocksId: string; deduped: boolean }
const targetSchema = z.object({ projectId: itemScopeSchema, itemKey: digest }).strict();
const requestSchema = z.object({
  projectId: projectIdSchema, itemKey: digest,
  after: z.array(targetSchema).min(1).max(ITEM_BLOCKS_MAX, `先に済ませることは${ITEM_BLOCKS_MAX}件までです`).nullable()
    .refine(v => v === null || new Set(v.map(t => `${t.projectId}\n${t.itemKey}`)).size === v.length, '同じ項目を2回選んでいます'),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict();
const refKey = (projectId: string, itemKey: string) => `${projectId}\n${itemKey}`;
const sameAfter = (a: { project_id: string; item_key: string }[] | null, b: { project_id: string; item_key: string }[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x.project_id === b[i]!.project_id && x.item_key === b[i]!.item_key);

/**
 * 直近に生成したNOW項目の一覧にある、片付いていない項目に先の項目を付ける（nullで外す）。先の項目は、いまのNOW（またはプロジェクト未定の一覧）にあり、
 * 片付いていない項目に限る。互いに待つ組（先の項目が、ほかの項目を通してこの項目を待っている）は受け付けない。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemBlocks(config: HubConfig, request: ItemBlocksRequest): Promise<ItemBlocksResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    const { rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      const previous = (await readItemBlocks(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        const asked = r.after?.map(t => ({ project_id: t.projectId, item_key: t.itemKey })) ?? null;
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && r.after !== null) || !sameAfter(previous.after, asked)) throw new Error('同じ受付IDで別の先に済ませることが記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, blocksId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], allResolutions = await readItemResolutions(vault), resolved = activeResolutions(allResolutions, r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    // 片付いた項目の印は付けも外しもしない（戻したときは、片付ける前の印のまま戻る）。
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    // 先の項目は、いまの一覧にある片付いていない項目に限る（統合済みのプロジェクトの項目は、統合先の一覧で選び直してもらう）。
    const targets = await itemMergeTargets(vault), refs: BlockRef[] = [];
    for (const t of r.after ?? []) {
      if (t.projectId === r.projectId && t.itemKey === r.itemKey) throw new ItemBlocksError({ code: 'blocks-refused', cause: 'self' });
      if (targets.has(t.projectId)) throw new ItemBlocksError({ code: 'blocks-refused', cause: 'missing' });
      let other: NowItem | undefined;
      try { other = (await readNowItems(vault, t.projectId))?.items.find(i => i.key === t.itemKey); } catch { other = undefined; }
      if (!other) throw new ItemBlocksError({ code: 'blocks-refused', cause: 'missing' });
      // プロジェクト未定の一覧のうち、本人の項目にできるのは本人が追加した行動だけ（AIの提案は、先に行動にしてもらう）。
      if (t.projectId === UNASSIGNED_SCOPE && other.action === undefined) throw new ItemBlocksError({ code: 'blocks-refused', cause: 'missing' });
      if (other.resolution !== null || activeResolutions(allResolutions, t.projectId).has(t.itemKey)) throw new ItemBlocksError({ code: 'blocks-refused', cause: 'closed' });
      refs.push({ project_id: t.projectId, item_key: other.key, section: other.section, text: other.text, input_id: other.input_id });
    }
    const { records } = await readItemBlocks(vault), current = effectiveItemRecords(records, r.projectId, list, resolved, blocksCleared).byKey.get(r.itemKey);
    const asked = r.after === null ? null : refs.map(x => ({ project_id: x.project_id, item_key: x.item_key }));
    const unchanged = sameAfter(current?.after ?? null, asked);
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の印と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      const latest = current ?? records.filter(x => x.project_id === r.projectId && x.item_key === r.itemKey).at(-1);
      if (latest) return { projectId: r.projectId, itemKey: r.itemKey, blocksId: latest.id, deduped: true };
    }
    if (r.after === null && !current) throw new Error('この項目に先に済ませることは付いていません');
    if (unchanged) throw new Error('この項目には既に同じ先に済ませることが付いています');
    if (refs.length && waitsOn(records, refs, refKey(r.projectId, r.itemKey))) throw new ItemBlocksError({ code: 'blocks-refused', cause: 'cycle' });
    // 引き継いだ印を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = r.after === null && current && current.item_key !== r.itemKey ? { key: current.item_key, section: current.section, text: current.text, input_id: current.input_id } : item;
    const record: ItemBlockRecord = {
      schema_version: 1, id: `BLK-${ulid()}`, project_id: r.projectId, item_key: target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      after: r.after === null ? null : refs, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(blocksPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('先に済ませることの記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, blocksId: record.id, deduped: false };
  });
}

/**
 * 先の項目のどれかが、記録をたどってtargetを待っているか（互いに待つ組になるか）。項目ごとに最後の記録だけを使う。
 * 本文の引き継ぎで指すキーが変わった記録は追えないため、記録に残したキーでたどる（追えない組は、HOMEの「先待ち」で本人が気づける）。
 */
function waitsOn(records: ItemBlockRecord[], start: BlockRef[], target: string): boolean {
  const latest = new Map<string, ItemBlockRecord>();
  for (const r of records) latest.set(refKey(r.project_id, r.item_key), r);
  const seen = new Set<string>(), queue = start.map(x => refKey(x.project_id, x.item_key));
  while (queue.length) {
    const key = queue.shift()!;
    if (key === target) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of latest.get(key)?.after ?? []) queue.push(refKey(next.project_id, next.item_key));
  }
  return false;
}
