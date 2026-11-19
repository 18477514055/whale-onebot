import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createOriginalAgentConfig, originalBusinessSettingsMatch, RUNTIME_MODEL_AUTH_MARKER } from './original-agent-config.mjs';

const failure = code => Object.assign(new Error(code), { code });
const safeCode = error => typeof error?.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code) ? error.code : 'AGENT_PROCESS_ERROR';

// D12/D13: no business overlay, activation/pause calls, backlog acknowledgement,
// trial phase or message budget. The original App owns all business decisions.
export async function startOriginalAgentRuntime({ dataDir, homeDir, appEntry, preloadPath,
  logDir, onebot, consolePort, onebotSha256, modelBase, modelRelay, publish = () => {},
  signal, startupTimeoutMs = 180000, spawnProcess = spawn, request = fetch } = {}) {
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 300000)
    throw failure('AGENT_START_TIMEOUT_INVALID');
  if (!onebot || !Number.isSafeInteger(onebot.port) || !Number.isSafeInteger(onebot.wsPort) ||
      typeof onebot.token !== 'string' || !onebot.token || typeof modelRelay !== 'string' || !modelRelay ||
      !/^[a-f0-9]{64}$/.test(onebotSha256 ?? '')) throw failure('AGENT_CONNECTIONS_REQUIRED');
  const relay = new URL(modelBase);
  if (relay.protocol !== 'http:' || relay.hostname !== '127.0.0.1' || !relay.port || relay.pathname !== '/v1' ||
      relay.username || relay.password || relay.search || relay.hash) throw failure('AGENT_MODEL_RELAY_INVALID');
  signal?.throwIfAborted();
  const configFile = path.join(dataDir, 'config.json');
  const stat = fs.lstatSync(configFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024)
    throw failure('AGENT_CONFIG_INVALID');
  const original = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const configured = createOriginalAgentConfig(original, {
    onebotWsUrl: `ws://127.0.0.1:${onebot.wsPort}`, onebotHttpUrl: `http://127.0.0.1:${onebot.port}`,
    consoleHost: '127.0.0.1', consolePort, modelAuthMarker: RUNTIME_MODEL_AUTH_MARKER,
  });
  if (!originalBusinessSettingsMatch(original, configured)) throw failure('AGENT_BUSINESS_CONFIG_CHANGED');
  // Non-secret deployment settings only. Never replace the data directory/DB.
  fs.writeFileSync(configFile, JSON.stringify(configured, null, 2) + '\n');
  const output = fs.createWriteStream(path.join(logDir, 'agent-stdout.log'), { flags: 'a', mode: 0o600 });
  const errors = fs.createWriteStream(path.join(logDir, 'agent-stderr.log'), { flags: 'a', mode: 0o600 });
  let processError, logError, child, stopping;
  const notify = value => { try { publish(value); } catch { /* Diagnostics must not affect business work. */ } };
  output.on('error', error => { logError = safeCode(error); });
  errors.on('error', error => { logError = safeCode(error); });
  try {
    child = spawnProcess(process.execPath, ['--import', pathToFileURL(preloadPath).href, appEntry], {
      cwd: path.dirname(appEntry), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/bin', HOME: homeDir, TMPDIR: path.join(homeDir, 'tmp'), TZ: 'Asia/Shanghai',
        QQ_AGENT_DATA_DIR: dataDir, WHALE_ORIGINAL_AGENT: '1', WHALE_PHONE_ONEBOT_SHA: onebotSha256,
        WHALE_ONEBOT_TOKEN: onebot.token, WHALE_MODEL_BROKER_BASE: modelBase, WHALE_MODEL_RELAY_TOKEN: modelRelay },
    });
  } catch (error) { output.end(); errors.end(); throw failure(safeCode(error)); }
  child.on('error', error => { processError = safeCode(error); });
  child.stdout.pipe(output); child.stderr.pipe(errors);
  const exited = new Promise(resolve => child.once('close', (code, nativeSignal) => {
    output.end(); errors.end();
    notify({ processExit: { code, signal: nativeSignal }, ...(processError ? { failureCode: processError } : {}) });
    resolve({ code, signal: nativeSignal });
  }));
  const stop = () => stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 10000);
    try {
      const result = await exited;
      await Promise.allSettled([finished(output), finished(errors)]);
      return result;
    } finally { clearTimeout(timer); }
  })();
  const aborted = () => { void stop(); };
  signal?.addEventListener('abort', aborted, { once: true });
  void exited.finally(() => signal?.removeEventListener('abort', aborted));
  notify({ stage: 'loading-original-data', consolePort, businessSettingsPreserved: true });
  const deadline = Date.now() + startupTimeoutMs;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (processError) throw failure(processError);
      if (logError) throw failure('AGENT_LOG_FAILED');
      if (child.exitCode !== null || child.signalCode !== null) throw failure('AGENT_START_EXIT');
      try {
        const response = await request(`http://127.0.0.1:${consolePort}/healthz`, {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000),
        });
        const healthy = response.ok;
        await response.body?.cancel();
        if (healthy) {
          // No writes to /api/runtime or /api/pause. Original active/paused values win.
          notify({ stage: 'ready-original-rules', consolePort, businessSettingsPreserved: true });
          return { child, exited, stop, businessSettingsPreserved: true };
        }
      } catch (error) { if (signal?.aborted) throw error; }
      await delay(250, undefined, { signal });
    }
    throw failure('AGENT_HEALTH_TIMEOUT');
  } catch (error) { await stop(); throw error; }
}
