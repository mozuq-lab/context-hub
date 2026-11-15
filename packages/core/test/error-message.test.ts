import {afterEach,expect,test} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {z} from 'zod';
import {defaultConfig,loadConfig} from '../src/config.js';
import {userFacingError} from '../src/error-message.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

test('CLIのエラーは、既知の失敗を日本語にし、パス・本文・外部のstderrは出さない',()=>{
 expect(userFacingError(new Error('infer:spawn'))).toContain('モデル実行のコマンドを起動できません');
 expect(userFacingError(new Error('infer:exit'))).toContain('モデル実行のコマンドが失敗しました');
 // 先頭が英字でも、本体が書いた日本語の文はそのまま示す。
 expect(userFacingError(new Error('frontmatter がありません'))).toBe('frontmatter がありません');
 expect(userFacingError(new Error('Vault内にsymlinkがあります'))).toBe('Vault内にsymlinkがあります');
 // 外部の例外（パスを含む）や複数行は一般的な案内にする。
 expect(userFacingError(new Error("ENOENT: no such file or directory, open '/home/someone/秘密.md'"))).not.toContain('/home/someone');
 expect(userFacingError(new Error('失敗しました\n/home/someone/x'))).not.toContain('/home/someone');
 expect(userFacingError(new Error('読めません: /Users/someone/vault/x.md'))).not.toContain('/Users/someone');
 // 引数の形式の誤りは、値を出さずに項目を示す。
 const parsed=z.object({project:z.string().regex(/^[a-z]+$/)}).safeParse({project:'秘密の値'});
 const message=userFacingError(parsed.error);expect(message).toContain('project');expect(message).not.toContain('秘密の値');
});

test('設定の誤りは、値を出さずにキーの場所を示す',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ctx-config-'));roots.push(root);const path=join(root,'config.json');
 await writeFile(path,JSON.stringify({...defaultConfig(join(root,'vault'),join(root,'state')),organize:{...defaultConfig(join(root,'vault')).organize,timeoutSec:'秘密の値'},privacy:{redactSecrets:true,patterns:[{label:'x',pattern:'('}]}}));
 const error=await loadConfig(path).then(()=>undefined,(e:Error)=>e);
 expect(error?.message).toContain('organize.timeoutSec');expect(error?.message).toContain('privacy.patterns.0.pattern');expect(error?.message).not.toContain('秘密の値');
 const run=await new Promise<string>(done=>{const p=spawn(process.execPath,[resolve('packages/core/dist/cli.js'),'--config',path,'doctor'],{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>err+=d);p.on('close',()=>done(err));});
 expect(run).toContain('organize.timeoutSec');expect(run).not.toContain('秘密の値');
});
