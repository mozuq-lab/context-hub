import {afterEach,expect,test,vi} from 'vitest';
import {rm,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {workflowSetup} from './workflow-fixtures.js';
import {aiCandidate} from './review-fixtures.js';
import {propose,approve,reject,recoverKnowledgeApprovalsLocked} from '../src/approvals.js';
import {readReviewCandidates,buildReviewIndex} from '../src/candidate-review.js';
import {correctInput} from '../src/corrections.js';
import {Vault,hash,parseMarkdown} from '../src/storage.js';
import {generatedMarkdown} from '../src/views.js';
import {decideProject} from '../src/project-proposals.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test('4種類の候補を同じ一覧で読み、indexは元ファイルhashに結び付く',async()=>{
 const{config,vault}=await aiCandidate(roots,true);
 await propose(config,{kind:'knowledge',claim:'復元は別フォルダーへ行う'});
 await propose(config,{kind:'preference',claim:'説明は日本語で行う'});
 const items=await readReviewCandidates(config);
 expect(items.map(c=>c.kind).sort()).toEqual(['decision','knowledge','preference','project']);
 expect(items.every(c=>c.status==='pending')).toBe(true);
 const index=await buildReviewIndex(config);expect(index.schema_version).toBe(1);
 for(const item of index.items){expect(item.dependencies[item.path]).toBe(hash((await vault.read(item.path))!));expect(item.candidateHash).toBe(item.dependencies[item.path]);}
});
test('本人作成の候補は原文なしで採用でき、承認記録と反映先を一覧へ示す',async()=>{
 const{config,vault}=await workflowSetup(roots);const c=await propose(config,{kind:'preference',claim:'説明は日本語'});
 await approve(config,c.candidateId,c.hash,{scope:'global'});
 const[item]=await readReviewCandidates(config);
 expect(item).toMatchObject({status:'approved',reflected:true,decisionId:`APR-${c.candidateId.slice(4)}`,targetPath:`30_knowledge/KNW-${c.candidateId.slice(4)}.md`});
 expect(await vault.files('30_knowledge')).toHaveLength(1);
 await expect(reject(config,c.candidateId,c.hash)).rejects.toThrow();
});
test('候補hashが変わらなくても新しい訂正があれば古い候補として拒否する',async()=>{
 const c=await aiCandidate(roots);await correctInput(c.config,c.input.inputId,{source:'cli',occurredAt:'2026-11-01T02:00:00Z',text:'採用方針はまだ決まっていない'});
 expect(hash((await c.vault.read(c.path))!)).toBe(c.hash);
 expect((await readReviewCandidates(c.config))[0].status).toBe('stale');
 await expect(approve(c.config,c.id,c.hash,{scope:'global'})).rejects.toThrow();
 expect(await c.vault.files('90_system/approvals')).toHaveLength(0);
});
test('根拠receiptが未同期なら確認待ちにして承認を止める',async()=>{
 const c=await aiCandidate(roots);await rm(join(c.config.vaultPath,`90_system/receipts/${c.input.inputId}.json`));
 expect((await readReviewCandidates(c.config))[0].status).toBe('unavailable');
 await expect(approve(c.config,c.id,c.hash,{scope:'global'})).rejects.toThrow();
});
test('壊れた候補が混在しても正常な候補を残す',async()=>{
 const{config,vault}=await workflowSetup(roots);const good=await propose(config,{claim:'有効な候補'});
 await vault.create('90_system/candidates/CAN-00000000000000000000000000.md','破損');
 await vault.create('90_system/project-candidates/PCAN-00000000000000000000000000.md','破損');
 const items=await readReviewCandidates(config);
 expect(items.find(c=>c.id===good.candidateId)?.status).toBe('pending');
 expect(items.filter(c=>c.status==='unavailable')).toHaveLength(2);
});
test('候補を解析した後でも反映先が危険なリンクなら承認可能にしない',async()=>{
 const{config}=await workflowSetup(roots);const c=await propose(config,{claim:'保存先を確認する'});
 const outside=join(config.vaultPath,'..','outside.txt');await writeFile(outside,'外側の架空データ');
 await symlink(outside,join(config.vaultPath,`30_knowledge/KNW-${c.candidateId.slice(4)}.md`));
 expect((await readReviewCandidates(config))[0].status).toBe('unavailable');
 await expect(approve(config,c.candidateId,c.hash,{scope:'global'})).rejects.toThrow();
});
test('不正な候補日時でも他の候補の一覧を壊さない',async()=>{
 const{config,vault}=await workflowSetup(roots);const c=await propose(config,{claim:'不正日時'});
 const parsed=parseMarkdown((await vault.read(c.path))!);await vault.write(c.path,generatedMarkdown({...parsed.meta,generated_at:42},parsed.text));
 await propose(config,{claim:'正常候補'});
 const items=await readReviewCandidates(config);expect(items.find(i=>i.id===c.candidateId)?.status).toBe('unavailable');
 expect(items.find(i=>i.claim==='正常候補')?.status).toBe('pending');
});
test('index生成中に候補が変わったら操作可能なsnapshotとして返さない',async()=>{
 const{config,vault}=await workflowSetup(roots);const c=await propose(config,{claim:'旧候補'});const read=Vault.prototype.readBytes;let changed=false;
 vi.spyOn(Vault.prototype,'readBytes').mockImplementation(async function(this:Vault,path,max){
  const raw=await read.call(this,path,max);
  if(path===c.path&&!changed){changed=true;const parsed=parseMarkdown((await this.read(c.path))!);await this.write(c.path,generatedMarkdown({...parsed.meta,claim:'新候補'},parsed.text));}
  return raw;
 });
 const index=await buildReviewIndex(config);expect(index.items[0].status).toBe('unavailable');
});
test('無関係な破損project候補があっても正常な候補を承認できる',async()=>{
 const c=await aiCandidate(roots,true);await c.vault.create('90_system/project-candidates/PCAN-00000000000000000000000000.md','破損');
 const candidate=(await readReviewCandidates(c.config)).find(i=>i.kind==='project')!;
 expect(candidate.status).toBe('pending');
 const result=await decideProject(c.config,{candidateId:candidate.id,expectedHash:candidate.candidateHash,confirmationToken:candidate.confirmationToken!,confirmed:true,action:'approve',source:'cli',sourceEventId:'review-test'});
 expect(result.projectId).toMatch(/^project-/);
});
test('承認後に根拠が訂正されても過去の判断を保持し注意を示す',async()=>{
 const c=await aiCandidate(roots);await approve(c.config,c.id,c.hash,{scope:'global'});
 const before=await c.vault.read(`30_knowledge/KNW-${c.id.slice(4)}.md`);
 await correctInput(c.config,c.input.inputId,{source:'cli',occurredAt:'2026-11-01T02:00:00Z',text:'別の方針へ変更する'});
 const[item]=await readReviewCandidates(c.config);expect(item.status).toBe('approved');expect(item.warnings.join(' ')).toContain('訂正');
 expect(await c.vault.read(`30_knowledge/KNW-${c.id.slice(4)}.md`)).toBe(before);
});
test('承認後の候補消失でも同じ判断は凍結snapshotから確認し重複しない',async()=>{
 const{config,vault}=await workflowSetup(roots);const c=await propose(config,{claim:'保存する方針'});
 await approve(config,c.candidateId,c.hash,{scope:'global'});await rm(join(config.vaultPath,c.path));
 expect((await approve(config,c.candidateId,c.hash,{scope:'global'})).deduped).toBe(true);
 expect(await vault.files('30_knowledge')).toHaveLength(1);
 expect((await readReviewCandidates(config))[0].status).toBe('approved');
});
test('承認記録だけがある停止後は反映未確認とし同じ判断から回復する',async()=>{
 const{config,vault}=await workflowSetup(roots);const c=await propose(config,{claim:'耐久化する'});const create=Vault.prototype.create;
 vi.spyOn(Vault.prototype,'create').mockImplementation(async function(this:Vault,p,raw){if(p.startsWith('30_knowledge/'))throw new Error('停止');return create.call(this,p,raw);});
 await expect(approve(config,c.candidateId,c.hash,{scope:'global'})).rejects.toThrow('停止');vi.restoreAllMocks();
 expect((await readReviewCandidates(config))[0]).toMatchObject({status:'approved',reflected:false});
 expect(await vault.withLock(()=>recoverKnowledgeApprovalsLocked(config,vault,2,false))).toBe(1);
 expect((await readReviewCandidates(config))[0].reflected).toBe(true);
 expect(await vault.files('90_system/approvals')).toHaveLength(1);
});
test('新知識作成後・旧知識の後継更新前の停止を反映待ちとして回復する',async()=>{
 const{config,vault}=await workflowSetup(roots),old=await propose(config,{claim:'旧方針'});
 const prior=await approve(config,old.candidateId,old.hash,{scope:'global'}),oldPath=`30_knowledge/${prior.knowledgeId}.md`;
 const next=await propose(config,{claim:'新方針',supersedes:prior.knowledgeId});const write=Vault.prototype.write;
 vi.spyOn(Vault.prototype,'write').mockImplementation(async function(this:Vault,path,raw){if(path===oldPath)throw new Error('旧知識更新前に停止');return write.call(this,path,raw);});
 await expect(approve(config,next.candidateId,next.hash,{scope:'global'})).rejects.toThrow('旧知識更新前に停止');vi.restoreAllMocks();
 const state=(await readReviewCandidates(config)).find(i=>i.id===next.candidateId)!;expect(state.status).toBe('approved');expect(state.reflected).toBe(false);
 expect(await vault.withLock(()=>recoverKnowledgeApprovalsLocked(config,vault,2))).toBe(1);
 expect(parseMarkdown((await vault.read(oldPath))!).meta.superseded_by).toBe(`KNW-${next.candidateId.slice(4)}`);
 expect((await readReviewCandidates(config)).find(i=>i.id===next.candidateId)!.reflected).toBe(true);
 expect(await vault.files('90_system/approvals')).toHaveLength(2);expect(await vault.files('30_knowledge')).toHaveLength(2);
});
test('プロジェクト判断履歴の別名と検索語は承認時点のsnapshotから返す',async()=>{
 const f=await aiCandidate(roots,true),item=(await readReviewCandidates(f.config)).find(i=>i.kind==='project')!;
 await decideProject(f.config,{candidateId:item.id,expectedHash:item.candidateHash,confirmationToken:item.confirmationToken!,confirmed:true,action:'approve',source:'cli',sourceEventId:'snapshot-details'});
 const doc=parseMarkdown((await f.vault.read(item.path))!);await f.vault.write(item.path,generatedMarkdown({...doc.meta,proposal:{...(doc.meta.proposal as object),aliases:['承認後の別名'],keywords:['承認後の検索語']}},doc.text));
 const history=(await readReviewCandidates(f.config)).find(i=>i.id===item.id)!;
 expect(history.status).toBe('approved');expect(history).toMatchObject({aliases:[],keywords:['記録']});
});
