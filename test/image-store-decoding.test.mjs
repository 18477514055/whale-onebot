import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ImageStore} from '../src/media/image-store.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const encoded=spawnSync(process.execPath,['-e',`
const sharp=require('sharp');(async()=>{const raw=Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);const out={};
out.jpeg=(await sharp(raw,{raw:{width:2,height:2,channels:4}}).jpeg().toBuffer()).toString('base64');
out.other=(await sharp(Buffer.alloc(16,128),{raw:{width:2,height:2,channels:4}}).jpeg().toBuffer()).toString('base64');
for(const f of ['gif','webp'])out[f]=(await sharp(Buffer.concat([raw,Buffer.alloc(16,128)]),{raw:{width:2,height:4,channels:4,pageHeight:2}}).toFormat(f,{delay:[100,200],loop:0,lossless:true}).toBuffer()).toString('base64');
process.stdout.write(JSON.stringify(out));})().catch(()=>process.exit(2));`],{cwd:project,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:65536});
assert.equal(encoded.status,0,'Actual original fixture encoding required');
const fixtures=Object.fromEntries(Object.entries(JSON.parse(encoded.stdout)).map(([key,value])=>[key,Buffer.from(value,'base64')]));
function fixture(t,maxBytes){
 const tmp=path.join(project,'.tmp');fs.mkdirSync(tmp,{recursive:true});const parent=fs.mkdtempSync(path.join(tmp,'image-store-decoding-')),root=path.join(parent,'qq-onebot');fs.mkdirSync(root);
 t.after(()=>{const real=fs.realpathSync(parent);assert.equal(path.dirname(real),fs.realpathSync(tmp));fs.rmSync(real,{recursive:true,force:true});});
 return {root,store:new ImageStore({projectRoot:root,...(maxBytes?{maxBytes}:{})})};
}
test('JPEG and animated GIF/WebP stage real original bytes with format-derived filenames and cross-instance full inspection',async t=>{
 const {root,store}=fixture(t);
 for(const format of ['jpeg','gif','webp']){
  const bytes=fixtures[format],asset=await store.stage(bytes,{filename:'misleading.png'});
  assert.equal(asset.format,format);assert.equal(asset.frames,format==='jpeg'?1:2);assert.equal(asset.width,2);assert.equal(asset.height,2);
  assert.equal(asset.validation,'full-decode');assert.equal(asset.decoded,true);assert.equal(asset.sha256,sha(bytes));
  assert(asset.fileName.endsWith(format==='jpeg'?'.jpg':'.'+format));
  const fresh=new ImageStore({projectRoot:root});assert.deepEqual(await fresh.inspect(asset.token),asset);
  assert.deepEqual(fs.readFileSync(await fresh.resolve(asset.token)),bytes);
 }
});
test('caller mutation during asynchronous JPEG decode cannot change staged snapshot',async t=>{
 const {store}=fixture(t),input=Buffer.from(fixtures.jpeg);const pending=store.stage(input);input.fill(0);const asset=await pending;
 assert.equal(asset.sha256,sha(fixtures.jpeg));assert.deepEqual(fs.readFileSync(store.assetPath(asset.token)),fixtures.jpeg);
});
test('inspect and resolve reject files replaced while the isolated decoder is pending',async t=>{
 const {store}=fixture(t),asset=await store.stage(fixtures.jpeg),file=store.assetPath(asset.token);
 for(const operation of ['inspect','resolve']){
  fs.writeFileSync(file,fixtures.jpeg);const pending=store[operation](asset.token);
  // Calls synchronously snapshot the original bytes, then await real worker decode.
  fs.writeFileSync(file,fixtures.other);
  await assert.rejects(pending,{code:'ASSET_CHANGED'});
 }
});
test('64 MiB existing store configuration passes through decoder limits without widening defaults',async t=>{
 const {store}=fixture(t,64*1024*1024);assert.equal((await store.stage(fixtures.jpeg)).decoded,true);
 const {store:normal}=fixture(t);assert.equal(normal.maxBytes,10*1024*1024);
});
