import {deflateSync,crc32} from 'node:zlib';
import {PCM_BYTES,packWav,refuse} from './limits.mjs';
export const WIDTH=96,HEIGHT=96,AUDIO_RATE=16000,AUDIO_SECONDS=2;
const no = () => {throw refuse('INSUFFICIENT_AV')};
function decode(str,bytes) {
  if(typeof str!=='string'||str.length!==Math.ceil(bytes/3)*4) no();
  const buf=Buffer.from(str,'base64'); if(buf.length!==bytes||buf.toString('base64')!==str) no(); return buf;
}
function audible(pcm){let power=0;for(let i=0;i<pcm.length;i+=2)power+=pcm.readInt16LE(i)**2;return power/(pcm.length/2)>=32**2;}
export function makePacket(frame,pcm,work_id){
  if(frame.length!==WIDTH*HEIGHT*3 || pcm.length!==PCM_BYTES || !audible(pcm)) no();
  return {work_id,frames:[{ms:1000,width:WIDTH,height:HEIGHT,rgb24:frame.toString('base64')}],audio:{rate:AUDIO_RATE,pcm16le:pcm.toString('base64')}};
}
function chunk(name,data){const s=Buffer.alloc(12+data.length);s.writeUInt32BE(data.length);s.write(name,4);data.copy(s,8);s.writeUInt32BE(crc32(s.subarray(4,-4)),s.length-4);return s;}
// Rebuild PNG/WAV from raw samples: never forward ancillary chunks, EXIF, names, paths or packet keys.
export function encodeMinimal({frames,audio}={}) {
  if(!Array.isArray(frames)||frames.length<1||frames.length>4||audio?.rate!==AUDIO_RATE) no();
  const {ms,width:w,height:h,rgb24}=frames[0]??{};
  if(!Number.isInteger(ms)||ms<0||ms>10000||![w,h].every(x=>Number.isInteger(x)&&x>=1&&x<=160)) no();
  const rgb=decode(rgb24,w*h*3),pcm=decode(audio.pcm16le,PCM_BYTES);
  if(!audible(pcm)) no();
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
  const stride=w*3, rows=Buffer.alloc(h*(stride+1));for(let y=0;y<h;y++) rgb.copy(rows,y*(stride+1)+1,y*stride,(y+1)*stride);
  return {png:Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ih),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]),wav:packWav(pcm)};
}
