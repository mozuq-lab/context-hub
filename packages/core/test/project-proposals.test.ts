import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { Vault } from '../src/storage.js';
import { capture } from '../src/capture.js';
import { correctInput } from '../src/corrections.js';
import { organize } from '../src/organize.js';
import { MockLlm } from '../src/llm.js';
import { addProject, readProjects } from '../src/projects.js';
import { decideProject, listProjectCandidates } from '../src/project-proposals.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'ctx-project-'));roots.push(root);const config=defaultConfig(join(root,'vault'),join(root,'state'));const vault=new Vault(config);await vault.init();return{config,vault};}
const proposal={title:'家庭菜園',aliases:['菜園'],keywords:['栽培'],rationale:'継続した活動の記録'};
const result={category:'idea' as const,summary:'菜園を試したい',project_candidates:[],next_action_suggestions:[],extracted:{current:[],next:[],open:[]},knowledge_candidate:null,new_project_hint:null,project_proposal:proposal};
async function candidate(config:any){await capture(config,{source:'cli',occurredAt:'2026-10-03T10:00:00Z',text:'家庭菜園を始めたい'});await organize(config,new MockLlm([result]));return(await listProjectCandidates(config))[0];}
function request(c:any,action:'approve'|'reject'='approve'){return{candidateId:c.candidateId,expectedHash:c.candidateHash,confirmationToken:c.confirmationToken,action,source:'quickadd',sourceEventId:'REQ-'+'a'.repeat(32),confirmed:true as const};}
test('候補だけでは定義を作らず古い候補の承認を拒否する',async()=>{
 const{config}=await setup();const c=await candidate(config);expect(c).toBeDefined();expect(await readProjects(config)).toHaveLength(0);
 await organize(config,new MockLlm());expect(await listProjectCandidates(config)).toHaveLength(1);
 await expect(decideProject(config,{...request(c),confirmationToken:'0'.repeat(64)})).rejects.toThrow();await expect(decideProject(config,{...request(c),expectedHash:'0'.repeat(64)})).rejects.toThrow();
 await correctInput(config,c.rootInputId,{source:'cli',occurredAt:'2026-10-03T11:00:00Z',text:'菜園案を取り消す'});
 expect((await listProjectCandidates(config))[0].status).toBe('stale');await expect(decideProject(config,request(c))).rejects.toThrow();expect(await readProjects(config)).toHaveLength(0);
});
test('承認記録後の停止を同じ定義へ回復する',async()=>{
 const{config,vault}=await setup();const c=await candidate(config);const create=Vault.prototype.create;
 vi.spyOn(Vault.prototype,'create').mockImplementation(async function(this:Vault,path,text){if(path===`10_projects/${c.projectId}/project.md`)throw new Error('停止');return create.call(this,path,text);});
 await expect(decideProject(config,request(c))).rejects.toThrow('停止');expect(await vault.files('90_system/project-approvals')).toHaveLength(1);expect(await readProjects(config)).toHaveLength(0);vi.restoreAllMocks();
 expect(await decideProject(config,request(c))).toMatchObject({projectId:c.projectId,deduped:true});expect(await readProjects(config)).toMatchObject([{id:c.projectId,title:'家庭菜園',aliases:['菜園']}]);
 await expect(decideProject(config,request(c,'reject'))).rejects.toThrow();expect((await listProjectCandidates(config))[0].status).toBe('approved');
});
test('既存名と別名に一致する候補の承認を拒否し却下を巻き戻さない',async()=>{
 const{config}=await setup();const c=await candidate(config);await addProject(config,{id:'existing',title:'栽培日記',aliases:['菜園']});await expect(decideProject(config,request(c))).rejects.toThrow();
 const other=await setup();const second=await candidate(other.config);await decideProject(other.config,request(second,'reject'));expect((await listProjectCandidates(other.config))[0].status).toBe('rejected');await expect(decideProject(other.config,request(second))).rejects.toThrow();
});
test('承認後の定義更新を再送と定期回復が巻き戻さない',async()=>{
 const{config,vault}=await setup();const c=await candidate(config);await decideProject(config,request(c));const path=`10_projects/${c.projectId}/project.md`,updated=(await vault.read(path))!.replace('  - 栽培','  - 家庭菜園');await vault.write(path,updated);
 await organize(config,new MockLlm());await decideProject(config,request(c));expect(await vault.read(path)).toBe(updated);
});
