import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createIntegratedHostPlan } from '../src/host/integrated-plan.mjs';
import { OnlineObservation, classifyIntegratedHostExit, summarizeRoundtripReachability } from '../src/host/online-observation.mjs';
import { parseSessionHold, sessionStartupLimitMs, sessionWatchdogDelay } from '../src/host/session-hold.mjs';
import { createModelBroker, createOriginalModelBroker } from '../src/host/full-agent-model-broker.mjs';
import { protectOriginalModelRelay } from '../src/host/model-relay-auth.mjs';
import { protectLocalBroker, OPENCODE_BASE, OPENCODE_MODEL } from './verify-opencode-model.mjs';
import { BOT_UIN, OWNER_UIN, TEST_GROUP } from '../src/config/account.mjs';

const mode = process.argv[2] ?? '--preflight';
assert(['--preflight', '--prepare-login', '--prepare-media', '--probe-media-path', '--login'].includes(mode));
const options = process.argv.slice(3);
const practicalAgent = options.includes('--phone-agent');
const originalAgent = options.includes('--original-agent');
assert(!(practicalAgent && originalAgent), 'Choose original normal mode or historical trial, not both');
if (originalAgent) {
  assert(['--prepare-login', '--login'].includes(mode), 'Original Agent requires preparation or login');
  options.splice(options.indexOf('--original-agent'), 1);
}
if (practicalAgent) {
  assert(['--prepare-login','--login'].includes(mode), 'Phone Agent requires login preparation or login');
  options.splice(options.indexOf('--phone-agent'),1);
}
const splitOneBotPorts = options.at(-1) === '--split-onebot-ports';
if (splitOneBotPorts) {
  assert(mode === '--login' || mode === '--prepare-login', 'Split OneBot ports require login or login preparation');
  options.pop();
}
assert(!originalAgent || options.length === 0, 'Original normal mode is resident; --hold-hours is for bounded calibration only');
const sessionHoldMs = parseSessionHold(mode, options);
const preflight = mode === '--preflight';
const networkShared = mode === '--login';
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function physical(p, directory = false) {
  assert.equal(fs.realpathSync(p), p);
  const stat = fs.lstatSync(p);
  assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
  return stat;
}
function pinned(relative, sha256) {
  const file = path.join(root, relative);
  physical(file);
  const bytes = fs.readFileSync(file);
  assert.equal(digest(bytes), sha256);
  return JSON.parse(bytes);
}
const base = pinned('experiments/first-native-load/manifest.json', '25825a05c94eabdd905eca379c57fe40a693cb133f306c9b6aae42ae3f0a6d79');
const candidate = pinned('experiments/native-load-candidate/manifest.json', '18cab930da889b84c5f3ad8911220801ed0ffbb53c21e89fd16efba668b6d895');
const scope = pinned('evidence/native-host-scope-linux.json', 'c1468d133250e43a3ae69e702ffdec14456cde6890de60c07ca2032b5d99a4ca');
assert.equal(process.version, base.version);
assert.equal(digest(JSON.stringify(process.config)), base.nodeConfigSha256);
function entry(kind, source, guest, expected) {
  const bytes = physical(source).size;
  const sha256 = digest(fs.readFileSync(source));
  if (expected) {
    assert.equal(bytes, expected.bytes);
    assert.equal(sha256, expected.sha256);
  }
  return { kind, source, guest, sha256, bytes };
}
entry('metadata', base.bwrap.source, '/input/bwrap', base.bwrap);
const temporary = path.join(root, '.tmp');
const runtime = path.join(root, 'runtime');
const lock = path.join(runtime, 'integrated-login.lock');
const profileId = mode.slice(2) + '-' + randomBytes(10).toString('hex');
if (networkShared) {
  if (!fs.existsSync(runtime)) fs.mkdirSync(runtime);
  physical(runtime, true);
  const found = spawnSync('/usr/bin/pgrep', ['-f', '^/mnt/d/qq-onebot/[.]tools/[^ ]+/bin/node /mnt/d/qq-onebot/scripts/(login-qr|session-ready|status-calibration)-linux[.]mjs --start$']);
  assert.equal(found.status, 1, 'An owned login runner is active or its state could not be checked');
}
let lockFd;
if (networkShared) {
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.error('An integrated QQ login already owns the experiment lock.');
    process.exit(2);
  }
}
try {
  if (lockFd !== undefined) fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, profileId }));
  await run();
} finally {
  if (lockFd !== undefined) {
    const original = fs.fstatSync(lockFd);
    fs.closeSync(lockFd);
    const current = fs.lstatSync(lock, { throwIfNoEntry: false });
    if (current?.ino === original.ino && current.dev === original.dev) fs.unlinkSync(lock);
  }
}

async function run() {
  if (!fs.existsSync(temporary)) fs.mkdirSync(temporary);
  physical(temporary, true);
  const work = fs.mkdtempSync(path.join(temporary, 'integrated-inputs-'));
  const systemLibraries = base.normalMounts.map(m => {
    const verified = entry('library', m.source, m.target, m);
    if (m.source.startsWith(root + '/')) return verified;
    assert(m.source.startsWith('/usr/lib/x86_64-linux-gnu/'));
    const copy = path.join(work, path.basename(m.target));
    fs.copyFileSync(m.source, copy, fs.constants.COPYFILE_EXCL);
    return entry('library', copy, m.target, m);
  });
  // The host may outlive edits to the workspace. Mount a per-run driver just
  // like the per-run source tree, and verify the bytes that actually ran.
  const driverSource = path.join(root, 'experiments/integrated-host', preflight ? 'preflight.mjs' : 'login.mjs');
  physical(driverSource);
  const driver = path.join(work, 'driver.mjs');
  fs.copyFileSync(driverSource, driver, fs.constants.COPYFILE_EXCL);
  const packageSource = path.join(root, 'package.json');
  physical(packageSource);
  const packageSnapshot = path.join(work, 'package.json');
  fs.copyFileSync(packageSource, packageSnapshot, fs.constants.COPYFILE_EXCL);
  const inputs = [
    entry('node', process.execPath, '/bin/node', base.node),
    entry('provider', scope.artifacts.provider.path, '/host/libonebot-node-host.so', scope.artifacts.provider),
    entry('loader', candidate.artifacts.loader.source, '/input/loader.node', candidate.artifacts.loader),
    ...base.qqMounts.map(m => entry(m.kind === 'qq-wrapper' ? 'wrapper' : 'library', m.source, m.target, m)),
    ...systemLibraries,
    entry('metadata', driver, '/input/driver.mjs'),
    entry('metadata', packageSnapshot, '/qq-onebot/package.json'),
  ];
  let agentSettings, modelBroker, modelAuth;
  if (practicalAgent || originalAgent) {
    const current = JSON.parse(fs.readFileSync(path.join(root,'evidence/phone-agent-current-runtime-20261115.json'),'utf8'));
    const deps = JSON.parse(fs.readFileSync(path.join(root,'evidence/phone-agent-current-linux-deps-phone-agent-deps-OkS7xy-20261115.json'),'utf8'));
    assert(deps.passed && current.linuxWork.startsWith(root+'/.tmp/phone-agent-runtime-'));
    const restored = fs.existsSync(path.join(current.linuxWork,'original-settings-restored.json'));
    if (practicalAgent && restored)
      throw Error('D12_ORIGINAL_SETTINGS_REQUIRE_NORMAL_MODE_NOT_PRACTICAL_OVERLAY');
    if (originalAgent && !restored) throw Error('ORIGINAL_SETTINGS_RESTORATION_REQUIRED');
    const appRoot = current.linuxWork+'/app';
    const appSnapshot = path.join(work,'agent-app');
    fs.mkdirSync(appSnapshot);
    function copyAppTree(source, relative='') {
      physical(source,true);
      for (const child of fs.readdirSync(source,{withFileTypes:true})) {
        const name = relative ? relative+'/'+child.name : child.name;
        if (name==='node_modules') continue;
        const from=path.join(source,child.name), to=path.join(appSnapshot,name);
        if(child.isDirectory()){fs.mkdirSync(to);copyAppTree(from,name);}
        else { assert(child.isFile()); physical(from); fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
          inputs.push(entry('metadata',to,'/input/agent-app/'+name)); }
      }
    }
    copyAppTree(appRoot);
    function copyDependencyTree(source,relative='') {
      physical(source,true);
      for(const child of fs.readdirSync(source,{withFileTypes:true})){
        const name=relative?relative+'/'+child.name:child.name,from=path.join(source,child.name);
        const to=path.join(appSnapshot,'node_modules',name);
        if(child.isDirectory()){fs.mkdirSync(to,{recursive:true});copyDependencyTree(from,name);}
        else{assert(child.isFile());physical(from);fs.mkdirSync(path.dirname(to),{recursive:true});
          fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);inputs.push(entry('metadata',to,'/input/agent-app/node_modules/'+name));}
      }
    }
    copyDependencyTree(deps.app+'/node_modules');
    const preloadName = originalAgent ? 'original-agent-preload.mjs' : 'practical-agent-preload.mjs';
    const preload=path.join(work,preloadName);
    fs.copyFileSync(path.join(root,'experiments',preloadName),preload,fs.constants.COPYFILE_EXCL);
    inputs.push(entry('metadata',preload,'/input/'+preloadName));
    let phaseDir;
    if (practicalAgent) {
      phaseDir = networkShared ? path.join(root,'runtime/practical-chat-stage-20261115') : path.join(work,'phase');
      fs.mkdirSync(phaseDir,{recursive:true,mode:0o700});
      const phaseFile=path.join(phaseDir,'chat-phase.json');
      if(networkShared && !fs.existsSync(phaseFile)){
        const marker=path.join(phaseDir,'initialized-once');
        fs.writeFileSync(marker,'D10 practical trial; do not reset\n',{flag:'wx',mode:0o600});
        const fd=fs.openSync(phaseFile,'wx',0o600);
        try{fs.writeFileSync(fd,JSON.stringify({phaseId:'d6-live-agent-2026-11-15',bot:BOT_UIN,group:TEST_GROUP,tester:OWNER_UIN,limit:3,count:0,pending:false,frozen:false}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      }
      if(networkShared){
        const phase=JSON.parse(fs.readFileSync(phaseFile,'utf8'));
        assert.equal(phase.phaseId,'d6-live-agent-2026-11-15');
        assert(phase.count>=0&&phase.count<3&&!phase.pending&&!phase.frozen&&!fs.existsSync(phaseFile+'.owner'),'Practical phase exhausted, owned or uncertain; do not restart');
      }
    }
    const consoleReservation=net.createServer();
    await new Promise(resolve=>consoleReservation.listen(0,'127.0.0.1',resolve));
    const consolePort=consoleReservation.address().port;
    await new Promise(resolve=>consoleReservation.close(resolve));
    let data = current.linuxWork+'/data', home = current.linuxWork+'/home';
    if (originalAgent && !networkShared) {
      // Preparation must not advance original messages, reminders or timers.
      // Only the real App source/dependencies are used here; all data is synthetic.
      data = path.join(work, 'original-preparation-data'); home = path.join(work, 'original-preparation-home');
      fs.mkdirSync(data); fs.mkdirSync(home); fs.mkdirSync(path.join(home, 'tmp'));
      fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({
        server:{host:'127.0.0.1',port:consolePort,token:''},
        onebot:{wsUrl:'ws://127.0.0.1:9',httpUrl:'http://127.0.0.1:9',accessToken:'',httpAccessToken:''},
        api:{baseUrl:OPENCODE_BASE,model:OPENCODE_MODEL,apiKey:'',priceRemoteUrl:'none'},
        runtime:{mode:'active',paused:false},allow:{groups:[],private:[]},allowAllWhenEmpty:false,
        persona:'SYNTHETIC_PREPARATION_ONLY',
      }),{flag:'wx',mode:0o600});
    }
    if (originalAgent && networkShared) {
      // No second App may own this working copy. Do not inspect argv/env contents.
      const owners=spawnSync('/usr/bin/pgrep',['-f','^/bin/node --import (file://)?/input/(practical|original)-agent-preload[.]mjs /input/agent-app/src/server[.]js$']);
      assert.equal(owners.status,1,'An Agent working-copy owner exists or could not be checked');
      if (!fs.existsSync(path.join(home,'tmp'))) fs.mkdirSync(path.join(home,'tmp'));
    }
    agentSettings={ data, home, phaseDir, appSnapshot, consolePort, originalData:networkShared,
      onebotSha256:digest(fs.readFileSync(path.join(appSnapshot,'src/onebot/onebot.js'))) };
    if(networkShared){
      // D8: opaque credential loading only; never print/hash/copy this file.
      let apiKey;
      try{const file='/mnt/c/Users/24239/Desktop/apikey.txt',s=fs.lstatSync(file);
        assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=65536);
        const bytes=fs.readFileSync(file);try{
          apiKey=bytes[0]===0xff&&bytes[1]===0xfe?bytes.subarray(2).toString('utf16le').trim():
            bytes[0]===0xfe&&bytes[1]===0xff?Buffer.from(bytes.subarray(2)).swap16().toString('utf16le').trim():new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();
        }finally{bytes.fill(0);}
      }catch{throw Error('OPENCODE_CREDENTIAL_FILE_FAILED');}
      modelBroker=originalAgent
        ? createOriginalModelBroker({baseUrl:OPENCODE_BASE,apiKey})
        : createModelBroker({baseUrl:OPENCODE_BASE,apiKey,model:OPENCODE_MODEL,maxRequests:64,maxTokens:32768,
          maxInputBytes:8388608,maxOutputBytes:8388608,timeoutMs:120000}); apiKey=undefined;
      modelAuth=originalAgent ? protectOriginalModelRelay(modelBroker) : protectLocalBroker(modelBroker);
      await new Promise(resolve=>modelBroker.server.listen(0,'127.0.0.1',resolve));
      agentSettings.modelBase='http://127.0.0.1:'+modelBroker.server.address().port+'/v1';
    }
  }
  if (preflight || mode === '--prepare-login' || networkShared) {
    // Mount only the reviewed client module and its three source dependencies.
    // The guest resolves ws from the existing, independently verified package.
    const clientSources = {
      'onebot/onebot.js': '7df8444ff930d437d37ba621e95e07fa00f6cb3e9fdf4b49efac14816c9a2f6d',
      'onebot/face-catalog.js': '51f90d00e204b1d1542e221e7f577f1f541ec53e5d7a342b024ad4bc1f4aa256',
      'core/util.js': '823e4390ec3a9ede6e0a18d0f64cd6ca0d114448ee2477d35857777cd00b0ab0',
      'core/http-body.js': '5a5891ead4e2b66cf6521827e28e146d27d538da3e409acd20307b0af0e32627',
    };
    const reviewed = [];
    for (const [relative, expectedHash] of Object.entries(clientSources)) {
      const source = '/mnt/d/QQ-Agent/app/src/' + relative;
      if (!fs.existsSync(source)) break;
      physical(source);
      const bytes = fs.readFileSync(source);
      if (digest(bytes) !== expectedHash) break;
      reviewed.push([relative, bytes]);
    }
    if (reviewed.length === Object.keys(clientSources).length) for (const [relative, bytes] of reviewed) {
      const copy = path.join(work, 'agent-client', relative);
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, bytes, { flag: 'wx' });
      inputs.push(entry('metadata', copy, '/qq-onebot/agent-client/' + relative));
    }
  }
  function walk(relative, kind) {
    const dir = path.join(root, relative);
    physical(dir, true);
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = relative + '/' + item.name;
      if (item.isDirectory()) walk(child, kind);
      else {
        assert(item.isFile());
        inputs.push(entry(kind, path.join(root, child), '/qq-onebot/' + child));
      }
    }
  }
  walk('src', 'source');
  for (const name of ['ws', 'sharp', '@img/colour', 'detect-libc', 'semver', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64'])
    walk('node_modules/' + name, 'dependency');
  const plan = createIntegratedHostPlan({ platform: 'linux', projectRoot: root, profileId, inputs });
  for (const relative of ['.tmp', 'runtime', 'runtime/integrated', 'runtime/integrated-control', 'evidence']) {
    const dir = path.join(root, relative);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    physical(dir, true);
  }
  const writeMounts = plan.mounts.filter(m => m.access !== 'read-only');
  for (const mount of writeMounts) fs.mkdirSync(mount.source, { mode: 0o700 });
  for (const dir of ['home', 'config', 'cache']) fs.mkdirSync(path.join(plan.profile.path, dir), { mode: 0o700 });
  // 正式使用：QQ 登录态（login.db + nt_qq 账号目录 + msf 设备指纹）固定持久化，
  // 跨启动复用，使快速登录免扫码。global 目录独立于随机 profile，是唯一复用的运行时状态。
  const loginStateRoot = path.join(runtime, 'qq-login-state');
  const loginStateGlobal = path.join(loginStateRoot, 'global');
  for (const dir of [loginStateRoot, loginStateGlobal]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    physical(dir, true);
  }
  const snapshot = path.join(work, 'snapshot');
  const treeInputs = plan.inputManifest.entries.filter(x => ['source', 'dependency'].includes(x.kind));
  const mountedSource = item => ['source', 'dependency'].includes(item.kind) ? path.join(snapshot, item.guest) : item.source;
  for (const item of treeInputs) {
    const target = mountedSource(item);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(item.source, target, fs.constants.COPYFILE_EXCL);
    entry(item.kind, target, item.guest, item);
  }
  const snapshotIdentity = physical(snapshot, true);
  function verifySnapshotInventory() {
    const actual = [];
    function walkSnapshot(directory) {
      physical(directory, true);
      for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, file.name);
        if (file.isDirectory()) walkSnapshot(target);
        else {
          assert(file.isFile());
          actual.push(target);
        }
      }
    }
    walkSnapshot(snapshot);
    assert.deepEqual(actual.sort(), treeInputs.map(mountedSource).sort());
  }
  verifySnapshotInventory();
  const hostCanary = path.join(work, 'unmounted-canary');
  fs.writeFileSync(hostCanary, 'synthetic-only', { flag: 'wx' });
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const hostPort = server.address().port;
  const configName = preflight ? 'preflight.json' : 'login.json';
  const config = path.join(work, configName);
  const namespaces = Object.fromEntries(['user', 'net', 'mnt', 'pid', 'ipc'].map(n => [n, fs.readlinkSync('/proc/self/ns/' + n)]));
  fs.writeFileSync(config, JSON.stringify({
    entries: plan.inputManifest.entries, manifestSha256: plan.inputManifest.sha256,
    inputContentSha256: plan.inputManifest.contentSha256, hostPort, hostCanary, namespaces,
    parentNamespaces: namespaces, runId: profileId, networkShared, initializeOnly: mode === '--prepare-login',
    sessionHoldMs, splitOneBotPorts, originalAgent, normalResident: originalAgent && networkShared,
    originalData: originalAgent ? agentSettings?.originalData : undefined,
    practicalAgent, practicalOnebotSha256: agentSettings?.onebotSha256, practicalConsolePort:agentSettings?.consolePort,
    mediaOnly: mode === '--prepare-media',
    mediaPathOnly: mode === '--probe-media-path',
  }), { flag: 'wx', mode: 0o600 });
  const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--assert-userns-disabled', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv'];
  if (networkShared) {
    args.push('--share-net');
    const resolvers = fs.readFileSync('/etc/resolv.conf', 'utf8').split('\n').filter(line => /^nameserver\s+[0-9a-fA-F:.]+\s*$/.test(line));
    assert(resolvers.length > 0 && resolvers.length <= 3);
    const file = path.join(work, 'resolv.conf');
    fs.writeFileSync(file, resolvers.join('\n') + '\n', { flag: 'wx' });
    args.push('--ro-bind', file, '/etc/resolv.conf');
  }
  for (const item of plan.inputManifest.entries.filter(x => !['source', 'dependency'].includes(x.kind)))
    args.push('--ro-bind', item.source, item.guest);
  for (const tree of ['/qq-onebot/src', '/qq-onebot/node_modules'])
    args.push('--ro-bind', path.join(snapshot, tree), tree);
  for (const mount of writeMounts)
    args.push(mount.access.includes('write') ? '--bind' : '--ro-bind', mount.source, mount.guest);
  // 正式使用：QQ 登录态固定持久化目录覆盖 profile 内的 global，跨启动复用登录态。
  args.push('--bind', loginStateGlobal, '/qq-onebot/runtime/global');
  args.push('--ro-bind', config, '/input/' + configName,
    '--symlink', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/lib64/ld-linux-x86-64.so.2',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const name of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'])
    args.push('--setenv', name, plan.environment[name]);
  args.push('--setenv', 'QQ_AGENT_DATA_DIR', '/qq-onebot/.tmp');
  if (practicalAgent || originalAgent) {
    args.push('--bind',agentSettings.data,'/working','--bind',agentSettings.home,'/lab-home',
      '--bind',agentSettings.data,'/data/data/com.termux/files/home/qqagent/data',
      '--ro-bind',agentSettings.appSnapshot,'/data/data/com.termux/files/home/qqagent/app');
    if (practicalAgent) args.push('--bind',agentSettings.phaseDir,'/phase-state');
    if (networkShared) args.push('--setenv','WHALE_MODEL_BROKER_BASE',agentSettings.modelBase,
      '--setenv','WHALE_MODEL_RELAY_TOKEN',modelAuth.token);
  }
  args.push('--chdir', plan.environment.cwd, '--remount-ro', '/', '/bin/node', '/input/driver.mjs');
  function readStatus() {
    const file = path.join(plan.profile.path, 'status.json');
    if (!fs.existsSync(file)) return null;
    if (physical(file).size > 32768) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  try {
    // Positive control for the listener that the isolated child must fail to reach.
    await new Promise((resolve, reject) => net.createConnection({ host: '127.0.0.1', port: hostPort }).once('error', reject).once('end', resolve));
    const observed = await new Promise((resolve, reject) => {
      const startedAt = process.hrtime.bigint();
      // Point-in-time reachability and timed exposure are reported independently.
      const observation = networkShared ? new OnlineObservation({ maxGapMs: 3000 }) : null;
      observation?.record({ atMs: 0, kind: 'unverified', generation: 1 });
      const child = spawn(base.bwrap.source, args, { cwd: work, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      let deadlineElapsed = false;
      const expire = () => { deadlineElapsed = child.kill('SIGKILL'); };
      let holdWatchdogArmed = false;
      let timer;
      const armHoldWatchdog = state => {
        if (!networkShared || holdWatchdogArmed || deadlineElapsed) return false;
        if (originalAgent) {
          if (state.phase !== 'session-ready-observed' || state.identityMatches !== true ||
              state.initCallbackAccepted !== true || state.sessionHold?.state !== 'resident') return false;
          clearTimeout(timer);
          holdWatchdogArmed = true;
          return true;
        }
        const holdDelay = sessionWatchdogDelay(state, sessionHoldMs);
        if (holdDelay === null) return false;
        clearTimeout(timer);
        timer = setTimeout(expire, holdDelay);
        holdWatchdogArmed = true;
        return true;
      };
      timer = setTimeout(() => {
        if (networkShared) {
          try { if (armHoldWatchdog(readStatus())) return; } catch {}
        }
        expire();
      }, networkShared ? sessionStartupLimitMs : (practicalAgent || originalAgent) ? 225000 : 45000);
      let captured = 0, lastPhase, qrPublished = false;
      const terminate = () => child.kill('SIGTERM');
      process.once('SIGTERM', terminate);
      process.once('SIGINT', terminate);
      const poll = setInterval(() => {
        if (preflight) return;
        try {
          const state = readStatus();
          if (!state) return;
          armHoldWatchdog(state);
          let qrFile;
          if (!qrPublished && state.qrRequests === 1 && state.sessionGeneration === 1 &&
              ['qr-ready', 'qr-polling', 'requesting-qr'].includes(state.phase)) {
            const candidate = path.join(plan.profile.path, 'qr.png');
            if (fs.existsSync(candidate)) {
              const size = physical(candidate).size;
              if (size >= 32 && size <= 1024 * 1024) {
                qrFile = candidate;
                qrPublished = true;
              }
            }
          }
          const phaseKey=state.phase+((practicalAgent||originalAgent)?':'+(state.liveAgent?.stage??'waiting'):'');
          if (phaseKey === lastPhase && !qrFile) return;
          lastPhase = phaseKey;
          console.log(JSON.stringify({ phase: state.phase, identityMatches: state.identityMatches === true, qrFile,
            ...((practicalAgent||originalAgent)?{liveAgent:state.liveAgent}: {}) }));
        } catch {}
      }, 300);
      if (!preflight) console.log(JSON.stringify({ mode, profile: plan.profile.path, control: writeMounts.find(m => m.guest === '/control').source }));
      for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
        captured = Math.min(Number.MAX_SAFE_INTEGER, captured + chunk.length);
        if (!originalAgent && captured > (preflight ? 65536 : 8 * 1024 * 1024)) child.kill('SIGKILL');
        else if (preflight && name === 'stdout') stdout += chunk;
        else if (preflight) stderr += chunk;
      });
      child.once('error', error => {
        clearTimeout(timer);
        clearInterval(poll);
        process.removeListener('SIGTERM', terminate);
        process.removeListener('SIGINT', terminate);
        reject(error);
      });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        clearInterval(poll);
        process.removeListener('SIGTERM', terminate);
        process.removeListener('SIGINT', terminate);
        try {
          if (!preflight) {
            const state = readStatus();
            if (observation) {
              const atMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
              const kind = classifyIntegratedHostExit({ phase: state?.phase, signal, status, deadlineElapsed });
              observation.record({ atMs: Math.max(1, atMs), kind, generation: 1 });
            }
            resolve({ status, signal, phase: state?.phase, loginConnectAttempts: state?.loginConnectAttempts, qrRequests: state?.qrRequests,
              initAttempts: state?.sessionInitAttempts, identityMatches: state?.identityMatches === true, outputBytesDiscarded: captured,
              onlineObservation: observation?.summarize(),
              roundtripReachability: observation ? summarizeRoundtripReachability(state) : undefined,
              roundtripResult: observation ? state?.roundtripResult : undefined });
            return;
          }
          assert.equal(status, 0, stderr);
          assert.equal(signal, null);
          resolve(JSON.parse(stdout));
        } catch (error) { reject(error); }
      });
    });
    if (preflight) {
      assert.equal(observed.manifestSha256, plan.inputManifest.sha256);
      assert.equal(Object.keys(observed.checks).length, 27);
      assert.equal(observed.checks.scopedReadOnlyChallengeThroughWebSocket, true);
      assert.equal(observed.checks.oneBotChallengeRequiresOfflineEndpoints, true);
      assert.equal(observed.checks.oneBotReverseEventMatchesForward, true);
      assert.equal(observed.checks.oneBotOfflineStartThenAttach, true);
      assert.equal(observed.checks.oneBotProcessRestartsWithoutReplacingNativeListener, true);
      assert.equal(observed.checks.oneBotBridgeReattachmentPreservesMessageId, true);
      assert.equal(observed.checks.oneBotRetainedTerminalIdReadOnAllTransports, true);
      assert.equal(observed.checks.oneBotReceiveChallengeThroughWebSocket, true);
      assert.equal(observed.checks.oneBotInboundReadbackWithoutSend, true);
      assert.equal(observed.checks.oneBotRoundtripChallengeConfirmed, true);
      assert.equal(observed.checks.oneBotRoundtripAuthenticatedUidReceipt, true);
      assert.equal(observed.checks.oneBotUnknownReplyReadbackRetainsPending, true);
      assert.equal(observed.checks.oneBotDualPortRoundtripRestored, true);
      assert.equal(observed.checks.oneBotRestartedReverseOfflineAction, true);
      assert.equal(observed.checks.oneBotRoundtripResumesWithoutResendingChallenge, true);
      assert.equal(observed.checks.composedSessionSyntheticReceipt, true);
      assert.equal(observed.checks.composedSessionLatchAndPortReuse, true);
      assert(Object.values(observed.checks).every(value => value === true));
    } else if (mode === '--prepare-login') {
      assert.equal(observed.phase, 'login-service-initialized-offline');
      assert.equal(observed.status, 0);
      assert.equal(observed.loginConnectAttempts, 0);
      assert.equal(observed.qrRequests, 0);
      assert.equal(observed.initAttempts, 0);
      const guestPreflight = path.join(plan.profile.path, 'preflight.json');
      assert(physical(guestPreflight).size <= 32768);
      const guest = JSON.parse(fs.readFileSync(guestPreflight, 'utf8'));
      assert.equal(guest.manifestSha256, plan.inputManifest.sha256);
      observed.exactInputInventory = guest.checks.exactInputInventory;
      assert.equal(observed.exactInputInventory, true);
      observed.services = readStatus()?.services;
      assert.deepEqual(Object.keys(observed.services ?? {}).sort(), ['getBuddyService', 'getGroupService',
        'getMsgService', 'getProfileLikeService', 'getProfileService', 'getRichMediaService', 'getRobotService']);
      observed.roundtripServices = readStatus()?.roundtripServices;
      assert.deepEqual(observed.roundtripServices, { inboundListener: false, send: false, messageReadback: false,
        groupInfo: false, historyReconciliation: false, roundtripMethodsAvailable: false });
      observed.statusEndpoint = readStatus()?.statusEndpoint;
      const reverseWebSocket = { connected: true, pongVerified: true };
      const reverseStatusVerified = { ...reverseWebSocket, authenticatedOfflineStatus: true };
      assert.deepEqual(observed.statusEndpoint, { unauthenticatedStatusRejected: true,
        authenticatedOfflineStatus: true, businessActionsAdvertised: false, reverseWebSocket: reverseStatusVerified,
        authenticatedOfflineWebSocket: true });
      observed.oneBotRestart = readStatus()?.oneBotRestart;
      assert.deepEqual(observed.oneBotRestart, { replacedChild: true, portReused: true, authenticatedOfflineStatus: true,
        reverseWebSocket: reverseStatusVerified,
        ...(splitOneBotPorts && { webSocketPortReused: true }) });
      observed.oneBotStatus = readStatus()?.oneBotStatus;
      const expectedStatus = { endpointResponded: true, status: { online: false, good: false } };
      assert.deepEqual(observed.oneBotStatus, { ...expectedStatus, reverseWebSocket: { ...reverseWebSocket, ...expectedStatus },
        webSocket: expectedStatus, sessionHold: { state: 'not-started', remainingMs: null },
        nativeSession: { checked: false, matchesAuthenticatedSession: null } });
      if(practicalAgent){
        observed.practicalAgent=readStatus()?.liveAgent;
        assert.equal(observed.practicalAgent?.stage,'offline-app-prepared');
        assert.equal(observed.practicalAgent?.activationRoutesVerified,true);
      }
      if(originalAgent){
        observed.originalAgent=readStatus()?.liveAgent;
        assert.equal(observed.originalAgent?.stage,'offline-original-app-prepared');
        assert.equal(observed.originalAgent?.businessSettingsPreserved,true);
        assert.equal(observed.originalAgent?.originalData,false);
        assert.equal(observed.originalAgent?.activationRoutesUsed,false);
        assert.equal(observed.originalAgent?.processExit?.code,0);
      }
      observed.oneBotShutdown = readStatus()?.oneBotShutdown;
      assert.deepEqual(observed.oneBotShutdown, { childExited: true, portsClosed: true, reverseDisconnected: true, ownerLockReleased: true });
    } else if (mode === '--prepare-media') {
      assert.equal(observed.phase, 'media-copy-verified-offline');
      assert.equal(observed.status, 0);
      assert.equal(observed.qrRequests, 0);
      observed.media = readStatus()?.media;
      assert.equal(observed.media?.input, 'onebot-base64');
      assert(observed.media?.bytes > 0);
    } else if (mode === '--probe-media-path') {
      observed.mediaPath = readStatus()?.mediaPath;
    }
    verifySnapshotInventory();
    for (const item of plan.inputManifest.entries) entry(item.kind, mountedSource(item), item.guest, item);
    // The guest has exited. Keep the manifest and run diagnostics, but discard
    // the verified source/dependency copy for successful offline preparations.
    const removeInputSnapshot = !networkShared && (preflight || observed.status === 0);
    if (removeInputSnapshot) {
      assert.equal(path.dirname(work), temporary);
      physical(temporary, true);
      physical(work, true);
      const current = physical(snapshot, true);
      assert.equal(current.dev, snapshotIdentity.dev);
      assert.equal(current.ino, snapshotIdentity.ino);
      fs.rmSync(snapshot, { recursive: true, maxRetries: 3, retryDelay: 100 });
    }
    const report = { at: new Date().toISOString(), profileId, work: path.relative(root, work),
      inputManifest: configName, inputManifestSha256: plan.inputManifest.sha256,
      inputContentSha256: plan.inputManifest.contentSha256, splitOneBotPorts, practicalAgent, originalAgent,
      resident:originalAgent&&networkShared, originalData:originalAgent ? networkShared : undefined, inputCount: inputs.length,
      mountedInputsVerifiedAtExit: true, inputSnapshotRemoved: removeInputSnapshot, hostLoopbackPositiveControl: true,
      qqExecuted: !preflight, networkShared, observed };
    const file = preflight ? path.join(root, 'evidence/integrated-preflight-linux.json') :
      mode === '--prepare-login' ? path.join(root, originalAgent ? 'evidence/integrated-original-agent-preparation-linux-20261115.json' : practicalAgent ? 'evidence/integrated-phone-agent-preparation-linux-20261115.json' : 'evidence/integrated-login-preparation-linux.json') :
      mode === '--prepare-media' ? path.join(root, 'evidence/integrated-media-copy-linux.json') :
      mode === '--probe-media-path' ? path.join(root, 'evidence/integrated-media-path-linux.json') : path.join(work, 'parent-result.json');
    if (fs.existsSync(file)) physical(file);
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    if (!preflight && observed.status !== 0) process.exitCode = 1;
  } finally {
    await modelBroker?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
