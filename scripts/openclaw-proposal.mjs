import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parseArgs} from 'node:util';

function checkedOptions(options) {
 const snowflake=/^\d{17,20}$/u;
 if(!options||!['repo','home','configPath'].every(key=>typeof options[key]==='string'&&isAbsolute(options[key]))
   ||!['guildId','channelId'].every(key=>typeof options[key]==='string'&&snowflake.test(options[key]))
   ||!Array.isArray(options.allowedSenderIds)||options.allowedSenderIds.length===0
   ||!options.allowedSenderIds.every(id=>typeof id==='string'&&snowflake.test(id)))throw new Error('絶対パスとDiscordのguild/channel/許可ユーザーIDを明示してください');
 return {...options,allowedSenderIds:[...new Set(options.allowedSenderIds)]};
}

// 既存設定はメモリで扱い、出力するのは公開情報から組み立てた追加差分だけ。
export function proposeOpenClaw(original,options) {
 const {repo,home,configPath,guildId,channelId,allowedSenderIds}=checkedOptions(options);
 if(original?.channels?.discord?.enabled!==true||original.channels.discord.groupPolicy!=='allowlist')throw new Error('有効なDiscord allowlist設定を事前に確認してください');
 const config=structuredClone(original),changes=[];
 // この導入手順は既存mainと専用hubだけを扱う。他の構成の所有者を推測しない。
 const entries=config.agents?.entries;
 if(!entries?.main||config.agents.list!==undefined||Object.keys(entries).some(id=>!['main','hub'].includes(id))||Object.values(entries).some(entry=>entry.default===true))throw new Error('既存エージェント構成の所有者を個別に確認してください');
 function set(keys,value){let target=config;for(const k of keys.slice(0,-1)){if(target[k]===undefined)target[k]={};if(!target[k]||typeof target[k]!=='object'||Array.isArray(target[k]))throw new Error('追加先の設定構造が想定と異なります');target=target[k];}const key=keys.at(-1);if(target[key]!==undefined){if(isDeepStrictEqual(target[key],value))return;throw new Error('追加対象に既存設定があります。差分を再検討してください');}target[key]=value;changes.push({op:'add',path:'/'+keys.join('/'),value});}
 set(['agents','entries','hub'],{name:'hub',workspace:join(home,'.openclaw/workspace-hub'),agentDir:join(home,'.openclaw/agents/hub/agent'),tools:{profile:'minimal',alsoAllow:['context-hub'],deny:['session_status']}});
 const binding={agentId:'hub',match:{channel:'discord',accountId:'default',peer:{kind:'channel',id:channelId}}};
 if(config.bindings!==undefined&&!Array.isArray(config.bindings))throw new Error('bindingsが配列ではありません');
 config.bindings??=[];
 if(!config.bindings.some(b=>isDeepStrictEqual(b,binding))){if(config.bindings.some(b=>b.match?.channel==='discord'&&b.match?.peer?.id===channelId))throw new Error('対象チャンネルには既存bindingがあります');config.bindings.push(binding);changes.push({op:'append',path:'/bindings',value:binding});}
 set(['channels','discord','guilds',guildId,'channels',channelId],{enabled:true,requireMention:false,users:allowedSenderIds});
 set(['plugins','entries','context-hub'],{enabled:true,config:{configPath,guildId,channelIds:[channelId],allowedSenderIds,accountId:'default'}});
 config.plugins.load??={};config.plugins.load.paths??=[];
 if(!Array.isArray(config.plugins.load.paths))throw new Error('plugins.load.pathsが配列ではありません');
 const plugin=join(repo,'packages/openclaw-plugin');
 if(!config.plugins.load.paths.includes(plugin)){config.plugins.load.paths.push(plugin);changes.push({op:'append',path:'/plugins/load/paths',value:plugin});}
 if(config.plugins.allow!==undefined){if(!Array.isArray(config.plugins.allow))throw new Error('plugins.allowが配列ではありません');if(!config.plugins.allow.includes('context-hub')){config.plugins.allow.push('context-hub');changes.push({op:'append',path:'/plugins/allow',value:'context-hub'});}}
 // 単独mainの暗黙の担当は、複数エージェント化すると失われる。明示して保持する。
 set(['agents','ownership'],'explicit');
 set(['agents','defaults','heartbeat','agentId'],'main');
 set(['agents','defaults','systemAgent','agentId'],'main');
 const mainBinding={agentId:'main',match:{channel:'discord',accountId:'default'}};
 if(!config.bindings.some(b=>isDeepStrictEqual(b,mainBinding))){if(config.bindings.some(b=>isDeepStrictEqual(b.match,mainBinding.match)))throw new Error('既存Discordアカウントの担当が競合しています');config.bindings.push(mainBinding);changes.push({op:'append',path:'/bindings',value:mainBinding});}
 const diff=['# OpenClaw設定の追加差分（JSONパス別、未適用）',...changes.map(c=>`@@ ${c.path}${c.op==='append'?' / 末尾追加':''} @@\n${JSON.stringify(c.value,null,2).split('\n').map(line=>'+ '+line).join('\n')}`)].join('\n\n')+'\n';
 return{config,changes,diff};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const {values,positionals}=parseArgs({args:process.argv.slice(2),allowPositionals:true,options:{'hub-config':{type:'string'},'guild-id':{type:'string'},'channel-id':{type:'string'},'allowed-sender-id':{type:'string',multiple:true}}});
  if(positionals.length!==1)throw new Error('入力ファイルを1件指定してください');
  const options=checkedOptions({repo:resolve(import.meta.dirname,'..'),home:homedir(),configPath:values['hub-config'],guildId:values['guild-id'],channelId:values['channel-id'],allowedSenderIds:values['allowed-sender-id']});
  const raw=await readFile(resolve(positionals[0]),'utf8'),proposal=proposeOpenClaw(JSON.parse(raw),options);
  process.stdout.write(`# 基準設定 SHA-256: ${createHash('sha256').update(raw).digest('hex')}\n${proposal.diff}`);
 }
 catch{process.stderr.write('設定差分を生成できません。既存の対象設定・設定形式を確認してください。\n');process.exitCode=1;}
}
