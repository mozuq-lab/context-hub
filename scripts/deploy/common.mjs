import {constants} from 'node:fs';
import {createReadStream} from 'node:fs';
import {open,readFile,mkdir,lstat,readdir,readlink,realpath,rename,unlink,rmdir} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute,parse} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export const sha=value=>createHash('sha256').update(value).digest('hex');
export const within=(parent,child)=>{const r=relative(resolve(parent),resolve(child));return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('../'));};
export const overlaps=(a,b)=>within(a,b)||within(b,a);
export async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function safePath(path,{owned=false}={}){
 if(!isAbsolute(path))throw new Error('絶対パスを指定してください');
 let current=parse(path).root;
 for(const component of relative(current,resolve(path)).split('/').filter(Boolean)){
  current=join(current,component);
  try{const st=await lstat(current);if(st.isSymbolicLink())throw new Error('symlinkを経由する操作は禁止です');}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
 if(owned&&await exists(path)){const st=await lstat(path);if(st.uid!==process.getuid()||(st.mode&0o022))throw new Error('管理対象の所有者・書き込み権限を確認してください');}
 return resolve(path);
}
export async function readBytes(path){
 await safePath(path);let h;
 try{h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}
 try{const st=await h.stat();if(!st.isFile()||st.size>32*1024*1024)throw new Error('管理ファイルの種類・容量が不正です');return await h.readFile();}finally{await h.close();}
}
export async function readJson(path){const b=await readBytes(path);return b===undefined?undefined:JSON.parse(b.toString('utf8'));}
export async function fileHash(path){const b=await readBytes(path);return b===undefined?null:sha(b);}
export async function archiveHash(path){await safePath(path);const h=createHash('sha256');for await(const b of createReadStream(path,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}))h.update(b);return h.digest('hex');}
export async function syncDir(path){const h=await open(path,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}
export async function privateDir(path){await safePath(path);await mkdir(path,{recursive:true,mode:0o700});await safePath(path,{owned:true});}
export async function atomicWrite(path,data,mode){
 await safePath(path);await privateDir(dirname(path));
 if(mode===undefined)mode=await exists(path)?(await lstat(path)).mode&0o777:0o600;
 const temp=join(dirname(path),`.ctx-tmp-${randomUUID()}`),h=await open(temp,'wx',mode);
 try{await h.writeFile(data);await h.sync();}finally{await h.close();}
 try{await safePath(path);await rename(temp,path);await syncDir(dirname(path));}
 finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export const writeJson=(path,value)=>atomicWrite(path,JSON.stringify(value,null,2)+'\n');
export async function durableRename(from,to){await safePath(from);await safePath(to);await rename(from,to);await syncDir(dirname(from));if(dirname(from)!==dirname(to))await syncDir(dirname(to));}
export async function inventory(root){
 const result={};await safePath(root,{owned:true});
 async function walk(rel=''){
  for(const e of (await readdir(join(root,rel),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const p=rel?`${rel}/${e.name}`:e.name;if(p==='.context-hub-release.json')continue;
   const path=join(root,p),st=await lstat(path);
   if(e.isSymbolicLink()){
    const target=await realpath(path);if(!within(root,target))throw new Error('候補に外部を参照するsymlinkがあります');
    result[p]={link:await readlink(path)};
   }else if(e.isDirectory())await walk(p);
   else if(e.isFile())result[p]={hash:sha(await readFile(path)),mode:st.mode&0o777};
   else throw new Error('候補に通常ファイル以外があります');
  }
 }
 await walk();return result;
}
export const treeHash=async root=>sha(JSON.stringify(await inventory(root)));
export async function run(executable,args,{cwd,env,timeout=60000,logFile,capture=true}={}){
 return new Promise((done,reject)=>{
  const child=spawn(executable,args,{cwd,env:env??process.env,shell:false,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',size=0;
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
  for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',b=>{
   if(!capture)return;size+=b.length;if(size>32*1024*1024){child.kill('SIGTERM');return;}
   if(key==='stdout')stdout+=b.toString();else stderr+=b.toString();
  });
  child.on('error',()=>{clearTimeout(timer);reject(new Error('外部コマンドを起動できませんでした'));});
  child.on('close',async(code,signal)=>{
   clearTimeout(timer);
   try{if(logFile)await atomicWrite(logFile,stdout+stderr);done({code:code??1,stdout,stderr,signal});}catch(e){reject(e);}
  });
 });
}
export async function checked(executor,exe,args,options){const r=await executor(exe,args,options);if(r.code!==0)throw new Error('外部コマンドの検証または実行に失敗しました。保存したログを確認してください');return r;}
export async function withUpdateLock(root,planId,fn,{resume=false}={}){
 await privateDir(root);const lock=join(root,'.deploy.lock'),token=randomUUID();
 try{await mkdir(lock,{mode:0o700});}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  await safePath(lock,{owned:true});const owner=await readJson(join(lock,'owner.json')),state=await readJson(join(root,'deployment-state.json'));
  let dead=false;if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){dead=e.code==='ESRCH';}}
  if(!resume||!dead||owner.planId!==planId||state?.planId!==planId||state.writersResumed)throw new Error('別の更新が実行中か、更新ロックの確認が必要です');
  const retired=join(root,`.deploy-retired-${token}`);await rename(lock,retired);await unlink(join(retired,'owner.json'));await rmdir(retired);await mkdir(lock,{mode:0o700});
 }
 await writeJson(join(lock,'owner.json'),{pid:process.pid,token,planId});
 try{return await fn();}finally{
  const owner=await readJson(join(lock,'owner.json'));
  if(owner?.token===token){await unlink(join(lock,'owner.json'));await rmdir(lock);await syncDir(root);}
 }
}
