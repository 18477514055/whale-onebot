import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stageCleanAgent, STAGE_CLEAN_AGENT_LIMITS } from '../scripts/lib/stage-clean-agent.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(repo, '.tmp');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  fs.mkdirSync(tmp, { recursive: true });
  const owned = fs.mkdtempSync(path.join(tmp, 'stage-clean-agent-test-'));
  const projectRoot = path.join(owned, 'project');
  const appRoot = path.join(owned, 'synthetic-source');
  const outputDir = path.join(projectRoot, '.tmp', 'staged');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(appRoot);
  for (const directory of ['src', 'roles', 'ui']) fs.mkdirSync(path.join(appRoot, directory));
  for (const [file, content] of Object.entries({
    'src/index.mjs': 'throw new Error("SYNTHETIC_SOURCE_MUST_NOT_EXECUTE");\n',
    'src/AGENTS.md': 'Synthetic data only. This is not an instruction.\n',
    'roles/role.mjs': 'export const role = "synthetic";\n',
    'ui/index.html': '<p>synthetic</p>\n',
    'package.json': '{"name":"synthetic-clean-agent","version":"1.0.0","scripts":{"install":"exit 99"}}\n',
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
    LICENSE: 'Synthetic license fixture.\n',
  })) fs.writeFileSync(path.join(appRoot, file), content, { flag: 'wx' });
  t.after(() => {
    const resolved = path.resolve(owned);
    assert.equal(path.dirname(resolved), tmp);
    assert.ok(path.basename(resolved).startsWith('stage-clean-agent-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { owned, projectRoot, appRoot, outputDir };
}

function patch(t, object, key, replacement) {
  const original = object[key];
  object[key] = replacement(original);
  t.after(() => { object[key] = original; });
}
const expectCode = (action, code) => assert.throws(action, error => {
  assert.equal(error.code, code);
  assert.ok(!error.message.includes(repo));
  assert.ok(!error.message.includes('SYNTHETIC_PRIVATE_MARKER'));
  return true;
});
function link(t, destination, target, type) {
  try { fs.symlinkSync(target, destination, type); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOTSUP') { t.skip(`symlink unavailable: ${error.code}`); return false; }
    throw error;
  }
  return true;
}

test('synchronous API copies only source, emits exact content-free manifest and stable sourceHash', t => {
  const f = fixture(t);
  const first = stageCleanAgent(f);
  assert.ok(!(first instanceof Promise));
  assert.equal(first.verified, true);
  assert.equal(first.filesCount, 7);
  assert.equal(first.outputDir, f.outputDir);
  assert.deepEqual(first.manifest.source, {
    kind: 'allowlisted-source-only', directories: ['src', 'roles', 'ui'],
    requiredFiles: ['package.json', 'package-lock.json', 'LICENSE'],
    oldDataInputs: 'none', dependenciesCopied: false, sourceExecuted: false,
  });
  const disk = fs.readFileSync(path.join(f.outputDir, 'staging-manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(disk), first.manifest);
  assert.ok(!disk.includes('SYNTHETIC_SOURCE_MUST_NOT_EXECUTE'));
  assert.ok(!disk.includes('exit 99'));
  assert.ok(!disk.includes(f.appRoot));
  let sum = 0;
  for (const item of first.manifest.files) {
    assert.deepEqual(Object.keys(item), ['path', 'bytes', 'sha256']);
    const bytes = fs.readFileSync(path.join(f.outputDir, item.path));
    assert.deepEqual(bytes, fs.readFileSync(path.join(f.appRoot, item.path)));
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.sha256, hash(bytes));
    sum += bytes.length;
  }
  assert.equal(first.totalBytes, sum);
  assert.equal(first.sourceHash, hash(JSON.stringify(first.manifest.files)));
  const second = stageCleanAgent({ ...f, outputDir: path.join(f.projectRoot, '.tmp', 'second') });
  assert.equal(second.sourceHash, first.sourceHash);
  assert.deepEqual(second.manifest, first.manifest);
});

test('allows normal configuration source modules while rejecting configuration instances separately', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.appRoot, 'src', 'core'));
  const modules = ['config.js', 'config-legacy.js', 'data.js', 'history.js', 'history.mjs', 'chat-history.js', 'messages.js', 'transcripts.js', 'conversations.js', 'backup-helper.js', 'tokens.js'];
  for (const module of modules) fs.writeFileSync(path.join(f.appRoot, 'src', 'core', module), 'export const synthetic = true;\n');
  const result = stageCleanAgent(f);
  assert.equal(result.filesCount, 7 + modules.length);
  for (const module of modules) {
    assert.ok(result.manifest.files.some(file => file.path === `src/core/${module}`));
    assert.equal(fs.readFileSync(path.join(f.outputDir, 'src', 'core', module), 'utf8'), 'export const synthetic = true;\n');
  }
});

test('never enumerates source root or reads/enumerates old data/config/.env/node_modules/history', t => {
  const f = fixture(t);
  for (const directory of ['data', 'config', 'database', 'node_modules', 'history', 'old-copy']) {
    fs.mkdirSync(path.join(f.appRoot, directory));
    fs.writeFileSync(path.join(f.appRoot, directory, 'private.txt'), 'SYNTHETIC_PRIVATE_MARKER');
  }
  fs.writeFileSync(path.join(f.appRoot, '.env'), 'SYNTHETIC_PRIVATE_MARKER');
  const observed = [];
  const forbidden = absolute => {
    const relative = path.relative(f.appRoot, String(absolute));
    return relative === '.env' || /^(?:data|config|database|node_modules|history|old-copy)(?:[\\/]|$)/i.test(relative);
  };
  for (const name of ['readdirSync', 'readFileSync', 'openSync', 'lstatSync']) patch(t, fs, name, original => function (absolute, ...args) {
    observed.push([name, String(absolute)]);
    assert.ok(!forbidden(absolute), `forbidden source access via ${name}`);
    if (name === 'readdirSync') assert.notEqual(String(absolute), f.appRoot, 'source root enumeration');
    return original.call(this, absolute, ...args);
  });
  const result = stageCleanAgent(f);
  assert.equal(result.filesCount, 7);
  assert.ok(observed.length > 0);
  assert.ok(!fs.existsSync(path.join(f.outputDir, 'node_modules')));
});

for (const item of ['src', 'roles', 'ui', 'package.json', 'package-lock.json', 'LICENSE']) {
  test(`requires mandatory allowlist entry ${item}`, t => {
    const f = fixture(t);
    fs.rmSync(path.join(f.appRoot, item), { recursive: true });
    expectCode(() => stageCleanAgent(f), 'STAGE_REQUIRED_PATH_MISSING');
    assert.ok(!fs.existsSync(f.outputDir));
  });
}

test('rejects outside-.tmp output before reading source bytes', t => {
  const f = fixture(t);
  patch(t, fs, 'openSync', () => () => { assert.fail('must reject before byte reads'); });
  for (const outputDir of [path.join(f.projectRoot, 'output'), path.join(f.owned, 'outside'), path.join(f.projectRoot, '.tmp')]) {
    expectCode(() => stageCleanAgent({ ...f, outputDir }), 'STAGE_OUTPUT_OUTSIDE_TMP');
  }
});

test('rejects existing output and never alters or cleans it', t => {
  const f = fixture(t);
  fs.mkdirSync(f.outputDir, { recursive: true });
  const sentinel = path.join(f.outputDir, 'unowned.txt');
  fs.writeFileSync(sentinel, 'unowned');
  expectCode(() => stageCleanAgent(f), 'STAGE_OUTPUT_EXISTS');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unowned');
});

test('rejects relative arguments and source/output overlap', t => {
  const f = fixture(t);
  expectCode(() => stageCleanAgent({ ...f, projectRoot: '.' }), 'STAGE_INVALID_ARGUMENT');
  const appRoot = path.join(f.projectRoot, '.tmp', 'source');
  fs.mkdirSync(appRoot, { recursive: true });
  expectCode(() => stageCleanAgent({ ...f, appRoot, outputDir: path.join(appRoot, 'src', 'out') }), 'STAGE_SOURCE_OUTPUT_OVERLAP');
});

for (const name of ['.env', '.env.production', '.envrc', '.npmrc', '.netrc', 'token.json', 'config.json', 'config.local.json', 'account.json', 'session.config.json', 'cache.sqlite', 'db.sqlite3', 'cache.sqlite-wal', 'cache.db', 'cache.db-shm', 'private.pem', 'private.key', 'identity.pfx', 'private.keystore', 'old.backup', 'module.node']) {
  test(`rejects forbidden source artifact ${name}`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.appRoot, 'src', name), 'SYNTHETIC_PRIVATE_MARKER');
    expectCode(() => stageCleanAgent(f), 'STAGE_FORBIDDEN_ENTRY');
    assert.ok(!fs.existsSync(f.outputDir));
  });
}

const historicalInstances = ['history', 'chat-history', 'chat_history', 'messages', 'transcripts', 'conversations']
  .flatMap(basename => ['json', 'jsonl', 'ndjson', 'sqlite', 'db', 'txt'].map(extension => `${basename}.${extension}`))
  .concat(['history-2026.json', 'CHAT-HISTORY.JSONL', 'messages.2026.ndjson', 'conversation.txt']);
const sensitiveLineInstances = ['config', 'account', 'session']
  .flatMap(basename => ['jsonl', 'ndjson'].map(extension => `${basename}.${extension}`));
for (const [index, name] of [...historicalInstances, ...sensitiveLineInstances].entries()) {
  const directory = ['src', 'roles', 'ui'][index % 3];
  test(`rejects embedded historical/sensitive instance before any content read: ${directory}/${name}`, t => {
    const f = fixture(t);
    const instance = path.join(f.appRoot, directory, name);
    fs.writeFileSync(instance, 'SYNTHETIC_PRIVATE_MARKER');
    let attemptedReads = 0;
    for (const method of ['readFileSync', 'openSync']) patch(t, fs, method, original => function (absolute, ...args) {
      if (String(absolute) === instance) {
        attemptedReads++;
        throw new Error('synthetic forbidden instance read');
      }
      return original.call(this, absolute, ...args);
    });
    expectCode(() => stageCleanAgent(f), 'STAGE_FORBIDDEN_ENTRY');
    assert.equal(attemptedReads, 0);
    assert.ok(!fs.existsSync(f.outputDir));
  });
}

for (const name of ['data', 'config', 'node_modules', 'history', 'backup-old', '.ssh', '.aws']) {
  test(`rejects runtime/history directory ${name} inside whitelist`, t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.appRoot, 'src', name));
    expectCode(() => stageCleanAgent(f), 'STAGE_FORBIDDEN_ENTRY');
  });
}

test('rejects source file hardlink', t => {
  const f = fixture(t);
  fs.linkSync(path.join(f.appRoot, 'src', 'index.mjs'), path.join(f.owned, 'linked-source.mjs'));
  expectCode(() => stageCleanAgent(f), 'STAGE_HARDLINK');
});

test('rejects source directory junction without enumerating its target', t => {
  const f = fixture(t);
  const external = path.join(f.owned, 'junction-target');
  fs.mkdirSync(external);
  fs.rmSync(path.join(f.appRoot, 'roles'), { recursive: true });
  if (!link(t, path.join(f.appRoot, 'roles'), external, 'junction')) return;
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    assert.notEqual(String(absolute), external);
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_LINK');
});

test('rejects source root reached through a junction ancestor', t => {
  const f = fixture(t);
  const alias = path.join(f.owned, 'source-alias');
  if (!link(t, alias, f.appRoot, 'junction')) return;
  expectCode(() => stageCleanAgent({ ...f, appRoot: alias }), 'STAGE_LINK');
});

test('rejects source leaf symlink (synthetic lstat fallback if host denies file symlinks)', t => {
  const f = fixture(t);
  const target = path.join(f.appRoot, 'src', 'index.mjs');
  fs.unlinkSync(target);
  try { fs.symlinkSync(path.join(f.appRoot, 'roles', 'role.mjs'), target, 'file'); }
  catch (error) {
    if (!['EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    fs.writeFileSync(target, 'synthetic');
    patch(t, fs, 'lstatSync', original => function (absolute, ...args) {
      const stat = original.call(this, absolute, ...args);
      return String(absolute) === target ? Object.assign(Object.create(stat), { isSymbolicLink: () => true }) : stat;
    });
  }
  expectCode(() => stageCleanAgent(f), 'STAGE_LINK');
});

test('rejects target .tmp junction and does not write through it', t => {
  const f = fixture(t);
  const external = path.join(f.owned, 'unowned-target');
  fs.mkdirSync(external);
  if (!link(t, path.join(f.projectRoot, '.tmp'), external, 'junction')) return;
  expectCode(() => stageCleanAgent(f), 'STAGE_LINK');
  assert.deepEqual(fs.readdirSync(external), []);
});

test('rejects target nested-parent junction', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.projectRoot, '.tmp'));
  if (!link(t, path.join(f.projectRoot, '.tmp', 'alias'), f.appRoot, 'junction')) return;
  expectCode(() => stageCleanAgent({ ...f, outputDir: path.join(f.projectRoot, '.tmp', 'alias', 'out') }), 'STAGE_LINK');
});

test('rejects mismatched source realpath', t => {
  const f = fixture(t);
  const target = path.join(f.appRoot, 'src');
  patch(t, fs.realpathSync, 'native', original => function (absolute, ...args) {
    if (String(absolute) === target) return f.owned;
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_PHYSICAL_PATH');
});

test('rejects mismatched target physical path before source reads', t => {
  const f = fixture(t);
  const target = path.join(f.projectRoot, '.tmp');
  fs.mkdirSync(target);
  patch(t, fs.realpathSync, 'native', original => function (absolute, ...args) {
    if (String(absolute) === target) return f.owned;
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_PHYSICAL_PATH');
});

test('rejects source mutation during a stable read', t => {
  const f = fixture(t);
  const target = path.join(f.appRoot, 'src', 'index.mjs');
  let triggered = false;
  patch(t, fs, 'readSync', original => function (...args) {
    const result = original.apply(this, args);
    if (!triggered && args[1].toString('utf8').includes('SYNTHETIC_SOURCE_MUST_NOT_EXECUTE')) {
      triggered = true;
      fs.appendFileSync(target, '// synthetic mutation\n');
    }
    return result;
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_CHANGED');
  assert.ok(triggered);
});

test('rejects same-size source mutation after initial snapshot', t => {
  const f = fixture(t);
  let triggered = false;
  patch(t, fs, 'mkdirSync', original => function (absolute, ...args) {
    const result = original.call(this, absolute, ...args);
    if (String(absolute) === f.outputDir && !triggered) {
      triggered = true;
      const target = path.join(f.appRoot, 'roles', 'role.mjs');
      const previous = fs.readFileSync(target);
      fs.writeFileSync(target, Buffer.alloc(previous.length, 0x78));
    }
    return result;
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_SOURCE_CHANGED');
  assert.ok(fs.existsSync(f.outputDir), 'failed output retained as evidence');
});

test('rejects added source file in second snapshot', t => {
  const f = fixture(t);
  patch(t, fs, 'mkdirSync', original => function (absolute, ...args) {
    const result = original.call(this, absolute, ...args);
    if (String(absolute) === f.outputDir) fs.writeFileSync(path.join(f.appRoot, 'src', 'added.mjs'), 'synthetic');
    return result;
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_SOURCE_CHANGED');
});

test('rejects extra target file during full-set verification and retains evidence', t => {
  const f = fixture(t);
  let injected = false;
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    if (String(absolute) === f.outputDir && !injected) {
      injected = true;
      fs.writeFileSync(path.join(f.outputDir, 'extra.txt'), 'synthetic');
    }
    return original.call(this, absolute, ...args);
  });
  assert.throws(() => stageCleanAgent(f), error => error.code === 'STAGE_TARGET_EXTRA' && error.evidenceRetained === true);
  assert.ok(fs.existsSync(path.join(f.outputDir, 'extra.txt')));
});

test('rejects extra empty target directory during full-set verification', t => {
  const f = fixture(t);
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    if (String(absolute) === f.outputDir) fs.mkdirSync(path.join(f.outputDir, 'extra'));
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_TARGET_EXTRA');
});

test('rejects missing target file at final full-set verification', t => {
  const f = fixture(t);
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    if (String(absolute) === f.outputDir) fs.unlinkSync(path.join(f.outputDir, 'src', 'index.mjs'));
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_TARGET_MISSING');
});

test('rejects target byte corruption in final verification', t => {
  const f = fixture(t);
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    if (String(absolute) === f.outputDir) fs.writeFileSync(path.join(f.outputDir, 'src', 'index.mjs'), 'synthetic corruption');
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_TARGET_CHANGED');
});

test('rejects target hardlink created before final verification', t => {
  const f = fixture(t);
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    if (String(absolute) === f.outputDir) fs.linkSync(path.join(f.outputDir, 'src', 'index.mjs'), path.join(f.owned, 'target-hardlink.mjs'));
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_HARDLINK');
});

test('rejects target directory replaced with junction and never cleans unowned target', t => {
  const f = fixture(t);
  const unowned = path.join(f.owned, 'unowned-dir');
  fs.mkdirSync(unowned);
  fs.writeFileSync(path.join(unowned, 'sentinel'), 'unowned');
  let injected = false;
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    if (String(absolute) === f.outputDir && !injected) {
      injected = true;
      fs.rmSync(path.join(f.outputDir, 'roles'), { recursive: true });
      fs.symlinkSync(unowned, path.join(f.outputDir, 'roles'), 'junction');
    }
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_LINK');
  assert.equal(fs.readFileSync(path.join(unowned, 'sentinel'), 'utf8'), 'unowned');
});

test('rejects a real target directory replacement by identity, retaining unowned evidence', t => {
  const f = fixture(t);
  let injected = false;
  patch(t, fs, 'mkdirSync', original => function (absolute, ...args) {
    const result = original.call(this, absolute, ...args);
    if (String(absolute) === path.join(f.outputDir, 'roles') && !injected) {
      injected = true;
      fs.renameSync(f.outputDir, path.join(f.projectRoot, '.tmp', 'moved-owned-output'));
      original.call(this, f.outputDir);
      fs.writeFileSync(path.join(f.outputDir, 'unowned.txt'), 'unowned');
    }
    return result;
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_DIRECTORY_CHANGED');
  assert.equal(fs.readFileSync(path.join(f.outputDir, 'unowned.txt'), 'utf8'), 'unowned');
});

test('rejects existing output parent replacement observed between preflight and writes', t => {
  const f = fixture(t);
  const parent = path.dirname(f.outputDir);
  fs.mkdirSync(parent);
  let injected = false;
  patch(t, fs, 'openSync', original => function (absolute, ...args) {
    const result = original.call(this, absolute, ...args);
    if (!injected) {
      injected = true;
      fs.renameSync(parent, path.join(f.projectRoot, 'displaced-tmp'));
      fs.mkdirSync(parent);
      fs.writeFileSync(path.join(parent, 'unowned.txt'), 'unowned');
    }
    return result;
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_DIRECTORY_CHANGED');
  assert.ok(!fs.existsSync(f.outputDir));
  assert.equal(fs.readFileSync(path.join(parent, 'unowned.txt'), 'utf8'), 'unowned');
});

test('allows unrelated ancestor directory timestamp changes during metadata checks', t => {
  const f = fixture(t);
  const parent = path.dirname(f.outputDir);
  fs.mkdirSync(parent);
  const ancestors = new Set([f.owned, parent]);
  let mutations = 0;
  patch(t, fs.realpathSync, 'native', original => function (absolute, ...args) {
    const result = original.call(this, absolute, ...args);
    if (ancestors.has(String(absolute))) {
      const timestamp = new Date(1700000000000 + (++mutations * 1000));
      fs.utimesSync(absolute, timestamp, timestamp);
    }
    return result;
  });
  const first = stageCleanAgent(f);
  const second = stageCleanAgent({ ...f, outputDir: path.join(parent, 'second') });
  assert.equal(first.verified, true);
  assert.equal(second.sourceHash, first.sourceHash);
  assert.ok(mutations > 2, 'the regression must exercise actual timestamp changes');
});

test('still rejects a source whitelist directory replacement despite allowing ancestor timestamps', t => {
  const f = fixture(t);
  const sourceDirectory = path.join(f.appRoot, 'src');
  let replaced = false;
  patch(t, fs, 'mkdirSync', original => function (absolute, ...args) {
    const result = original.call(this, absolute, ...args);
    if (String(absolute) === f.outputDir && !replaced) {
      replaced = true;
      fs.renameSync(sourceDirectory, path.join(f.appRoot, 'moved-synthetic-src'));
      original.call(this, sourceDirectory);
      fs.writeFileSync(path.join(sourceDirectory, 'index.mjs'), 'synthetic replacement');
    }
    return result;
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_DIRECTORY_CHANGED');
  assert.ok(replaced);
});

test('preserves empty allowed directories and zero-byte files', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.appRoot, 'src', 'empty'));
  fs.writeFileSync(path.join(f.appRoot, 'src', 'empty.mjs'), '');
  const result = stageCleanAgent(f);
  assert.equal(result.filesCount, 8);
  assert.ok(fs.lstatSync(path.join(f.outputDir, 'src', 'empty')).isDirectory());
  const item = result.manifest.files.find(file => file.path === 'src/empty.mjs');
  assert.equal(item.bytes, 0);
  assert.equal(item.sha256, hash(''));
});

test('all output file opens are exclusive and preexisting raced file is not clobbered', t => {
  const f = fixture(t);
  const target = path.join(f.outputDir, 'LICENSE');
  const writeFile = fs.writeFileSync;
  patch(t, fs, 'openSync', original => function (absolute, flags, ...args) {
    if (typeof flags === 'number' && (flags & fs.constants.O_WRONLY)) {
      assert.ok(flags & fs.constants.O_EXCL);
      assert.ok(flags & fs.constants.O_CREAT);
      assert.ok(String(absolute).startsWith(`${f.outputDir}${path.sep}`));
      if (String(absolute) === target) writeFile(target, 'unowned-raced-file', { flag: 'wx' });
    }
    return original.call(this, absolute, flags, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_OUTPUT_CONFLICT');
  assert.equal(fs.readFileSync(target, 'utf8'), 'unowned-raced-file');
});

test('single-file size limit fails before allocation/read', t => {
  const f = fixture(t);
  const target = path.join(f.appRoot, 'src', 'index.mjs');
  fs.truncateSync(target, STAGE_CLEAN_AGENT_LIMITS.maxFileBytes + 1);
  expectCode(() => stageCleanAgent(f), 'STAGE_FILE_LIMIT');
});

test('total-byte limit bounds combined input', t => {
  const f = fixture(t);
  let bytesRead = 0;
  patch(t, fs, 'readSync', original => function (...args) {
    const result = original.apply(this, args);
    bytesRead += result;
    return result;
  });
  for (let index = 0; index < 9; index++) {
    const target = path.join(f.appRoot, 'src', `large-${index}.mjs`);
    fs.writeFileSync(target, '');
    fs.truncateSync(target, STAGE_CLEAN_AGENT_LIMITS.maxFileBytes);
  }
  expectCode(() => stageCleanAgent(f), 'STAGE_TOTAL_LIMIT');
  assert.ok(bytesRead <= STAGE_CLEAN_AGENT_LIMITS.maxTotalBytes);
  assert.ok(!fs.existsSync(f.outputDir));
});

test('entry limit rejects excessive synthetic directory entries', t => {
  const f = fixture(t);
  const originalNames = fs.readdirSync(path.join(f.appRoot, 'src'));
  patch(t, fs, 'readdirSync', original => function (absolute, ...args) {
    if (String(absolute) === path.join(f.appRoot, 'src')) return Array(STAGE_CLEAN_AGENT_LIMITS.maxEntries).fill(originalNames[0]);
    return original.call(this, absolute, ...args);
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_ENTRY_LIMIT');
});

test('depth limit rejects excessively nested synthetic source', t => {
  const f = fixture(t);
  let current = path.join(f.appRoot, 'src');
  for (let index = 0; index < STAGE_CLEAN_AGENT_LIMITS.maxDepth; index++) {
    current = path.join(current, 'd');
    fs.mkdirSync(current);
  }
  expectCode(() => stageCleanAgent(f), 'STAGE_DEPTH_LIMIT');
});

test('native errors are sanitized and never expose absolute paths or content', t => {
  const f = fixture(t);
  patch(t, fs, 'openSync', () => () => {
    const error = new Error(`${f.appRoot} SYNTHETIC_PRIVATE_MARKER`);
    error.code = 'EACCES';
    throw error;
  });
  expectCode(() => stageCleanAgent(f), 'STAGE_IO');
});
