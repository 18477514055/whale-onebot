// Delete ONLY explicitly audited duplicate binary leaves, never whole worktrees.
// Preserve control/log/data paths and one verified canonical copy per digest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const kinds = new Set(['integrated-copied-system-library','windows-synthetic-kit-node-copy','windows-runtime-negative-or-relocation-fixture-binary']);
const error = code => Object.assign(new Error(code), { code });
const inside = (root,p) => p!==root && !path.relative(root,p).startsWith('..') && !path.isAbsolute(path.relative(root,p));
export function physicalInside(root, target, directory = false) {
  root=fs.realpathSync(root); target=path.resolve(target);
  if(!inside(root,target))throw error('CLEANUP_OUTSIDE_PROJECT');
  let cursor=root;
  for(const part of path.relative(root,target).split(path.sep)){
    cursor=path.join(cursor,part);const s=fs.lstatSync(cursor);
    if(s.isSymbolicLink())throw error('CLEANUP_LINK_BOUNDARY');
  }
  const s=fs.lstatSync(target);
  if(directory ? !s.isDirectory() : !s.isFile() || s.nlink!==1)throw error('CLEANUP_OBJECT_TYPE');
  return s;
}
export function fileDigest(file) {
  const fd=fs.openSync(file,'r'),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);
  try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));return hash.digest('hex');}
  finally{fs.closeSync(fd);}
}
function candidatePath(root,p,kind){
  const relative=path.relative(root,p).replaceAll('\\','/');
  if(kind==='integrated-copied-system-library')return /^\.tmp\/integrated-inputs-[A-Za-z0-9]+\/[^/]+\.so(?:\.[0-9]+)*$/.test(relative);
  if(kind==='windows-synthetic-kit-node-copy')return /^\.tmp\/(?:windows-sandbox-host-[A-Za-z0-9]+|Windows (?:rehearsal|sandbox) &[^/]+|sandbox copy &[^/]+)\/input\/node\.exe$/.test(relative);
  return /^\.tmp\/(?:stage-integrity-[a-f0-9]+|windows-stage-verifier-[a-f0-9]+\/relocated-runtime)\/[^/]+\.(?:dll|node|exe)$/i.test(relative);
}
function touches(p,q){return p===q||p.startsWith(q+path.sep)||q.startsWith(p+path.sep);}
function liveBinding(root){
  const file=path.join(root,'runtime/integrated-login.lock');physicalInside(root,file);
  const x=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!/^login-[a-f0-9]{20}$/.test(x.profileId??'')||!Number.isSafeInteger(x.pid))throw error('CLEANUP_LIVE_BINDING_INVALID');
  return x;
}
export function verifyPayloadPlan(root,audit){
  root=fs.realpathSync(root);
  if(path.resolve(audit.root)!==root||!Array.isArray(audit.payloadCandidates)||!audit.active?.work)throw error('CLEANUP_AUDIT_INVALID');
  const binding=liveBinding(root);
  if(binding.pid!==audit.active.pid||binding.profileId!==audit.active.profileId)throw error('CLEANUP_LIVE_BINDING_CHANGED');
  const protect=[audit.active.work,path.join(root,'runtime'),path.join(root,'.tools'),path.join(root,'node_modules'),
    path.join(root,'.tmp/phone-agent-current-7qCsKd'),path.join(root,'.tmp/phone-agent-runtime-6g9XJC'),path.join(root,'.tmp/phone-agent-deps-OkS7xy'),
    audit.payloadSummary?.retainCurrentWindowsKit,audit.payloadSummary?.retainWindowsOfficialStage,
    ...(audit.processReferenceProbe?.records??[]).flatMap(x=>x.workReferences??[]).map(p=>p.replace(/^\/mnt\/d\/qq-onebot\//,root+path.sep)),
  ].filter(Boolean).map(p=>path.resolve(p));
  const plan=[],skipped=[],seen=new Set();
  for(const row of audit.payloadCandidates){
    const target=path.resolve(row.path??''),peer=path.resolve(row.retainedPeer??'');
    if(!kinds.has(row.kind)||row.state!=='candidate-rebuildable-payload-only'||!candidatePath(root,target,row.kind)||
      !/^[a-f0-9]{64}$/.test(row.declaredSha256??'')||!Number.isSafeInteger(row.logicalBytes)||row.logicalBytes<1)
      throw error('CLEANUP_CANDIDATE_INVALID');
    if(protect.some(p=>touches(target,p))||target===peer)throw error('CLEANUP_PROTECTED_REFERENCE');
    if(seen.has(target))continue;seen.add(target);
    if(!fs.existsSync(target)){skipped.push({path:target,reason:'ALREADY_ABSENT'});continue;}
    const st=physicalInside(root,target),ps=physicalInside(root,peer);
    if(st.size!==row.logicalBytes||ps.size!==st.size)throw error('CLEANUP_SIZE_CHANGED');
    if(fileDigest(peer)!==row.declaredSha256||fileDigest(target)!==row.declaredSha256)throw error('CLEANUP_HASH_CHANGED');
    plan.push({path:target,kind:row.kind,bytes:st.size,sha256:row.declaredSha256,retainedPeer:peer,
      identity:{dev:st.dev,ino:st.ino,mtimeMs:st.mtimeMs},manifest:row.manifest});
  }
  return {binding,plan,skipped,logicalBytes:plan.reduce((n,x)=>n+x.bytes,0)};
}
function sameFile(root,row){
  const s=physicalInside(root,row.path);
  if(s.dev!==row.identity.dev||s.ino!==row.identity.ino||s.mtimeMs!==row.identity.mtimeMs||s.size!==row.bytes)
    throw error('CLEANUP_FILE_CHANGED_AFTER_REVIEW');
}
function freeBytes(root){try{const s=fs.statfsSync(root,{bigint:true});return Number(s.bavail*s.bsize);}catch{return null;}}
export function applyVerifiedPlan(root,verified,{reportDirectory,canonicalDirectory,rollbackProbe=true}={}){
  root=fs.realpathSync(root);
  const current=liveBinding(root);
  if(current.pid!==verified.binding.pid||current.profileId!==verified.binding.profileId)throw error('CLEANUP_LIVE_BINDING_CHANGED');
  const freeBytesBeforeRetention=freeBytes(root);
  for(const folder of [reportDirectory,canonicalDirectory]){
    if(!inside(root,path.resolve(folder)))throw error('CLEANUP_OUTPUT_OUTSIDE_PROJECT');
    fs.mkdirSync(folder,{recursive:true});physicalInside(root,folder,true);
  }
  const canonical=new Map();
  // Finish every retained copy BEFORE the first deletion. No multi-GB move/trash.
  for(const row of verified.plan){
    const target=path.join(canonicalDirectory,row.sha256+'.bin');
    if(!canonical.has(row.sha256)){
      if(!fs.existsSync(target))fs.copyFileSync(row.retainedPeer,target,fs.constants.COPYFILE_EXCL);
      physicalInside(root,target);
      if(fileDigest(target)!==row.sha256)throw error('CLEANUP_CANONICAL_INVALID');
      canonical.set(row.sha256,target);
    }
    row.canonical=target;
  }
  const id='storage-cleanup-'+Date.now()+'-'+randomBytes(3).toString('hex');
  const reportFile=path.join(reportDirectory,id+'.json'),journal=path.join(reportDirectory,id+'.jsonl');
  const report={startedAt:new Date().toISOString(),binding:verified.binding,freeBytesBeforeRetention,freeBytesBefore:freeBytes(root),
    auditOnly:false,recursiveDeletes:false,canonicalDirectory,canonicalCopies:canonical.size,plan:verified.plan,
    skipped:verified.skipped,deletedFiles:0,deletedLogicalBytes:0,failures:[],rollbackProbe:null};
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const out=fs.openSync(journal,'wx');
  try{
    for(const row of verified.plan){
      try{
        const binding=liveBinding(root);
        if(binding.pid!==verified.binding.pid||binding.profileId!==verified.binding.profileId)throw error('CLEANUP_LIVE_BINDING_CHANGED');
        sameFile(root,row); // Absolute path and every ancestor are checked again.
        fs.unlinkSync(row.path);
        report.deletedFiles++;report.deletedLogicalBytes+=row.bytes;
        fs.writeSync(out,JSON.stringify({at:new Date().toISOString(),path:row.path,bytes:row.bytes,sha256:row.sha256,canonical:row.canonical,deleted:true})+'\n');
      }catch(e){report.failures.push({path:row.path,code:e.code??'CLEANUP_FAILED'});break;}
    }
    fs.fsyncSync(out);
    if(rollbackProbe&&report.deletedFiles>0&&!report.failures.length){
      const row=[...verified.plan].sort((a,b)=>a.bytes-b.bytes)[0];
      if(fs.existsSync(row.path))throw error('CLEANUP_ROLLBACK_TARGET_EXISTS');
      physicalInside(root,path.dirname(row.path),true);
      fs.copyFileSync(row.canonical,row.path,fs.constants.COPYFILE_EXCL);
      physicalInside(root,row.path);
      if(fileDigest(row.path)!==row.sha256)throw error('CLEANUP_ROLLBACK_HASH_FAILED');
      // Remove only this freshly verified restored duplicate, never the canonical.
      physicalInside(root,row.path);fs.unlinkSync(row.path);
      report.rollbackProbe={path:row.path,restoredAtOriginalPath:true,sha256Matched:true,duplicateRemovedAgain:true};
    }
  }finally{
    fs.closeSync(out);report.finishedAt=new Date().toISOString();report.freeBytesAfter=freeBytes(root);
    report.freeBytesChange=report.freeBytesAfter!==null&&report.freeBytesBefore!==null?report.freeBytesAfter-report.freeBytesBefore:null;
    report.netFreeBytesChange=report.freeBytesAfter!==null&&freeBytesBeforeRetention!==null?report.freeBytesAfter-freeBytesBeforeRetention:null;
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
  }
  return {reportFile,journal,...report};
}
async function main(){
  const root=fs.realpathSync(path.resolve(import.meta.dirname,'..'));
  if(process.platform!=='win32'||root.toLowerCase()!=='d:\\qq-onebot')throw error('CLEANUP_WINDOWS_PROJECT_ONLY');
  const args=process.argv.slice(2),apply=args.includes('--apply');
  const i=args.indexOf('--audit');if(i<0||!args[i+1])throw error('CLEANUP_AUDIT_ARGUMENT_REQUIRED');
  const file=path.resolve(args[i+1]);physicalInside(root,file);
  const audit=JSON.parse(fs.readFileSync(file,'utf8'));
  // Fresh process/mount/open-file references before either preview or apply.
  const node=audit.active?.linuxNode??'/mnt/d/qq-onebot/.tools/node-v24.20.0-linux-x64/bin/node';
  const probe=spawnSync('wsl.exe',['-d','Debian','--',node,'/mnt/d/qq-onebot/scripts/audit-storage.mjs','--probe-process-references'],{encoding:'utf8',timeout:30000,maxBuffer:2000000});
  if(probe.status!==0)throw error('CLEANUP_PROCESS_PROBE_FAILED');
  const live=JSON.parse(probe.stdout);
  if(live.failures.length||live.records.some(x=>x.inspectionComplete!==true))throw error('CLEANUP_PROCESS_REFERENCES_UNKNOWN');
  const owner=liveBinding(root);
  if(!live.records.some(x=>x.pid===owner.pid&&x.roles?.launcher===true)||!live.records.some(x=>x.roles?.driver===true))
    throw error('CLEANUP_CURRENT_OWNER_NOT_OBSERVED');
  audit.processReferenceProbe=live;
  const windows=spawnSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like 'D:\\qq-onebot\\.tmp\\*' }).Count"],{encoding:'utf8',timeout:15000});
  if(windows.status!==0||windows.stdout.trim()!=='0')throw error('CLEANUP_WINDOWS_PAYLOAD_IN_USE');
  const sandbox=spawnSync('powershell.exe',['-NoProfile','-Command','@(Get-Process -Name WindowsSandbox,WindowsSandboxClient,WindowsSandboxRemoteSession -ErrorAction SilentlyContinue).Count'],{encoding:'utf8',timeout:10000});
  if(sandbox.status!==0||sandbox.stdout.trim()!=='0')throw error('CLEANUP_SANDBOX_REFERENCE_UNKNOWN');
  const verified=verifyPayloadPlan(root,audit);
  if(!apply){console.log(JSON.stringify({preview:true,audit:file,files:verified.plan.length,logicalBytes:verified.logicalBytes,
    kinds:[...new Set(verified.plan.map(x=>x.kind))],activeProfile:verified.binding.profileId,allContentHashesVerified:true,
    activeWorkProtected:audit.active.work,canonicalRetention:'backups/storage-cleanup-20261115/canonical'}));return;}
  const result=applyVerifiedPlan(root,verified,{reportDirectory:path.join(root,'evidence'),canonicalDirectory:path.join(root,'backups/storage-cleanup-20261115/canonical')});
  console.log(JSON.stringify({report:result.reportFile,deletedFiles:result.deletedFiles,deletedLogicalBytes:result.deletedLogicalBytes,
    canonicalCopies:result.canonicalCopies,freeBytesChange:result.freeBytesChange,failures:result.failures,
    rollbackProbe:result.rollbackProbe,recursiveDeletes:false}));
  if(result.failures.length)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
