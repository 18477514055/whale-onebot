import {spawn} from 'node:child_process';
import {open,constants,realpath} from 'node:fs/promises';
import path from 'node:path';
import {bounded, refuse} from './limits.mjs';
import {makePacket, WIDTH, HEIGHT, AUDIO_RATE, AUDIO_SECONDS} from './packet.mjs';

const local = p => typeof p === 'string' && path.isAbsolute(p) && !/^[/\\]{2}/.test(p) && !p.includes('\0');
function decode(exe, fd, args, exact, signal) {
  signal.throwIfAborted();
  return new Promise((resolve,reject) => {
    // Fixed demuxer, no path/network protocols or external data references. Open descriptor only.
    const child = spawn(exe, ['-nostdin','-hide_banner','-loglevel','error','-xerror','-max_alloc','67108864','-threads','1','-filter_threads','1','-protocol_whitelist','fd','-format_whitelist','mov','-f','mov','-enable_drefs','0','-use_absolute_path','0','-max_pixels','16777216','-ss','1','-i','fd:', ...args,'pipe:1'], {
      windowsHide:true,shell:false,stdio:[fd,'pipe','pipe'],env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}
    });
    let n=0, bad=false; const out=Buffer.alloc(exact);
    const kill=()=>{child.kill('SIGKILL')};
    signal.addEventListener('abort',kill,{once:true});
    child.stdout.on('data', b=>{if(n+b.length>exact){bad=true;kill();}else{b.copy(out,n);n+=b.length;}});
    child.stderr.on('data',()=>{bad=true;}); // Consume all error-level stderr without exposing file/metadata.
    child.once('error',()=>{bad=true;});
    child.once('close',code=>{signal.removeEventListener('abort',kill); if(code!==0||bad||n!==exact||signal.aborted){out.fill(0);reject(refuse('INSUFFICIENT_AV'));}else resolve(out);});
  });
}

// Trusted callback maps an opaque work identity to a private, immutable, authorized local file.
// A URL, arbitrary path from a caller, symlink or non-regular file is not an authorization.
export function createFfmpegExtractor({ffmpegPath,resolveAuthorizedFile,timeoutMs=10000}) {
  if(!local(ffmpegPath)||typeof resolveAuthorizedFile!=='function') throw refuse('MEDIA_UNAVAILABLE');
  return async(work,{signal}={})=>bounded(signal,timeoutMs,async sig=>{
    let a,b,frame,pcm;
    try {
      const p=await resolveAuthorizedFile(work,{signal:sig}); sig.throwIfAborted();
      if(!local(p)||typeof work?.work_id!=='string'||!work.work_id.length||work.work_id.length>128) throw refuse('NOT_AUTHORIZED');
      const canonical=await realpath(p); if(!local(canonical)||path.relative(p,canonical)!=='') throw refuse('NOT_AUTHORIZED');
      const flags=constants.O_RDONLY | (constants.O_NOFOLLOW||0) | (constants.O_NONBLOCK||0);
      a=await open(p,flags); b=await open(p,flags);
      const s=await a.stat({bigint:true}), t=await b.stat({bigint:true});
      if(!s.isFile() || !t.isFile() || s.size<1n || s.size>256n*1024n*1024n || s.dev!==t.dev || s.ino!==t.ino) throw refuse('INSUFFICIENT_AV');
      frame=await decode(ffmpegPath,a.fd,['-map','0:V:0','-an','-sn','-dn','-map_metadata','-1','-vf',`scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2`,'-frames:v','1','-pix_fmt','rgb24','-threads','1','-f','rawvideo'],WIDTH*HEIGHT*3,sig);
      pcm=await decode(ffmpegPath,b.fd,['-map','0:a:0','-vn','-sn','-dn','-map_metadata','-1','-af',`aresample=${AUDIO_RATE},atrim=end_sample=${AUDIO_SECONDS*AUDIO_RATE},asetpts=N/SR/TB`,'-ac','1','-ar',String(AUDIO_RATE),'-c:a','pcm_s16le','-f','s16le'],AUDIO_SECONDS*AUDIO_RATE*2,sig);
      return makePacket(frame,pcm,work.work_id);
    } catch(e){throw refuse(e?.reason==='NOT_AUTHORIZED'?'NOT_AUTHORIZED':'INSUFFICIENT_AV');}
    finally{await Promise.allSettled([a?.close(),b?.close()]);frame?.fill(0);pcm?.fill(0);}
  });
}
