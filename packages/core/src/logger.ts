import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, readdir, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { HubConfig } from './types.js';
export interface OperationLog { op:'capture'|'organize'|'approve'|'reject'|'propose'; input_id?:string; ms?:number; error_kind?:'storage'|'llm'|'validation'; counts?:Record<string,number> }
export async function logOperation(config: HubConfig, event: OperationLog): Promise<boolean> {
  try {
    await mkdir(config.logging.dir,{recursive:true,mode:0o700});
    if((await lstat(config.logging.dir)).isSymbolicLink())return false;
    const dir=await realpath(config.logging.dir);
    try {const vault=await realpath(config.vaultPath), rel=relative(vault,dir);if(!rel||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel)))return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return false;}
    if(!['capture','organize','approve','reject','propose'].includes(event.op))return false;
    const counts:Record<string,number>={};
    for(const key of ['processed','failed','skipped','deduped','conflicts'])if(Number.isSafeInteger(event.counts?.[key])&&event.counts![key]>=0)counts[key]=event.counts![key];
    const record={ts:new Date().toISOString(),op:event.op,
      ...(event.input_id&&/^IN-[0-9A-HJKMNP-TV-Z]{26}$/.test(event.input_id)?{input_id:event.input_id}:{}),
      ...(Number.isFinite(event.ms)&&event.ms!>=0?{ms:Math.round(event.ms!)}:{}),
      ...(event.error_kind&&['storage','llm','validation'].includes(event.error_kind)?{error_kind:event.error_kind}:{}),counts};
    const date=new Intl.DateTimeFormat('sv-SE',{timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const handle=await open(join(dir,`${date}.jsonl`),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(JSON.stringify(record)+'\n');}finally{await handle.close();}
    const cutoff=Date.now()-config.logging.retentionDays*86400000;
    for(const file of await readdir(dir))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)&&Date.parse(file.slice(0,10)+'T23:59:59+09:00')<cutoff)await unlink(join(dir,file));
    return true;
  }catch{return false;}
}
