import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {planStamp,applyStamp,isStamped,UPSTREAM_COPYRIGHT} from '../scripts/lib/stamp-runtime-licenses.mjs';

function fixture(t){
  const base=fs.mkdtempSync(path.resolve('.tmp/runtime-licenses-test-'));
  t.after(()=>{assert.equal(fs.realpathSync(base),base);assert(path.dirname(base)===path.resolve('.tmp'));fs.rmSync(base,{recursive:true});});
  const root=path.join(base,'repo'),runtime=path.join(base,'runtime');
  fs.mkdirSync(path.join(root,'third-party/qq-agent-plus'),{recursive:true});
  fs.writeFileSync(path.join(root,'third-party/qq-agent-plus/LICENSE'),'MIT License\n\n'+UPSTREAM_COPYRIGHT+'\n');
  fs.writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),'derived from qq-agent-plus\n');
  fs.mkdirSync(path.join(runtime,'app/src'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'app/src/server.js'),'SYNTHETIC_UPSTREAM');
  fs.mkdirSync(path.join(runtime,'data'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'data/config.json'),'{"synthetic":true}');
  return{root,runtime};
}

test('stamp writes upstream LICENSE and notices into app/ and leaves user data alone',t=>{
  const f=fixture(t),plan=planStamp(f.runtime,{root:f.root});
  assert.deepEqual(plan.errors,[]);
  assert.equal(isStamped(plan),false);
  assert.deepEqual(plan.entries.map(e=>e.to),['LICENSE','THIRD_PARTY_NOTICES.md']);
  assert(plan.entries.every(e=>e.state==='pending'));

  const written=applyStamp(plan);
  assert.deepEqual(written,['LICENSE','THIRD_PARTY_NOTICES.md']);
  const license=path.join(f.runtime,'app/LICENSE');
  assert(fs.readFileSync(license,'utf8').includes(UPSTREAM_COPYRIGHT));
  assert(fs.readFileSync(path.join(f.runtime,'app/THIRD_PARTY_NOTICES.md'),'utf8').includes('qq-agent-plus'));
  // 只写 app/：上游源码与用户数据一个字节都不许动
  assert.equal(fs.readFileSync(path.join(f.runtime,'app/src/server.js'),'utf8'),'SYNTHETIC_UPSTREAM');
  assert.equal(fs.readFileSync(path.join(f.runtime,'data/config.json'),'utf8'),'{"synthetic":true}');

  const again=planStamp(f.runtime,{root:f.root});
  assert.equal(isStamped(again),true);
  assert.deepEqual(applyStamp(again),[]);
});

test('stamp refuses a tree without app/ instead of writing licenses somewhere else',t=>{
  const f=fixture(t),plan=planStamp(path.join(f.runtime,'data'),{root:f.root});
  assert.equal(plan.entries.length,0);
  assert.match(plan.errors[0],/找不到 app\//);
  assert.equal(isStamped(plan),false);
  assert.deepEqual(applyStamp(plan),[]);
  assert(!fs.existsSync(path.join(f.runtime,'data/LICENSE')));
});

test('stamp refuses an upstream license that lost its copyright line',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'third-party/qq-agent-plus/LICENSE'),'MIT License\n\nCopyright (c) 2020 Somebody Else\n');
  const plan=planStamp(f.runtime,{root:f.root});
  assert.equal(plan.entries.length,1);
  assert.match(plan.errors[0],/拒绝盖章/);
  assert.equal(isStamped(plan),false);
  assert(!fs.existsSync(path.join(f.runtime,'app/LICENSE')));
});

test('stamp reports a stale on-package license as pending so it gets refreshed',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.runtime,'app/LICENSE'),'MIT License\n\nCopyright (c) 2020 Somebody Else\n');
  const plan=planStamp(f.runtime,{root:f.root});
  assert.equal(plan.entries.find(e=>e.to==='LICENSE').state,'pending');
  assert.equal(isStamped(plan),false);
  applyStamp(plan);
  assert.equal(planStamp(f.runtime,{root:f.root}).entries.find(e=>e.to==='LICENSE').state,'same');
});
