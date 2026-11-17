import {constants} from 'node:fs';
import {createReadStream} from 'node:fs';
import {open,readFile,mkdir,lstat,readdir,readlink,realpath,rename,unlink,rmdir} from 'node:fs/promises';
import {resolve,dirname,basename,join,relative,isAbsolute,parse} from 'node:path';
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
async function caseInsensitiveAncestor(ancestor){
 const device=(await lstat(ancestor)).dev;
 for(let current=ancestor;;current=dirname(current)){
  const parent=dirname(current);
  if(parent===current||(await lstat(parent)).dev!==device)throw new Error('未作成パスの大小文字の同一性を確認できません');
  const name=basename(current),alias=name.replace(/[a-z]/i,c=>c===c.toLowerCase()?c.toUpperCase():c.toLowerCase());
  if(alias===name)continue;
  const original=await lstat(current);let other;
  try{other=await lstat(join(parent,alias));}catch(e){if(e.code==='ENOENT')return false;throw e;}
  return original.dev===other.dev&&original.ino===other.ino;
 }
}
export async function canonicalPath(path){
 await safePath(path);let ancestor=resolve(path);const tail=[];
 for(;;){
  let physical;
  try{physical=await realpath(ancestor);}
  catch(e){if(e.code!=='ENOENT')throw e;tail.push(basename(ancestor));ancestor=dirname(ancestor);continue;}
  // 同じfilesystemで大小文字aliasを実証できた場合だけ、未作成部分を比較用に揃える。
  const insensitive=tail.length>0&&await caseInsensitiveAncestor(physical);
  return join(physical,...tail.toReversed().map(part=>insensitive?part.toLowerCase():part));
 }
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
  const grouped=process.platform!=='win32',child=spawn(executable,args,{cwd,env:env??process.env,shell:false,detached:grouped,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',size=0,finished=false,expired=false,forceTimer,deadline;
  function kill(signal){try{process.kill(grouped?-child.pid:child.pid,signal);}catch{}}
  async function finish(result,error){if(finished)return;finished=true;clearTimeout(timer);clearTimeout(forceTimer);clearTimeout(deadline);try{if(logFile)await atomicWrite(logFile,stdout+stderr);if(error)reject(error);else done(result);}catch(e){reject(e);}}
  function stop(){if(expired)return;expired=true;kill('SIGTERM');forceTimer=setTimeout(()=>kill('SIGKILL'),1000);deadline=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();finish({code:1,stdout,stderr,signal:'SIGKILL'});},2000);}
  const timer=setTimeout(stop,timeout);
  for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',b=>{
   if(!capture)return;size+=b.length;if(size>32*1024*1024){stop();return;}
   if(key==='stdout')stdout+=b.toString();else stderr+=b.toString();
  });
  child.on('error',()=>finish(null,new Error('外部コマンドを起動できませんでした')));
  child.on('close',(code,signal)=>finish({code:expired?1:code??1,stdout,stderr,signal}));
 });
}
export async function checked(executor,exe,args,options){const r=await executor(exe,args,options);if(r.code!==0)throw new Error('外部コマンドの検証または実行に失敗しました。保存したログを確認してください');return r;}
export async function withUpdateLock(root,planId,fn,{resume=false}={}){
 await privateDir(root);const lock=join(root,'.deploy.lock'),reaper=join(root,'.deploy.reap'),token=randomUUID();
 if(await exists(reaper))throw new Error('更新ロックの回収が実行中か、回収記録の確認が必要です');
 try{await mkdir(lock,{mode:0o700});}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  if(!resume)throw new Error('別の更新が実行中か、更新ロックの確認が必要です');
  try{await mkdir(reaper,{mode:0o700});}catch{throw new Error('更新ロックの回収が実行中です');}
  try{
   await writeJson(join(reaper,'owner.json'),{pid:process.pid,token});
   await safePath(lock,{owned:true});const st=await lstat(lock),owner=await readJson(join(lock,'owner.json')),state=await readJson(join(root,'deployment-state.json'));
   let dead=false;if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){dead=e.code==='ESRCH';}}
   if(!dead||typeof owner.token!=='string'||owner.planId!==planId||state?.planId!==planId||state.writersResumed)throw new Error('別の更新が実行中か、更新ロックの確認が必要です');
   const now=await lstat(lock),latest=await readJson(join(lock,'owner.json'));
   if(st.ino!==now.ino||st.dev!==now.dev||JSON.stringify(latest)!==JSON.stringify(owner))throw new Error('回収中に更新ロックが変わりました');
   await unlink(join(lock,'owner.json'));await rmdir(lock);await mkdir(lock,{mode:0o700});
   await writeJson(join(lock,'owner.json'),{pid:process.pid,token,planId});
  }finally{const owner=await readJson(join(reaper,'owner.json'));if(owner?.token===token){await unlink(join(reaper,'owner.json'));await rmdir(reaper);}}
 }
 await writeJson(join(lock,'owner.json'),{pid:process.pid,token,planId});
 if(await exists(reaper)){const owner=await readJson(join(lock,'owner.json'));if(owner?.token===token){await unlink(join(lock,'owner.json'));await rmdir(lock);}throw new Error('更新ロックの回収が実行中です');}
 try{return await fn();}finally{
  const owner=await readJson(join(lock,'owner.json'));
  if(owner?.token===token){await unlink(join(lock,'owner.json'));await rmdir(lock);await syncDir(root);}
 }
}
