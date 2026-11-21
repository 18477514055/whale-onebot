import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionHeartbeat} from '../android/bili-protocol-host.mjs';
for(const result of ['verified','reauth_required','disconnected','throws','abort'])test(`account heartbeat: ${result}`,async()=>{
 const ac=new AbortController(),events=[];let release,checks=0;
 const tick=sessionHeartbeat({signal:ac.signal,report:()=>events.push('report'),yieldSession:s=>events.push(s),check:async()=>{checks++;await new Promise(r=>release=r);if(result==='throws')throw Error();return result;}});
 for(let i=0;i<11;i++)await tick();const pending=tick();await tick();assert.equal(checks,1);assert.equal(events.length,11);
 if(result==='abort')ac.abort();release();await pending;await tick();
 assert.deepEqual(events.slice(11),result==='verified'?['report','report']:result==='abort'?[]:[result==='reauth_required'?result:'session_unconfirmed']);
});
