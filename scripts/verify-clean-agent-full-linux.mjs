import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createModelBroker } from '../src/host/full-agent-model-broker.mjs';
import { protectLocalBroker, OPENCODE_BASE, OPENCODE_MODEL } from './verify-opencode-model.mjs';
import { stageCleanAgent } from './lib/stage-clean-agent.mjs';
import { cleanInventory, runCleanAgentIsolation } from './lib/run-clean-agent-isolation.mjs';

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const [mode, input, expectedSha256] = process.argv.slice(2);
const staging = mode === '--stage' || mode === '--prepare';
async function externalSyntheticModel(model = 'clean-fixture-model') {
  const key = randomBytes(24).toString('hex'); let calls = 0, fault = false;
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${key}`)
        throw new Error('SYNTHETIC_UPSTREAM_AUTH');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2097152) throw new Error('SYNTHETIC_INPUT_LIMIT'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks)); calls++;
      const matches = [...JSON.stringify(body.messages).matchAll(/clean-in-(initial|protocolRestart|appRestart|bridgeReattached|identityRestored)-([a-f0-9]{24})/g)];
      const match = matches.at(-1); let message = { role: 'assistant', content: '' };
      if (match) {
        const toolId = `clean_${match[1]}`;
        if (!body.messages.some(item => item.role === 'tool' && item.tool_call_id === toolId)) {
          if (!body.tools?.some(tool => tool.function?.name === 'send_message')) throw new Error('SEND_TOOL_MISSING');
          message = { role: 'assistant', content: null, tool_calls: [{ id: toolId, type: 'function', function: {
            name: 'send_message', arguments: JSON.stringify({ messages: `clean-reply-${match[2]}` }) } }] };
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    } catch { fault = true; res.writeHead(400).end('{}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const broker = createModelBroker({ baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: key,
    model, maxRequests: 16, maxTokens: model === OPENCODE_MODEL ? 4096 : 512, allowLoopbackUpstream: true });
  broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening');
  return { secrets: [key], stats: () => ({ synthetic: true, calls, fault, broker: broker.stats() }),
    dispatch: async (body, { signal }) => {
      const response = await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal });
      return { status: response.status, body: await response.json() };
    },
    close: async () => { await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); },
  };
}
if (!['--stage', '--prepare', '--install', '--run', '--run-channel', '--run-real-model', '--run-opencode-fixture'].includes(mode) || typeof input !== 'string' || !path.isAbsolute(input) ||
    (staging ? process.argv.length !== 4 : process.argv.length !== 5 || !/^[a-f0-9]{64}$/.test(expectedSha256)))
  throw new Error('Use --stage/--prepare approved-source; --install staging-root manifest-sha; --run staging-root preparation-sha');
if (mode !== '--stage' && (process.platform !== 'linux' || process.arch !== 'x64')) throw new Error('Linux x64 only');
async function externalRealModel() {
  const key = process.env.OPENCODE_API_KEY;
  if (typeof key !== 'string' || !key) throw new Error('OPENCODE_KEY_REQUIRED');
  const broker = createModelBroker({ baseUrl: OPENCODE_BASE, apiKey: key, model: OPENCODE_MODEL,
    maxRequests: 6, maxTokens: 4096, timeoutMs: 90000 });
  const localAuth = protectLocalBroker(broker);
  broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening');
  return { secrets: [key, localAuth.token], stats: () => ({ synthetic: false, provider: 'OpenCode Go',
    model: OPENCODE_MODEL, calls: broker.stats().requests, broker: broker.stats() }),
    dispatch: async (body, { signal }) => {
      const response = await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...localAuth.headers }, body: JSON.stringify(body), redirect: 'error', signal });
      return { status: response.status, body: await response.json() };
    }, close: () => broker.close() };
}
let runRoot, appDir, staged;
if (staging) {
  runRoot = fs.mkdtempSync(path.join(root, '.tmp/clean-agent-'));
  appDir = path.join(runRoot, 'app');
  staged = stageCleanAgent({ projectRoot: root, appRoot: input, outputDir: appDir });
} else {
  runRoot = fs.realpathSync(input); appDir = path.join(runRoot, 'app');
  if (!runRoot.startsWith(path.join(root, '.tmp/clean-agent-'))) throw new Error('INVALID_STAGING_ROOT');
}
function sourceManifest(expected) {
  const file = path.join(appDir, 'staging-manifest.json');
  if (expected && hash(file) !== expected) throw new Error('SOURCE_MANIFEST_ANCHOR_CHANGED');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length ||
      createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== manifest.sourceHash)
    throw new Error('SOURCE_MANIFEST_IDENTITY_CHANGED');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.includes(String.fromCharCode(92)) ||
        entry.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')) || path.isAbsolute(entry.path) || seen.has(entry.path))
      throw new Error('SOURCE_MANIFEST_PATH');
    seen.add(entry.path);
    if (hash(path.join(appDir, entry.path)) !== entry.sha256) throw new Error('STAGED_SOURCE_CHANGED');
  }
  return manifest;
}
if (mode === '--stage') {
  console.log(JSON.stringify({ staged: true, runRoot, files: staged.filesCount, bytes: staged.totalBytes,
    sourceHash: staged.sourceHash, manifestSha256: hash(path.join(appDir, 'staging-manifest.json')), dependenciesInstalled: false }));
} else if (mode === '--prepare' || mode === '--install') {
  const manifest = sourceManifest(mode === '--install' ? expectedSha256 : undefined);
  const manifestShaBefore = hash(path.join(appDir, 'staging-manifest.json'));
  const before = cleanInventory(appDir);
  const allowedFiles = new Set([...manifest.files.map(file => file.path), 'staging-manifest.json']);
  if (before.some(file => file.type === 'file' && !allowedFiles.has(file.path)) || fs.existsSync(path.join(appDir, 'node_modules')))
    throw new Error('UNEXPECTED_PREINSTALL_FILES');
  for (const name of ['npm-home', 'npm-cache']) fs.mkdirSync(path.join(runRoot, name));
  const emptyConfig = path.join(runRoot, 'empty.npmrc'); fs.writeFileSync(emptyConfig, '', { flag: 'wx' });
  const globalConfig = path.join(runRoot, 'global-empty.npmrc'); fs.writeFileSync(globalConfig, '', { flag: 'wx' });
  const lockBefore = hash(path.join(appDir, 'package-lock.json'));
  const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund',
      '--cache', path.join(runRoot, 'npm-cache'), '--userconfig', emptyConfig, '--globalconfig', globalConfig], {
      cwd: appDir, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(runRoot, 'npm-home'), LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  fs.writeFileSync(path.join(runRoot, 'install-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  if (result.code !== 0 || result.signal) {
    console.error(JSON.stringify({ prepared: false, runRoot, stage: 'CLEAN_DEPENDENCY_INSTALL_FAILED', install: result })); process.exitCode = 1;
  } else {
    if (hash(path.join(appDir, 'package-lock.json')) !== lockBefore) throw new Error('LOCKFILE_CHANGED');
    sourceManifest(manifestShaBefore);
    const record = { prepared: true, runRoot, appDir, files: manifest.filesCount, bytes: manifest.totalBytes,
      sourceHash: manifest.sourceHash, lockSha256: lockBefore, npmIgnoreScripts: true, npmExitCode: 0,
      manifestSha256: hash(path.join(appDir, 'staging-manifest.json')), appInventory: cleanInventory(appDir) };
    const preparedFile = path.join(runRoot, 'prepared.json');
    fs.writeFileSync(preparedFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, runRoot, appDir, files: record.files, bytes: record.bytes,
      sourceHash: record.sourceHash, preparationSha256: hash(preparedFile), inventoryEntries: record.appInventory.length }));
  }
} else {
  const preparedFile = path.join(runRoot, 'prepared.json');
  if (hash(preparedFile) !== expectedSha256) throw new Error('PREPARATION_ANCHOR_CHANGED');
  const record = JSON.parse(fs.readFileSync(preparedFile, 'utf8'));
  if (!record.prepared || record.runRoot !== runRoot || record.appDir !== appDir || !Array.isArray(record.appInventory))
    throw new Error('INVALID_PREPARATION');
  const manifest = sourceManifest(record.manifestSha256);
  if (manifest.sourceHash !== record.sourceHash) throw new Error('SOURCE_HASH_CHANGED');
  let external, result;
  try {
    if (mode === '--run-channel') external = await externalSyntheticModel();
    if (mode === '--run-real-model') external = await externalRealModel();
    if (mode === '--run-opencode-fixture') external = await externalSyntheticModel(OPENCODE_MODEL);
    const realFlow = mode === '--run-real-model' || mode === '--run-opencode-fixture';
    result = await runCleanAgentIsolation({ projectRoot: root, appDir, runRoot, expectedAppInventory: record.appInventory,
      ...(external ? { modelDispatch: external.dispatch, parentSecretValues: external.secrets } : {}),
      ...(realFlow ? { realModel: true, timeoutMs: mode === '--run-opencode-fixture' ? 60000 : 300000 } : {}) });
    if (external) {
      result.externalModel = external.stats();
      if (realFlow) result.passed &&= result.observed?.realModel === true && result.observed.runs.length === 1 &&
        result.modelChannel.succeeded >= 2 && result.parentCredentialAbsentFromDataAndLogs === true;
      else result.passed &&= !result.externalModel.fault && result.externalModel.calls === 10 &&
        result.modelChannel.succeeded === 10 && result.parentCredentialAbsentFromDataAndLogs === true;
      if (mode === '--run-opencode-fixture') {
        result.observed.realModel = false;
        result.observed.modelFlowFixture = true;
        result.observed.limitations = ['Synthetic upstream exercising only the single-message real-model flow; NO actual OpenCode call or real QQ.', ...result.observed.limitations.slice(1)];
      }
    }
  } finally { await external?.close(); }
  const evidence = path.join(result.runtime, 'result.json');
  fs.writeFileSync(evidence, JSON.stringify({ ...result, preparation: record }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: result.passed, evidence, observed: result.observed, stderr: result.process.stderr,
    exitCode: result.process.code, stdout: result.observed ? undefined : result.process.stdout }));
  if (!result.passed) process.exitCode = 1;
}
