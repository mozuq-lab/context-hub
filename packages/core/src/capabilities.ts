import { ASK_QUESTION_CHARS } from './ask.js';
import { Vault } from './storage.js';
import type { HubConfig } from './types.js';

/**
 * 本体が受け付ける依頼と、本人が設定で有効にした機能をアプリへ知らせるファイル。
 * アプリは、ここにない依頼の画面を出さない（対応前の本体へ受け付けられない依頼を送らないため）。
 * 生成日時を入れず、同じ版・同じ設定なら同じ本文にする（同期を無駄に走らせない）。
 */
export const capabilitiesPath = '90_system/capabilities.json';
/** 依頼の種類のうち、新しく足したもの。これより前からある依頼は、アプリが本体の生成物から対応を判断している。 */
export const capabilityFeatures = ['item-repeat', 'item-occurrence', 'ask', 'client-preferences'] as const;
export type CapabilityFeature = typeof capabilityFeatures[number];
export function capabilitiesDocument(config: Pick<HubConfig, 'ask'>): string {
  const features = capabilityFeatures.filter(f => f !== 'ask' || config.ask.enabled);
  return JSON.stringify({ schema_version: 1, features, ask: { enabled: config.ask.enabled, max_question_chars: ASK_QUESTION_CHARS } }, null, 2) + '\n';
}
/** Writerロック内で使う。内容が変わったときだけ書く。 */
export async function writeCapabilitiesLocked(config: Pick<HubConfig, 'ask'>, vault: Vault): Promise<boolean> {
  const text = capabilitiesDocument(config);
  if (await vault.read(capabilitiesPath) === text) return false;
  await vault.write(capabilitiesPath, text);
  return true;
}
