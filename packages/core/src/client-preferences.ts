import { z } from 'zod';
import { projectIdSchema } from './projects.js';
import { CONTEXT_VOCABULARY_MAX, contextTagSchema } from './item-contexts.js';
import { findSecrets, secretSettings, summarizeFindings } from './secrets.js';
import { Vault } from './storage.js';
import type { HubConfig } from './types.js';

/**
 * アプリの好み（ピン留めと並び順・メモのひな形・文脈かごの上限・場所・道具の札の語彙）を、端末間でそろえるための共有の記録。
 * - アプリは変更を受付ファイルで送り、本体がまとまり（グループ）ごとに新しい方を残して1つのファイルへ書く。
 * - ほかの端末は読込のときにこのファイルを読み、自分のものより新しいまとまりを取り込む。
 * - 本体は好みの中身を使わない（HOMEやNOWには出さない）。既読・ウインドウの位置・通知の許可・APIキーのような端末ごとの状態は扱わない。
 * - 遅れて届いた古い依頼で巻き戻さない。端末の時計が進みすぎていても、受け付けた時刻より新しい日時は記録しない。
 */
export const clientPreferencesPath = '90_system/client-preferences.json';
export const PREFERENCE_PINS_MAX = 30;
export const PREFERENCE_TEMPLATES_MAX = 12;
export const PREFERENCE_TEMPLATE_NAME_CHARS = 40;
export const PREFERENCE_TEMPLATE_BODY_CHARS = 1000;
export const preferenceBasketLimits = [6000, 12000, 30000] as const;
export const preferenceGroups = ['pins', 'templates', 'basket', 'contexts'] as const;
export type PreferenceGroup = typeof preferenceGroups[number];
/** 受付ファイルの本文（JSON）の上限。 */
export const PREFERENCES_MAX_BYTES = 32 * 1024;

const instant = z.string().datetime({ offset: true });
const deviceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const lineText = (max: number) => z.string().min(1).max(max).refine(v => v.trim().length > 0, '空白だけは指定できません');
const pinsValue = z.object({ ids: z.array(projectIdSchema).max(PREFERENCE_PINS_MAX).refine(ids => new Set(ids).size === ids.length, '同じプロジェクトを重ねて指定できません') }).strict();
const templateSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/), name: lineText(PREFERENCE_TEMPLATE_NAME_CHARS).refine(v => !/[\r\n]/.test(v), '名前は1行にしてください'),
  body: lineText(PREFERENCE_TEMPLATE_BODY_CHARS), project: projectIdSchema.optional(),
}).strict();
const templatesValue = z.object({ items: z.array(templateSchema).max(PREFERENCE_TEMPLATES_MAX).refine(items => new Set(items.map(t => t.id)).size === items.length, '同じひな形を重ねて指定できません') }).strict();
const basketValue = z.object({ max_chars: z.union(preferenceBasketLimits.map(n => z.literal(n)) as [z.ZodLiteral<6000>, z.ZodLiteral<12000>, z.ZodLiteral<30000>]) }).strict();
// 場所・道具の札の語彙（アプリで札を選ぶときの一覧、並びは本人が決めた順）。本体は札の記録をこの語彙で縛らない（外した札も項目には残る）。
const contextsValue = z.object({ items: z.array(contextTagSchema).max(CONTEXT_VOCABULARY_MAX).refine(items => new Set(items).size === items.length, '同じ札を重ねて指定できません') }).strict();
const valueSchemas = { pins: pinsValue, templates: templatesValue, basket: basketValue, contexts: contextsValue } as const;
const entry = <T extends z.ZodTypeAny>(value: T) => z.object({ updated_at: instant, value }).strict();
/** 受付ファイルの本文。送るのは変えたまとまりだけでよい。 */
export const preferencesPayloadSchema = z.object({
  schema_version: z.literal(1), device: deviceSchema,
  groups: z.object({ pins: entry(pinsValue).optional(), templates: entry(templatesValue).optional(), basket: entry(basketValue).optional(), contexts: entry(contextsValue).optional() }).strict()
    .refine(g => Object.keys(g).length > 0, 'そろえる好みを1つ以上指定してください'),
}).strict();
export type PreferencesPayload = z.infer<typeof preferencesPayloadSchema>;
const storedEntry = <T extends z.ZodTypeAny>(value: T) => z.object({ updated_at: instant, device: deviceSchema, request_id: z.string().min(1).max(200), value }).strict();
export const clientPreferencesSchema = z.object({
  schema_version: z.literal(1),
  groups: z.object({ pins: storedEntry(pinsValue).optional(), templates: storedEntry(templatesValue).optional(), basket: storedEntry(basketValue).optional(), contexts: storedEntry(contextsValue).optional() }).strict(),
}).strict();
export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;

/** 本文をJSONとして読み、形を確かめる。 */
export function parsePreferencesPayload(text: string): PreferencesPayload {
  if (Buffer.byteLength(text) > PREFERENCES_MAX_BYTES) throw new Error('好みの本文が上限を超えています');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('好みの本文はJSONで指定してください'); }
  return preferencesPayloadSchema.parse(value);
}

/** 受け付けられない理由。同じ内容を何度送っても同じ結果になるため、受付は再試行しない。 */
export type PreferencesReason = { code: 'preferences-secret'; labels: string[] };
export class PreferencesError extends Error {
  constructor(readonly reason: PreferencesReason, message: string) { super(message); this.name = 'PreferencesError'; }
}
export function preferencesMessage(reason: PreferencesReason): string {
  return `ひな形に秘密情報らしい文字列（${reason.labels.join('・')}）があるため、ほかの端末とそろえませんでした。ひな形から取り除いてから、もう一度そろえてください。`;
}

export async function readClientPreferences(vault: Vault): Promise<ClientPreferences | undefined> {
  const raw = await vault.read(clientPreferencesPath);
  if (raw === undefined) return undefined;
  return clientPreferencesSchema.parse(JSON.parse(raw));
}

export interface PreferencesRequest { payload: PreferencesPayload; source: string; sourceEventId: string; now?: Date }
export interface PreferencesResult { applied: PreferenceGroup[]; deduped: boolean }
/**
 * 好みのまとまりを、記録より新しいものだけ書き換える。同じ日時なら先に届いた方を残す。
 * ひな形に秘密情報らしい文字列があれば、どのまとまりも書かずに断る（同期するファイルへ広げないため）。
 * 記録が壊れているときは、届いたまとまりだけで作り直す（好みは端末にも残っているため）。
 */
export async function setClientPreferences(config: HubConfig, request: PreferencesRequest): Promise<PreferencesResult> {
  const payload = preferencesPayloadSchema.parse(request.payload), vault = new Vault(config), now = request.now ?? new Date();
  const settings = secretSettings(config);
  if (settings.enabled && payload.groups.templates) {
    const findings = payload.groups.templates.value.items.flatMap(t => [...findSecrets(t.name, settings), ...findSecrets(t.body, settings)]);
    if (findings.length) throw new PreferencesError({ code: 'preferences-secret', labels: summarizeFindings(findings).map(f => f.label) }, 'ひな形に秘密情報らしい文字列があります');
  }
  return vault.withLock(async () => {
    let current: ClientPreferences;
    try { current = (await readClientPreferences(vault)) ?? { schema_version: 1, groups: {} }; } catch { current = { schema_version: 1, groups: {} }; }
    // 同じ受付IDの再送（書いた後、受領記録の前に停止したとき）は、書き直さずに前の結果を返す。
    // 時計の進んだ端末の日時は受け付けた時刻に丸めるため、再送で比べ直すと、その間に届いた新しい変更を巻き戻してしまう。
    const stored = preferenceGroups.filter(g => current.groups[g]?.request_id === request.sourceEventId);
    if (stored.length) return { applied: stored, deduped: true };
    const next: ClientPreferences = { schema_version: 1, groups: { ...current.groups } }, applied: PreferenceGroup[] = [];
    for (const group of preferenceGroups) {
      const incoming = payload.groups[group];
      if (!incoming) continue;
      const existing = current.groups[group];
      // 受け付けた時刻より先の日時は、受け付けた時刻に丸める（時計の進んだ端末の変更がいつまでも勝たないように）。
      const at = Date.parse(incoming.updated_at) > now.getTime() ? now.toISOString() : new Date(incoming.updated_at).toISOString();
      if (existing && Date.parse(existing.updated_at) >= Date.parse(at)) continue;
      (next.groups as Record<string, unknown>)[group] = { updated_at: at, device: payload.device, request_id: request.sourceEventId, value: valueSchemas[group].parse(incoming.value) };
      applied.push(group);
    }
    if (applied.length) await vault.write(clientPreferencesPath, JSON.stringify(clientPreferencesSchema.parse(next), null, 2) + '\n');
    return { applied, deduped: false };
  });
}
