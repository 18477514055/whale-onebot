// Static GNU relocation/disassembly inspection. No dlopen, ldd, QQ execution,
// environment changes, stubs, or modification of the prior ABI evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const project=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const root=path.join(project,'.tools','qq-linux-inspection');
const out=path.join(root,'relocations');fs.mkdirSync(out,{recursive:true});
if(fs.realpathSync(out)!==out)throw new Error('Output must be physical');
const evidenceFiles=['native-abi-linux.json','native-dependencies-linux.json'];
const inputHashes=Object.fromEntries(evidenceFiles.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(project,'evidence',name))).digest('hex')]));
const abi=JSON.parse(fs.readFileSync(path.join(project,'evidence',evidenceFiles[0]),'utf8'));
const dependencies=JSON.parse(fs.readFileSync(path.join(project,'evidence',evidenceFiles[1]),'utf8'));
const wrapper=path.join(root,'wrapper.node');
const linux=value=>process.platform==='linux'?value:`/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\','/')}`;
async function hash(filename){const h=crypto.createHash('sha256');for await(const data of fs.createReadStream(filename))h.update(data);return h.digest('hex');}
if(await hash(wrapper)!==abi.wrapper.sha256)throw new Error('Wrapper identity changed');
const commands=[];
function invocation(program,args){return process.platform==='win32'?['wsl.exe',['-d','Debian','--','env','LC_ALL=C',program,...args]]:[program,args];}
function run(program,args,name){
  const [exe,argv]=invocation(program,args);const r=spawnSync(exe,argv,{encoding:'utf8',maxBuffer:128*1024*1024,timeout:240000,env:{...process.env,LC_ALL:'C'}});
  commands.push({program:exe,args:argv,status:r.status,stderr:r.stderr,raw:name??null});
  if(r.error||r.status!==0)throw new Error(`Static tool failed: ${program}; ${r.status}; ${r.stderr}`);
  if(name)fs.writeFileSync(path.join(out,name),r.stdout);return r.stdout;
}
const dynamic=run('readelf',['--dynamic',linux(wrapper)],'dynamic.txt');
const sectionsRaw=run('readelf',['--section-headers','--wide',linux(wrapper)],'sections.txt');
const segmentsRaw=run('readelf',['--program-headers','--wide',linux(wrapper)],'segments.txt');
const relocationRaw=run('readelf',['--relocs','--wide',linux(wrapper)],'relocations.txt');
const pltRaw=run('objdump',['--disassemble','--section=.plt','--no-show-raw-insn',linux(wrapper)],'plt.txt');
const sections=[];
for(const line of sectionsRaw.split('\n')){const m=line.match(/^\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)/i);if(m)sections.push({index:Number(m[1]),name:m[2],type:m[3],address:parseInt(m[4],16),offset:parseInt(m[5],16),bytes:parseInt(m[6],16)});}
const sectionAt=address=>sections.find(s=>address>=s.address&&address<s.address+s.bytes&&s.type!=='NOBITS');
const location=address=>{const section=sectionAt(address);return{linkedAddress:'0x'+address.toString(16),section:section?.name??null,fileOffset:section?address-section.address+section.offset:null};};
const relro=[];for(const line of segmentsRaw.split('\n')){const m=line.match(/^\s*GNU_RELRO\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)/i);if(m)relro.push({address:Number(BigInt(m[2])),bytes:Number(BigInt(m[5]))});}
const names=dependencies.originalHostWifiphoto.symbols.map(s=>s.name);
if(names.length!==12||new Set(names).size!==12)throw new Error('Expected fixed 12-symbol scope');
const namesSet=new Set(names),tables=[],relocations=[];let table;
for(const line of relocationRaw.split('\n')){
  const header=line.match(/^Relocation section '([^']+)' at offset (0x[0-9a-f]+) contains (\d+) entries:/i);
  if(header){table={name:header[1],offset:header[2],declared:Number(header[3]),parsed:0};tables.push(table);continue;}
  if(!/^\s*[0-9a-f]{16}\s+[0-9a-f]{16}\s+R_/i.test(line))continue;
  if(!table)throw new Error('Relocation outside declared table');table.parsed++;
  const f=line.trim().split(/\s+/);if(!namesSet.has(f[4]))continue;
  const address=parseInt(f[0],16);relocations.push({symbol:f[4],table:table.name,type:f[2],info:f[1],symbolIndex:Number(BigInt('0x'+f[1])>>32n),target:location(address),withinGnuRelro:relro.some(r=>address>=r.address&&address<r.address+r.bytes),raw:line});
}
if(tables.length===0||tables.some(t=>t.declared!==t.parsed))throw new Error('GNU relocation output incomplete');
const records=names.map(name=>({name,symbol:abi.comparison.undefinedSymbols.find(s=>s.name===name),relocations:relocations.filter(r=>r.symbol===name),plt:null,references:[]}));
for(const record of records){
  const lines=pltRaw.split('\n');const i=lines.findIndex(line=>line.endsWith(`<${record.name}@plt>:`));
  if(i<0)throw new Error('PLT label missing for target');
  const address=parseInt(lines[i].split(' ')[0],16);record.plt={...location(address),instructions:lines.slice(i+1,i+4)};
  for(const relocation of record.relocations){
    if(relocation.target.fileOffset===null)throw new Error('Unmapped relocation target');
    const fd=fs.openSync(wrapper,'r'),word=Buffer.alloc(8);try{if(fs.readSync(fd,word,0,8,relocation.target.fileOffset)!==8)throw new Error('Short GOT read');}finally{fs.closeSync(fd);}
    relocation.initialWordHex=word.toString('hex');relocation.initialWordValue='0x'+word.readBigUInt64LE().toString(16);
    relocation.initialWordPointsToPltPush=word.readBigUInt64LE()===BigInt(address+6);
  }
}
// Stream complete GNU disassembly; retain only exact target references and a
// digest of the full stream. This is linear disassembly, not CFG reachability.
const [exe,argv]=invocation('objdump',['--disassemble','--no-show-raw-insn',linux(wrapper)]);
const child=spawn(exe,argv,{stdio:['ignore','pipe','pipe'],env:{...process.env,LC_ALL:'C'}});
let stderr='',bytes=0,lines=0,currentSection=null;const outputHash=crypto.createHash('sha256');
child.stdout.on('data',chunk=>{bytes+=chunk.length;outputHash.update(chunk);});
child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>1024*1024)child.kill();});
const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
const timer=setTimeout(()=>child.kill(),240000);
try{
  for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
    lines++;const section=line.match(/^Disassembly of section (.+):$/);if(section){currentSection=section[1];continue;}
    if(!line.includes('wifiphoto'))continue;
    const instruction=line.match(/^\s*([0-9a-f]+):\s+(.+)$/i);if(!instruction)continue;
    for(const record of records){if(!line.includes(`<${record.name}@plt>`)&&!line.includes(`<${record.name}@Base>`))continue;const decoded=instruction[2];record.references.push({...location(parseInt(instruction[1],16)),disassembledSection:currentSection,kind:/^(?:call|jmp)q?\s+[0-9a-f]+\s+/.test(decoded)?'direct-branch-to-plt':'other-symbol-reference',instruction:decoded});if(record.references.length>10000)throw new Error('Reference retention limit exceeded');}
  }
}finally{clearTimeout(timer);}
const result=await completed;commands.push({program:exe,args:argv,status:result.code,signal:result.signal,stderr,streamBytes:bytes,streamLines:lines,streamSha256:outputHash.digest('hex'),raw:'filtered-reference-lines.json'});
if(result.code!==0)throw new Error('Complete disassembly did not finish successfully');
fs.writeFileSync(path.join(out,'filtered-reference-lines.json'),JSON.stringify(records.map(r=>({name:r.name,references:r.references})),null,2)+'\n');
for(let i=0;i<records.length;i++){const site=records[i].references.find(r=>r.kind==='direct-branch-to-plt'&&r.disassembledSection!=='.plt');if(site)run('objdump',['--disassemble','--start-address='+site.linkedAddress,'--stop-address=0x'+(Number(BigInt(site.linkedAddress))+32).toString(16),linux(wrapper)],`reference-${i}.txt`);}
const types=[];
for(const excluded of dependencies.packageProviderSearch.excludedCandidates){
  const filename=path.join(root,'dependencies','files',...excluded.member.slice(2).split('/'));
  const b=fs.readFileSync(filename);const entry={member:excluded.member,bytes:b.length,sha256:await hash(filename),first64Bytes:b.subarray(0,64).toString('hex')};
  if(b.subarray(0,2).toString()==='MZ'){
    const text=run('objdump',['--file-headers',linux(filename)],path.basename(filename)+'.format.txt');entry.gnuFormat=text.match(/file format (\S+)/)?.[1]??null;
  }else if(b.readUInt32BE(0)===0xcafebabe){
    // A bounded reading of this exact two-slice Apple fat header, not an ELF
    // decoder or general-purpose Mach-O analysis implementation.
    const count=b.readUInt32BE(4);if(count!==2)throw new Error('Unexpected fat header count');entry.format='Apple fat Mach-O';entry.slices=[];
    for(let i=0;i<count;i++){const p=8+i*20,cpu=b.readUInt32BE(p),offset=b.readUInt32BE(p+8),size=b.readUInt32BE(p+12);if(offset+size>b.length||offset<48||b.readUInt32LE(offset)!==0xfeedfacf||b.readUInt32LE(offset+4)!==cpu)throw new Error('Fat slice does not match a bounded Mach-O64 header');entry.slices.push({cpuType:'0x'+cpu.toString(16),architecture:cpu===0x01000007?'x86-64':cpu===0x0100000c?'arm64':'unknown',offset,bytes:size,machHeaderMagic:'0xfeedfacf',machFileType:b.readUInt32LE(offset+12)});}
  }else entry.format='unknown';types.push(entry);
}
const eagerFlags=dynamic.split('\n').filter(line=>/\(BIND_NOW\)|\(FLAGS\).*\bBIND_NOW\b|\(FLAGS_1\).*\bNOW\b/.test(line));
const report={schema:1,observedAt:new Date().toISOString(),mode:'static-only-no-target-execution',inputEvidenceSha256:inputHashes,wrapperSha256:abi.wrapper.sha256,relocationTables:tables,gnuRelro:relro,eagerDynamicFlagLines:eagerFlags,records,nonElfTypes:types,commands,interpretation:{allTwelveOnlyJumpSlot:records.every(r=>r.relocations.length===1&&r.relocations[0].type==='R_X86_64_JUMP_SLOT'&&r.relocations[0].table==='.rela.plt'),dynamicObjectRequestsImmediateBinding:eagerFlags.length>0,underLazyBinding:'These function relocation slots may be deferred until used; not proof of successful dlopen or constructor safety.',underNowBinding:'All twelve require providers before dlopen returns if RTLD_NOW or LD_BIND_NOW applies.',constructorReachability:'unknown; INIT and INIT_ARRAY are present and no transitive startup call graph was proved.',noRuntimeConclusion:true},primaryReferences:['https://man7.org/linux/man-pages/man3/dlopen.3.html','https://nodejs.org/download/release/v24.20.0/docs/api/process.html#processdlopenmodule-filename-flags','https://github.com/apple-oss-distributions/xnu/blob/main/EXTERNAL_HEADERS/mach-o/fat.h','https://github.com/apple-oss-distributions/xnu/blob/main/EXTERNAL_HEADERS/mach-o/loader.h'],limitations:['No target or target code was executed.','Complete GNU disassembly is a linear sweep, not a verified control-flow graph; references do not prove execution or reachability.','Direct symbolic branches are retained; register-indirect calls and transitive paths are not reconstructed.','Unresolved references can fail under lazy binding when called, including during constructors before dlopen returns.','Missing DT_NEEDED files and non-PLT/data relocations are not excused by lazy PLT binding.','Fat Mach-O inspection covers only the exact bounded two-slice header and inner Mach-O64 magic/CPU/filetype, not exports.']};
report.rawEvidenceSha256={};for(const name of fs.readdirSync(out))if(fs.statSync(path.join(out,name)).isFile())report.rawEvidenceSha256[name]=await hash(path.join(out,name));
for(const name of evidenceFiles)if(await hash(path.join(project,'evidence',name))!==inputHashes[name])throw new Error('Prior evidence changed during analysis');
fs.writeFileSync(path.join(project,'evidence','native-relocations-linux.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({relocationTables:tables,eagerFlags,targets:records.map(r=>({name:r.name,types:r.relocations.map(x=>x.type),plt:r.plt.linkedAddress,directReferences:r.references.filter(x=>x.kind==='direct-branch-to-plt'&&x.disassembledSection!=='.plt').map(x=>x.linkedAddress)})),nonElfTypes:types},null,2));
