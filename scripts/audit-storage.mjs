// Read-only storage audit. Sole writes: a NEW evidence/storage-audit-*.json.
// Never follows symlinks/junctions; never reads business data, credentials or keys.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
if(process.platform==='linux'&&process.argv.includes('--probe-process-references')) {
  assert.equal(root,'/mnt/d/qq-onebot');
  const records=[],failures=[];
  const projectPaths=text=>[...new Set([...text.matchAll(/(?:\/mnt\/d|D:)\/(?:qq-onebot)\/[^\s\x00"']*/gi)].map(m=>m[0].replaceAll(/\\040/g,' ').replaceAll(/\\134/g,'\\')))];
  const workPaths=text=>[...new Set([...text.matchAll(/(?:\/mnt\/d\/qq-onebot|\/qq-onebot)\/\.tmp\/integrated-inputs-[A-Za-z0-9]+/g)].map(m=>m[0].replace(/^\/qq-onebot\//,'/mnt/d/qq-onebot/')))];
  for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))) {
    const base='/proc/'+name;let args;
    try{args=fs.readFileSync(base+'/cmdline','utf8').split('\0').filter(Boolean);}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')failures.push({pid:Number(name),field:'exact-driver-classification',code:e.code});continue;}
    if(!args.length)continue;
    const launcher=args.some(v=>v==='/mnt/d/qq-onebot/scripts/integrated-preflight-linux.mjs'||v==='scripts/integrated-preflight-linux.mjs');
    const nodeExe=/(?:^|\/)node$/.test(args[0]);
    const driver=nodeExe&&args[1]==='/input/driver.mjs';
    const bwrap=/(?:^|\/)bwrap$/.test(args[0]);
    const app=nodeExe&&args.includes('/input/agent-app/src/server.js');
    let cwd=null;try{cwd=fs.readlinkSync(base+'/cwd');}catch{}
    const argumentPaths=projectPaths(args.join('\0'));
    const isProject=argumentPaths.length>0||(cwd?.startsWith(root));
    if(!(launcher||driver||app||(bwrap&&isProject)||cwd?.includes('/.tmp/integrated-inputs-')))continue;
    let mounts='',fdPaths=[],inspectionComplete=true;
    try{mounts=fs.readFileSync(base+'/mountinfo','utf8');}catch(e){inspectionComplete=false;failures.push({pid:Number(name),field:'mountinfo',code:e.code});}
    try{for(const fd of fs.readdirSync(base+'/fd')){try{const v=fs.readlinkSync(base+'/fd/'+fd);if(v.includes('/.tmp/integrated-inputs-'))fdPaths.push(v);}catch{}}}catch(e){inspectionComplete=false;failures.push({pid:Number(name),field:'project-open-file-paths',code:e.code});}
    const refs=workPaths([args.join('\0'),cwd??'',mounts,fdPaths.join('\n')].join('\n'));
    records.push({pid:Number(name),roles:{launcher,driver,bwrap,app},cwdProjectPath:cwd?.startsWith(root)||cwd?.startsWith('/qq-onebot')?cwd:null,projectArgumentWorkPaths:[...new Set(argumentPaths.flatMap(workPaths))],workReferences:refs,projectOpenFilePaths:fdPaths,inspectionComplete});
  }
  fs.writeFileSync(1,JSON.stringify({records,failures,fullArgvDumped:false,environmentRead:false,scope:'exact project launcher/driver/bwrap/app and project cwd/open-file/mount references only'})+'\n');
  process.exit(0);
}
assert.equal(root.replaceAll('\\','/').toLowerCase(), 'd:/qq-onebot');
const startedAt = new Date().toISOString();
const abs = r => path.resolve(root, r);
const rel = p => path.relative(root,p).replaceAll('\\','/');
const inside = p => p === root || (!path.relative(root,p).startsWith('..') && !path.isAbsolute(path.relative(root,p)));
const errors = [], links = [], excludedSecrets = [], businessAggregates = [];
const dirs = new Map(), allFiles = new Map();
const protectedRoots = [
  '.tmp/phone-agent-runtime-6g9XJC/data', '.tmp/phone-agent-runtime-6g9XJC/home',
  '.tmp/phone-agent-current-7qCsKd', '.tmp/phone-agent-deps-OkS7xy',
];
const sensitive = n => /^(?:\.ssh|\.gnupg|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|apikey(?:\..*)?|api[-_]?key(?:\..*)?|private[-_]?key(?:\..*)?)$/i.test(n) || /\.(?:pem|key|p12|pfx)$/i.test(n);
function noLinks(p) {
  assert(inside(p));
  let here=root;
  for (const component of path.relative(root,p).split(path.sep).filter(Boolean)) {
    here=path.join(here,component); const s=fs.lstatSync(here);
    assert(!s.isSymbolicLink(),'LINK_BOUNDARY');
  }
}
function safeJson(p) {
  try {
    noLinks(p); const s=fs.lstatSync(p);
    if (!s.isFile() || s.size>4_000_000) return null;
    // Callers pass ONLY exact control manifests/status/result filenames, never data/config.
    return JSON.parse(fs.readFileSync(p,'utf8'));
  } catch(e) { if(e.code!=='ENOENT') errors.push({path:rel(p),operation:'control-json',code:e.code??'INVALID_CONTROL_METADATA'}); return null; }
}
function hostPath(v) {
  if(typeof v!=='string')return null;
  const normalized=v.replaceAll('\\','/');
  if(normalized.startsWith('/mnt/d/qq-onebot/'))return abs(normalized.slice('/mnt/d/qq-onebot/'.length));
  if(/^d:\/qq-onebot\//i.test(normalized))return path.resolve(normalized);
  return null;
}
const lockFile=abs('runtime/integrated-login.lock');
const lock=safeJson(lockFile);
assert(lock?.profileId==='login-12ae6a93f2639df1df3f' && lock.pid===214,'ACTIVE_LOCK_CHANGED_REVIEW_REQUIRED');
const tmpEntries=fs.readdirSync(abs('.tmp'),{withFileTypes:true});
const manifests=[];
for(const d of tmpEntries) {
  if(!d.isDirectory()||d.isSymbolicLink()||!/^integrated-inputs-/.test(d.name))continue;
  const work=abs('.tmp/'+d.name);
  for(const name of ['login.json','preflight.json']) {
    const file=path.join(work,name); if(!fs.existsSync(file))continue;
    const j=safeJson(file);
    if(j&&typeof j.runId==='string'&&Array.isArray(j.entries))manifests.push({work,file,j});
  }
}
const active=manifests.filter(m=>m.j.runId===lock.profileId);
assert.equal(active.length,1,'ACTIVE_MANIFEST_NOT_UNIQUE');
const live=active[0];
const activeRefs=new Set([live.work,abs('runtime/integrated/'+lock.profileId),lockFile]);
for(const e of live.j.entries) {const p=hostPath(e.source);if(p&&inside(p))activeRefs.add(p);}
for(const p of protectedRoots) activeRefs.add(abs(p));
const linuxNode=live.j.entries.find(e=>e.kind==='node')?.source;
assert(linuxNode?.startsWith('/mnt/d/qq-onebot/.tools/'));
const processProbeResult=spawnSync('wsl.exe',['-d','Debian','--',linuxNode,'/mnt/d/qq-onebot/scripts/audit-storage.mjs','--probe-process-references'],{encoding:'utf8',timeout:20000,maxBuffer:2_000_000,windowsHide:true});
let processProbe;
try {assert.equal(processProbeResult.status,0);processProbe=JSON.parse(processProbeResult.stdout);}
catch {processProbe={records:[],failures:[{operation:'project-process-probe',code:processProbeResult.error?.code??'FAILED'}],unavailable:true};}
const processReferencedWorks=new Set(processProbe.records.flatMap(x=>x.workReferences).map(hostPath).filter(Boolean));
for(const p of processReferencedWorks)activeRefs.add(p);
const processReferencesUncertain=processProbe.unavailable||processProbe.failures.length>0;
const referenceTouches = p => [...activeRefs].some(q=>q===p||q.startsWith(p+path.sep)||p.startsWith(q+path.sep));
function empty(p) {return {path:p,logicalBytes:0,files:0,directories:1,symlinks:0,special:0,hardlinkedFiles:0,errors:0,secretEntriesExcluded:0,complete:true};}
function walk(p, hidden=false) {
  assert(inside(p));
  const r=rel(p); const aggregate=empty(p);
  const protect=protectedRoots.includes(r); hidden=hidden||protect;
  let entries;
  try { const st=fs.lstatSync(p); if(st.isSymbolicLink())throw Error('LINK_BOUNDARY'); entries=fs.readdirSync(p,{withFileTypes:true}); }
  catch(e){aggregate.errors++;aggregate.complete=false;errors.push({path:hidden?'[protected business subtree]':r,operation:'readdir',code:e.code??'LINK_BOUNDARY'});return aggregate;}
  for(const d of entries) {
    const q=path.join(p,d.name);assert(inside(q));
    if(sensitive(d.name)) {aggregate.secretEntriesExcluded++;aggregate.complete=false;if(!hidden)excludedSecrets.push({parent:r,kind:d.isDirectory()?'directory':'entry'});continue;}
    if(d.isSymbolicLink()) {aggregate.symlinks++;if(!hidden)links.push({path:rel(q),followed:false});continue;}
    let s;try{s=fs.lstatSync(q);}catch(e){aggregate.errors++;aggregate.complete=false;errors.push({path:hidden?'[protected business subtree]':rel(q),operation:'lstat',code:e.code??'UNKNOWN'});continue;}
    if(s.isSymbolicLink()){aggregate.symlinks++;if(!hidden)links.push({path:rel(q),followed:false});continue;}
    if(s.isDirectory()) {
      const child=walk(q,hidden);
      for(const key of ['logicalBytes','files','directories','symlinks','special','hardlinkedFiles','errors','secretEntriesExcluded'])aggregate[key]+=child[key];
      aggregate.complete&&=child.complete;
    } else if(s.isFile()) {
      aggregate.files++;aggregate.logicalBytes+=s.size;if(s.nlink>1)aggregate.hardlinkedFiles++;
      if(!hidden)allFiles.set(q,{bytes:s.size,mtimeMs:s.mtimeMs});
    } else aggregate.special++;
  }
  if(!hidden||protect)dirs.set(p,aggregate);
  if(protect)businessAggregates.push({...aggregate,metadataOnly:true,internalNamesSuppressed:true});
  return aggregate;
}
const total=walk(root);
const size=p=>dirs.get(p)??{path:p,logicalBytes:0,files:0,complete:!fs.existsSync(p)};
const digestDeclared = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex'); // hashes manifest metadata ONLY
function snapshotFacts(m,kind) {
  const p=path.join(m.work,kind), s=dirs.get(p);if(!s)return null;
  const records=kind==='snapshot'?m.j.entries.filter(e=>['source','dependency'].includes(e.kind)).map(e=>({guest:e.guest,sha256:e.sha256,bytes:e.bytes})):
    m.j.entries.filter(e=>typeof e.guest==='string'&&e.guest.startsWith('/input/agent-app/')).map(e=>({guest:e.guest.slice('/input/agent-app/'.length),sha256:e.sha256,bytes:e.bytes}));
  const expected = records.reduce((n,e)=>n+(Number.isSafeInteger(e.bytes)?e.bytes:0),0);
  const declaredInventoryMatchesMetadata=records.length===s.files&&expected===s.logicalBytes&&s.symlinks===0&&s.complete;
  const fingerprint=records.length?digestDeclared(records.sort((a,b)=>a.guest.localeCompare(b.guest))):null;
  const suspicious=[];
  for(const f of allFiles.keys()) if(f.startsWith(p+path.sep)) {
    const name=path.relative(p,f).replaceAll('\\','/');
    // src/memory and src/knowledge are CODE, not business datasets. Only a
    // root business directory or an actual DB/log/report disqualifies the copy.
    if(/^(?:data|home|memory|knowledge|sessions|backups|outcomes)(?:\/|$)|(?:^|\/)(?:result|parent-result|manifest|status|preflight|login)\.json$|\.(?:log|db|sqlite|sqlite3)(?:-|$)/i.test(name))suspicious.push(name);
  }
  return {path:p,kind,logicalBytes:s.logicalBytes,files:s.files,complete:s.complete,manifest:m.file,runId:m.j.runId,networkShared:!!m.j.networkShared,activeReference:referenceTouches(p),declaredInventoryMatchesMetadata,declaredFingerprint:fingerprint,expectedFiles:records.length,expectedBytes:expected,contentHashesRecomputed:false,suspiciousBusinessOrReportEntries:suspicious};
}
const artifacts=manifests.flatMap(m=>['snapshot','agent-app'].map(k=>snapshotFacts(m,k)).filter(Boolean));
const groups=new Map();for(const a of artifacts){if(!a.declaredFingerprint)continue;const k=a.kind+':'+a.declaredFingerprint;const g=groups.get(k)??[];g.push(a);groups.set(k,g);}
const candidates=[];
for(const a of artifacts) {
  const profile=abs('runtime/integrated/'+a.runId);
  const parent=safeJson(path.join(path.dirname(a.path),'parent-result.json'));
  const status=safeJson(path.join(profile,'status.json'));
  const stopped=!!parent?.observed && (Number.isInteger(parent.observed.status)||parent.observed.signal!=null);
  const isOffline=!a.networkShared;
  const peers=groups.get(a.kind+':'+a.declaredFingerprint)??[];
  const retainPeers=peers.filter(x=>x.path!==a.path).map(x=>({path:x.path,active:x.activeReference,logicalBytes:x.logicalBytes}));
  // Preserve at least one representative of EVERY historical inventory so a
  // unique rollback snapshot is never classified disposable just from its name.
  const anchor=peers.find(x=>x.activeReference)??[...peers].sort((x,y)=>x.path.localeCompare(y.path))[0];
  const hasRetainedPeer=peers.length>1&&anchor?.path!==a.path;
  const certainty=!processReferencesUncertain&&!a.activeReference&&a.declaredInventoryMatchesMetadata&&a.suspiciousBusinessOrReportEntries.length===0&&(isOffline||stopped)&&hasRetainedPeer;
  const state=certainty?'candidate-rebuildable-subtree-only':a.activeReference?'retain-active':'unknown-retain';
  const work=path.dirname(a.path);
  const retainedControlFiles=['login.json','preflight.json','parent-result.json'].map(n=>path.join(work,n)).filter(p=>allFiles.has(p));
  const retainedLogs=[...allFiles.keys()].filter(p=>p.startsWith(work+path.sep)&&!p.startsWith(a.path+path.sep)&&/\.(?:log|json)$/i.test(p)).map(p=>rel(p));
  candidates.push({...a,state,exitedEvidence:{offlineManifest:isOffline,parentResult:parent?path.join(work,'parent-result.json'):null,parentStatus:parent?.observed?.status??null,parentSignal:parent?.observed?.signal??null,statusPhase:typeof status?.phase==='string'?status.phase:null},sameDeclaredInventoryPeers:retainPeers,retainedControlFiles,otherJsonLogFilesOutsideCandidate:retainedLogs,uniqueReportsOrLogsInsideCandidate:a.suspiciousBusinessOrReportEntries.length>0?'potential-present':'none-found-by-name-and-inventory',rebuildBasis:certainty?'Manifest source/dependency inventory and file/byte counts agree; snapshot is staging copy, not data. Keep manifest, driver and logs. Exact historical-byte restoration requires surviving same-fingerprint peer or original inputs; no content hash verification was performed.':'Not approved: active reference, incomplete inventory, possible business/report file, or no completed/offline evidence.'});
}
const payloadCandidates=[];
const liveLibraries=new Map(live.j.entries.filter(e=>e.kind==='library'&&hostPath(e.source)&&path.dirname(hostPath(e.source))===live.work).map(e=>[path.basename(e.source),e]));
for(const m of manifests) {
  if(m===live)continue;
  const parent=safeJson(path.join(m.work,'parent-result.json'));
  const exited=!!parent?.observed&&(Number.isInteger(parent.observed.status)||parent.observed.signal!=null);
  if(m.j.networkShared&&!exited)continue;
  for(const e of m.j.entries) {
    const p=hostPath(e.source); if(!p||path.dirname(p)!==m.work||e.kind!=='library'||!/^.+\.so(?:\.[0-9]+)*$/.test(path.basename(p)))continue;
    const s=allFiles.get(p),peer=liveLibraries.get(path.basename(p));
    if(!s||s.bytes!==e.bytes||!peer||peer.sha256!==e.sha256||peer.bytes!==e.bytes||referenceTouches(p))continue;
    payloadCandidates.push({path:p,kind:'integrated-copied-system-library',logicalBytes:s.bytes,files:1,state:'candidate-rebuildable-payload-only',manifest:m.file,runId:m.j.runId,offline:!m.j.networkShared,parentExitStatus:parent?.observed?.status??null,declaredSha256:e.sha256,retainedPeer:hostPath(peer.source),contentHashRecomputed:false,uniqueReportsOrLogsInsideCandidate:false,generator:'scripts/integrated-preflight-linux.mjs:104-110',preserve:'Entire work except individually listed .so files; retain login/preflight manifest, driver, parent-result, logs and unique rollback input.'});
  }
}
const kit=safeJson(abs('evidence/windows-sandbox-host-kit.json'));
const retainedKit=kit?.work?hostPath(kit.work):null;
const retainedNode=retainedKit?path.join(retainedKit,'input','node.exe'):null;
const retainedNodeManifest=retainedKit?safeJson(path.join(retainedKit,'input','manifest.json')):null;
for(const t of [...dirs.values()].filter(x=>path.dirname(x.path)===abs('.tmp')&&/^(?:windows-sandbox-host-|Windows (?:rehearsal|sandbox) &|sandbox copy &)/i.test(path.basename(x.path)))) {
  if(t.path===retainedKit)continue;
  const manifest=path.join(t.path,'input','manifest.json'),j=safeJson(manifest);
  const p=path.join(t.path,'input','node.exe'),s=allFiles.get(p),peer=retainedNode?allFiles.get(retainedNode):null;
  if(!s||!peer||s.bytes!==peer.bytes||!j?.files?.['node.exe']||j.files['node.exe']!==retainedNodeManifest?.files?.['node.exe']||referenceTouches(p))continue;
  payloadCandidates.push({path:p,kind:'windows-synthetic-kit-node-copy',logicalBytes:s.bytes,files:1,state:'candidate-rebuildable-payload-only',manifest,declaredSha256:j.files['node.exe'],retainedPeer:retainedNode,contentHashRecomputed:false,uniqueReportsOrLogsInsideCandidate:false,generator:'scripts/prepare-windows-sandbox-host.mjs:12-16,23-36,65-69,93-106; scripts/verify-windows-sandbox-host.mjs:15-20,59-89',preserve:'Keep input/manifest.json, all source, .wsb, output/, rehearsal/, canary and current evidence-registered kit. Only node.exe is proposed.'});
}
const retainedStageReport=safeJson(abs('evidence/windows-qq-stage.json'));
const retainedStage=typeof retainedStageReport?.stage==='string'?abs(retainedStageReport.stage):null;
const retainedStageManifest=retainedStage?safeJson(path.join(retainedStage,'manifest.json')):null;
for(const base of ['.tmp/stage-integrity-59cb580dbef7405b8dcf5b7db680afb2','.tmp/windows-stage-verifier-b4e309454aa54e35b1f1dfe1b3b879c3/relocated-runtime']) {
  const stage=abs(base),manifest=path.join(stage,'manifest.json'),j=safeJson(manifest);
  if(!Array.isArray(j?.files)||!Array.isArray(retainedStageManifest?.files))continue;
  for(const e of j.files) {
    if(!/^[a-z0-9_.-]+\.(?:dll|node|exe)$/i.test(e.name))continue;
    const p=path.join(stage,e.name),s=allFiles.get(p);
    const peer=retainedStageManifest.files.find(x=>x.name.toLowerCase()===e.name.toLowerCase()&&x.sha256===e.sha256&&x.bytes===e.bytes);
    const peerPath=peer?path.join(retainedStage,peer.name):null;
    if(!s||s.bytes!==e.bytes||!peerPath||allFiles.get(peerPath)?.bytes!==e.bytes||referenceTouches(p))continue;
    payloadCandidates.push({path:p,kind:'windows-runtime-negative-or-relocation-fixture-binary',logicalBytes:s.bytes,files:1,state:'candidate-rebuildable-payload-only',manifest,declaredSha256:e.sha256,retainedPeer:peerPath,contentHashRecomputed:false,uniqueReportsOrLogsInsideCandidate:false,generator:'scripts/stage-windows-qq-runtime.mjs:45-76,95-127',preserve:'Keep manifest.json, extra.txt negative-fixture marker, directories, any logs/reports, and all .tools official source/retained stage.'});
  }
}
for(const item of payloadCandidates) {
  item.suggestedCanonicalPath=abs('backups/storage-cleanup-20261115/canonical/'+item.declaredSha256+'.bin');
  item.restoreMapping={deletedLeafWouldBe:item.path,restoreFrom:item.suggestedCanonicalPath,expectedBytes:item.logicalBytes,expectedSha256:item.declaredSha256};
  item.canonicalNotCreatedByAudit=true;
  item.rootMustCopyAndIndependentlyHashBeforeDeleting=true;
  if(processReferencesUncertain)item.state='unknown-retain-process-reference-probe-incomplete';
}
const profiles=[];
const profileRoot=abs('runtime/integrated');
for(const d of fs.readdirSync(profileRoot,{withFileTypes:true})) {
  if(!d.isDirectory()||d.isSymbolicLink()||!/^login-/.test(d.name))continue;
  const p=path.join(profileRoot,d.name), st=safeJson(path.join(p,'status.json'));
  const m=manifests.find(x=>x.j.runId===d.name), parent=m?safeJson(path.join(m.work,'parent-result.json')):null;
  const controlFiles=['status.json','preflight.json','agent-stdout.log','agent-stderr.log'].map(n=>path.join(p,n)).filter(x=>allFiles.has(x));
  profiles.push({path:p,...size(p),active:d.name===lock.profileId,state:d.name===lock.profileId?'retain-active':'retain-login-data-and-evidence-even-if-exited',phase:typeof st?.phase==='string'?st.phase:null,parentExitStatus:parent?.observed?.status??null,parentExitSignal:parent?.observed?.signal??null,controlAndLogFiles:controlFiles,hasUniqueLogs:controlFiles.some(x=>/\.log$/i.test(x)),reason:'QQ session/database/config contents not read. Exited does not establish data is disposable; retain profile, auth/session DBs and unique diagnostics.'});
}
const depth=r=>r? r.split('/').length:0;
const rootItems=[...dirs.values()].filter(x=>depth(rel(x.path))===1).concat([...allFiles].filter(([p])=>depth(rel(p))===1).map(([p,s])=>({path:p,logicalBytes:s.bytes,files:1,directories:0,complete:true})));
const sorted=a=>a.sort((x,y)=>y.logicalBytes-x.logicalBytes);
const shallow=[...dirs.values()].filter(x=>depth(rel(x.path))<=2&&x.path!==root);
const tempChildren=[...dirs.values()].filter(x=>depth(rel(x.path))===2&&rel(x.path).startsWith('.tmp/'));
const retain=[...new Set([...protectedRoots.map(abs),live.work,abs('runtime/integrated/'+lock.profileId),abs('src'),abs('scripts'),abs('docs'),abs('evidence'),abs('qq-onebot-ledger-memory'),abs('backups'),abs('dist'),abs('.tools'),abs('node_modules')])].map(p=>({...size(p),path:p,state:'retain',reason:referenceTouches(p)?'active reference or explicit protected material':'source/evidence/rollback/platform tool material; no deletion inference'}));
const lockAtEnd=safeJson(lockFile);
assert(lockAtEnd?.pid===lock.pid&&lockAtEnd?.profileId===lock.profileId,'ACTIVE_LOCK_CHANGED_DURING_SCAN');
const report={schemaVersion:1,startedAt,finishedAt:new Date().toISOString(),root,method:{metadataOnly:true,lstat:true,direntSymlinkCheck:true,followLinks:false,readlink:false,contentHashes:false,writeScope:'new script plus new evidence/storage-audit-*.json only',logicalBytesNotAllocatedBytes:true,hardlinksCountedPerPath:true,businessContentRead:false,credentialsRead:false,processesInspected:false,protectedBusinessSubtreesMetadataOnly:true,noDeletionPerformed:true},coverage:{...total,rootItemsCount:rootItems.length,directoriesCount:total.directories,manifestCount:manifests.length,controlJsonReadsOnly:true,errors,symlinksNotFollowed:links,secretEntriesExcluded:excludedSecrets,nonAtomicLiveMetadataSnapshot:true,reportItselfNotIncluded:true,limitations:['Logical bytes from lstat regular files; not allocated clusters, sparse/compression or hardlink-deduplicated physical usage.','Symlink targets and key/SSH-pattern entries excluded entirely.','Control manifests/status/parent results only were parsed; no DB, log, config or business content read.','No process open-file/liveness inspection; current lock is rechecked but old profile exit is based on parent-result or offline manifest.','Declared inventory fingerprints are manifest-only, not independent content duplicate hashes.','Only explicit protected roots publish aggregate sizes; their internal file/directory names are suppressed.']},active:{lock:lockFile,pid:lock.pid,profileId:lock.profileId,manifest:live.file,work:live.work,snapshot:path.join(live.work,'snapshot'),agentApp:path.join(live.work,'agent-app'),inputCount:live.j.entries.length,inputContentSha256:live.j.inputContentSha256,sourceReferences:[...activeRefs].sort()},rootTop10:sorted([...rootItems]).slice(0,10),rootItems:sorted(rootItems),firstAndSecondLevelDirectories:sorted(shallow),tmpChildren:sorted(tempChildren),protectedBusinessAggregates:businessAggregates,candidates:sorted(candidates),candidateSummary:{count:candidates.filter(x=>x.state==='candidate-rebuildable-subtree-only').length,logicalBytes:candidates.filter(x=>x.state==='candidate-rebuildable-subtree-only').reduce((n,x)=>n+x.logicalBytes,0),noWholeWorkOrProfileDeletion:true},profiles:sorted(profiles),retain,unknownLargeDirectories:sorted(tempChildren.filter(x=>x.logicalBytes>=50_000_000&&!artifacts.some(a=>a.path.startsWith(x.path+path.sep))&&!protectedRoots.some(r=>abs(r)===x.path))).map(x=>({...x,state:referenceTouches(x.path)?'retain-active-reference':'unknown-retain',reason:'No proof all contents are rebuildable; may contain reports, data, runtime material or fallback.'}))};
report.processReferenceProbe={...processProbe,uncertain:!!processReferencesUncertain,referencedWorks:[...processReferencedWorks],probeStatus:processProbeResult.status};
report.payloadCandidates=payloadCandidates;
report.payloadSummary={count:payloadCandidates.length,logicalBytes:payloadCandidates.reduce((n,x)=>n+x.logicalBytes,0),byKind:Object.fromEntries([...new Set(payloadCandidates.map(x=>x.kind))].map(kind=>[kind,{files:payloadCandidates.filter(x=>x.kind===kind).length,logicalBytes:payloadCandidates.filter(x=>x.kind===kind).reduce((n,x)=>n+x.logicalBytes,0)}])),preserveAllManifestsReportsLogs:true,retainCurrentWindowsKit:retainedKit,retainWindowsOfficialStage:retainedStage,requiresRootFinalLivenessAndPathReview:true};
const executionLeafCandidates=payloadCandidates.filter(x=>x.state==='candidate-rebuildable-payload-only');
const uniquePayloads=new Map(executionLeafCandidates.map(x=>[x.declaredSha256,x.logicalBytes]));
report.executionLeafSummary={candidateArray:'payloadCandidates; retain only state=candidate-rebuildable-payload-only',files:executionLeafCandidates.length,logicalBytes:executionLeafCandidates.reduce((n,x)=>n+x.logicalBytes,0),uniqueSha256:uniquePayloads.size,canonicalBytesIfOneCopyPerSha:[...uniquePayloads.values()].reduce((n,x)=>n+x,0),canonicalNotYetCreated:true,contentHashesAreDeclaredNotRecomputed:true,allHistoricalManifestsRemainUnmodified:true};
report.candidateSummary.totalNonOverlappingLogicalBytes=report.candidateSummary.logicalBytes+report.executionLeafSummary.logicalBytes;
report.manualExactProcessProbe={timing:'performed between first and second audit report, not separately timestamped',source:'read-only WSL commands in this audit session',exactDriverPattern:'(^|/| )scripts/integrated-preflight-linux[.]mjs( |$)',pidOutput:[214],cwdPid214:'/mnt/d/qq-onebot',fullArgvOrEnvironmentDumped:false,limitation:'Only this exact integrated driver was checked; root must recheck candidate executable open-file/liveness state immediately before any later deletion. Earlier absolute-node-and-script pattern returned no match and was NOT treated as proof of no owner.'};
const filename='storage-audit-'+new Date().toISOString().replaceAll(/[:.]/g,'-')+'.json';
const output=abs('evidence/'+filename);noLinks(path.dirname(output));
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({report:output,coverage:report.coverage.logicalBytes,files:report.coverage.files,directories:report.coverage.directories,errors:errors.length,excludedSecretEntries:report.coverage.secretEntriesExcluded,rootTop10:report.rootTop10,candidateSummary:report.candidateSummary,payloadSummary:report.payloadSummary,topCandidates:report.candidates.filter(x=>x.state==='candidate-rebuildable-subtree-only').slice(0,12).map(x=>({path:x.path,logicalBytes:x.logicalBytes,files:x.files,runId:x.runId,kind:x.kind,peers:x.sameDeclaredInventoryPeers.length})),active:report.active.work},null,2));
