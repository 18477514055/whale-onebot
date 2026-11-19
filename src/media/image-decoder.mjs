// Parent imports no image/native library. Each job owns a fresh bounded worker.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const worker=fileURLToPath(new URL('./decoder-worker.mjs',import.meta.url));
const typed=Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic=(name,object)=>Object.getOwnPropertyDescriptor(typed,name).get.call(object);
const arrayBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
export class ImageDecoderError extends Error {
  constructor(code){super('Image decoding did not complete: '+code);this.name='ImageDecoderError';this.code=code;}
}
function fail(code){throw new ImageDecoderError(code);}
function physicalDirectory(directory){
  const absolute=path.resolve(directory);let current=path.parse(absolute).root;
  for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const s=fs.lstatSync(current);
    if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(current)!==current)fail('UNSAFE_PATH');
  }
}
export class ImageDecoder {
  #limits;#active=0;
  constructor({maxInputBytes=10*1024*1024,maxPixels=16*1024*1024,maxFrames=100,maxTotalPixels=16*1024*1024,timeoutMs=10000,maxConcurrent=2}={}){
    const limits={maxInputBytes,maxPixels,maxFrames,maxTotalPixels,timeoutMs,maxConcurrent};
    const maxima={maxInputBytes:64*1024*1024,maxPixels:16*1024*1024,maxFrames:256,maxTotalPixels:16*1024*1024,timeoutMs:60000,maxConcurrent:8};
    for(const [key,value]of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1||value>maxima[key])fail('INVALID_LIMIT');
    this.#limits=Object.freeze(limits);
  }
  get activeCount(){return this.#active;}
  async decode(input,{signal}={}){
    if(signal!==undefined&&(!(signal instanceof AbortSignal)))fail('INVALID_SIGNAL');
    if(signal?.aborted)fail('CANCELLED');
    if(this.#active>=this.#limits.maxConcurrent)fail('BUSY');
    let source;
    try{
      if(!(input instanceof Uint8Array))fail('INVALID_INPUT');
      const buffer=intrinsic('buffer',input),length=intrinsic('byteLength',input),offset=intrinsic('byteOffset',input);
      arrayBufferLength.call(buffer); // Reject actual shared memory despite prototype changes.
      if(length<1||length>this.#limits.maxInputBytes)fail('INPUT_LIMIT');
      source=Buffer.from(new Uint8Array(buffer,offset,length));
    }catch(e){if(e instanceof ImageDecoderError)throw e;fail('INVALID_INPUT');}
    physicalDirectory(root);const temporary=path.join(root,'.tmp');
    try{fs.mkdirSync(temporary);}catch(e){if(e.code!=='EEXIST')throw e;}physicalDirectory(temporary);
    const directory=fs.mkdtempSync(path.join(temporary,'image-decoder-'));physicalDirectory(directory);
    const expectedHash=createHash('sha256').update(source).digest('hex');
    this.#active++;
    try{
      return await new Promise((resolve,reject)=>{
        const env={HOME:directory,TMPDIR:directory,TEMP:directory,TMP:directory,XDG_CACHE_HOME:directory,XDG_CONFIG_HOME:directory,
          SHARP_IGNORE_GLOBAL_LIBVIPS:'1',UV_THREADPOOL_SIZE:'1',LANG:'C',LC_ALL:'C'};
        if(process.platform==='win32'){env.SystemRoot=process.env.SystemRoot??'C:\\Windows';env.WINDIR=env.SystemRoot;env.PATH=path.join(env.SystemRoot,'System32');}
        else env.PATH='/usr/bin:/bin';
        const child=spawn(process.execPath,['--max-old-space-size=128',worker,JSON.stringify(this.#limits)],{cwd:directory,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let cause=null,stdout='',outputBytes=0,errorBytes=0;
        const terminate=code=>{cause??=code;child.kill('SIGKILL');};
        const abort=()=>terminate('CANCELLED');
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        const timer=setTimeout(()=>terminate('TIMEOUT'),this.#limits.timeoutMs);
        child.on('error',()=>{cause??='WORKER_FAILED';});
        child.stdin.on('error',()=>{}); // Worker may reject or be cancelled before input drains.
        child.stdout.on('data',part=>{outputBytes+=part.length;if(outputBytes>8192)terminate('WORKER_OUTPUT_LIMIT');else stdout+=part.toString('utf8');});
        child.stderr.on('data',part=>{errorBytes+=part.length;if(errorBytes>32768)terminate('WORKER_OUTPUT_LIMIT');});
        child.on('close',(status,exitSignal)=>{
          clearTimeout(timer);signal?.removeEventListener('abort',abort);
          if(cause){reject(new ImageDecoderError(cause));return;}
          try{
            const reply=JSON.parse(stdout);
            if(reply.ok===false&&status===2&&['INVALID_IMAGE','INPUT_LIMIT','UNSUPPORTED_FORMAT','DECODER_UNAVAILABLE','PIXEL_OR_FRAME_LIMIT'].includes(reply.code))fail(reply.code);
            const r=reply.result;
            if(status!==0||exitSignal||reply.ok!==true||!r||r.sha256!==expectedHash||r.bytes!==source.length||r.decoded!==true||r.validation!=='full-decode'||r.decoderVersion!=='0.35.5')fail('WORKER_FAILED');
            if(!['png','jpeg','gif','webp'].includes(r.format)||![r.width,r.height,r.frames].every(v=>Number.isSafeInteger(v)&&v>0)||r.frames>this.#limits.maxFrames||r.width*r.height>this.#limits.maxPixels||r.width*r.height*r.frames>this.#limits.maxTotalPixels||r.decodedBytes!==r.width*r.height*r.frames*4||!/^[a-f0-9]{64}$/.test(r.decodedPixelsSha256))fail('WORKER_FAILED');
            resolve(Object.freeze(r));
          }catch(e){reject(e instanceof ImageDecoderError?e:new ImageDecoderError('WORKER_FAILED'));}
        });
        child.stdin.end(source);
      });
    }finally{
      this.#active--;
      // Only our mkdtemp directory, after process close; no recursive outside path.
      if(fs.existsSync(directory)&&fs.realpathSync(directory)===directory&&path.dirname(directory)===temporary){try{fs.rmSync(directory,{recursive:true,force:true});}catch{}}
    }
  }
}
