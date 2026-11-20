// Pure static GNU-tool dependency inspection; never runs package/native code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const arm64 = process.argv[2] === '--arm64';
const supplemental = arm64 && process.argv[4] === '--supplemental';
if (process.argv.length !== (supplemental ? 5 : arm64 ? 4 : 2))
  throw new Error('Usage: inspect-linux-dependencies.mjs [--arm64 <local archive> [--supplemental]]');
const toolsRoot = path.join(project, '.tools');
const armAbi = arm64 ? JSON.parse(fs.readFileSync(path.join(project, 'evidence', 'native-abi-linux-arm64.json'), 'utf8')) : null;
const root = arm64 ? path.resolve(project, armAbi.rawEvidenceDirectory) : path.join(toolsRoot, 'qq-linux-inspection');
if (arm64 && (path.dirname(root) !== toolsRoot || !/^qq-linux-arm64-inspection-[A-Za-z0-9]+$/.test(path.basename(root))))
  throw new Error('Unexpected ARM64 inspection directory');
const elfMachine = arm64 ? /Machine:\s+AArch64/ : /Machine:\s+Advanced Micro Devices X86-64/;
const out = path.join(root, 'dependencies');
const files = path.join(out, 'files');
for (const directory of [root, out, files]) {
  fs.mkdirSync(directory, { recursive: true });
  if (fs.realpathSync(directory) !== directory) throw new Error('Analysis directories must be physical');
}
const commands = [];
const toLinux = value => process.platform === 'linux' ? value : `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\','/')}`;
function run(program, args, destination, allowFailure=false) {
  const executable = process.platform === 'win32' ? 'wsl.exe' : program;
  const actualArgs = process.platform === 'win32' ? ['-d','Debian','--','env','LC_ALL=C',program,...args] : args;
  const record = { program: executable, args: actualArgs, stdoutFile: destination ? path.relative(project,destination).replaceAll('\\','/') : null };
  commands.push(record);
  let fd, result;
  if (destination) {
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Linked output rejected');
    fd = fs.openSync(destination,'w');
  }
  try { result = spawnSync(executable, actualArgs, { encoding:'utf8', stdio:fd===undefined?'pipe':['ignore',fd,'pipe'],maxBuffer:128*1024*1024,timeout:240000,env:{...process.env,LC_ALL:'C'} }); }
  finally { if(fd!==undefined)fs.closeSync(fd); }
  record.status=result.status; record.stderr=result.stderr;
  if(result.error || (result.status!==0&&!allowFailure))throw new Error(`Static ${program} failed: ${result.status}; ${String(result.stderr).slice(0,500)}`);
  return allowFailure?{status:result.status,stdout:result.stdout,stderr:result.stderr}:result.stdout;
}
async function hash(file) { const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex'); }
const archive=arm64?path.resolve(process.argv[3]):path.join(root,'QQ_3.2.35_261103_amd64_01.deb');
if (arm64 && (path.dirname(path.dirname(archive)) !== toolsRoot || !/^qq-linux-arm64-[a-f0-9]{32}$/.test(path.basename(path.dirname(archive))) ||
    path.basename(archive) !== 'qq-arm64-complete.deb' || fs.realpathSync(archive) !== archive)) throw new Error('Expected a local ARM64 archive');
const expected=arm64?'5f93ea62347dd772c7be4115413c95d2a60d189f3dd81bc194834bd4d7343cf2':'7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac';
if(fs.statSync(archive).size!==(arm64?208717176:188287504) || await hash(archive)!==expected)throw new Error('Package identity mismatch');
if (arm64 && (armAbi.archive.sha256 !== expected || await hash(path.join(root,'wrapper.node')) !== armAbi.wrapper.sha256 ||
    await hash(path.join(root,'package-listing.txt')) !== armAbi.rawEvidenceSha256['package-listing.txt'])) throw new Error('ARM64 ABI evidence mismatch');
const listing=fs.readFileSync(path.join(root,'package-listing.txt'),'utf8').split('\n');
// Exhaustive bounded provider search across the package's .so/.so.N/.node
// inventory; this does not treat these optional objects as already loaded.
const selected=['./opt/QQ/qq',...listing.map(line=>line.match(/\s(\.\/opt\/QQ\/\S+\.(?:so(?:\.[^/\s]+)?|node))$/)?.[1]).filter(Boolean).filter(member=>member!=='./opt/QQ/resources/app/wrapper.node')];
for(const member of selected){const rows=listing.filter(line=>line.endsWith(' '+member));if(rows.length!==1||rows[0][0]!=='-'||member.includes('..'))throw new Error('Extraction member is not a unique regular file');}
// Restrict all destination ancestors before tar creates only the selected files.
for(const member of selected){
  const relative=member.slice(2), target=path.join(files,...relative.split('/'));
  let current=files;
  for(const part of relative.split('/').slice(0,-1)){current=path.join(current,part);fs.mkdirSync(current,{recursive:true});if(fs.realpathSync(current)!==current)throw new Error('Linked extraction ancestor');}
  if(fs.existsSync(target)&&!fs.lstatSync(target).isFile())throw new Error('Non-regular extraction target');
}
const dataArchive=path.join(out,'data.tar.xz');
const priorPath=path.join(project,'evidence',supplemental?'native-dependencies-linux-arm64-supplemental.json':arm64?'native-dependencies-linux-arm64.json':'native-dependencies-linux.json');
const prior=fs.existsSync(priorPath)?JSON.parse(fs.readFileSync(priorPath,'utf8')):null;
const extractionRecordPath=path.join(out,'extracted-members.json');
const priorExtraction=fs.existsSync(extractionRecordPath)?JSON.parse(fs.readFileSync(extractionRecordPath,'utf8')):null;
const extraction=[];
for(const member of selected){const target=path.join(files,...member.slice(2).split('/'));const old=(prior?.archiveSha256===expected?prior.modules.find(m=>m.path===toLinux(target)):null)??(priorExtraction?.archiveSha256===expected?priorExtraction.members.find(m=>m.member===member):null);if(!old||!fs.existsSync(target)||await hash(target)!==old.sha256)extraction.push(member);}
if(extraction.length){
  run('ar',['p',toLinux(archive),'data.tar.xz'],dataArchive);
  run('tar',['--extract','--xz','--no-same-owner','--no-same-permissions','--no-overwrite-dir','--file='+toLinux(dataArchive),'--directory='+toLinux(files),'--',...extraction]);
  fs.unlinkSync(dataArchive);
}
const extractedMembers=[];for(const member of selected)extractedMembers.push({member,sha256:await hash(path.join(files,...member.slice(2).split('/')))});
fs.writeFileSync(extractionRecordPath,JSON.stringify({archiveSha256:expected,members:extractedMembers},null,2)+'\n');
const cacheEntries=new Map();
const systemSource = arm64 ? 'arm64-sysroot' : 'ldconfig-cache';
const sysrootLib = path.join(toolsRoot,'arm64-linux-sysroot','usr','aarch64-linux-gnu','lib');
if (arm64) {
  if (fs.realpathSync(sysrootLib) !== sysrootLib) throw new Error('Expected physical ARM64 library directory');
  for (const name of fs.readdirSync(sysrootLib).sort()) {
    if (!/^(?:lib|ld-)[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)*$/.test(name)) continue;
    const file = fs.realpathSync(path.join(sysrootLib,name));
    if (path.dirname(file) !== sysrootLib || !fs.statSync(file).isFile()) throw new Error('ARM64 library escapes sysroot');
    cacheEntries.set(name,[toLinux(file)]);
  }
  if (supplemental) {
    const manifest = JSON.parse(fs.readFileSync(path.join(project,'evidence','linux-arm64-runtime-libraries.json'),'utf8'));
    const overlay = path.resolve(project,manifest.overlay);
    if (!/^libraries-[a-zA-Z0-9]+$/.test(path.basename(path.dirname(overlay))) || path.basename(overlay) !== 'lib' ||
        path.dirname(path.dirname(overlay)) !== path.join(toolsRoot,'debian-arm64-runtime') || fs.realpathSync(overlay) !== overlay ||
        manifest.architecture !== 'arm64') throw new Error('Unexpected ARM64 overlay');
    const expected = new Set();
    for (const item of manifest.acquisitions.flatMap(record => record.staged)) {
      if (!/^lib[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)+$/.test(item.name) || expected.has(item.name) || cacheEntries.has(item.name))
        throw new Error('Invalid or conflicting ARM64 overlay name');
      const file = path.join(overlay,item.name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== item.bytes || await hash(file) !== item.sha256)
        throw new Error('ARM64 overlay file differs from manifest');
      expected.add(item.name);
      cacheEntries.set(item.name,[toLinux(file)]);
    }
    if (fs.readdirSync(overlay).some(name=>!expected.has(name))) throw new Error('Unexpected ARM64 overlay file');
  }
} else {
  const cache=run('/sbin/ldconfig',['-p']);
  fs.writeFileSync(path.join(out,'ldconfig-cache.txt'),cache);
  for(const line of cache.split('\n')){const match=line.match(/^\s*(\S+)\s+\(([^)]+)\)\s+=>\s+(\S+)/);if(match&&match[2].includes('x86-64')){const list=cacheEntries.get(match[1])??[];list.push(match[3]);cacheEntries.set(match[1],list);}}
}
const packageFiles=new Map(selected.map(member=>[toLinux(path.join(files,...member.slice(2).split('/'))),member]));
const modules=new Map();
function inspect(filename,kind,originOverride){
  const canonical=run('readlink',['-f',filename]).trim();
  if(modules.has(canonical))return modules.get(canonical);
  const id=`module-${String(modules.size).padStart(2,'0')}`;
  const raw=run('readelf',['--file-header','--dynamic','--dyn-syms','--version-info','--wide',canonical]);
  if(!/Class:\s+ELF64/.test(raw)||!elfMachine.test(raw))throw new Error('Unexpected target architecture');
  const rawPath=path.join(out,id+'.readelf.txt');fs.writeFileSync(rawPath,raw);
  const declared=Number(raw.match(/Symbol table '\.dynsym' contains (\d+) entries:/)?.[1]);
  // GNU readelf may render a type as "<OS specific>: 10" (three tokens).
  // Anchor binding/visibility columns instead of assuming a fixed token count.
  const symbols=raw.split('\n').map(line=>line.match(/^\s*(\d+):\s+([0-9a-fA-F]+)\s+(\S+)\s+(.+?)\s+(GLOBAL|LOCAL|WEAK|UNIQUE|<OS specific>:\s+\d+)\s+(DEFAULT|INTERNAL|HIDDEN|PROTECTED)\s+(\S+)(?:\s+(\S+))?/)).filter(Boolean).map(f=>({index:Number(f[1]),type:f[4],binding:f[5],visibility:f[6],section:f[7],name:f[8]??'',baseName:(f[8]??'').split('@')[0]}));
  if(!declared||symbols.length!==declared)throw new Error('Dynamic symbol output incomplete');
  const needed=[...raw.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(m=>m[1]);
  const paths=[...raw.matchAll(/\((RUNPATH|RPATH)\).*?\[([^\]]+)\]/g)].map(m=>({tag:m[1],value:m[2]}));
  const soname=raw.match(/\(SONAME\).*?\[([^\]]+)\]/)?.[1]??null;
  const versionNeeds=[];const versionDefinitions=[];let section='',need;
  for(const line of raw.split('\n')){
    if(line.startsWith('Version needs section'))section='needs';
    else if(line.startsWith('Version definition section'))section='definitions';
    else if(line.startsWith('Version symbols section'))section='symbols';
    if(section==='needs'){
      const file=line.match(/File:\s+(\S+)\s+Cnt:/);if(file){need={file:file[1],versions:[]};versionNeeds.push(need);}
      const name=line.match(/Name:\s+(\S+)\s+Flags:/);if(name&&need)need.versions.push(name[1]);
    }else if(section==='definitions'){const name=line.match(/Name:\s+(\S+)/);if(name)versionDefinitions.push(name[1]);}
  }
  const m={id,path:canonical,kind,origin:originOverride??path.posix.dirname(canonical),sha256:run('sha256sum',[canonical]).split(/\s+/)[0],soname,needed,paths,versionNeeds,versionDefinitions,symbolCount:symbols.length,symbols,edges:[],rawEvidence:path.relative(project,rawPath).replaceAll('\\','/')};modules.set(canonical,m);return m;
}
const node=inspect(toLinux(path.join(toolsRoot,`node-v24.20.0-linux-${arm64?'arm64':'x64'}`,'bin','node')),'node');
const appOrigin=toLinux(path.join(files,'opt','QQ','resources','app'));
const wrapper=inspect(toLinux(path.join(root,'wrapper.node')),'wrapper',appOrigin);
const reachable=new Set([node.path,wrapper.path]);const queue=[node,wrapper];const missing=[];const resolverLimitations=[];
for(let index=0;index<queue.length;index++){
  const source=queue[index];
  if(source.paths.some(x=>x.tag==='RPATH'))resolverLimitations.push(`${source.id}: RPATH inheritance is not modeled`);
  for(const name of source.needed){
    const candidates=[];
    for(const entry of source.paths.filter(x=>x.tag==='RUNPATH'||!source.paths.some(y=>y.tag==='RUNPATH'))){
      for(const dir of entry.value.split(':')){
        const expanded=dir.replaceAll('${ORIGIN}',source.origin).replaceAll('$ORIGIN',source.origin);
        if(!expanded.startsWith('/')||expanded.includes('$')){resolverLimitations.push(`${source.id}: unsupported search component ${dir}`);continue;}
        const candidate=path.posix.normalize(path.posix.join(expanded,name));
        // Only explicitly extracted package files can resolve via package RUNPATH.
        if(packageFiles.has(candidate))candidates.push({path:candidate,via:entry.tag});
      }
    }
    for(const candidate of cacheEntries.get(name)??[])candidates.push({path:candidate,via:systemSource});
    const chosen=candidates[0];
    if(!chosen){const edge={name,resolved:null,candidates:[]};source.edges.push(edge);missing.push({consumer:source.id,name});continue;}
    if(chosen.via==='ldconfig-cache'&&!/^\/(?:usr\/)?lib(?:64)?\//.test(chosen.path))throw new Error('Unexpected system library path');
    const target=inspect(chosen.path,chosen.via===systemSource?'system':'package');
    source.edges.push({name,resolved:target.id,via:chosen.via,candidates});
    if(!reachable.has(target.path)){reachable.add(target.path);queue.push(target);}
  }
}
const globalExports=new Map();
for(const m of queue){for(const symbol of m.symbols){if(symbol.section==='UND'||!symbol.name||!['GLOBAL','WEAK','UNIQUE'].includes(symbol.binding)||!['DEFAULT','PROTECTED'].includes(symbol.visibility))continue;const list=globalExports.get(symbol.baseName)??[];list.push({module:m.id,name:symbol.name,type:symbol.type});globalExports.set(symbol.baseName,list);}}
function compatible(required,provided){const version=required.includes('@')?required.split('@').pop():null;return version?provided.split('@').pop()===version:!provided.includes('@')||provided.includes('@@');}
const comparisons=[];const versionChecks=[];
for(const m of queue){
  const results=m.symbols.filter(s=>s.section==='UND'&&s.name).map(s=>{const candidates=globalExports.get(s.baseName)??[];return{...s,providers:candidates.filter(p=>compatible(s.name,p.name)),versionMismatchedCandidates:candidates.filter(p=>!compatible(s.name,p.name))};});
  comparisons.push({module:m.id,undefinedCount:results.length,matched:results.filter(s=>s.providers.length).length,unresolvedStrong:results.filter(s=>!s.providers.length&&s.binding!=='WEAK'),unresolvedWeak:results.filter(s=>!s.providers.length&&s.binding==='WEAK')});
  for(const requirement of m.versionNeeds){const edge=m.edges.find(e=>e.name===requirement.file);const provider=queue.find(x=>x.id===edge?.resolved);versionChecks.push({consumer:m.id,file:requirement.file,provider:provider?.id??null,required:requirement.versions,missing:provider?requirement.versions.filter(v=>!provider.versionDefinitions.includes(v)):requirement.versions,status:provider?(requirement.versions.every(v=>provider.versionDefinitions.includes(v))?'matched':'version-missing'):'library-missing'});}
}
let supplementalSymbolCandidates;
if (supplemental) {
  const requested = new Map(comparisons.flatMap(m=>m.unresolvedStrong.map(symbol=>[symbol.name,symbol.baseName])));
  const providers = new Map();
  const wanted = new Set(requested.values());
  const overlayPaths = new Set([...cacheEntries.values()].flat().filter(file=>file.includes('/debian-arm64-runtime/')));
  for (const file of overlayPaths) {
    const module = inspect(file,'supplemental-provider-reference');
    for (const symbol of module.symbols) {
      if (!wanted.has(symbol.baseName) || symbol.section==='UND' || !['GLOBAL','WEAK','UNIQUE'].includes(symbol.binding) ||
          !['DEFAULT','PROTECTED'].includes(symbol.visibility)) continue;
      const list = providers.get(symbol.baseName)??[];
      list.push({ module:module.id, file:path.posix.basename(module.path), name:symbol.name });
      providers.set(symbol.baseName,list);
    }
  }
  const symbols = [...requested].map(([name,baseName])=>({name,providers:(providers.get(baseName)??[])
    .filter(candidate=>compatible(name,candidate.name))}));
  supplementalSymbolCandidates = { required: symbols.length, available: symbols.filter(item=>item.providers.length>0).length,
    addedToReachableScope: false, symbols };
}
// A separately inspected QQ executable is evidence of a possible original host
// provider. It is deliberately NOT added to the independent Node host scope.
const qq=inspect(toLinux(path.join(files,'opt','QQ','qq')),'qq-host-reference');
const major=inspect(toLinux(path.join(files,'opt','QQ','resources','app','major.node')),'major-module-reference');
const nt=wrapper.symbols.filter(s=>s.section==='UND'&&/^_ZNK?2nt9wifiphoto/.test(s.name));
const exportsFor=(m,s)=>m.symbols.filter(p=>p.baseName===s.baseName&&p.section!=='UND'&&p.binding!=='LOCAL'&&['DEFAULT','PROTECTED'].includes(p.visibility)).map(p=>({name:p.name,type:p.type,binding:p.binding,section:p.section,bindingSemanticsKnown:['GLOBAL','WEAK','UNIQUE'].includes(p.binding)}));
const ntProviders=nt.map(s=>({name:s.name,binding:s.binding,qqExports:exportsFor(qq,s),majorExports:exportsFor(major,s)}));
const providerCandidates=[], excludedCandidates=[];
for(const member of selected){
  const filename=toLinux(path.join(files,...member.slice(2).split('/')));
  const header=run('readelf',['--file-header',filename],undefined,true);
  const format=header.stdout;
  if(header.status!==0||!/Class:\s+ELF64/.test(format)||!elfMachine.test(format)){excludedCandidates.push({member,status:header.status,header:format,stderr:header.stderr});continue;}
  const candidate=inspect(filename,'package-provider-reference');
  providerCandidates.push({member,module:candidate.id,format});
}
const packageProviders=nt.map(s=>({name:s.name,providers:providerCandidates.flatMap(c=>{const m=[...modules.values()].find(x=>x.id===c.module);return exportsFor(m,s).map(symbol=>({module:m.id,member:c.member,...symbol}));})}));
const gnutlsCache=cacheEntries.get('libgnutls.so.30')??[];
const report={schema:1,observedAt:new Date().toISOString(),mode:'static-only-no-target-execution',archiveSha256:expected,roots:[node.id,wrapper.id],resolutionPolicy:'Per-object package RUNPATH/RPATH candidates then current x86-64 ldconfig cache; no LD_LIBRARY_PATH or preloads; no execution. Version-matched global export union reports availability, not runtime binding order.',coverage:{neededClosureComplete:missing.length===0&&resolverLimitations.length===0,missingNeeded:missing,inspectedReachableModules:queue.length,resolverLimitations,allStrongUndefinedMatched:comparisons.every(x=>x.unresolvedStrong.length===0),allVersionNeedsMatched:versionChecks.every(x=>x.status==='matched')},modules:[...modules.values()].map(({symbols,...m})=>({...m,undefinedCount:symbols.filter(s=>s.section==='UND'&&s.name).length})),comparisons,versionChecks,originalHostWifiphoto:{qq:qq.id,requiredCount:nt.length,providedByQq:ntProviders.filter(s=>s.qqExports.length).length,symbols:ntProviders,addedToIndependentNodeScope:false},externalObservationChecks:{gnutlsSoname:'libgnutls.so.30',ldconfigCandidates:gnutlsCache,status:gnutlsCache.length?'present-in-cache-not-loaded':'absent-from-current-cache',reason:'Upstream reports a libbugly dynamic dependency; DT_NEEDED alone does not establish it.'},tools:{readelf:run('readelf',['--version']).split('\n')[0],tar:run('tar',['--version']).split('\n')[0]},commands,limitations:['No QQ, wrapper, dynamic loader, ldd or maintainer script executed.','Missing cache entries are scoped to this WSL snapshot, not a statement about every Linux system.','Absent package RUNPATH candidate means not in the explicitly extracted candidate set; broader package contents remain separately inventoried.','Global union matching does not prove ELF lookup order, interposition, IFUNC execution, relocation or C++ ABI semantics.','Dynamic dlopen/dlsym dependencies are not a complete DT_NEEDED closure.','QQ executable export matches do not supply these symbols to the independent Node process.']};
report.originalHostWifiphoto.major=major.id;
report.originalHostWifiphoto.providedByMajor=ntProviders.filter(s=>s.majorExports.length).length;
report.packageProviderSearch={scope:'All regular .so/.so.N/.node members under opt/QQ plus QQ main ELF, excluding wrapper already inspected as root',candidates:providerCandidates,excludedCandidates,requiredCount:nt.length,providedCount:packageProviders.filter(s=>s.providers.length).length,symbols:packageProviders,optionalCandidatesAddedToIndependentNodeScope:false};
const rawHashes={};for(const name of fs.readdirSync(out).filter(n=>n.endsWith('.txt')))rawHashes[name]=await hash(path.join(out,name));report.rawEvidenceSha256=rawHashes;
if (arm64) {
  report.architecture = 'arm64';
  report.supplementalLibraries = supplemental;
  if (supplemental) report.supplementalSymbolCandidates = supplementalSymbolCandidates;
  report.resolutionPolicy = `Per-object package RUNPATH/RPATH then the local Debian AArch64 sysroot${supplemental ? ' and verified library overlay' : ''}; no host ldconfig cache or preloads. Static version-matched provider union only.`;
  report.limitations[1] = 'Missing libraries are scoped to the supplied AArch64 libraries.';
  report.externalObservationChecks.gnutlsCacheScope = 'local AArch64 sysroot';
  report.externalObservationChecks.status = gnutlsCache.length ? 'present-in-sysroot-not-loaded' : 'absent-from-sysroot';
}
fs.writeFileSync(priorPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({coverage:report.coverage,wifiphoto:report.originalHostWifiphoto,gnutls:report.externalObservationChecks,summary:comparisons.map(m=>({module:m.module,undefined:m.undefinedCount,matched:m.matched,missingStrong:m.unresolvedStrong.length,missingWeak:m.unresolvedWeak.length}))},null,2));
