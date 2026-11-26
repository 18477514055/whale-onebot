import {bounded} from './limits.mjs';
import {encodeMinimal} from './packet.mjs';
import {resultOf} from './model.mjs';
export {createConfiguredModelAnalyzer} from './model.mjs';
export {createFfmpegExtractor} from './ffmpeg.mjs';

// Optional standalone path. The plugin can instead pass {frames,audio} directly to analyze.
export async function understandWork({extract, analyze, signal, publicOnly=false, work, timeoutMs=15000,maxUnits}) {
  const no=reason=>({understood:false,reason});
  if(!work || (publicOnly && work.visibility!=='public'))return no('NOT_PUBLIC');
  if(typeof work.work_id!=='string'||!work.work_id.length||typeof extract!=='function'||typeof analyze!=='function')return no('MEDIA_UNAVAILABLE');
  try{return await bounded(signal,timeoutMs,async sig=>{
    const clip=await extract(work,{signal:sig}); sig.throwIfAborted();
    if(clip?.work_id!==work.work_id)return no('INSUFFICIENT_AV');
    encodeMinimal(clip); // Validate before crossing even an injected analyzer boundary.
    const {ms,width,height,rgb24}=clip.frames[0], {rate,pcm16le}=clip.audio;
    const answer=await analyze({frames:[{ms,width,height,rgb24}],audio:{rate,pcm16le}},{signal:sig,maxUnits});sig.throwIfAborted();
    const result=resultOf(answer);return result.understood?{...result,summary:result.visualEvidence+'；'+result.audioEvidence}:no('MODEL_UNCERTAIN');
  });}catch(e){return no(['INSUFFICIENT_AV','NOT_AUTHORIZED','TIMEOUT','CANCELLED'].includes(e?.reason)?e.reason:'MEDIA_UNAVAILABLE');}
}
