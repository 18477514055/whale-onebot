// Verify the fixed source archive by extracting it only into a new project
// temporary directory, then comparing its internal source manifest and workspace.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readSourceArchive } from './lib/source-archive.mjs';
const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const [mode, npmCli, agentApp, ...extra] = process.argv.slice(2);
assert(mode === undefined || (mode === '--smoke' && path.isAbsolute(npmCli ?? '') &&
  (agentApp === undefined || path.isAbsolute(agentApp)) && extra.length === 0),
  'Usage: verify-package.mjs [--smoke <absolute path to npm-cli.js> [absolute Agent Plus app path]]');
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'dist/manifest.json')));
assert.equal(manifest.file,'whale-onebot-0.1.0.tar.gz');
const archive=path.join(root,'dist',manifest.file);
assert.equal(digest(archive),manifest.sha256);assert.equal(fs.statSync(archive).size,manifest.bytes);
const tar=args=>{
  const result=spawnSync('tar',args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim().split(/\r?\n/).filter(Boolean);
};
// Native tar stdout uses the Windows active code page even for a UTF-8 PAX archive.
// Inventory and type checks therefore come from bounded, checksum-verified raw headers.
const inventory=readSourceArchive(archive),names=inventory.map(entry=>entry.name);
assert.equal(names.length,manifest.entries);
assert(inventory.every(entry=>entry.type==='file'||entry.type==='directory'),'Links and special files rejected');
const directories=new Set(['src','test','scripts','docs','experiments','evidence']);
const rootFiles=new Set(['README.md','AGENTS.md','admin-change-log.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','.gitignore']);
const normalized=names.map(name=>{
  assert(!name.includes('\\')&&!name.startsWith('/')&&!name.includes(':'));
  const value=name.replace(/\/$/,'');
  const parts=value.split('/');assert(parts.every(part=>part&&part!=='.'&&part!=='..'));
  assert(directories.has(parts[0])||(parts.length===1&&rootFiles.has(value)),'Unrecognized archive member');
  return value;
});
assert.equal(new Set(normalized).size,normalized.length,'Duplicate archive member');
const temp=path.join(root,'.tmp');fs.mkdirSync(temp,{recursive:true});assert.equal(fs.realpathSync(temp),temp);
const workspaces = [];
function createWorkspace(prefix) {
  const directory = fs.mkdtempSync(path.join(temp, prefix));
  assert.equal(path.dirname(directory), temp);
  assert.equal(fs.realpathSync(directory), directory);
  const { dev, ino } = fs.lstatSync(directory, { bigint: true });
  workspaces.push({ directory, dev, ino });
  return directory;
}

let report;
let verificationError;
try {
  const extracted = createWorkspace('archive-check-');
  tar(['-xzf',archive,'-C',extracted]);
  const sourceManifest=JSON.parse(fs.readFileSync(path.join(extracted,'evidence/source-manifest.json')));
  assert(Array.isArray(sourceManifest.files)&&sourceManifest.files.length>0);
  const paths=new Set();
  for(const entry of sourceManifest.files){
    assert(typeof entry.path==='string'&&normalized.includes(entry.path)&&!paths.has(entry.path));paths.add(entry.path);
    const inside=path.join(extracted,entry.path),live=path.join(root,entry.path);
    assert.equal(fs.realpathSync(inside),inside);assert(fs.lstatSync(inside).isFile());
    assert.equal(digest(inside),entry.sha256,`Archive source mismatch: ${entry.path}`);
    assert.equal(digest(live),entry.sha256,`Workspace changed after source manifest: ${entry.path}`);
  }
  const expectedSourceFiles=normalized.filter((name,index)=>inventory[index].type==='file'&&!name.startsWith('evidence/'));
  assert.deepEqual([...paths].sort(),expectedSourceFiles.sort(),'Source manifest coverage differs from archive');
  report={at:new Date().toISOString(),archive:manifest.file,sha256:manifest.sha256,bytes:manifest.bytes,
    entries:names.length,sourceFiles:paths.size,internalHashesMatch:true,workspaceHashesMatch:true,
    linksRejected:true,containsExistingData:false};
  if (mode === '--smoke') {
    assert.equal(path.basename(npmCli), 'npm-cli.js');
    const work = createWorkspace('archive-smoke-');
    const userConfig = path.join(work, 'user.npmrc');
    const globalConfig = path.join(work, 'global.npmrc');
    for (const config of [userConfig, globalConfig]) fs.writeFileSync(config, '', { flag: 'wx' });
    const env = { TEMP: work, TMP: work, TMPDIR: work };
    for (const key of ['SystemRoot', 'WINDIR', 'PATH']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    assert(!fs.existsSync(path.join(extracted, 'node_modules')));
    const dependencyInstall = spawnSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--include=optional',
      '--no-audit', '--no-fund', '--cache', path.join(work, 'cache'), '--userconfig', userConfig, '--globalconfig', globalConfig],
    { cwd: extracted, env, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true });
    assert.equal(dependencyInstall.status, 0, 'Clean locked dependency installation failed' +
      (dependencyInstall.error?.code ? ' (' + dependencyInstall.error.code + ')' : ''));
    assert.equal(digest(path.join(extracted, 'package-lock.json')), digest(path.join(root, 'package-lock.json')));
    const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { randomBytes } from 'node:crypto';
      import { main } from './src/cli.mjs';
      import sharp from 'sharp';
      const token = randomBytes(24).toString('hex');
      const app = await main({ env: { WHALE_ONEBOT_TOKEN: token, WHALE_ONEBOT_PORT: '0' }, log() {} });
      try {
        const url = 'http://127.0.0.1:' + app.server.address.port + '/get_status';
        const denied = await fetch(url, { signal: AbortSignal.timeout(3000) });
        assert.equal(denied.status, 401);
        await denied.body.cancel();
        const allowed = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000) });
        assert.equal(allowed.status, 200);
        assert.deepEqual(await allowed.json(), { status: 'ok', retcode: 0, data: { online: false, good: false } });
        const image = sharp({ create: { width: 1, height: 1, channels: 3, background: '#123456' } });
        assert.deepEqual([...await image.raw().toBuffer()], [18, 52, 86]);
      } finally {
        await app.close();
      }
    `], { cwd: extracted, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.error?.message);
    const transportSmoke = spawnSync(process.execPath, ['--test', 'test/cli.test.mjs'], {
      cwd: extracted, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    assert.equal(transportSmoke.status, 0, transportSmoke.stderr || transportSmoke.stdout || transportSmoke.error?.message);
    const evidenceSmoke = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      '--test-name-pattern=command client preserves|capability preview|live scope', 'test/online-observation.test.mjs', 'test/inbound-challenge.test.mjs'], {
      cwd: extracted, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    assert.equal(evidenceSmoke.status, 0, evidenceSmoke.stderr || evidenceSmoke.stdout || evidenceSmoke.error?.message);
    assert.match(evidenceSmoke.stdout, /^# pass 5\r?$/m, 'Expected all five packaged evidence checks');
    report.smoke = { platform: process.platform, node: process.version, cleanLockedInstall: true,
      httpAuthAndOfflineStatus: true, packagedCliTransportTestsPassed: true, packagedEvidenceTestsPassed: true,
      sharpPixelReadback: true, qqExecuted: false };
    if (agentApp !== undefined) {
      const probe = spawnSync(process.execPath, ['scripts/verify-agent-plus-client.mjs', agentApp], {
        cwd: extracted, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
      const client = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(client.actualAgentClient, true);
      for (const check of ['actualClientReconnectsAfterOneBotChildRestart', 'composedNativeBridgeReplyAndMention',
        'composedNativeBridgeFileMetadata', 'composedNativeBridgeGroupFileList', 'composedNativeBridgeImageUrl', 'reverseWebSocketReconnectsAndReadsSameReceipt',
        'composedNativeBridgeVoiceTranscription', 'composedNativeBridgeUnicodeReaction', 'composedNativeBridgeExtendedFace',
        'composedNativeBridgeReactionResponders',
        'composedNativeBridgeRecoversRestartGapViaHistory',
        'composedNativeBridgePreservesHistoryCursorAcrossReattachment',
        'composedNativeBridgeReportsUnsubmittedReattachmentAcrossTransports',
        'composedNativeBridgeReportsReadOnlyRecoveryWithPendingOutcome',
        'composedNativeBridgeRetainsReadOnlyServiceAfterUnknownWrite',
        'composedNativeBridgeMemberCacheMiss', 'composedNativeBridgeFriendRequests', 'composedNativeBridgeSelfProfile',
        'scopedReadOnlyAgentClient', 'scopedAdminReadOnlyAgentClient'])
        assert.equal(client.checks?.[check], true, 'Missing packaged integration check: ' + check);
      report.smoke.agentPlus = client;
    }
  }
} catch (error) {
  verificationError = error;
  throw error;
} finally {
  const errors = [];
  for (const { directory, dev, ino } of workspaces.reverse()) {
    try {
      assert.equal(fs.realpathSync(temp), temp);
      assert.equal(fs.realpathSync(directory), directory);
      const current = fs.lstatSync(directory, { bigint: true });
      assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === dev && current.ino === ino,
        'Temporary archive directory was replaced');
      fs.rmSync(directory, { recursive: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Could not clean up archive verification directories', { cause: verificationError });
}
report.temporaryDirectoriesRemoved = true;
const destination=path.join(root,mode === '--smoke' ? `dist/smoke-${process.platform}.json` : 'dist/verification.json');
if(fs.existsSync(destination)){const stat=fs.lstatSync(destination);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);}
fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
