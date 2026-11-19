import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {verifyPayloadPlan,applyVerifiedPlan,fileDigest,physicalInside} from '../scripts/cleanup-duplicate-payloads.mjs';
function fixture(t){
  const base=fs.mkdtempSync(path.resolve('.tmp/duplicate-cleanup-test-')),root=path.join(base,'qq-onebot');
  fs.mkdirSync(root);
  t.after(()=>{assert.equal(fs.realpathSync(base),base);assert(path.dirname(base)===path.resolve('.tmp'));fs.rmSync(base,{recursive:true});});
  const active=path.join(root,'.tmp/integrated-inputs-ACTIVE'),old=path.join(root,'.tmp/integrated-inputs-OLD');
  fs.mkdirSync(active,{recursive:true});fs.mkdirSync(old,{recursive:true});fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
  const profileId='login-'+'a'.repeat(20),pid=1234;
  fs.writeFileSync(path.join(root,'runtime/integrated-login.lock'),JSON.stringify({profileId,pid}));
  const peer=path.join(active,'libsynthetic.so'),target=path.join(old,'libsynthetic.so');
  fs.writeFileSync(peer,'SYNTHETIC_DUPLICATE');fs.copyFileSync(peer,target);
  const keep=path.join(old,'parent-result.json');fs.writeFileSync(keep,'{"synthetic":true}');
  const business=path.join(root,'.tmp/phone-agent-runtime-6g9XJC/data/messages.sqlite');fs.mkdirSync(path.dirname(business),{recursive:true});fs.writeFileSync(business,'SYNTHETIC_PROTECTED');
  const row={path:target,kind:'integrated-copied-system-library',state:'candidate-rebuildable-payload-only',logicalBytes:fs.statSync(target).size,declaredSha256:fileDigest(target),retainedPeer:peer};
  const audit={root,active:{work:active,pid,profileId},payloadCandidates:[row]};
  return{root,active,old,peer,target,keep,business,audit};
}
test('cleanup verifies both hashes and preserves active inputs/control/business while removing one leaf',t=>{
  const f=fixture(t),verified=verifyPayloadPlan(f.root,f.audit);
  assert.equal(verified.plan.length,1);
  const result=applyVerifiedPlan(f.root,verified,{reportDirectory:path.join(f.root,'evidence'),canonicalDirectory:path.join(f.root,'backups/canonical')});
  assert.equal(result.deletedFiles,1);assert.equal(result.failures.length,0);assert(!fs.existsSync(f.target));
  assert.equal(fs.readFileSync(f.peer,'utf8'),'SYNTHETIC_DUPLICATE');assert.equal(fs.readFileSync(f.business,'utf8'),'SYNTHETIC_PROTECTED');
  assert.equal(fs.readFileSync(f.keep,'utf8'),'{"synthetic":true}');
  assert.equal(result.rollbackProbe.restoredAtOriginalPath,true);assert.equal(result.rollbackProbe.sha256Matched,true);
  const canonical=result.plan[0].canonical;assert.equal(fileDigest(canonical),f.audit.payloadCandidates[0].declaredSha256);
});
test('cleanup rejects a changed duplicate instead of trusting manifest claims',t=>{
  const f=fixture(t);fs.writeFileSync(f.target,'TAMPERED_DUPLICATE!');
  assert.throws(()=>verifyPayloadPlan(f.root,f.audit),/CLEANUP_(SIZE|HASH)_CHANGED/);assert(fs.existsSync(f.target));
});
test('cleanup refuses the active work even when the file shape and hash are valid',t=>{
  const f=fixture(t);f.audit.payloadCandidates[0].path=f.peer;f.audit.payloadCandidates[0].retainedPeer=f.target;
  assert.throws(()=>verifyPayloadPlan(f.root,f.audit),/CLEANUP_PROTECTED_REFERENCE/);assert(fs.existsSync(f.peer));
});
test('cleanup refuses protected data and arbitrary report files as candidates',t=>{
  const f=fixture(t);for(const target of [f.business,f.keep]){
    const audit=structuredClone(f.audit);audit.payloadCandidates[0].path=target;
    assert.throws(()=>verifyPayloadPlan(f.root,audit),/CLEANUP_CANDIDATE_INVALID/);
  }
});
test('cleanup refuses binding replacement after preview before canonical writes',t=>{
  const f=fixture(t),verified=verifyPayloadPlan(f.root,f.audit);
  fs.writeFileSync(path.join(f.root,'runtime/integrated-login.lock'),JSON.stringify({profileId:'login-'+'b'.repeat(20),pid:4321}));
  assert.throws(()=>applyVerifiedPlan(f.root,verified,{reportDirectory:path.join(f.root,'evidence'),canonicalDirectory:path.join(f.root,'backups/canonical')}),/CLEANUP_LIVE_BINDING_CHANGED/);
  assert(fs.existsSync(f.target));assert(!fs.existsSync(path.join(f.root,'backups')));
});
test('cleanup handles an already absent old leaf without resetting state or touching retained files',t=>{
  const f=fixture(t);fs.unlinkSync(f.target);const verified=verifyPayloadPlan(f.root,f.audit);
  assert.equal(verified.plan.length,0);assert.equal(verified.skipped[0].reason,'ALREADY_ABSENT');assert(fs.existsSync(f.peer));
});
test('cleanup refuses outside-project outputs and path traversal',t=>{
  const f=fixture(t);assert.throws(()=>physicalInside(f.root,path.dirname(f.root)),/CLEANUP_OUTSIDE_PROJECT/);
  const audit=structuredClone(f.audit);audit.payloadCandidates[0].path=path.resolve(f.root,'../outside.so');
  assert.throws(()=>verifyPayloadPlan(f.root,audit),/CLEANUP_CANDIDATE_INVALID/);
});
