import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Duplex } from 'node:stream';
import { serveModelChannel } from './clean-agent-model-channel.mjs';

export function cleanInventory(root) {
  const files = []; let total = 0;
  function walk(relative = '') {
    const directory = path.join(root, relative);
    const before = fs.lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(directory) !== directory)
      throw new Error('CLEAN_AGENT_DIRECTORY_BOUNDARY');
    for (const name of fs.readdirSync(directory).sort()) {
      if (/[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('CLEAN_AGENT_UNSAFE_INPUT_NAME');
      const rel = relative ? `${relative}/${name}` : name, absolute = path.join(root, rel);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) throw new Error('CLEAN_AGENT_INPUT_LINK');
      if (stat.isDirectory()) { files.push({ path: rel, type: 'directory' }); walk(rel); }
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 134217728) throw new Error('CLEAN_AGENT_INPUT_TYPE');
        total += stat.size; if (total > 536870912) throw new Error('CLEAN_AGENT_INPUT_SIZE');
        const bytes = fs.readFileSync(absolute), after = fs.lstatSync(absolute);
        if ([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') !==
            [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') || bytes.length !== stat.size)
          throw new Error('CLEAN_AGENT_INPUT_CHANGED');
        files.push({ path: rel, type: 'file', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      if (files.length > 20000) throw new Error('CLEAN_AGENT_INPUT_ENTRIES');
    }
    const after = fs.lstatSync(directory);
    if ([before.dev, before.ino, before.mtimeMs, before.ctimeMs].join(':') !==
        [after.dev, after.ino, after.mtimeMs, after.ctimeMs].join(':')) throw new Error('CLEAN_AGENT_DIRECTORY_CHANGED');
  }
  walk(); return files;
}
export function validNamespaces(observed, parent) {
  return observed !== null && typeof observed === 'object' && Object.entries(parent).every(([name, value]) =>
    Object.hasOwn(observed, name) && typeof observed[name] === 'string' &&
    new RegExp(`^${name}:\\[\\d+\\]$`).test(observed[name]) && observed[name] !== value);
}
export async function runCleanAgentIsolation({ projectRoot, appDir, runRoot, expectedAppInventory, timeoutMs = 120000,
  modelDispatch, parentSecretValues = [], realModel = false }) {
  if (typeof realModel !== 'boolean' || (realModel && !modelDispatch)) throw new TypeError('CLEAN_AGENT_REAL_MODEL_CONTEXT');
  if (modelDispatch !== undefined && typeof modelDispatch !== 'function') throw new TypeError('CLEAN_AGENT_MODEL_DISPATCH');
  if (!Array.isArray(parentSecretValues) || parentSecretValues.some(value => typeof value !== 'string' || !value))
    throw new TypeError('CLEAN_AGENT_PARENT_SECRETS');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('CLEAN_AGENT_LINUX_X64_REQUIRED');
  for (const file of [projectRoot, appDir, runRoot, process.execPath]) {
    if (fs.realpathSync(file) !== path.resolve(file)) throw new Error('CLEAN_AGENT_PHYSICAL_PATH_REQUIRED');
  }
  if (!appDir.startsWith(projectRoot + '/.tmp/') || !runRoot.startsWith(projectRoot + '/.tmp/'))
    throw new Error('CLEAN_AGENT_OUTPUT_BOUNDARY');
  if (fs.existsSync(path.join(appDir, 'data'))) throw new Error('CLEAN_AGENT_OLD_DATA_DENIED');
  const runtime = fs.mkdtempSync(path.join(runRoot, 'attempt-'));
  for (const name of ['data', 'home', 'input', 'input/src', 'input/experiments'])
    fs.mkdirSync(path.join(runtime, name), { mode: 0o700 });
  const inventory = [];
  function copy(source, dest, relative) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('CLEAN_AGENT_INPUT_LINK');
    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { mode: 0o700 });
      for (const name of fs.readdirSync(source).sort()) copy(path.join(source, name), path.join(dest, name), `${relative}/${name}`);
    } else {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 134217728) throw new Error('CLEAN_AGENT_INPUT_TYPE');
      const bytes = fs.readFileSync(source), after = fs.lstatSync(source);
      if ([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') !==
          [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') || bytes.length !== stat.size)
        throw new Error('CLEAN_AGENT_INPUT_CHANGED');
      fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
      inventory.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  if (!Array.isArray(expectedAppInventory) || JSON.stringify(cleanInventory(appDir)) !== JSON.stringify(expectedAppInventory))
    throw new Error('CLEAN_AGENT_PREPARED_INVENTORY_CHANGED');
  copy(appDir, path.join(runtime, 'app-snapshot'), 'app');
  if (JSON.stringify(cleanInventory(appDir)) !== JSON.stringify(expectedAppInventory) ||
      JSON.stringify(cleanInventory(path.join(runtime, 'app-snapshot'))) !== JSON.stringify(expectedAppInventory))
    throw new Error('CLEAN_AGENT_SNAPSHOT_CHANGED');
  const beforeSrc = cleanInventory(path.join(projectRoot, 'src'));
  copy(path.join(projectRoot, 'src'), path.join(runtime, 'input/src'), 'src');
  if (JSON.stringify(cleanInventory(path.join(projectRoot, 'src'))) !== JSON.stringify(beforeSrc) ||
      JSON.stringify(cleanInventory(path.join(runtime, 'input/src'))) !== JSON.stringify(beforeSrc))
    throw new Error('CLEAN_AGENT_PROJECT_SOURCE_CHANGED');
  fs.mkdirSync(path.join(runtime, 'input/node_modules'));
  const wsSource = path.join(projectRoot, 'node_modules/ws'), beforeWs = cleanInventory(wsSource);
  copy(wsSource, path.join(runtime, 'input/node_modules/ws'), 'node_modules/ws');
  if (JSON.stringify(cleanInventory(wsSource)) !== JSON.stringify(beforeWs) ||
      JSON.stringify(cleanInventory(path.join(runtime, 'input/node_modules/ws'))) !== JSON.stringify(beforeWs))
    throw new Error('CLEAN_AGENT_PROJECT_DEPENDENCY_CHANGED');
  for (const name of ['clean-agent-full-linux.mjs', 'clean-agent-preload.mjs'])
    copy(path.join(projectRoot, 'experiments', name), path.join(runtime, 'input/experiments', name), `experiments/${name}`);
  if (modelDispatch) {
    fs.mkdirSync(path.join(runtime, 'input/scripts'));
    fs.mkdirSync(path.join(runtime, 'input/scripts/lib'));
    copy(path.join(projectRoot, 'scripts/lib/clean-agent-model-channel.mjs'),
      path.join(runtime, 'input/scripts/lib/clean-agent-model-channel.mjs'), 'scripts/lib/clean-agent-model-channel.mjs');
  }
  const bwrap = path.join(projectRoot, '.tools/bubblewrap/extracted/usr/bin/bwrap');
  const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--assert-userns-disabled',
    '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu',
    '--symlink', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/lib64/ld-linux-x86-64.so.2',
    '--ro-bind', process.execPath, '/bin/node', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', path.join(runtime, 'app-snapshot'), '/app', '--ro-bind', path.join(runtime, 'input'), '/project',
    '--bind', path.join(runtime, 'data'), '/working', '--bind', path.join(runtime, 'home'), '/lab-home',
    '--setenv', 'HOME', '/lab-home', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'QQ_AGENT_DATA_DIR', '/working',
    ...(modelDispatch ? ['--setenv', 'WHALE_CLEAN_MODEL_CHANNEL', '1'] : []),
    ...(realModel ? ['--setenv', 'WHALE_CLEAN_REAL_MODEL', '1'] : []),
    '--chdir', '/working', '--remount-ro', '/', '/bin/node', '/project/experiments/clean-agent-full-linux.mjs'];
  const parentNamespaces = Object.fromEntries(['net', 'pid', 'mnt', 'user'].map(name => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]));
  let modelChannel;
  const capture = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/timeout', ['-k', '5', String(Math.ceil(timeoutMs / 1000)), bwrap, ...args], {
      cwd: runtime, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: [modelDispatch ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exceeded = false;
    if (modelDispatch) {
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin }); stream.on('error', () => {});
      modelChannel = serveModelChannel(stream, { dispatch: modelDispatch, maxRequests: realModel ? 6 : 16, timeoutMs: realModel ? 120000 : 20000 });
    } else child.stdout.on('data', chunk => {
      stdout += chunk; if (stdout.length > 1048576) { exceeded = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk; if (stderr.length > 1048576) { exceeded = true; child.kill('SIGTERM'); }
    });
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      await modelChannel?.close(); resolve({ code, signal, stdout, stderr, exceeded });
    });
  });
  let observed;
  try {
    if (modelDispatch) {
      const lines = capture.stderr.split('\n').filter(line => line.startsWith('CLEAN_AGENT_FULL_RESULT='));
      if (lines.length !== 1) throw new Error('MISSING_CHANNEL_RESULT');
      observed = JSON.parse(lines[0].slice('CLEAN_AGENT_FULL_RESULT='.length));
      capture.stderr = capture.stderr.split('\n').filter(line => !line.startsWith('CLEAN_AGENT_FULL_RESULT=')).join('\n');
    } else observed = JSON.parse(capture.stdout.trim());
  } catch { observed = null; }
  let parentSecretsAbsent = true;
  if (modelDispatch && parentSecretValues.length) {
    const scan = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('CLEAN_AGENT_OUTPUT_LINK');
        if (stat.isDirectory()) scan(file);
        else {
          if (!stat.isFile() || stat.size > 268435456) throw new Error('CLEAN_AGENT_OUTPUT_BOUND');
          const bytes = fs.readFileSync(file);
          if (parentSecretValues.some(value => bytes.includes(Buffer.from(value)))) parentSecretsAbsent = false;
        }
      }
    };
    scan(path.join(runtime, 'data')); scan(path.join(runtime, 'home'));
    for (const secret of parentSecretValues) {
      if (JSON.stringify(observed).includes(secret) || capture.stdout.includes(secret) || capture.stderr.includes(secret)) parentSecretsAbsent = false;
      capture.stdout = capture.stdout.split(secret).join('[REDACTED]'); capture.stderr = capture.stderr.split(secret).join('[REDACTED]');
    }
    if (!parentSecretsAbsent) observed = { passed: false, stage: 'PARENT_CREDENTIAL_LEAK' };
  }
  const namespaceIsolation = validNamespaces(observed?.namespaces, parentNamespaces);
  return { passed: capture.code === 0 && !capture.signal && !capture.exceeded && observed?.passed === true && namespaceIsolation,
    at: new Date().toISOString(), runtime, appDir, inputInventory: inventory,
    bwrapSha256: createHash('sha256').update(fs.readFileSync(bwrap)).digest('hex'),
    nodeSha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    namespaceIsolation, parentNamespaces, observed, process: capture,
    ...(modelDispatch ? { modelChannel: modelChannel.stats(), parentCredentialAbsentFromDataAndLogs: parentSecretsAbsent } : {}),
    retained: 'Only this new test attempt; no existing profile or data was mounted.' };
}
