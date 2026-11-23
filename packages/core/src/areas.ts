import { z } from 'zod';
import type { Project } from './types.js';

/**
 * プロジェクトの領域（GTDの責任範囲。例: 仕事・家・健康）。本人がプロジェクトに1つ付け、HOME・週次レビュー・アプリで領域ごとにまとめて見る。
 * - AIは付けず推測もしない。本人の指定だけをproject.mdの`area`に書く（プロジェクト案の採用・帰属の推定・登録簿のハッシュには使わない）。
 * - 選べる領域の一覧（語彙）は、アプリの好み（client-preferences.jsonのareas）で端末の間にそろえる。記録は語彙に縛らない。
 */
export const AREA_CHARS = 20;
export const AREA_VOCABULARY_MAX = 12;
/** 領域を付けていないプロジェクトをまとめる見出し。 */
export const NO_AREA_LABEL = '領域なし';
/**
 * 領域の名前1つ。1行・20文字以内（UTF-16の単位で数える）で、前後の空白・制御文字・書式文字（ゼロ幅など）・行区切り・文字の向きを変える制御を含めない。
 * 端末と本体で同じ領域を同じ文字列として比べるため、NFCに正規化した文字列だけを受け付ける。
 */
export const areaSchema = z.string().min(1, '領域が空です').max(AREA_CHARS, `領域は${AREA_CHARS}文字以内にしてください`)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, '領域は1行で書いてください（制御文字は使えません）')
  .refine(v => v.trim() === v, '領域の前後に空白は付けられません')
  .refine(v => v !== NO_AREA_LABEL, `「${NO_AREA_LABEL}」は領域の名前に使えません`)
  .refine(v => v.normalize('NFC') === v, '領域の文字を正規化（NFC）してください');
/** 領域の語彙（アプリで選ぶ一覧。並びは本人が決めた順）。 */
export const areaVocabularySchema = z.array(areaSchema).max(AREA_VOCABULARY_MAX).refine(items => new Set(items).size === items.length, '同じ領域を重ねて指定できません');

/** project.mdに手で書いた領域の値。規則に合わない値は付いていないものとして扱い、doctorで示す。 */
export function readArea(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return areaSchema.safeParse(value).success ? value : undefined;
}
/** 手で書いた領域のうち、規則に合わず読み飛ばしているもの（doctor用）。 */
export function invalidArea(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && (!value.trim() || areaSchema.safeParse(value).success));
}

/**
 * 領域の並び。語彙にある領域は語彙の順、語彙にない領域は名前の順で後ろに置き、領域なしは最後。
 * 返すのは実際にプロジェクトに付いている領域だけ（語彙にあっても使われていない領域は含めない）。
 */
export function orderAreas(areas: Iterable<string | undefined>, vocabulary: readonly string[] = []): (string | undefined)[] {
  const used = new Set(areas), named = [...used].filter((a): a is string => a !== undefined);
  const known = vocabulary.filter(a => used.has(a)), rest = named.filter(a => !vocabulary.includes(a)).sort((a, b) => a.localeCompare(b, 'ja'));
  return [...known, ...rest, ...(used.has(undefined) ? [undefined] : [])];
}
/** 領域を使っているか（1つでもプロジェクトに付いていれば、HOMEと週次レビューで領域ごとにまとめる）。 */
export const usesAreas = (projects: readonly Pick<Project, 'area'>[]): boolean => projects.some(p => p.area !== undefined);

