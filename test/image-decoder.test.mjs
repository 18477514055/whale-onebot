import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {ImageDecoder} from '../src/media/image-decoder.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Original deterministic RGB(A) pixels, encoded by a separate fixture process.
// No image data is downloaded or read from any existing account/workspace data.
const generation=spawnSync(process.execPath,['-e',`
const sharp=require('sharp');
(async()=>{const results={};const raw=Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
for(const format of ['png','jpeg','webp','gif'])results[format]=(await sharp(raw,{raw:{width:2,height:2,channels:4}}).toFormat(format,format==='webp'?{lossless:true}:{}).toBuffer()).toString('base64');
const animation=Buffer.concat([raw,Buffer.from(raw).fill(128)]);
for(const format of ['gif','webp'])results['animated_'+format]=(await sharp(animation,{raw:{width:2,height:4,channels:4,pageHeight:2}}).toFormat(format,{loop:0,delay:[100,200],lossless:true}).toBuffer()).toString('base64');
results.raw=raw.toString('base64');results.animation=animation.toString('base64');process.stdout.write(JSON.stringify(results));})().catch(()=>process.exit(2));
`],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:65536});
assert.equal(generation.status,0,'Original fixture encoder must actually run on this platform');
const fixtures=Object.fromEntries(Object.entries(JSON.parse(generation.stdout)).map(([k,v])=>[k,Buffer.from(v,'base64')]));
test('real PNG JPEG WebP GIF full pixel decodes preserve source bytes and expose only bounded metadata',async()=>{
 const decoder=new ImageDecoder();
 for(const format of ['png','jpeg','webp','gif']){
  const bytes=fixtures[format],snapshot=Buffer.from(bytes),r=await decoder.decode(bytes);
  assert.equal(r.format,format);assert.equal(r.width,2);assert.equal(r.height,2);assert.equal(r.frames,1);
  assert.equal(r.sha256,sha(bytes));assert.equal(r.bytes,bytes.length);assert.equal(r.decoded,true);assert.equal(r.validation,'full-decode');assert.equal(r.decodedBytes,16);assert.equal(r.decoderVersion,'0.35.5');
  if(format!=='jpeg')assert.equal(r.decodedPixelsSha256,sha(fixtures.raw));
  assert.deepEqual(bytes,snapshot);assert.equal('exif' in r,false);assert.equal('path' in r,false);
 }
 assert.equal(decoder.activeCount,0);
});
test('animated GIF and WebP decode every frame instead of reporting a first-frame success',async()=>{
 const decoder=new ImageDecoder();
 for(const format of ['gif','webp']){
  const r=await decoder.decode(fixtures['animated_'+format]);assert.equal(r.frames,2);assert.equal(r.width,2);assert.equal(r.height,2);assert.equal(r.decodedBytes,32);
  // GIF is palette/one-bit alpha and can quantize the original second frame.
  if(format==='webp')assert.equal(r.decodedPixelsSha256,sha(fixtures.animation));
 }
});
test('truncated compressed inputs are rejected and SVG never enters a supported decoder',async()=>{
 const decoder=new ImageDecoder();
 for(const name of ['png','jpeg','webp','gif'])await assert.rejects(decoder.decode(fixtures[name].subarray(0,Math.floor(fixtures[name].length*0.7))));
 await assert.rejects(decoder.decode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),{code:'UNSUPPORTED_FORMAT'});
});
test('valid metadata alone cannot approve a PNG with broken compressed pixel data',async()=>{
 const corrupt=Buffer.from(fixtures.png);let offset=8;
 while(offset+12<=corrupt.length){const length=corrupt.readUInt32BE(offset);if(corrupt.toString('ascii',offset+4,offset+8)==='IDAT'){
   corrupt[offset+8]=0;corrupt[offset+9]=0;
   let crc=0xffffffff;for(const byte of corrupt.subarray(offset+4,offset+8+length)){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
   corrupt.writeUInt32BE((crc^0xffffffff)>>>0,offset+8+length);break;
 }offset+=length+12;}
 const metadataOnly=spawnSync(process.execPath,['-e',"const sharp=require('sharp');const parts=[];process.stdin.on('data',x=>parts.push(x));process.stdin.on('end',async()=>{try{const m=await sharp(Buffer.concat(parts)).metadata();console.log(JSON.stringify({width:m.width,height:m.height}));}catch{process.exitCode=2;}});"],{cwd:root,input:corrupt,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:8192});
 assert.equal(metadataOnly.status,0);assert.deepEqual(JSON.parse(metadataOnly.stdout),{width:2,height:2});
 await assert.rejects(new ImageDecoder().decode(corrupt),{code:'INVALID_IMAGE'});
});
test('input pixels total animated pixels and frame bounds reject before success',async()=>{
 await assert.rejects(new ImageDecoder({maxInputBytes:10}).decode(fixtures.png),{code:'INPUT_LIMIT'});
 await assert.rejects(new ImageDecoder({maxPixels:3}).decode(fixtures.png),{code:'PIXEL_OR_FRAME_LIMIT'});
 await assert.rejects(new ImageDecoder({maxFrames:1}).decode(fixtures.animated_gif),{code:'PIXEL_OR_FRAME_LIMIT'});
 await assert.rejects(new ImageDecoder({maxTotalPixels:7}).decode(fixtures.animated_gif));
});
test('bytes snapshot rejects shared or disguised inputs and ignores caller mutations after admission',async()=>{
 const decoder=new ImageDecoder(),bytes=Buffer.from(fixtures.png),operation=decoder.decode(bytes);bytes.fill(0);assert.equal((await operation).sha256,sha(fixtures.png));
 const shared=new SharedArrayBuffer(128);Object.setPrototypeOf(shared,ArrayBuffer.prototype);
 await assert.rejects(decoder.decode(new Uint8Array(shared)),{code:'INVALID_INPUT'});
 for(const value of ['file.png','https://example.invalid/x',Object.create(Uint8Array.prototype)])await assert.rejects(decoder.decode(value),{code:'INVALID_INPUT'});
 const oversized=new Uint8Array(1024);Object.defineProperty(oversized,'byteLength',{value:1});await assert.rejects(new ImageDecoder({maxInputBytes:128}).decode(oversized),{code:'INPUT_LIMIT'});
});
test('concurrency is bounded, cancellation waits for child closure, and later independent decode succeeds',async()=>{
 const decoder=new ImageDecoder({maxConcurrent:1}),abort=new AbortController();
 const pending=decoder.decode(fixtures.png,{signal:abort.signal});assert.equal(decoder.activeCount,1);
 await assert.rejects(decoder.decode(fixtures.png),{code:'BUSY'});abort.abort();
 await assert.rejects(pending,{code:'CANCELLED'});assert.equal(decoder.activeCount,0);
 assert.equal((await decoder.decode(fixtures.png)).decoded,true);
 const pre=new AbortController();pre.abort();await assert.rejects(decoder.decode(fixtures.png,{signal:pre.signal}),{code:'CANCELLED'});assert.equal(decoder.activeCount,0);
});
test('wall deadline terminates worker and removes only its own temporary directory',async t=>{
 const mkdtemp=t.mock.method(fs,'mkdtempSync');
 const decoder=new ImageDecoder({timeoutMs:1});await assert.rejects(decoder.decode(fixtures.png),{code:'TIMEOUT'});assert.equal(decoder.activeCount,0);
 assert.equal(mkdtemp.mock.callCount(),1);
 const directory=mkdtemp.mock.calls[0].result;
 assert.match(directory,/[/\\]image-decoder-[^/\\]+$/);
 assert.equal(fs.existsSync(directory),false);
});
test('invalid limits cannot remove resource bounds',()=>{
 for(const options of [{maxConcurrent:0},{maxConcurrent:9},{maxFrames:257},{maxTotalPixels:Infinity},{timeoutMs:0},{maxInputBytes:65*1024*1024}])assert.throws(()=>new ImageDecoder(options),{code:'INVALID_LIMIT'});
});
