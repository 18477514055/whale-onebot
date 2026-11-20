import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const temporary = path.join(root, '.tmp');
assert.equal(fs.realpathSync(temporary), temporary);
const work = fs.mkdtempSync(path.join(temporary, 'windows-sandbox-host-'));
const input = path.join(work, 'input');
const output = path.join(work, 'output');
const rehearsal = path.join(work, 'rehearsal');
for (const dir of [input, output, rehearsal, path.join(input, 'corrected'), path.join(input, 'missing')]) fs.mkdirSync(dir);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scopeBytes = fs.readFileSync(path.join(root, 'evidence', 'native-host-scope-win32.json'));
assert.equal(hash(scopeBytes), '038578701c96fab90a43b226fde63c7f6cfc043510e9d81557d647e9f087d6bd');
const scope = JSON.parse(scopeBytes);
assert(scope.passed);
const files = {};
function stage(source, relative, expected) {
  assert.equal(fs.realpathSync(source), source);
  const stat = fs.lstatSync(source);
  assert(stat.isFile() && stat.nlink === 1);
  const bytes = fs.readFileSync(source);
  const digest = hash(bytes);
  if (expected) assert.equal(digest, expected);
  const target = path.join(input, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  assert.equal(hash(fs.readFileSync(target)), digest);
  files[relative] = digest;
}
stage(fs.realpathSync(process.execPath), 'node.exe', '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5');
stage(scope.provider.path, 'corrected/onebot-node-host.dll', scope.provider.sha256);
for (const folder of ['corrected', 'missing']) {
  stage(scope.consumer.path, folder + '/consumer.node', scope.consumer.sha256);
  const relative = folder + '/child.cjs';
  const child = "require('./consumer.node').start(process.argv[2] === 'stop');\n";
  fs.writeFileSync(path.join(input, relative), child, { flag: 'wx' });
  files[relative] = hash(child);
}
stage(path.join(root, 'experiments', 'windows-sandbox-host', 'bootstrap.mjs'), 'bootstrap.mjs');
for (const relative of ['cli.mjs', 'core.mjs', 'actions.mjs', 'segments.mjs', 'quick-operations.mjs',
  'protocol/core.mjs', 'bridge/qq-profile.mjs', 'bridge/error.mjs', 'bridge/native-bridge.mjs',
  'service.mjs', 'outcome-store.mjs', 'host/bridge-ipc.mjs', 'host/onebot-process.mjs', 'host/onebot-child.mjs',
  'transport/index.mjs', 'transport/server.mjs', 'transport/outbound.mjs']) {
  stage(path.join(root, 'src', relative), 'src/' + relative);
}
function stageWs(relative = '') {
  const dir = path.join(root, 'node_modules', 'ws', relative);
  assert.equal(fs.realpathSync(dir), dir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) stageWs(name);
    else {
      assert(entry.isFile());
      stage(path.join(dir, entry.name), 'node_modules/ws/' + name);
    }
  }
}
stageWs();
const canary = path.join(work, 'unmapped-canary.txt');
fs.writeFileSync(canary, 'original synthetic canary', { flag: 'wx' });
const manifest = { files, unmappedCanary: canary, nodeConfigSha256: 'cef8c4e3f5021ff106d9d0a910912e6336d56faaec280e8000ee84227fa86a96' };
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(path.join(input, 'manifest.json'), manifestText, { flag: 'wx' });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const settings = ['VGpu', 'Networking', 'AudioInput', 'VideoInput', 'PrinterRedirection', 'ClipboardRedirection'];
const config = [
  '<Configuration>',
  ...settings.map(name => '  <' + name + '>Disable</' + name + '>'),
  '  <ProtectedClient>Enable</ProtectedClient>',
  '  <MemoryInMB>4096</MemoryInMB>',
  '  <MappedFolders>',
  ...[[input, 'Input', true], [output, 'Output', false]].flatMap(([dir, target, readOnly]) => [
    '    <MappedFolder>', '      <HostFolder>' + xml(dir) + '</HostFolder>',
    '      <SandboxFolder>C:\\Whale\\' + target + '</SandboxFolder>',
    '      <ReadOnly>' + readOnly + '</ReadOnly>', '    </MappedFolder>',
  ]),
  '  </MappedFolders>',
  '  <LogonCommand>',
  '    <Command>&quot;C:\\Whale\\Input\\node.exe&quot; &quot;C:\\Whale\\Input\\bootstrap.mjs&quot; &quot;C:\\Whale\\Output&quot;</Command>',
  '  </LogonCommand>',
  '</Configuration>',
].join('\n');
const configFile = path.join(work, 'native-host-check.wsb');
fs.writeFileSync(configFile, config, { flag: 'wx' });
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
  PATH: path.join(process.env.SystemRoot, 'System32'), TEMP: rehearsal, TMP: rehearsal };
const result = spawnSync(path.join(input, 'node.exe'), [path.join(input, 'bootstrap.mjs'), rehearsal, '--rehearsal'], {
  cwd: rehearsal, env, encoding: 'utf8', timeout: 45000, windowsHide: true, maxBuffer: 65536,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
assert.equal(result.signal, null);
assert.deepEqual(fs.readdirSync(output), []);
const report = { at: new Date().toISOString(), config: configFile, work,
  inputFiles: Object.keys(files).length + 1, configSha256: hash(config), manifestSha256: hash(manifestText),
  sandboxExecuted: false, rehearsal: JSON.parse(result.stdout) };
const destination = path.join(root, 'evidence', 'windows-sandbox-host-kit.json');
assert.equal(fs.realpathSync(path.dirname(destination)), path.dirname(destination));
const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
if (existing) assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1);
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
