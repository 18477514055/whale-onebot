// Original synthetic Windows provider/consumer integration. Never loads QQ.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPE } from './inspect-pe.mjs';
import { createExportPlan, renderForwarderDef, STOPPING_EXPORT, REGISTER_EXPORT } from './windows-host-exports.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const output = path.join(root, '.tmp/native-host-win32');
const evidenceFile = path.join(root, 'evidence/native-host-win32.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = file => sha(fs.readFileSync(file));
// Prepared once from separately verified inputs, never refreshed by this script.
const pins = {
  "node": {
    "platform": "win32",
    "arch": "x64",
    "version": "v24.20.0",
    "executableSha256": "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5",
    "configSha256": "cef8c4e3f5021ff106d9d0a910912e6336d56faaec280e8000ee84227fa86a96"
  },
  "recipeSha256": "e3fd934d07f3239f9174ca05a7a58aaf01e50b3b9b6c74d52a6f2f4a8d3996f5",
  "files": {
    "src/native/node-host-win32.cc": "48e4c353d3f88c93d2308322f5a13136b592b0bff1b55bb336cdd17c37e9b42a",
    "src/native/node-host.h": "a4d25fcecbbfa63769a36ef90ccf94d28116330e708088558c6f64724f0df2b1",
    "experiments/native-host-win32/consumer.cc": "157eab562c590d376d4d7053caa63b7c03a642511c973110468ae476e9a40c23",
    // Manually reviewed 2026-11-13: comment-only correction removes the old
    // pure-forwarder no-imports/no-DllMain claim; executable code unchanged.
    "experiments/native-host-win32/forwarder-probe.c": "2700510924afe8bb3e42aff203b8858f4fa51779714d4686ebc2c38a088a1ce4",
    "scripts/windows-host-exports.mjs": "daf7a8fddc50a8ba8062c10150bdb8ddacc8f898e52886110850236220c80299",
    "scripts/inspect-pe.mjs": "ea502c935dd35801c57fb4aca75af400168d8310a92a46f6b913cc4dcd2d20ca",
    "scripts/native-stopping-probe-win32.mjs": "fc5c5ccd1180d6d515d8b69699788ffc1cc34c4686e2e57160f62d470475e0ea",
    "experiments/native-host/pins.json": "c7ffff78c34dc07c3438cd2efbf1c245084469e5ed848d6b865b4545b8b7fad9",
    "evidence/native-abi.json": "6a2a059e3cce149f81e09424a52601eb9d791cc18c983211ec461dd5a9f281a0",
    "evidence/native-stopping-win32.json": "27611a27aad8e130b7a9fa0cbf5c28713f4653e885c6c6731c319999be872d09",
    ".tools/node-v24.20.0-win-x64/node.lib": "63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9",
    ".tools/node-simdjson-win32/simdjson.cpp": "73443d00a1ce1ebf4dbb5f1bce435d964f814facee646a81aa57626ad303155c",
    ".tmp/native-stopping-win32/simdjson.obj": "5e7f27370abc0d3c0b0116d39e88e526c998f85e44d194356b31afe7f40ded71"
  },
  "buildTrees": [
    {
      "path": ".tools/msvc-windows/toolchain/VC/Tools/MSVC/14.44.35207/include",
      "extensions": null,
      "sha256": "e2fbdba1a1decc6cf10343e3f519d377c0168089a6cf32aae290c658dd2eecfa",
      "fileCount": 314
    },
    {
      "path": ".tools/msvc-windows/toolchain/VC/Tools/MSVC/14.44.35207/lib/x64",
      "extensions": [
        ".lib"
      ],
      "sha256": "9d97769d31df04855b885887c4d9936fe31f0d10e01a7a644ff2773b04a19359",
      "fileCount": 87
    },
    {
      "path": ".tools/msvc-windows/toolchain/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64",
      "extensions": [
        ".exe",
        ".dll"
      ],
      "sha256": "1bd18bdbe102657b67a270e61450bb4cf08c5c658cfd815f60f43395236c197b",
      "fileCount": 56
    },
    {
      "path": ".tools/msvc-windows/extracted/microsoft.windows.sdk.cpp/c/Include/10.0.26100.0",
      "extensions": null,
      "sha256": "208ff3eab8ff01b785a316c2c408817251f2f85b47f5d88ed4dc949864f1562b",
      "fileCount": 4771
    },
    {
      "path": ".tools/msvc-windows/extracted/microsoft.windows.sdk.cpp.x64/c/um/x64",
      "extensions": [
        ".lib"
      ],
      "sha256": "c7256223d8ba1a24fb692a0cf2ac730d6027b8b2c567a77f09126a43df2aec13",
      "fileCount": 453
    },
    {
      "path": ".tools/msvc-windows/extracted/microsoft.windows.sdk.cpp.x64/c/ucrt/x64",
      "extensions": [
        ".lib"
      ],
      "sha256": "5a22e96a2606f5fa720005e05e9b84d364e7af0699c4557df60ec0b3b327e893",
      "fileCount": 8
    }
  ]
};
assert(pins, 'Fixed input pins must be prepared after seven-case stopping proof');

function treeDigest(directory, extensions = null) {
  const entries = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(current, entry.name);
      assert(!entry.isSymbolicLink(), 'Linked build input');
      if (entry.isDirectory()) walk(file);
      else {
        assert(entry.isFile(), 'Non-file build input');
        if (!extensions || extensions.includes(path.extname(entry.name).toLowerCase())) entries.push([path.relative(directory, file).replaceAll('\\', '/'), digest(file)]);
      }
    }
  }
  walk(directory); entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return sha(entries.map(([name, hash]) => `${name}\0${hash}\n`).join(''));
}

function identity(observed = {
  platform: process.platform, arch: process.arch, version: process.version,
  executableSha256: digest(process.execPath), configSha256: sha(JSON.stringify(process.config)),
}) { assert.deepEqual(observed, pins.node, 'Node identity/configuration mismatch before native load'); }
function safeDirectory(directory) {
  assert.equal(fs.realpathSync(root), root, 'Linked project root');
  const relative = path.relative(root, directory);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current); stat = fs.lstatSync(current);
    }
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Linked/non-directory artifact parent');
    assert.equal(fs.realpathSync(current), current, 'Artifact parent resolves elsewhere');
  }
}
function physicalFile(file, required = false) {
  assert.equal(fs.realpathSync(path.dirname(file)), path.dirname(file), 'Linked artifact parent');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code !== 'ENOENT' || required) throw error;
    return;
  }
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Linked or non-regular artifact leaf');
  assert.equal(fs.realpathSync(file), file, 'Artifact leaf resolves elsewhere');
}
function write(file, bytes) { physicalFile(file); fs.writeFileSync(file, bytes); }
function verifyFile(file, expected) { physicalFile(file, true); assert.equal(digest(file), expected, 'Full artifact hash mismatch before native load'); }
const child = process.argv[2] === '--child';
const guard = process.argv[2] === '--identity-guard';
if (guard) {
  assert.equal(process.argv.length, 4);
  const field = process.argv[3]; assert(['executableSha256', 'configSha256', 'version'].includes(field));
  assert.throws(() => identity({ ...pins.node, [field]: 'changed-synthetic-identity' }), /identity\/configuration mismatch/);
  process.stdout.write(JSON.stringify({ rejected: true, alteredField: field, beforeNativeLoad: true }) + '\n');
} else {
  identity(); assert.equal(path.basename(process.execPath).toLowerCase(), 'node.exe');
  for (const [relative, expected] of Object.entries(pins.files)) {
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    assert.equal(digest(path.join(root, relative)), expected, `Pinned source/header/recipe changed: ${relative}`);
  }
  const headerPins = JSON.parse(fs.readFileSync(path.join(root, 'experiments/native-host/pins.json')));
  for (const [relative, expected] of Object.entries(headerPins.files)) {
    if (!relative.startsWith('.tools/node-internals-v24.20.0/') && !relative.startsWith('.tools/node-v24.20.0-linux-x64/include/node/')) continue;
    assert.equal(digest(path.join(root, relative)), expected, `Exact Node header changed: ${relative}`);
  }
  const prior = JSON.parse(fs.readFileSync(path.join(root, 'evidence/native-stopping-win32.json')));
  assert.equal(prior.passed, true, 'Seven-case stopping proof required');
  assert.equal(prior.cases.length, 7); assert(prior.cases.every(item => item.passed));
  assert.equal(sha(JSON.stringify({ compile: prior.build.commonCompileArgs, link: prior.build.commonLinkArgs })), pins.recipeSha256);
  const rawPlan = fs.readFileSync(path.join(root, 'evidence/native-abi.json'));
  const plan = createExportPlan(JSON.parse(rawPlan));
  const positive = path.join(output, 'positive'), negative = path.join(output, 'without-provider');
  const tampered = path.join(output, 'tampered-provider');
  const manifestPath = path.join(output, 'artifacts.json');
  const providerName = 'onebot-node-host.dll';
  const modeNames = ['baseline', 'stop', 'forwarders', 'without-provider', 'tampered-provider'];
  if (child) {
    assert.equal(process.argv.length, 5); const mode = process.argv[3]; assert(modeNames.includes(mode));
    physicalFile(manifestPath, true); assert.equal(digest(manifestPath), process.argv[4], 'Artifact manifest changed');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    const base = mode === 'without-provider' ? negative : mode === 'tampered-provider' ? tampered : positive;
    assert.equal(fs.realpathSync(base), base); assert.equal(process.cwd(), base, 'Child cwd must be isolated');
    const consumer = path.join(base, 'consumer.node'), provider = path.join(base, providerName);
    verifyFile(consumer, manifest.consumer.sha256);
    if (mode === 'without-provider') {
      assert(!fs.existsSync(provider));
      assert(!fs.existsSync(path.join(path.dirname(process.execPath), providerName)), 'Unexpected app-directory provider');
      // No positive directory in PATH or cwd. This fresh process never loaded a provider.
      assert(!String(process.env.PATH).toLowerCase().includes(output.toLowerCase()));
      try { createRequire(import.meta.url)(consumer); assert.fail('Missing-provider control unexpectedly loaded'); }
      catch (error) {
        assert.equal(error.code, 'ERR_DLOPEN_FAILED');
        process.stdout.write(JSON.stringify({ loaded: false, code: error.code, message: error.message, isolatedCwd: true }) + '\n');
      }
    } else if (mode === 'tampered-provider') {
      assert.throws(() => verifyFile(provider, manifest.provider.sha256), /artifact hash mismatch/);
      process.stdout.write(JSON.stringify({ rejected: true, fullArtifactHash: true, beforeNativeLoad: true }) + '\n');
    } else {
      verifyFile(provider, manifest.provider.sha256);
      if (mode === 'forwarders') {
        const audit = path.join(base, 'forwarder-audit.node'); verifyFile(audit, manifest.audit.sha256);
        process.stdout.write(JSON.stringify(createRequire(import.meta.url)(audit)) + '\n');
      } else {
        const module = createRequire(import.meta.url)(consumer);
        assert.deepEqual(Object.keys(module).sort(), ['baseline', 'stop']); module[mode]();
      }
    }
  } else {
    assert.equal(process.argv.length, 2);
    for (const item of pins.buildTrees) assert.equal(treeDigest(path.join(root, item.path), item.extensions), item.sha256, `Pinned compiler/SDK inputs changed: ${item.path}`);
    for (const directory of [output, positive, negative, tampered]) safeDirectory(directory);
    const env = { ...process.env, TEMP: output, TMP: output };
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'INCLUDE', 'LIB', 'CL', '_CL_', 'LINK', '_LINK_']) delete env[key];
    // Process-local search restriction, never changes user/system PATH.
    env.PATH = path.join(process.env.SystemRoot, 'System32');
    const run = (exe, args, cwd = output) => {
      const result = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      return { status: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'original provider and consumers only; no QQ', pins,
      scriptSha256: digest(script), sharedHelperSevenCaseEvidenceSha256: digest(path.join(root, 'evidence/native-stopping-win32.json')),
      limitations: ['exact pinned Node binary/config only', 'local MSVC versus Node original Clang is an observed ABI experiment',
        '97 forwarded addresses plus three signature calls do not prove all 97 semantics', 'raw provider has no independent runtime identity gate; use guarded launcher',
        'QQ and Tencent runtime behavior not loaded or proven'], guards: [], compilation: [], cases: [] };
    const save = () => write(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
    const guardDirectory = fs.mkdtempSync(path.join(output, 'guards-'));
    const original = path.join(guardDirectory, 'original'), linked = path.join(guardDirectory, 'hardlink');
    fs.writeFileSync(original, 'synthetic-only'); fs.linkSync(original, linked);
    assert.throws(() => physicalFile(linked), /Linked or non-regular/); fs.unlinkSync(linked);
    const junction = path.join(guardDirectory, 'junction'); fs.symlinkSync(guardDirectory, junction, 'junction');
    assert.throws(() => physicalFile(path.join(junction, 'new')), /Linked artifact parent/); fs.unlinkSync(junction);
    assert.equal(fs.readFileSync(original, 'utf8'), 'synthetic-only');
    evidence.guards.push({ hardlinkRejected: true, linkedParentRejected: true, syntheticTargetUnchanged: true });
    const files = {
      provider: path.join(positive, providerName), consumer: path.join(positive, 'consumer.node'),
      audit: path.join(positive, 'forwarder-audit.node'), library: path.join(positive, 'onebot-node-host.lib'),
    };
    for (const filename of [providerName, 'onebot-node-host.lib', 'onebot-node-host.exp', 'provider.def', 'provider.obj',
      'consumer.node', 'consumer.obj', 'consumer.lib', 'consumer.exp', 'forwarder-audit.node', 'forwarder-audit.obj', 'forwarder-audit.lib', 'forwarder-audit.exp', 'probe-config.h']) physicalFile(path.join(positive, filename));
    write(path.join(positive, 'provider.def'), renderForwarderDef(plan, 'node.exe'));
    write(path.join(positive, 'probe-config.h'), `#define PROVIDER_PATH ${JSON.stringify(files.provider)}\nstatic const char* symbols[]={${plan.forwards.map(name => JSON.stringify(name)).join(',')}};\n`);
    const builds = [
      ['provider', 'src/native/node-host-win32.cc', [`/DEF:${path.join(positive, 'provider.def')}`]],
      ['consumer', 'experiments/native-host-win32/consumer.cc', [files.library]],
      ['audit', 'experiments/native-host-win32/forwarder-probe.c', []],
    ];
    for (const [name, relative, extra] of builds) {
      const object = path.join(positive, name === 'audit' ? 'forwarder-audit.obj' : `${name}.obj`);
      const compileArgs = [...prior.build.commonCompileArgs, `/I${positive}`, `/Fo${object}`, path.join(root, relative)];
      const compiled = run(prior.build.compiler, compileArgs); evidence.compilation.push({ name, phase: 'compile', args: compileArgs, ...compiled }); save();
      assert.equal(compiled.status, 0, JSON.stringify(compiled));
      const importName = name === 'provider' ? 'onebot-node-host' : name === 'audit' ? 'forwarder-audit' : name;
      const linkArgs = [...prior.build.commonLinkArgs, `/OUT:${files[name]}`, `/IMPLIB:${path.join(positive, `${importName}.lib`)}`, ...extra, object, ...prior.build.additionalObjects];
      const linked = run(prior.build.linker, linkArgs); evidence.compilation.push({ name, phase: 'link', args: linkArgs, ...linked }); save();
      assert.equal(linked.status, 0, JSON.stringify(linked));
    }
    const manifest = {};
    for (const name of ['provider', 'consumer', 'audit']) {
      const bytes = fs.readFileSync(files[name]), pe = inspectPE(bytes);
      assert.equal(pe.machine, '0x8664'); assert.equal(pe.format, 'PE32+');
      manifest[name] = { sha256: sha(bytes), bytes: bytes.length };
      evidence[name] = { path: files[name], ...manifest[name], pe };
    }
    const exports = evidence.provider.pe.exports.entries.filter(item => item.kind !== 'unused');
    assert.equal(exports.length, 99); assert.equal(exports.filter(item => item.kind === 'forwarder').length, 97);
    assert.deepEqual(exports.flatMap(item => item.names.map(n => n.name)).sort(), [...plan.forwards, ...plan.implementations].sort());
    for (const item of exports) {
      if (item.kind === 'forwarder') assert.equal(item.forwarder, `node.exe.${item.names[0].name}`);
      else { assert.equal(item.kind, 'address'); assert(plan.implementations.includes(item.names[0].name)); }
    }
    const consumerExports = evidence.consumer.pe.exports.entries.flatMap(item => item.names.map(n => n.name));
    assert(!consumerExports.some(name => /napi_register_module_v1|node_api_module_get_api_version/.test(name)), 'Consumer must use DllMain registration');
    const providerImports = evidence.consumer.pe.imports.filter(item => item.module.toLowerCase() === providerName).flatMap(item => item.symbols.map(symbol => symbol.name)).sort();
    assert.deepEqual(providerImports, [STOPPING_EXPORT, REGISTER_EXPORT].sort());
    assert.equal(evidence.consumer.pe.delayImports.length, 0);
    for (const directory of [negative, tampered]) {
      const target = path.join(directory, 'consumer.node'); physicalFile(target); fs.copyFileSync(files.consumer, target);
    }
    assert(!fs.existsSync(path.join(negative, providerName)), 'Negative fixture directory must have no provider');
    const bad = Buffer.from(fs.readFileSync(files.provider)); bad[bad.length - 1] ^= 1;
    write(path.join(tampered, providerName), bad);
    write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    evidence.artifactManifestSha256 = digest(manifestPath);
    for (const field of ['executableSha256', 'configSha256', 'version']) {
      const result = run(process.execPath, [script, '--identity-guard', field], negative);
      assert.equal(result.status, 0, JSON.stringify(result));
      evidence.guards.push({ ...JSON.parse(result.stdout), process: result });
    }
    for (const mode of modeNames) {
      const cwd = mode === 'without-provider' ? negative : mode === 'tampered-provider' ? tampered : positive;
      const result = run(process.execPath, [script, '--child', mode, evidence.artifactManifestSha256], cwd);
      evidence.cases.push({ mode, cwd, process: result }); save();
      assert.equal(result.signal, null); assert.equal(result.error, null);
      assert.equal(result.status, mode === 'stop' ? 1 : 0, JSON.stringify(result)); assert.equal(result.stderr, '');
      const observed = JSON.parse(result.stdout);
      if (mode === 'baseline' || mode === 'stop') assert.deepEqual(observed, { mode, constructorCalls: 1, before: false, after: mode === 'stop', stopResult: mode === 'stop' ? 0 : -1 });
      else if (mode === 'forwarders') assert.deepEqual(observed, { answer: 42, loaded: 1, resolved: 97, equal: 97, called: 3 });
      else if (mode === 'without-provider') { assert.equal(observed.loaded, false); assert.equal(observed.code, 'ERR_DLOPEN_FAILED'); assert.equal(observed.isolatedCwd, true); }
      else assert.deepEqual(observed, { rejected: true, fullArtifactHash: true, beforeNativeLoad: true });
      Object.assign(evidence.cases.at(-1), { passed: true, observed });
    }
    evidence.passed = true; save();
    console.log(JSON.stringify({ passed: true, exportCount: 99, cases: evidence.cases.map(({ mode, observed }) => ({ mode, observed })), guards: evidence.guards }, null, 2));
  }
}
