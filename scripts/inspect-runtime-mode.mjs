import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Read-only Electron wire-format inspection; no option writes or target launch.
// Format: https://github.com/electron/fuses/blob/main/src/constants.ts
// and getCurrentFuseWire in src/index.ts. Only RunAsNode is interpreted here.
const marker=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
export function inspectRuntimeMode(bytes){
 const offset=bytes.indexOf(marker);
 if(offset<0||bytes.indexOf(marker,offset+1)!==-1)throw Error('No unique Electron fuse wire');
 const header=offset+marker.length;
 if(header+2>bytes.length)throw Error('Truncated wire header');
 const version=bytes[header],length=bytes[header+1],start=header+2;
 if(version!==1||length<1||start+length>bytes.length)throw Error('Unsupported or truncated wire');
 const states=bytes.subarray(start,start+length);
 if([...states].some(n=>![0x30,0x31,0x72,0x90].includes(n)))throw Error('Unknown wire state');
 const state=states[0];
 return {offset,version,length,runAsNodeByte:state,runAsNode:state===0x31?'enabled':state===0x30?'disabled':'unknown'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert.equal(process.argv.length,2,'No arbitrary target paths');
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const target=path.join(root,'.tools/qq-linux-inspection/dependencies/files/opt/QQ/qq');
 assert(fs.realpathSync(target).startsWith(fs.realpathSync(root)+path.sep));
 // Positive/negative format controls do not execute any native code.
 const fixture=Buffer.concat([marker,Buffer.from([1,1,0x31])]);
 assert.equal(inspectRuntimeMode(fixture).runAsNode,'enabled');
 assert.throws(()=>inspectRuntimeMode(fixture.subarray(0,-1)));
 assert.throws(()=>inspectRuntimeMode(Buffer.concat([fixture,fixture])));
 const bytes=fs.readFileSync(target);
 assert.equal(bytes.length,204344328,'Unexpected official sample size');
 assert.equal(bytes.subarray(0,4).toString('hex'),'7f454c46');
 const report={at:new Date().toISOString(),target:path.relative(root,target).replaceAll('\\','/'),bytes:bytes.length,
 sha256:createHash('sha256').update(bytes).digest('hex'),...inspectRuntimeMode(bytes),
 method:'Static wire-format read of official downloaded ELF; source opened read-only',
 limits:['Configured feature only; no runtime mode tested','No feature flag or binary bytes changed','No QQ launched or account files read','Customized application behavior remains unverified even if feature bit is enabled']};
 fs.writeFileSync(path.join(root,'evidence/electron-runtime-mode-linux.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
