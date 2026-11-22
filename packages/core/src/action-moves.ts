import { Vault } from './storage.js';
import { capture, readInputs } from './capture.js';
import { actionSource } from './actions.js';
import { readProjects, resolveProject } from './projects.js';
import { UNASSIGNED_SCOPE, itemKey, itemScopeSchema, readNowItems } from './item-resolutions.js';
import type { CaptureResult, HubConfig } from './types.js';

/**
 * 本人が追加した行動を、別の置き場（プロジェクト・プロジェクト未定）へ移す。
 * 移す先に同じ文面の行動を追加し、元の行動を元の行（action_from_input・action_from_text・action_from_key）として指す。
 * 形は「自分の行動にする」と同じで、元の行動に効いていた期日・見直す日・繰り返し・手間の目安・連絡待ち・「いつかやる」は移した先の行動の記録へ写り、
 * 元の行動は元の置き場の一覧から外れる（movedActionIds。完了・却下とは数えない）。片付けた行動は移せない（未解決へ戻してから移す）。
 * 元に戻すときは、移した先の行動をもう一度移す。端末からは、同じ形の行動の追加（capture・kind: action）を依頼する。
 */
export interface MoveActionRequest {
  /** 元の行動が載っている置き場（プロジェクトのID、または_unassigned）。 */ from: string;
  /** 元の行動の項目キー（item listで確認）。 */ itemKey: string;
  /** 移す先の置き場（プロジェクトのID、または_unassigned）。 */ to: string;
  source: string; sourceEventId?: string; occurredAt: string;
}
export interface MoveActionResult extends CaptureResult { projectId: string; itemKey: string }

export async function moveAction(config: HubConfig, request: MoveActionRequest): Promise<MoveActionResult> {
  const from = itemScopeSchema.parse(request.from), to = itemScopeSchema.parse(request.to);
  const projects = await readProjects(config), place = (id: string) => id === UNASSIGNED_SCOPE ? id : resolveProject(projects, id);
  if (to !== UNASSIGNED_SCOPE && !projects.some(p => p.id === to)) throw new Error('移す先のプロジェクトがありません。先にproject addを実行してください');
  if (place(from) === place(to)) throw new Error('移す先が今の置き場と同じです');
  // 同じ受付IDの再送（移した後に止まった場合など）は、元の行動が一覧から外れていても、移した行動を返す（保存はしない）。
  if (request.sourceEventId !== undefined) {
    const saved = (await readInputs(config)).find(i => i.source === request.source && i.source_event_id === request.sourceEventId);
    if (saved) {
      const moved = actionSource(saved);
      if (moved?.key !== request.itemKey || (saved.project ?? UNASSIGNED_SCOPE) !== to) throw new Error('同じ受付IDで別の内容が記録されています。--event-idを確認してください');
      const result = await capture(config, { text: saved.text, kind: 'action', project: saved.project, source: saved.source, sourceEventId: saved.source_event_id, occurredAt: saved.occurred_at, meta: saved.meta });
      return { ...result, projectId: to, itemKey: itemKey(to, 'next', result.inputId, saved.text) };
    }
  }
  const item = (await readNowItems(new Vault(config), from))?.items.find(i => i.key === request.itemKey);
  if (!item) throw new Error('該当する項目がありません。item listで確認してください');
  if (!item.action) throw new Error('移せるのは本人が追加した行動です（AIの行は「自分の行動にする」で行動にします）');
  if (item.resolution) throw new Error('この行動は既に完了か、却下しています。未解決へ戻してから移してください');
  const result = await capture(config, { text: item.text, kind: 'action', project: to === UNASSIGNED_SCOPE ? undefined : to, source: request.source, sourceEventId: request.sourceEventId, occurredAt: request.occurredAt,
    meta: { action_from_input: item.input_id, action_from_text: item.text, action_from_key: item.key } });
  return { ...result, projectId: to, itemKey: itemKey(to, 'next', result.inputId, item.text) };
}
