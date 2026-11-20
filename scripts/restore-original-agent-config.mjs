// D12 restoration on the inactive Linux working COPY only. No phone or Key access.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createOriginalAgentConfig, originalBusinessSettingsMatch } from '../src/host/original-agent-config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert(args.length <= 1 && (!args.length || ['--preview', '--apply'].includes(args[0])), 'Use --preview or --apply');
const apply = args[0] === '--apply';
const source = path.join(root, '.tmp/phone-agent-current-7qCsKd/data/config.json');
const work = path.join(root, '.tmp/phone-agent-runtime-6g9XJC');
const target = path.join(work, 'data/config.json');
const marker = path.join(work, 'original-settings-restored.json');
for (const file of [source, target]) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(fs.realpathSync(file), file);
}
const originalBytes = fs.readFileSync(source), beforeBytes = fs.readFileSync(target);
const original = JSON.parse(originalBytes), before = JSON.parse(beforeBytes);
// Check that a backup would not persist an unexpected newly inserted credential.
createOriginalAgentConfig(before);
const after = createOriginalAgentConfig(original, { consoleHost: '127.0.0.1' });
const matches = originalBusinessSettingsMatch(original, after);
assert(matches);
const count = (cfg, key) => Array.isArray(cfg.allow?.[key]) ? cfg.allow[key].length : 0;
const report = { at: new Date().toISOString(), apply, phoneModified: false,
  source: path.relative(root, source).split(path.sep).join('/'),
  target: path.relative(root, target).split(path.sep).join('/'),
  businessSettingsMatchOriginal: matches, originalModelOriginPreserved: after.api?.baseUrl === original.api?.baseUrl,
  originalGroups: count(original, 'groups'), previousRuntimeGroups: count(before, 'groups'),
  originalPrivateTargets: count(original, 'private'), previousRuntimePrivateTargets: count(before, 'private'),
  originalActive: original.runtime?.mode === 'active', originalPaused: original.runtime?.paused === true,
  appliedDeploymentDifferences: after.server?.host === original.server?.host ? [] : ['server.host'],
  databaseReplaced: false, messageStateChanged: false, modelKeyRead: false, servicesStarted: false,
};
if (apply) {
  assert.equal(fs.existsSync(marker), false, 'Original settings already restored; do not overwrite later business changes');
  for (const owner of ['runtime/integrated-login.lock', 'runtime/resident-agent.lock',
    'runtime/practical-chat-stage-20261115/chat-phase.json.owner'])
    assert.equal(fs.existsSync(path.join(root, owner)), false, 'Stop the current instance before restoring configuration');
  const observed = fs.lstatSync(target);
  const directory = fs.mkdtempSync(path.join(root, 'backups/original-business-config-'));
  const backup = path.join(directory, 'config.json');
  let fd = fs.openSync(backup, 'wx', 0o600);
  try { fs.writeFileSync(fd, beforeBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  assert.deepEqual(fs.readFileSync(backup), beforeBytes);
  const current = fs.lstatSync(target);
  assert.equal(current.ino, observed.ino); assert.equal(current.dev, observed.dev);
  assert.deepEqual(fs.readFileSync(target), beforeBytes, 'Runtime configuration changed concurrently');
  assert.deepEqual(fs.readFileSync(source), originalBytes, 'Original baseline changed concurrently');
  const temporary = target + '.original-restore-' + Date.now() + '.tmp';
  fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(after, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  assert(originalBusinessSettingsMatch(original, JSON.parse(fs.readFileSync(target, 'utf8'))));
  report.backup = path.relative(root, backup).split(path.sep).join('/');
  report.previousBytesPreserved = true;
  fs.writeFileSync(marker, JSON.stringify({ schema: 'original-settings-v1', restoredAt: report.at,
    source: report.source, businessSettingsMatchOriginal: true, servicesStarted: false }, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(root, 'evidence/original-agent-config-restoration-20261115.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify(report));
