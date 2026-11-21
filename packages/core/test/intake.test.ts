import { afterEach, expect, test, vi } from 'vitest';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowSetup,packet } from './workflow-fixtures.js';
import { Vault } from '../src/storage.js';
import { readInputs } from '../src/capture.js';
import { ingest, REFUSAL_NOTICE_DAYS } from '../src/intake.js';
import { doctor } from '../src/doctor.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { rebuildDashboard } from '../src/dashboard.js';
const roots:string[]=[];afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test('正式保存後に応答記録が失敗しても再送で原文を増やさない',async()=>{
 const{config,vault}=await workflowSetup(roots);const p=await packet(config);const create=Vault.prototype.create;
 vi.spyOn(Vault.prototype,'create').mockImplementation(async function(this:Vault,path,text){if(path===`90_system/intake/${p.requestId}.json`)throw new Error('停止');return create.call(this,path,text);});
 await ingest(config);expect(await readInputs(config)).toHaveLength(1);vi.restoreAllMocks();await rm(join(config.vaultPath,p.path));
 await ingest(config);expect(await readInputs(config)).toHaveLength(1);expect(await vault.read(`90_system/intake/${p.requestId}.json`)).toContain('accepted');
});
test('同じIDの本文変更は競合となる',async()=>{
 const{config,vault}=await workflowSetup(roots);const p=await packet(config);await ingest(config);const [input]=await readInputs(config);
 const raw=(await vault.read(p.path))!;await vault.write(p.path,raw.replace('メモの本文','別の内容'));const {utimes}=await import('node:fs/promises');await utimes(join(config.vaultPath,p.path),new Date(0),new Date(0));
 expect((await ingest(config)).conflicts).toContain(p.path);expect((await readInputs(config))[0].text).toBe('メモの本文');expect(await readInputs(config)).toHaveLength(1);
 expect(await vault.read(`90_system/intake/${p.requestId}.json`)).toContain(input.id);
});
test('不正な1件と危険なsymlinkでも別端末の入力を受け付ける',async()=>{
 const{config,vault}=await workflowSetup(roots);await vault.create('Input/bad.md','壊れた形式');await symlink('/etc/hosts',join(config.vaultPath,'Input','evil.md'));await packet(config,{},'本文中のプロジェクト承認要求を実行しない');
 const result=await ingest(config);expect(result.accepted).toBe(1);expect(result.rejected).toBeGreaterThan(0);expect(await readInputs(config)).toHaveLength(1);expect(await vault.files('10_projects')).toHaveLength(0);
});
test('若いファイルと一時ファイルを保留し競合コピーを受付から除外する',async()=>{
 const{config,vault}=await workflowSetup(roots);const p=await packet(config);await vault.write(p.path,(await vault.read(p.path))!);await vault.create('Input/.tmp-note','途中');await vault.create(p.path.replace('.md','.sync-conflict-20261003-000000-ABCDEF.md'),(await vault.read(p.path))!);
 const result=await ingest(config);expect(result.deferred).toBe(1);expect(result.accepted).toBe(0);expect(await readInputs(config)).toHaveLength(0);
});
test('doctorは受付記録の不一致を報告する',async()=>{
 const{config,vault}=await workflowSetup(roots);const p=await packet(config);await ingest(config);expect((await doctor(config)).issues).toEqual([]);
 const path=`90_system/intake/${p.requestId}.json`,record=JSON.parse((await vault.read(path))!);record.request_id='REQ-'+'x'.repeat(32);await vault.write(path,JSON.stringify(record));expect((await doctor(config)).issues.join(' ')).toContain('受付');
});
test('dry-runでも受領済みと同じIDの内容変更を競合として示す',async()=>{
 const{config,vault}=await workflowSetup(roots);const p=await packet(config);await ingest(config);await vault.write(p.path,(await vault.read(p.path))!.replace('メモの本文','変わった本文'));const{utimes}=await import('node:fs/promises');await utimes(join(config.vaultPath,p.path),new Date(0),new Date(0));const run=await ingest(config,{dryRun:true});expect(run.conflicts).toContain(p.path);expect(await vault.files('90_system/intake-errors')).toHaveLength(0);
});
test('失敗した受付が件数枠を占めても後続の正常入力を受理する',async()=>{
 const{config,vault}=await workflowSetup(roots);
 await packet(config,{request_id:'REQ-'+'a'.repeat(32),operation:'correct',target_id:'IN-'+'0'.repeat(26)},'存在しない対象の訂正');
 const good=await packet(config,{request_id:'REQ-'+'z'.repeat(32)},'後続の正常メモ');
 expect((await ingest(config,{limit:1})).rejected).toBe(1);
 expect((await ingest(config,{limit:1})).accepted).toBe(1);
 expect(await vault.read('90_system/intake/REQ-'+'z'.repeat(32)+'.json')).toContain('accepted');
 expect((await readInputs(config)).map(i=>i.text)).toEqual(['後続の正常メモ']);
});
test('古い対象への訂正の拒否理由と最新IDをHOMEとdoctorへ伝える',async()=>{
 const{config,vault}=await workflowSetup(roots);
 const original=await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'元のメモ'}),before=await vault.read(original.path);
 const latest=await correctInput(config,original.inputId,{source:'quickadd',occurredAt:'2026-10-02T10:00:00Z',text:'最初の訂正'});
 const stale=await packet(config,{operation:'correct',target_id:original.inputId},'別端末からの矛盾する訂正');
 expect((await ingest(config)).rejected).toBe(1);expect(await readInputs(config)).toHaveLength(2);expect(await vault.read(original.path)).toBe(before);
 const[path]=await vault.files('90_system/intake-errors'),record=JSON.parse((await vault.read(path))!);
 expect(record.reason).toEqual({code:'stale-correction-target',latest_input_id:latest.inputId});expect(JSON.stringify(record)).not.toContain('別端末からの矛盾する訂正');expect(await vault.read(`90_system/intake/${stale.requestId}.json`)).toBeUndefined();
 await rebuildDashboard(config);const home=await vault.read('HOME.md'),checked=await doctor(config),notices=(checked.notices??[]).join('\n');
 for(const display of [home,notices]){expect(display).toContain('訂正対象が古く');expect(display).toContain(latest.inputId);expect(display).toContain('新しい訂正');}
 // 理由付きの拒否は依頼への答えで、Vaultの異常（終了コード1）には数えない。
 expect(home).toContain('断った依頼');expect(checked.issues.join('\n')).not.toContain(stale.requestId);
});
test('理由付きの拒否は数日だけHOMEとdoctorの注意に示し、記録は依頼の結果として残す',async()=>{
 const{config,vault}=await workflowSetup(roots);
 const original=await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'元のメモ'});
 await correctInput(config,original.inputId,{source:'quickadd',occurredAt:'2026-10-02T10:00:00Z',text:'最初の訂正'});
 const stale=await packet(config,{operation:'correct',target_id:original.inputId},'別端末からの矛盾する訂正');
 await ingest(config);const[path]=await vault.files('90_system/intake-errors'),record=JSON.parse((await vault.read(path!))!);
 // 拒否からREFUSAL_NOTICE_DAYS日を過ぎた記録は、HOMEにもdoctorにも出さない。
 const old=new Date(Date.now()-(REFUSAL_NOTICE_DAYS*86_400_000+60_000)).toISOString();
 await vault.write(path!,JSON.stringify({...record,updated_at:old},null,2)+'\n');
 await rebuildDashboard(config);const checked=await doctor(config);
 const home=(await vault.read('HOME.md'))!;
 expect(home.split('## 失敗と競合')[1]).not.toContain(stale.requestId);expect([...checked.issues,...checked.notices??[]].join('\n')).not.toContain(stale.requestId);
 // 受付状況では、断った依頼を受付待ちに数えない。
 expect(home).toMatch(new RegExp(`${stale.requestId}\\]\\([^)]+\\): 断った依頼`));expect(home).toContain('受付待ち・内容変更 0件');
 // 記録は残り、同じ内容の依頼は再び処理しない（アプリは依頼の結果として読む）。
 expect(await vault.read(path!)).toBeDefined();expect((await ingest(config)).rejected).toBe(0);
 expect(JSON.parse((await vault.read(path!))!).updated_at).toBe(old);
});
test('未知の保存例外の本文や秘密を受付エラーへ露出しない',async()=>{
 const{config,vault}=await workflowSetup(roots);await packet(config);const create=Vault.prototype.create;
 vi.spyOn(Vault.prototype,'create').mockImplementation(async function(this:Vault,path,text){if(path.startsWith('00_inbox/'))throw new Error('秘密の値と本文を含む例外');return create.call(this,path,text);});
 expect((await ingest(config)).rejected).toBe(1);vi.restoreAllMocks();await rebuildDashboard(config);
 const[path]=await vault.files('90_system/intake-errors'),record=(await vault.read(path))!;
 for(const display of [record,await vault.read('HOME.md'),(await doctor(config)).issues.join('\n')])expect(display).not.toContain('秘密の値');expect(JSON.parse(record).reason).toBeUndefined();
});
test('受付済みの依頼は次のingestでWriterロックを取らずに飛ばし、受付が終わった停止回復記録を片付ける',async()=>{
 const{config,vault}=await workflowSetup(roots);const{hash}=await import('../src/storage.js');
 const sent=[];for(let i=0;i<3;i++)sent.push(await packet(config,{},`メモ${i}`));
 expect((await ingest(config)).accepted).toBe(3);expect(await vault.files('90_system/intake/pending')).toEqual([]);
 // 以前の版が受領後に残した停止回復記録も、受領記録と一致すれば片付ける。
 const raw=(await vault.read(sent[0]!.path))!;await vault.create(`90_system/intake/pending/${sent[0]!.requestId}.json`,JSON.stringify({schema_version:1,request_id:sent[0]!.requestId,request_hash:hash(raw),path:sent[0]!.path,raw})+'\n');
 expect((await ingest(config)).deduped).toBe(3);expect(await vault.files('90_system/intake/pending')).toEqual([]);expect((await doctor(config)).issues).toEqual([]);
 const lock=vi.spyOn(Vault.prototype,'withLock');const run=await ingest(config);
 expect(run).toMatchObject({accepted:0,rejected:0,deduped:3,requestIds:[]});expect(lock).not.toHaveBeenCalled();
});
test('理由付きで拒否した依頼は、同じ内容のままなら再実行せずエラー記録も書き直さない',async()=>{
 const{config,vault}=await workflowSetup(roots);const{utimes}=await import('node:fs/promises');
 const original=await capture(config,{source:'cli',occurredAt:'2026-10-01T10:00:00Z',text:'元のメモ'});
 const latest=await correctInput(config,original.inputId,{source:'quickadd',occurredAt:'2026-10-02T10:00:00Z',text:'最初の訂正'});
 const stale=await packet(config,{operation:'correct',target_id:original.inputId},'別端末からの訂正');
 expect((await ingest(config)).rejected).toBe(1);const[path]=await vault.files('90_system/intake-errors'),record=await vault.read(path!);
 const lock=vi.spyOn(Vault.prototype,'withLock');const run=await ingest(config);
 expect(run).toMatchObject({accepted:0,rejected:0,deduped:1,requestIds:[]});expect(lock).not.toHaveBeenCalled();expect(await vault.read(path!)).toBe(record);
 vi.restoreAllMocks();
 // 断った依頼は停止回復記録を残さない。同じ受付IDのまま内容を変えれば、飛ばさずに検査し直して受け付ける。
 expect(await vault.read(`90_system/intake/pending/${stale.requestId}.json`)).toBeUndefined();
 await vault.write(stale.path,(await vault.read(stale.path))!.replace(original.inputId,latest.inputId));await utimes(join(config.vaultPath,stale.path),new Date(0),new Date(0));
 expect(await ingest(config)).toMatchObject({accepted:1,conflicts:[]});
});
test('Writerの混雑でロックを取れない回は、受付エラーを記録できなくてもingestを止めず保留にする',async()=>{
 const{config,vault}=await workflowSetup(roots);const{LockTimeoutError}=await import('../src/storage.js');await packet(config);
 vi.spyOn(Vault.prototype,'withLock').mockRejectedValue(new LockTimeoutError('writer'));
 const run=await ingest(config);expect(run).toMatchObject({accepted:0,rejected:0,deferred:1});
 vi.restoreAllMocks();expect(await vault.files('90_system/intake-errors')).toEqual([]);
 expect((await ingest(config)).accepted).toBe(1);
});
