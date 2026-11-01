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
function safePath(path) {
  return typeof path === 'string' && /^(00_inbox|10_projects|30_knowledge|90_system)\//.test(path) && !path.includes('\\') && !path.split('/').some(p => !p || p === '.' || p === '..');
}
async function reviewItems(params) {
  const root = JSON.parse(await read(params, '90_system/review/index.json'));
  if (root.schema_version !== 1 || !Array.isArray(root.items)) throw new Error('確認待ち一覧が未同期です');
  const items = [...root.items];
  if (root.pages !== undefined) {
    if (!Array.isArray(root.pages) || root.pages.length > 5000 || items.length) throw new Error('一覧の分割情報が不正です');
    const seen = new Set();
    for (const page of root.pages) {
      if (!/^90_system\/review\/page-\d{5}\.json$/.test(page.path) || seen.has(page.path)) throw new Error('一覧の参照先が不正です');
      seen.add(page.path);
      const raw = await read(params, page.path);
      if (await sha256(raw) !== page.hash) throw new Error('一覧の同期が未完了です');
      const value = JSON.parse(raw);
      if (value.schema_version !== 1 || !Array.isArray(value.items)) throw new Error('一覧の形式が不正です');
      items.push(...value.items);
    }
  }
  return items;
}
async function validateReview(params, item) {
  const project = item.kind === 'project', prefix = project ? 'PCAN' : 'CAN', folder = project ? 'project-candidates' : 'candidates';
  if (!(new RegExp('^' + prefix + '-[0-9A-HJKMNP-TV-Z]{26}$')).test(item.id) || item.status !== 'pending' || !['project', 'knowledge', 'decision', 'preference'].includes(item.kind) || !/^[a-f0-9]{64}$/.test(item.candidateHash) || item.path !== `90_system/${folder}/${item.id}.md` || !Array.isArray(item.inputIds) || !item.dependencies || item.dependencies[item.path] !== item.candidateHash) throw new Error('候補の情報が不正です');
  if (project && !/^[a-f0-9]{64}$/.test(item.confirmationToken)) throw new Error('確認情報が未同期です');
  await validateDependencies(params,item);
  const all = await inputs(params);
  if (item.inputIds.some(id => !all.some(i => i.id === id)) || all.some(i => item.inputIds.includes(i.corrects_input_id) && !item.inputIds.includes(i.id))) throw new Error('元のメモに未同期または新しい訂正があります。最新の候補を確認してください');
  return all.filter(i => item.inputIds.includes(i.id));
}
async function validateDependencies(params,item) {
  for (const [path, wanted] of Object.entries(item.dependencies)) {
    if (!safePath(path) || (wanted !== null && !/^[a-f0-9]{64}$/.test(wanted))) throw new Error('候補の参照先が不正です');
    const file = params.app.vault.getAbstractFileByPath(path);
    const actual = file ? await sha256(await params.app.vault.read(file)) : null;
    if (actual !== wanted) throw new Error('根拠・候補・判断の同期が未完了か変更されています。再同期後に確認してください');
  }
}
async function decideReview(params, action, project = false) {
  const candidates = (await reviewItems(params)).filter(i => i.status === 'pending' && (project ? i.kind === 'project' : ['knowledge', 'decision', 'preference'].includes(i.kind)));
  if (!candidates.length) { notify(params, '確認待ち候補がありません。HOMEと同期を確認してください。'); return; }
  const item = await params.quickAddApi.suggester(candidates.map(i => `${i.title} / ${i.id}`), candidates);
  if (!item) return;
  const target = !project && action === 'approve' ? await selectTarget(params,item) : undefined;
  if (!project && action === 'approve' && !target) return;
  const evidence = await validateReview(params, item);
  const originals = [];
  for (const source of evidence) originals.push(`${source.id}\n${await read(params, source.path)}`);
  const proposal = project ? metadata(params, await read(params, item.path)).proposal : undefined;
  const projectDetails = proposal ? `名前: ${proposal.title}\n別名: ${proposal.aliases.join('、') || 'なし'}\n検索語: ${proposal.keywords.join('、') || 'なし'}\n` : '';
  const previousPath=item.supersedes?Object.keys(item.dependencies).find(p=>p.endsWith(`/${item.supersedes}.md`)):undefined;
  const previous = previousPath ? await read(params,previousPath) : '';
  const targetDetails=target?`採用先: ${target.scope==='global'?'全ての作業に共通（本人の明示選択）':target.label}\n${item.kind==='knowledge'?'参考知識として必要時に参照します。':'有効な方針として対象のAI作業へ渡します。'}\n`:'';
  const details = `${projectDetails}${targetDetails}主張: ${item.claim}\n理由: ${item.rationale || '不明'}\n種別: ${item.kind}\n候補: ${item.id}\n生成日時: ${item.generatedAt || '不明'}\n\n元のメモ:\n${originals.join('\n\n') || '利用者の提案（原文なし）'}${previous ? '\n\n置き換え元:\n' + previous : ''}\n\n${action === 'approve' ? 'この内容を採用します。' : 'この候補を却下します。'}\n依頼保存後、Mac miniが最新状態を再検証します。`;
  if (!await params.quickAddApi.yesNoPrompt(action === 'approve' ? '知識・方針の候補を採用' : '知識・方針の候補を却下', details)) return;
  await validateReview(params, item);
  if(target)await validateTarget(params,target);
  return submit(params, `${project ? 'project' : 'knowledge'}-${action}`, { candidate_id: item.id, candidate_hash: item.candidateHash, ...(project ? { confirmation_token: item.confirmationToken } : target ? {scope:target.scope,...(target.scope==='project'?{project_id:target.project_id,project_hash:target.project_hash}:{})} : {}), confirmed: true });
}
async function selectTarget(params,item) {
  const root=JSON.parse(await read(params,'90_system/review/index.json'));
  if(!Array.isArray(root.projects))throw new Error('採用先一覧が未同期です');
  const suggestions=Array.isArray(item.projectSuggestions)?item.projectSuggestions:[];
  const ordered=[...root.projects].sort((a,b)=>Number(!suggestions.some(s=>s.projectId===a.id))-Number(!suggestions.some(s=>s.projectId===b.id)));
  const targets=ordered.map(p=>{const suggestion=suggestions.find(s=>s.projectId===p.id);return {scope:'project',project_id:p.id,project_hash:p.hash,path:p.path,label:`${p.title} (${p.id})${suggestion?` / ${suggestion.source==='explicit'?'元メモで指定':'AIの推定・本人確認が必要'}`:''}`};});
  targets.push({scope:'global',label:'全ての作業に共通（本人の明示選択）'},null);
  const selected=await params.quickAddApi.suggester(targets.map(t=>t?t.label:'保留する'),targets);
  if(selected)await validateTarget(params,selected);return selected;
}
async function validateTarget(params,target){
  if(target.scope==='global')return;
  if(target.scope!=='project'||!(/^[a-z0-9][a-z0-9-]{1,40}$/).test(target.project_id)||target.path!==`10_projects/${target.project_id}/project.md`||!(/^[a-f0-9]{64}$/).test(target.project_hash))throw new Error('採用先情報が不正です');
  const raw=await read(params,target.path);if(await sha256(raw)!==target.project_hash||metadata(params,raw).id!==target.project_id)throw new Error('採用先が変更・未同期です。再読込してください');
}
async function retireKnowledge(params){
  const candidates=(await reviewItems(params)).filter(i=>i.kind!=='project'&&i.status==='approved'&&i.reflected&&!i.retired);
  if(!candidates.length){notify(params,'適用停止できる採用済み記録がありません。');return;}
  const item=await params.quickAddApi.suggester(candidates.map(i=>`${i.title} / ${i.id}`),candidates);if(!item)return;
  const validate=async()=>{await validateDependencies(params,item);if(!safePath(item.targetPath)||!item.targetPath.endsWith(`/KNW-${item.id.slice(4)}.md`))throw new Error('停止先が不正です');const raw=await read(params,item.targetPath),meta=metadata(params,raw);if(meta.approval_id!==item.decisionId||meta.approved_hash!==item.candidateHash||meta.verified!==true)throw new Error('停止対象を確認できません');return {raw,id:meta.id,hash:await sha256(raw)};};
  const value=await validate();
  if(!await params.quickAddApi.yesNoPrompt('採用済み記録を適用停止',`${value.raw}\n\n自動適用を止めます。本文と採用履歴は保持します。`))return;
  const fresh=await validate();if(fresh.hash!==value.hash)throw new Error('確認中に停止対象が変更されました');
  return submit(params,'knowledge-retire',{target_id:value.id,target_hash:value.hash,confirmed:true});
}
module.exports = {
  captureMemo: safeAction(params => capture(params, 'memo')),
  captureSummary: safeAction(params => capture(params, 'work-summary')),
  correctInput: safeAction(correct),
  approveProject: safeAction(params => decideReview(params, 'approve', true)),
  rejectProject: safeAction(params => decideReview(params, 'reject', true)),
  retireKnowledge: safeAction(retireKnowledge),
  approveKnowledge: safeAction(params => decideReview(params, 'approve')),
  rejectKnowledge: safeAction(params => decideReview(params, 'reject')),
};
