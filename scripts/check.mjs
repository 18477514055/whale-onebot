import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[];
function walk(dir){for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile())files.push(file);else throw new Error('Unexpected source link');}}
for(const dir of ['src','test','scripts','docs','experiments'])walk(dir);
// 仓库里必须存在的根文件。开发记录（AGENTS.md / admin-change-log.md / 审计与实测）
// 按「仓库只放源码」的规矩只在本地 `_notes/`（已 gitignore），因此不在这张清单里；
// 换来的是 LICENSE —— 对外发布的仓库没有它就不合规。
for(const name of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','.gitignore'])files.push(name);
const sources=files.filter(x=>x.endsWith('.mjs'));
for(const file of sources){const result=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8'});if(result.status!==0){console.error('Syntax check failed: '+file);process.exit(1);}}
const tests=files.filter(x=>x.endsWith('.test.mjs')).sort();
// 必须与 `npm test` 同一条命令行：`test/preload.mjs` 负责补身份环境默认值、
// 建 .tmp/、固定 WHALE_MESSAGE_ID_SEED。少了它，身份/消息号相关用例会成批失败。
const result=spawnSync(process.execPath,['--import','./test/preload.mjs','--test','--test-reporter=tap',...tests.map(x=>path.join(root,x))],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
const evidence=path.join(root,'evidence');fs.mkdirSync(evidence,{recursive:true});
fs.writeFileSync(path.join(evidence,`tests-${process.platform}.tap`),result.stdout??'');
const checks={at:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,exitCode:result.status,filesChecked:sources.length,testFiles:tests.length,summary:(result.stdout??'').split('\n').filter(x=>/^# (tests|pass|fail|cancelled|skipped|duration_ms) /.test(x)),qqNativeRuntimeExecuted:false,testScope:'Synthetic QQ services, loopback transports, and real Sharp decoding in separate processes',phoneAccess:false,realMessagesSent:0};
fs.writeFileSync(path.join(evidence,`verification-${process.platform}.json`),JSON.stringify(checks,null,2)+'\n');
const manifest=files.sort().map(file=>({path:file.replaceAll('\\','/'),sha256:createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}));
fs.writeFileSync(path.join(evidence,'source-manifest.json'),JSON.stringify({generatedAt:new Date().toISOString(),files:manifest},null,2)+'\n');
console.log(JSON.stringify(checks,null,2));
if(result.status!==0){console.error(result.stdout,result.stderr);process.exitCode=1;}
