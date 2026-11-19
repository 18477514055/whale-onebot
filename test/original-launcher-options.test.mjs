import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('../scripts/integrated-preflight-linux.mjs',import.meta.url));
const root=fileURLToPath(new URL('../',import.meta.url));
for (const [name,args,reason] of [
  ['original normal mode cannot silently accept a calibration expiry',['--login','--original-agent','--hold-hours','1','--split-onebot-ports'],'Original normal mode is resident'],
  ['original mode and historical single-group trial cannot be combined',['--login','--original-agent','--phone-agent','--split-onebot-ports'],'Choose original normal mode or historical trial'],
  ['original mode cannot run a preflight as a login',['--preflight','--original-agent'],'Original Agent requires preparation or login'],
  ['duplicate original flags fail before filesystem or credential loading',['--login','--original-agent','--original-agent'],'Original normal mode is resident'],
]) test(name,()=>{
  const result=spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});
  assert.equal(result.status,1);assert.match(result.stderr,new RegExp(reason));assert.equal(result.stdout,'');
});
