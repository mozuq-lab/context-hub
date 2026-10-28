import {afterEach,expect,test} from 'vitest';
import {mkdtemp,rm,mkdir,writeFile,readdir,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig} from '../src/config.js';
import {logOperation} from '../src/logger.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
test('ログは本文を記録せず古い日付のログだけを削除',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ctx-log-'));roots.push(root);const c=defaultConfig(join(root,'vault'),join(root,'state'));await mkdir(c.logging.dir,{recursive:true});await writeFile(join(c.logging.dir,'2000-01-01.jsonl'),'old');await writeFile(join(c.logging.dir,'keep.txt'),'keep');
 expect(await logOperation(c,{op:'capture',input_id:'IN-01K5ABCDEFGHJKMNPQRSTVWXYZ',ms:3,text:'秘密本文'} as any)).toBe(true);
 const names=await readdir(c.logging.dir);expect(names).not.toContain('2000-01-01.jsonl');expect(names).toContain('keep.txt');const log=await readFile(join(c.logging.dir,names.find(n=>n.endsWith('.jsonl'))!),'utf8');expect(log).toContain('IN-01K5ABCDEFGHJKMNPQRSTVWXYZ');expect(log).not.toContain('秘密本文');
});
test('ログのsymlinkへ追記せず失敗を返す',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ctx-log-'));roots.push(root);const c=defaultConfig(join(root,'vault'),join(root,'state'));await mkdir(c.logging.dir,{recursive:true});const other=join(root,'other');await writeFile(other,'original');
 const date=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});await symlink(other,join(c.logging.dir,`${date}.jsonl`));expect(await logOperation(c,{op:'capture'})).toBe(false);expect(await readFile(other,'utf8')).toBe('original');
});
