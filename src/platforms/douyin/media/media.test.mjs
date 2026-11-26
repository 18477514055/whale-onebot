import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createConfiguredModelAnalyzer,createFfmpegExtractor,understandWork} from './understand.mjs';
import {makePacket} from './packet.mjs';
const exe=process.env.TEST_FFMPEG, good={understood:true,visualEvidence:'画面有红色区域',audioEvidence:'可听到连续音调',comment:null};
const work={work_id:'private-id',visibility:'public',secret:'synthetic-private-marker'};
const clip=()=>makePacket(Buffer.alloc(96*96*3,99),Buffer.alloc(64000,33),work.work_id);
const fake=(fn,opts={})=>createConfiguredModelAnalyzer({client:{chat:{completions:{create:fn}}},model:'synthetic-av',inputUnitsUpperBound:1000,...opts});
test('protocol packet -> model: one newly encoded PNG + canonical WAV, no metadata/credentials',async()=>{
  let calls=0;const analyze=fake(async (req,opts)=>{calls++;assert.equal(opts.maxRetries,0);assert.equal(req.store,false);assert.equal(req.max_completion_tokens,100);assert(!JSON.stringify(req).includes(work.work_id));assert(!JSON.stringify(req).includes(work.secret));const [im,au]=req.messages[1].content;assert.equal(Buffer.from(im.image_url.url.split(',')[1],'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(Buffer.from(au.input_audio.data,'base64').length,64044);return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(good)}}]};});
  assert.equal((await understandWork({work,extract:async()=>({...clip(),secret:work.secret}),analyze,maxUnits:1100})).understood,true);
  assert.equal((await analyze(clip(),{maxUnits:1001})).understood,false);assert.equal(calls,1);
});
test('missing audio/identity/visual evidence, deadline and cancellation fail closed',async()=>{
 const run=(extract,analyze=async()=>good,more={})=>understandWork({work,extract,analyze,...more});
 assert.equal((await run(async()=>({...clip(),audio:null}))).understood,false);assert.equal((await run(async()=>({...clip(),work_id:'other'}))).understood,false);
 assert.equal((await run(clip,async()=>({...good,visualEvidence:''}))).understood,false);
 assert.equal((await run(()=>new Promise(()=>{}),undefined,{timeoutMs:25})).reason,'TIMEOUT');
 assert.equal((await run(clip,undefined,{signal:AbortSignal.abort()})).reason,'CANCELLED');
});
test('model aborts in flight; transport errors and sensitive model output are not relayed',async()=>{
 const ctl=new AbortController();let started;const ready=new Promise(r=>started=r);
 const hanging=fake((_req,{signal})=>{started(signal);return new Promise(()=>{});});
 const result=hanging(clip(),{maxUnits:1300,signal:ctl.signal});const inner=await ready;ctl.abort();assert.equal((await result).reason,'CANCELLED');assert(inner.aborted);
 const failed=await fake(()=>{throw Error('synthetic-private-marker')})(clip(),{maxUnits:1300});assert(!JSON.stringify(failed).includes('synthetic-private-marker'));
 const invalid=await fake(()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...good,comment:'https://private.invalid/test'})}}]}))(clip(),{maxUnits:1300});assert.equal(invalid.understood,false);
});
test('real decoder: local synthetic MP4 -> red pixels/440Hz PCM; rejects silent/missing grant', {skip:!exe&&'set TEST_FFMPEG to a trusted absolute executable'},async()=>{
 const root=fileURLToPath(new URL('.',import.meta.url)),d=await mkdtemp(path.join(root,'fixture-'));const file=path.join(d,'test.mp4');
 try{const gen=(audio)=>execFileSync(exe,['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',"color=red:s=96x96:r=12:d=4,drawbox=color=blue:t=fill:enable='lt(t,1)'",'-f','lavfi','-i',audio,'-t','4','-c:v','mpeg4','-c:a','aac','-metadata','title=synthetic-private-marker',file]);
 gen('sine=frequency=440:duration=3,adelay=1000');const extract=createFfmpegExtractor({ffmpegPath:exe,resolveAuthorizedFile:(w)=>w===work?file:null});const p=await extract(work);assert.equal(p.work_id,work.work_id);const rgb=Buffer.from(p.frames[0].rgb24,'base64');assert(rgb[0]>230&&rgb[1]<10&&rgb[2]<10);
 const pcm=Buffer.from(p.audio.pcm16le,'base64');assert.equal(pcm.length,64000);let peaks=0;for(let i=2;i<pcm.length;i+=2)if(pcm.readInt16LE(i)>0&&pcm.readInt16LE(i-2)<=0)peaks++;assert(Math.abs(peaks-880)<8);
 await assert.rejects(extract({}),{reason:'NOT_AUTHORIZED'});gen('anullsrc=r=16000:cl=mono');await assert.rejects(extract(work),{reason:'INSUFFICIENT_AV'});
 }finally{if(path.dirname(d)!==path.resolve(root)||!path.basename(d).startsWith('fixture-')) throw Error('unsafe cleanup');await rm(d,{recursive:true,force:true});}
});
