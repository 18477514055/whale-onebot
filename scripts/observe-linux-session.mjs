import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { OnlineObservation } from '../src/host/online-observation.mjs';

const [profile, qqVersion, scenario, seconds, ...extra] = process.argv.slice(2);
if (extra.length || !/^login-[a-f0-9]{20}$/.test(profile ?? '') ||
    ![qqVersion, scenario].every(value => /^[\w.-]{1,80}$/.test(value ?? '')) ||
    !/^(?:[1-9]|[1-5]\d|60)$/.test(seconds ?? ''))
  throw new Error('Usage: observe-linux-session.mjs <profile> <qq-version> <scenario> <1-60 seconds>');

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, 'runtime', 'integrated', profile);
const client = path.join(import.meta.dirname, 'calibration-command.mjs');
function readSnapshot() {
  try {
    const response = JSON.parse(execFileSync(process.execPath, [client, directory, 'read_host_snapshot'], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    if (response.status === 'completed' && Number.isSafeInteger(response.data?.sessionGeneration)) return response.data;
  } catch {
    // A brief publication failure must not terminate the window or count as a kick.
  }
  return null;
}

const initial = readSnapshot();
if (!initial) throw new Error('No readable integrated host snapshot at the start of observation');
const startedAt = new Date().toISOString();
const started = performance.now();
const maxGapMs = 3000;
const observations = [];
const observer = new OnlineObservation({ maxGapMs });
const add = (atMs, generation, kind) => {
  const observation = { atMs, generation, kind };
  observer.record(observation);
  observations.push(observation);
};
let generation = initial.sessionGeneration;
let latest = initial;
let distinctSnapshots = 1;
let unavailableReads = 0;
add(0, generation, 'unverified');
for (let next = 1000; next < Number(seconds) * 1000; next += 1000) {
  await delay(Math.max(0, next - (performance.now() - started)));
  const snapshot = readSnapshot();
  if (!snapshot || snapshot.sessionGeneration < generation || snapshot.observedAt < latest.observedAt) {
    unavailableReads++;
    continue;
  }
  if (snapshot.observedAt === latest.observedAt) continue;
  latest = snapshot;
  generation = snapshot.sessionGeneration;
  distinctSnapshots++;
  // Snapshot timestamps and saved business-online flags cannot prove a fresh business response.
  add(Math.max(observations.at(-1).atMs + 1, Math.floor(performance.now() - started)), generation, 'unverified');
}
await delay(Math.max(0, Number(seconds) * 1000 - (performance.now() - started)));
add(Math.max(observations.at(-1).atMs + 1, Math.floor(performance.now() - started)), generation, 'observation_expired');
console.log(JSON.stringify({ implementation: 'whale-onebot', platform: 'linux', qqVersion, scenario, startedAt,
  maxGapMs, observations, snapshotDiagnostics: { distinctSnapshots, unavailableReads, lastPhase: latest.phase },
  summary: observer.summarize() }, null, 2));
