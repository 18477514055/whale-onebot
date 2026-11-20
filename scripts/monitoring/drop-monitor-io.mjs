import fs from 'node:fs/promises';
import path from 'node:path';
import { parseProcStat, exactParentCommand, identityContinuity, classifySample, shouldEmit, serializeSample } from './drop-monitor-core.mjs';

export const LIVE_PROFILE = 'login-12ae6a93f2639df1df3f';
export const ACTIVE_WORK = '.tmp/integrated-inputs-NNapHG';
const reject = () => { throw new Error('MONITOR_PATH_OR_OPTIONS_REJECTED'); };
const inside = (root, target) => target.startsWith(root + path.sep);

// Reject links in every existing component; do not follow project junctions.
export async function physicalPath(root, target, { missingLeaf = false } = {}) {
  if (!inside(root, target) && target !== root) reject();
  let current = root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const [index, part] of ['', ...segments].entries()) {
    if (part) current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) reject();
      if (index < segments.length && !stat.isDirectory()) reject();
    } catch (error) {
      if (missingLeaf && index === segments.length && error.code === 'ENOENT') return;
      throw error;
    }
  }
}
export async function readJson(root, file) {
  try {
    await physicalPath(root, file);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}
export async function inspectProcess(pid, root, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid < 1) return { exists: false };
  const base = path.join(procRoot, String(pid));
  try {
    const first = parseProcStat(await fs.readFile(path.join(base, 'stat'), 'utf8'));
    const argv = (await fs.readFile(path.join(base, 'cmdline'), 'utf8')).split('\0');
    if (argv.at(-1) === '') argv.pop();
    const cwd = await fs.readlink(path.join(base, 'cwd'));
    const last = parseProcStat(await fs.readFile(path.join(base, 'stat'), 'utf8'));
    return { exists: true, running: Boolean(first?.running && last?.running),
      starttime: first?.starttime === last?.starttime ? first?.starttime : null,
      commandMatches: exactParentCommand(argv, cwd, root, path.resolve) };
  } catch (error) {
    return { exists: error.code !== 'ENOENT', running: false, commandMatches: false };
  }
}
export async function getHealth(port, request = fetch) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return { reachable: false };
  try {
    // Exact loopback health endpoint. No token, business API, WS, QR or mailbox.
    const response = await request(`http://127.0.0.1:${port}/healthz`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) { await response.body?.cancel(); return { reachable: false }; }
    // Bound body even when Content-Length is absent. Never print response/errors.
    const reader = response.body?.getReader();
    if (!reader) return { reachable: true, ok: null, onebotConnected: null };
    let bytes = 0; const chunks = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 16384) { await reader.cancel(); return { reachable: true, ok: null, onebotConnected: null }; }
      chunks.push(Buffer.from(part.value));
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    return { reachable: true, ok: typeof body?.ok === 'boolean' ? body.ok : null,
      onebotConnected: typeof body?.onebotConnected === 'boolean' ? body.onebotConnected : null };
  } catch { return { reachable: false }; }
}

export function parseOptions(args, root) {
  let once = false, intervalMs = 3000, output;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--once' && !once) once = true;
    else if (key === '--interval-ms' && /^\d+$/.test(args[i + 1] ?? '')) intervalMs = Number(args[++i]);
    else if (key === '--output' && args[i + 1]) output = path.resolve(root, args[++i]);
    else reject();
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 2000 || intervalMs > 5000) reject();
  if (output && (path.dirname(output) !== path.join(root, 'runtime', 'monitoring') ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(path.basename(output)))) reject();
  return { once, intervalMs, output };
}

export async function createLogger(root, requested) {
  const base = path.join(root, 'runtime', 'monitoring');
  await physicalPath(root, path.join(root, 'runtime'));
  await physicalPath(root, base, { missingLeaf: true });
  await fs.mkdir(base, { recursive: true });
  await physicalPath(root, base);
  let directory;
  if (requested) {
    if (path.dirname(requested) !== base || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(path.basename(requested))) reject();
    await fs.mkdir(requested); // Never reuse another run, including --once.
    directory = requested;
  } else directory = await fs.mkdtemp(path.join(base, 'drop-'));
  const events = await fs.open(path.join(directory, 'events.jsonl'), 'wx', 0o600);
  const latest = await fs.open(path.join(directory, 'latest.json'), 'wx+', 0o600);
  return {
    directory,
    async write(sample) {
      // Re-project at the persistence boundary; arbitrary fields/strings are discarded.
      const line = serializeSample(sample);
      await events.write(line);
      await latest.truncate(0);
      await latest.write(line, 0, 'utf8');
    },
    async close() { await events.close(); await latest.close(); },
  };
}

export async function runMonitor({ root, once = false, intervalMs = 3000, output,
  procRoot = '/proc', request = fetch, onSample = () => {}, signal } = {}) {
  const logger = await createLogger(root, output);
  const lockFile = path.join(root, 'runtime/integrated-login.lock');
  const statusFile = path.join(root, 'runtime/integrated', LIVE_PROFILE, 'status.json');
  // Final-result source is the explicitly identified activework, NOT profile or old evidence.
  const resultFile = path.join(root, ACTIVE_WORK, 'parent-result.json');
  const initialLock = await readJson(root, lockFile);
  const initial = await inspectProcess(initialLock?.pid, root, procRoot);
  const bound = initialLock?.profileId === LIVE_PROFILE && initial.exists && initial.running &&
    initial.commandMatches && initial.starttime ? initial : null;
  let previous, emitted, lastEmission = -Infinity, lostSamples = 0, bindingLost = false, lastStatus, final;
  try {
    for (;;) {
      const lock = await readJson(root, lockFile);
      let proc = await inspectProcess(initialLock?.pid, root, procRoot);
      let continuous = !bindingLost && identityContinuity(bound, proc,
        lock?.pid === initialLock?.pid && lock?.profileId === LIVE_PROFILE);
      const status = bindingLost ? lastStatus : await readJson(root, statusFile);
      lastStatus = status;
      const health = continuous ? await getHealth(status?.liveAgent?.consolePort, request) : null;
      // Do not let a health response race a PID replacement or lock handover.
      proc = await inspectProcess(initialLock?.pid, root, procRoot);
      const afterLock = await readJson(root, lockFile);
      continuous = continuous && identityContinuity(bound, proc,
        afterLock?.pid === initialLock?.pid && afterLock?.profileId === LIVE_PROFILE);
      bindingLost ||= !continuous;
      continuous &&= !bindingLost; // Never rebind/recover after losing this process identity.
      const parentResult = await readJson(root, resultFile);
      const now = Date.now(), heartbeatClock = performance.now();
      final = classifySample({ status, health, process: proc, identityContinuous: continuous,
        parentResult, previous, stopped: signal?.aborted, bindingRejected: !bound, now });
      const finishing = once || !bound || signal?.aborted || parentResult || (!continuous && lostSamples >= 2);
      if (shouldEmit(emitted, final, lastEmission, heartbeatClock) || finishing) {
        await logger.write(final); await onSample(final); emitted = final; lastEmission = heartbeatClock;
      }
      previous = final;
      if (!continuous) lostSamples++; else lostSamples = 0;
      // At most two additional intervals to collect the existing final result.
      if (once || !bound || signal?.aborted || parentResult || lostSamples >= 3) break;
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, intervalMs);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    return final;
  } finally { await logger.close(); }
}
