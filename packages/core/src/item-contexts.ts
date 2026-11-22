import { z } from 'zod';
import { ulid } from 'ulid';
import { Vault } from './storage.js';
import { ItemTargetError, activeResolutions, itemScopeSchema, itemSections, readItemResolutions, readNowItems, settleItemRecords, type ItemSection } from './item-resolutions.js';
import { assertRecordTarget, effectiveItemRecords, itemRecordScope } from './item-schedules.js';
import type { HubConfig } from './types.js';

/**
 * NOWの「次の一手」「未解決」の項目に本人が付けた場所・道具の札（GTDのコンテキスト。例: 家・外出先・PC・電話）。
 * 今いる場所や手元の道具でできる項目を選ぶ手掛かりにする。1つの項目に複数付けられる。
 * 手間の目安と同じく、AIは付けず推測もしない。本人の指定だけを記録し、原文・整理結果・解決報告は変えない。
 * 札の語彙（選べる札の一覧）は、アプリの好み（client-preferences.jsonのcontexts）で端末の間にそろえる。
 * 記録は語彙に縛られない（語彙から外した札が付いた項目も、札を表示したまま付け直せる）。
 */
export const CONTEXT_TAG_CHARS = 20;
export const CONTEXT_TAGS_MAX = 8;
/**
 * 札1つ。空白・制御文字・書式文字（ゼロ幅など）と、NOWの行末の表示（「@家 @PC」）や表示の区切り、Markdownと紛れる文字（@・、,・括弧・<>`）を含めない。
 * 端末と本体で同じ札を同じ文字列として比べるため、NFCに正規化した文字列だけを受け付ける。
 */
export const contextTagSchema = z.string().min(1, '札が空です').max(CONTEXT_TAG_CHARS, `札は${CONTEXT_TAG_CHARS}文字以内にしてください`)
  .regex(/^[^\p{Cc}\p{Cf}\p{Z}\s@＠、,，・()（）[\]［］<>`]+$/u, '札に空白や「@・、,<>`」・括弧は使えません')
  .refine(t => t.normalize('NFC') === t, '札の文字を正規化（NFC）してください');
/** 項目の札の全体。付けた順（アプリは語彙の順）で、同じ札を重ねない。 */
export const contextTagsSchema = z.array(contextTagSchema).min(1, '札を1つ以上指定してください').max(CONTEXT_TAGS_MAX, `札は1つの項目に${CONTEXT_TAGS_MAX}個までです`)
  .refine(tags => new Set(tags).size === tags.length, '同じ札を重ねて指定できません');
export type ContextTags = z.infer<typeof contextTagsSchema>;
/** 札の語彙の上限（アプリの好みでそろえる一覧）。 */
export const CONTEXT_VOCABULARY_MAX = 30;
/** アプリが語彙を持たないときの既定の例。 */
export const defaultContextVocabulary = ['家', '外出先', 'PC', '電話'] as const;
/** NOW・CLIで項目の後ろに付ける札の表示。 */
export const contextsLabel = (tags: readonly string[]): string => tags.map(t => `@${t}`).join(' ');

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const contextIdSchema = z.string().regex(/^CTX-[0-9A-HJKMNP-TV-Z]{26}$/);
const inputIdSchema = z.string().regex(/^IN-[0-9A-HJKMNP-TV-Z]{26}$/);
/** 1件の記録は項目の札の全体。contextsがnullは札をすべて外した記録。 */
export const itemContextRecordSchema = z.object({
  schema_version: z.literal(1), id: contextIdSchema, project_id: itemScopeSchema, item_key: digest, section: z.enum(itemSections),
  text: z.string().max(4000), input_id: inputIdSchema, contexts: contextTagsSchema.nullable(),
  source: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200).optional(), created_at: z.string().datetime({ offset: true }),
}).strict();
export type ItemContextRecord = z.infer<typeof itemContextRecordSchema>;
export const contextDir = '90_system/item-contexts';
export const contextPath = (id: string) => `${contextDir}/${id}.json`;
export const contextCleared = (r: Pick<ItemContextRecord, 'contexts'>) => r.contexts === null;
const sameTags = (a: readonly string[] | null, b: readonly string[] | null) => a === null ? b === null : b !== null && a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * 記録と、読めなかった記録のパス。不正な記録があってもNOWやHOMEの生成は止めず、doctorで示す。
 * 統合元のプロジェクトで付けた札は、日付と同じく統合先の項目の記録として読み替える（rawを指定すると記録のまま）。
 */
export async function readItemContexts(vault: Vault, options: { raw?: boolean } = {}): Promise<{ records: ItemContextRecord[]; problems: string[] }> {
  const records: ItemContextRecord[] = [], problems: string[] = [];
  for (const path of await vault.files(contextDir)) {
    if (!/^90_system\/item-contexts\/CTX-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(path)) continue;
    try {
      const record = itemContextRecordSchema.parse(JSON.parse((await vault.read(path))!));
      if (path !== contextPath(record.id)) throw new Error();
      records.push(record);
    } catch { problems.push(path); }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  return { records: options.raw ? records : await settleItemRecords(vault, records), problems };
}

/**
 * 今のNOW項目に効く札。引き継ぎの規則は期日と同じ（作業要約が届いて根拠が変わっても、同じ欄・同じ本文なら引き継ぐ）。
 * 引き継ぎ先のない札は、手間の目安と同じく付け直しを求めず、そのまま使わない。
 */
export function effectiveContexts(records: ItemContextRecord[], projectId: string, items: Parameters<typeof effectiveItemRecords>[2], resolvedKeys: { has(key: string): boolean }): Map<string, string[]> {
  const { byKey } = effectiveItemRecords(records, projectId, items, resolvedKeys, contextCleared);
  return new Map([...byKey].flatMap(([key, r]) => r.contexts ? [[key, [...r.contexts]] as const] : []));
}

export interface ItemContextsRequest { projectId: string; itemKey: string; contexts: string[] | null; source: string; sourceEventId?: string }
export interface ItemContextsResult { projectId: string; itemKey: string; contextId: string; deduped: boolean }
const requestSchema = z.object({
  projectId: itemScopeSchema, itemKey: digest, contexts: contextTagsSchema.nullable(),
  source: z.string().min(1).max(200), sourceEventId: z.string().min(1).max(200).optional(),
}).strict();

/**
 * 直近に生成したNOW項目の一覧にある、片付いていない項目の札を、指定した全体に置き換える（nullで外す）。
 * 記録を先に作り、NOWの再生成前に停止した場合は同じ受付IDの再送で再生成だけを行う。
 */
export async function setItemContexts(config: HubConfig, request: ItemContextsRequest): Promise<ItemContextsResult> {
  const r = requestSchema.parse(request), vault = new Vault(config);
  return vault.withLock(async () => {
    const { unassigned, rebuild, assertOpen } = await itemRecordScope(config, vault, r.projectId);
    if (r.sourceEventId) {
      // 再送の照合は記録のままで行う（受け付けた後にプロジェクトが統合されても、同じ依頼として扱う）。
      // 引き継いだ札を外した記録は、引き継ぎ元のキーで残る。
      const previous = (await readItemContexts(vault, { raw: true })).records.find(x => x.source === r.source && x.source_event_id === r.sourceEventId);
      if (previous) {
        if (previous.project_id !== r.projectId || (previous.item_key !== r.itemKey && r.contexts !== null) || !sameTags(previous.contexts, r.contexts)) throw new Error('同じ受付IDで別の札が記録されています');
        await rebuild();
        return { projectId: r.projectId, itemKey: r.itemKey, contextId: previous.id, deduped: true };
      }
    }
    // 統合済みのプロジェクトの項目は統合先のNOWにある（キーも統合先のものになる）。
    assertOpen();
    const list = (await readNowItems(vault, r.projectId))?.items ?? [], resolved = activeResolutions(await readItemResolutions(vault), r.projectId);
    const item = list.find(i => i.key === r.itemKey);
    if (!item) throw new ItemTargetError({ code: 'item-missing' }, 'NOWに該当する項目がありません。最新のNOWで確認してください');
    assertRecordTarget(unassigned, item);
    // 片付いた項目の札は付けも外しもしない（戻したときは、片付ける前の札のまま戻る）。
    const closed = resolved.get(r.itemKey);
    if (closed) throw new ItemTargetError({ code: 'item-closed', state: closed.action === 'exclude' ? 'excluded' : 'resolved' }, 'この項目は既に解決済みか、誤りとして外しています');
    const { records } = await readItemContexts(vault), current = effectiveItemRecords(records, r.projectId, list, resolved, contextCleared).byKey.get(r.itemKey);
    const unchanged = sameTags(current?.contexts ?? null, r.contexts);
    if (unchanged && r.sourceEventId) {
      // 端末からの依頼が今の札と同じ（別の端末や二度押しで同じ依頼が重なった）なら、望んだ状態になっているので受け付けて何も記録しない。
      // 再試行し続けないよう、今の札の記録（外した依頼なら、この項目の最後の記録）を返す。
      const latest = current ?? records.filter(x => x.project_id === r.projectId && x.item_key === r.itemKey).at(-1);
      if (latest) return { projectId: r.projectId, itemKey: r.itemKey, contextId: latest.id, deduped: true };
    }
    if (r.contexts === null && !current) throw new Error('この項目に外す札はありません');
    if (unchanged) throw new Error('この項目には既に同じ札が付いています');
    // 引き継いだ札を外すときは、引き継ぎ元の記録を外す（項目のキーで外しても引き継ぎ元が残るため）。
    const target = r.contexts === null && current && current.item_key !== r.itemKey ? { key: current.item_key, section: current.section, text: current.text, input_id: current.input_id } : item;
    const record: ItemContextRecord = {
      schema_version: 1, id: `CTX-${ulid()}`, project_id: r.projectId, item_key: target.key, section: target.section as ItemSection, text: target.text, input_id: target.input_id,
      contexts: r.contexts, source: r.source, ...(r.sourceEventId ? { source_event_id: r.sourceEventId } : {}), created_at: new Date().toISOString(),
    };
    if (!await vault.create(contextPath(record.id), JSON.stringify(record, null, 2) + '\n')) throw new Error('札の記録が競合しました');
    await rebuild();
    return { projectId: r.projectId, itemKey: r.itemKey, contextId: record.id, deduped: false };
  });
}
