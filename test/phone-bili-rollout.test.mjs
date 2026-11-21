import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {destination,classify,transaction} from '../scripts/stage-phone-bili-rollout.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
test('closed paths, exact digest classification',()=>{for(const p of ['src/config/account.mjs','src/config/ACCOUNT.MJS','src/../../m.js','input/agent-app/settings.json','src/a;sh.mjs','src/data/a.js','src/settings.js','bili-protocol/node_modules/ws/what.js','bili-protocol/src/config/account.mjs'])assert.throws(()=>destination(p));const r={before:'missing',after:sha('new')};assert.deepEqual(['missing',r.after,sha('x'),undefined].map(h=>classify(r,h)),['create','already-current','divergent','unchecked']);});
test('execute actual transaction against isolated synthetic files: all-file preflight, backups, idempotence, and new-file rollback',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-rollout-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const id='abc123def456abcd',w=`files/bili-rollout-${id}`;
 const write=(p,s)=>{const f=path.join(dir,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};const read=p=>fs.readFileSync(path.join(dir,p),'utf8');
 const rows=['src/replace.mjs','src/create.mjs','input/agent-app/src/current.js'].map((p,i)=>({p,dest:destination(p),before:i===0?sha('old'):'missing',after:sha('new'+i)}));
 rows.forEach((r,i)=>write(r.p,'new'+i));write(rows[0].dest,'old');write(rows[2].dest,'new2');write(w+'/marker','');execFileSync('tar',['-cf',w+'/payload.tar',...rows.map(r=>r.p)],{cwd:dir});const arc=fs.readFileSync(path.join(dir,w,'payload.tar'));
 const script=transaction(rows,id,sha(arc));const shell=process.platform==='win32'?path.join(process.env.ProgramFiles,'Git','bin','bash.exe'):'/bin/sh';
 const run=(m,ok=true)=>{const r=spawnSync(shell,['-s','--',m],{cwd:dir,input:script,encoding:'utf8'});assert.equal(r.status===0,ok,`${r.status}: ${r.stdout} ${r.stderr}`);};
 write(rows[1].dest,'private');run('apply',false);assert.equal(read(rows[0].dest),'old');fs.unlinkSync(path.join(dir,rows[1].dest));run('check');run('apply');run('apply');assert.equal(read(w+'/old-0'),'old');assert.equal(read(rows[0].dest),'new0');assert.equal(read(rows[1].dest),'new1');
 write(rows[1].dest,'device edit');run('rollback',false);assert.equal(read(rows[0].dest),'new0');write(rows[1].dest,'new1');run('rollback');run('rollback');assert.equal(read(rows[0].dest),'old');assert.equal(read(rows[2].dest),'new2');assert.equal(fs.existsSync(path.join(dir,rows[1].dest)),false);
 write(w+'/payload.tar','tampered');run('apply',false);
});
