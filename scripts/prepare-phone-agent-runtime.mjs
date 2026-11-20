import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TEST_GROUP } from '../src/config/account.mjs';
const root=path.resolve(import.meta.dirname,'..');
assert.equal(process.platform,'win32');
const report=JSON.parse(fs.readFileSync(path.join(root,'evidence/phone-agent-current-copy-20261115.json'),'utf8'));
assert(report.passed&&report.destination.startsWith(path.join(root,'.tmp')+path.sep));
const source=path.join(report.destination,'data');
// The completed import verifier already walked this tree and rejected symlinks.
// Recheck directory entries immediately before copying; never follow a junction.
function check(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,e.name),s=fs.lstatSync(full);assert(!s.isSymbolicLink());if(s.isDirectory())check(full);else assert(s.isFile());}}
check(source);
const work=fs.mkdtempSync(path.join(root,'.tmp/phone-agent-runtime-'));
fs.cpSync(source,path.join(work,'data'),{recursive:true,errorOnExist:true,force:false,dereference:false});
fs.mkdirSync(path.join(work,'home'));fs.mkdirSync(path.join(work,'logs'));
const cfgPath=path.join(work,'data/config.json');
const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
function patch(target,changes){for(const [key,value] of Object.entries(changes)){
  if(value&&typeof value==='object'&&!Array.isArray(value)){if(!target[key]||typeof target[key]!=='object')target[key]={};patch(target[key],value);}
  else target[key]=value;}}
patch(cfg,{
  server:{host:'127.0.0.1',port:3210,strictPort:true,token:''},
  runtime:{mode:'observe',paused:true},
  allow:{groups:[Number(TEST_GROUP)],private:[]},allowAllWhenEmpty:false,
  onebot:{wsUrl:'ws://127.0.0.1:9',httpUrl:'http://127.0.0.1:9',accessToken:'',httpAccessToken:'',catchupReplyWindowMs:0},
  proactive:{enabled:false,followUpEnabled:false,selfWakeEnabled:false},pacing:{enabled:false},reminders:{enabled:false},
  dailyMoments:{enabled:false},lifeFeed:{enabled:false},qzoneInteractions:{enabled:false},groupDigest:{enabled:false},
  adminBriefing:{enabled:false},groupGame:{enabled:false},plugins:{enabled:false},mcp:{enabled:false},
  autoUpdate:{enabled:false,snowluma:{enabled:false}},api:{priceRemoteUrl:'none',channelPriceFeeds:[]},
  humanize:{shape:{enabled:false}},send:{hardSplitAt:0},
});
fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2)+'\n');
const result={at:new Date().toISOString(),work,linuxWork:'/mnt/d/qq-onebot/.tmp/'+path.basename(work),
  source:report.destination,phoneModified:false,originalImportedSnapshotModified:false,
  roleMemoryKnowledgePreserved:true,initialMode:'observe',paused:true,realQQ:false,realModel:false,
  note:'Only local runtime configuration overlay; no persona/memory/knowledge/session removal.'};
fs.writeFileSync(path.join(root,'evidence/phone-agent-current-runtime-20261115.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
