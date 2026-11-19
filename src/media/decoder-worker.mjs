// Fixed isolated decoder. Receives bytes, never paths/URLs; no QQ code is loaded.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const digest=b=>createHash('sha256').update(b).digest('hex');
const answer=value=>process.stdout.write(JSON.stringify(value)+'\n');
let failure='INVALID_IMAGE';
try {
  if(process.argv.length!==3)throw Error();
  const limits=JSON.parse(process.argv[2]);
  for(const key of ['maxInputBytes','maxPixels','maxFrames','maxTotalPixels','timeoutMs'])if(!Number.isSafeInteger(limits[key])||limits[key]<1)throw Error();
  if(limits.maxInputBytes>64*1024*1024||limits.maxPixels>16*1024*1024||limits.maxTotalPixels>16*1024*1024||limits.maxFrames>256||limits.timeoutMs>60000)throw Error();
  let size=0;const parts=[];
  for await(const part of process.stdin){size+=part.length;if(size>limits.maxInputBytes){failure='INPUT_LIMIT';throw Error();}parts.push(part);}
  const input=Buffer.concat(parts);parts.length=0;
  let expected;
  if(input.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))){
    expected='png';
    for(let offset=8;offset+12<=input.length;){const length=input.readUInt32BE(offset);if(length>input.length-offset-12)break;if(input.toString('ascii',offset+4,offset+8)==='acTL'){failure='UNSUPPORTED_FORMAT';throw Error();}offset+=length+12;}
  }else if(input.length>=3&&input[0]===255&&input[1]===216&&input[2]===255)expected='jpeg';
  else if(['GIF87a','GIF89a'].includes(input.toString('ascii',0,6)))expected='gif';
  else if(input.toString('ascii',0,4)==='RIFF'&&input.toString('ascii',8,12)==='WEBP')expected='webp';
  else{failure='UNSUPPORTED_FORMAT';throw Error();}
  let sharp;
  try{sharp=createRequire(import.meta.url)('sharp');if(sharp.versions.sharp!=='0.35.5')throw Error();}catch{failure='DECODER_UNAVAILABLE';throw Error();}
  sharp.cache(false);sharp.concurrency(1);
  const image=sharp(input,{animated:true,failOn:'warning',limitInputPixels:limits.maxTotalPixels,limitInputChannels:5,unlimited:false});
  const metadata=await image.metadata();
  if(metadata.format!==expected)throw Error();
  const frames=metadata.pages??1,width=metadata.width,height=metadata.pageHeight??metadata.height;
  const pixels=width*height,totalPixels=pixels*frames;
  if(![width,height,frames].every(v=>Number.isSafeInteger(v)&&v>0))throw Error();
  if(frames>limits.maxFrames||pixels>limits.maxPixels||totalPixels>limits.maxTotalPixels){failure='PIXEL_OR_FRAME_LIMIT';throw Error();}
  // metadata() alone never establishes decoding. Materialize all reported frames
  // as canonical RGBA pixels, with no resize/rotation or partial-region shortcut.
  const {data,info}=await image.toColourspace('srgb').ensureAlpha().raw({depth:'uchar'})
    .timeout({seconds:Math.max(1,Math.ceil(limits.timeoutMs/1000))}).toBuffer({resolveWithObject:true});
  if(info.width!==width||info.height!==height*frames||info.channels!==4||data.length!==totalPixels*4)throw Error();
  answer({ok:true,result:{format:expected,width,height,frames,orientation:Number.isInteger(metadata.orientation)?metadata.orientation:1,
    hasAlpha:metadata.hasAlpha===true,bytes:input.length,sha256:digest(input),decoded:true,validation:'full-decode',
    decodedBytes:data.length,decodedPixelsSha256:digest(data),decoderVersion:sharp.versions.sharp,libvipsVersion:sharp.versions.vips}});
}catch{answer({ok:false,code:failure});process.exitCode=2;}
