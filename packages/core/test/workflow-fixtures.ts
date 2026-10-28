import { mkdtemp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultConfig } from '../src/config.js';
import { Vault, markdown } from '../src/storage.js';
import type { HubConfig } from '../src/types.js';
export async function workflowSetup(roots:string[]){const root=await mkdtemp(join(tmpdir(),'ctx-flow-'));roots.push(root);const config=defaultConfig(join(root,'vault'),join(root,'state'));const vault=new Vault(config);await vault.init();return{config,vault};}
export async function packet(config:HubConfig,extra:Record<string,unknown>={},text='メモの本文'){
 const request_id=String(extra.request_id??`REQ-${randomBytes(16).toString('hex')}`),path=`Input/${request_id}.md`,meta={schema_version:1,request_id,operation:'capture',source:'quickadd',occurred_at:'2026-10-03T10:00:00Z',kind:'memo',...extra};
 if(meta.operation!=='capture')delete (meta as any).kind;
 await new Vault(config).create(path,markdown(meta,text));await utimes(join(config.vaultPath,path),new Date(0),new Date(0));return{requestId:request_id,path};
}
