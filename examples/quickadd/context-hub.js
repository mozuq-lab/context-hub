// QuickAddのユーザースクリプト。Node専用API・外部通信を使わない。
function metadata(params, raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (!match) throw new Error('同期されたノートの形式を確認してください');
  return params.obsidian.parseYaml(match[1]);
}
function notify(params, text) { if (params.obsidian.Notice) new params.obsidian.Notice(text); }
async function sha256(raw) {
  if (!crypto.subtle) throw new Error('内容確認に必要なWebCryptoが使えません。Mac側で承認してください');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function read(params, path) {
  const file = params.app.vault.getAbstractFileByPath(path);
  if (!file) throw new Error('必要なノートが未同期です。同期完了後に再実行してください');
  return params.app.vault.read(file);
}
async function submit(params, operation, fields, text = '') {
  if ((operation === 'capture' || operation === 'correct') && (!text.trim() || text.length > 8000)) throw new Error('本文は1〜8000文字にしてください');
  const id = 'REQ-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const meta = { schema_version: 1, request_id: id, operation, source: 'quickadd', occurred_at: new Date().toISOString(), ...fields };
  if (!params.app.vault.getAbstractFileByPath('Input')) await params.app.vault.createFolder('Input');
  await params.app.vault.create(`Input/${id}.md`, `---\n${JSON.stringify(meta)}\n---\n${text}`);
  notify(params, '端末に保存しました。同期・処理待ちです。HOMEで受領を確認できます。');
  return id;
}
async function capture(params, kind) {
  const text = await params.quickAddApi.wideInputPrompt(kind === 'memo' ? 'ContextHubへメモを追加' : 'AIの作業要約を追加（AI自己報告として保存）');
  if (text === undefined || text === null || !text.trim()) return;
  return submit(params, 'capture', { kind }, text);
}
async function inputs(params) {
  const result = [];
  for (const file of await params.app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith('00_inbox/') || file.path.includes('.sync-conflict-')) continue;
    const raw = await params.app.vault.read(file), meta = metadata(params, raw);
    if (!/^IN-[0-9A-HJKMNP-TV-Z]{26}$/.test(meta.id) || !file.path.endsWith(`_${meta.id}.md`)) throw new Error('同期された入力のIDが不正です');
    result.push({ ...meta, path: file.path, preview: raw.split(/\r?\n---\r?\n/).slice(1).join('\n').slice(0, 80) });
  }
  return result;
}
async function correct(params) {
  const all = await inputs(params), targets = new Set(all.map(i => i.corrects_input_id).filter(Boolean));
  const latest = all.filter(i => !targets.has(i.id));
  if (!latest.length) { notify(params, '訂正対象がありません。正式入力の同期を確認してください。'); return; }
  const selected = await params.quickAddApi.suggester(latest.map(i => `${i.id} / ${i.preview}`), latest);
  if (!selected) return;
  const text = await params.quickAddApi.wideInputPrompt(`訂正: ${selected.id}（原文は保持されます）`);
  if (text === undefined || text === null || !text.trim()) return;
  return submit(params, 'correct', { target_id: selected.id }, text);
}
async function decide(params, action) {
  const candidates = [];
  for (const file of await params.app.vault.getMarkdownFiles()) {
    if (!/^90_system\/project-candidates\/PCAN-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(file.path)) continue;
    const raw = await params.app.vault.read(file), meta = metadata(params, raw);
    if (file.path !== `90_system/project-candidates/${meta.id}.md`) throw new Error('候補IDとパスが一致しません');
    const decision = params.app.vault.getAbstractFileByPath(`90_system/project-approvals/PAPR-${meta.id.slice(5)}.json`);
    if (decision) {
      try { const record = JSON.parse(await params.app.vault.read(decision)); if (record.candidate_id === meta.id) continue; } catch { /* 未同期の断片はMiniが再検証する。 */ }
    }
    candidates.push({ raw, meta });
  }
  if (!candidates.length) { notify(params, '承認待ち候補がありません。候補と処理記録の同期を確認してください。'); return; }
  const selected = await params.quickAddApi.suggester(candidates.map(c => `${c.meta.proposal.title} / ${c.meta.id}`), candidates);
  if (!selected) return;
  const { raw, meta } = selected;
  const confirmation = JSON.parse(await read(params, `90_system/project-confirmations/${meta.id}.json`));
  if (confirmation.candidate_id !== meta.id || confirmation.candidate_hash !== await sha256(raw) || !/^[a-f0-9]{64}$/.test(confirmation.confirmation_token)) throw new Error('候補と確認情報が一致しません。同期完了後に再実行してください');
  const all = await inputs(params), evidence = all.filter(i => meta.evidence_ids.includes(i.id));
  if (evidence.length !== meta.evidence_ids.length || all.some(i => i.corrects_input_id && meta.evidence_ids.includes(i.corrects_input_id) && !meta.evidence_ids.includes(i.id))) throw new Error('根拠が未同期か新しい訂正があります。最新の候補を確認してください');
  const proposal = meta.proposal;
  const details = `名前: ${proposal.title}\n別名: ${proposal.aliases.join('、') || 'なし'}\n検索語: ${proposal.keywords.join('、') || 'なし'}\n理由: ${proposal.rationale}\n候補: ${meta.id}\n根拠: ${meta.evidence_ids.join(' → ')}\n生成日時: ${meta.generated_at}\nモデル: ${meta.generated_by.model}\n\n${action === 'approve' ? '承認するとMac miniがこの内容の定義を作成します。' : 'この候補を却下します。'}\n同期後、Mac miniが内容と最新状態を再検証します。`;
  if (!await params.quickAddApi.yesNoPrompt(action === 'approve' ? 'プロジェクト案を承認' : 'プロジェクト案を却下', details)) return;
  return submit(params, action === 'approve' ? 'project-approve' : 'project-reject', { candidate_id: meta.id, candidate_hash: confirmation.candidate_hash, confirmation_token: confirmation.confirmation_token, confirmed: true });
}
function safeAction(action) {
  return async params => {
    try { return await action(params); }
    catch (error) {
      if (error && error.name === 'MacroAbortError') return;
      notify(params, '保存・操作は完了していません。同期とHOMEの処理状況を確認してください。');
      throw error;
    }
  };
}
module.exports = {
  captureMemo: safeAction(params => capture(params, 'memo')),
  captureSummary: safeAction(params => capture(params, 'work-summary')),
  correctInput: safeAction(correct),
  approveProject: safeAction(params => decide(params, 'approve')),
  rejectProject: safeAction(params => decide(params, 'reject')),
};
