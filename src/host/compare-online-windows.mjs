import { OnlineObservation } from './online-observation.mjs';

function summarize(window) {
  const { implementation, platform, qqVersion, scenario, startedAt, maxGapMs, observations } = window;
  if (!['whale-onebot', 'napcat'].includes(implementation) ||
      ![platform, qqVersion, scenario].every(value => typeof value === 'string' && /^[\w.-]{1,80}$/.test(value)))
    throw new TypeError('Invalid observation window metadata');
  const startMs = Date.parse(startedAt);
  if (typeof startedAt !== 'string' || !Number.isFinite(startMs) || new Date(startMs).toISOString() !== startedAt)
    throw new TypeError('Use a UTC start timestamp with millisecond precision');
  if (!Array.isArray(observations) || observations.length === 0 || observations.length > 50000 ||
      observations[0]?.atMs !== 0)
    throw new TypeError('Expected bounded observations starting at monotonic offset zero');
  const observer = new OnlineObservation({ maxGapMs });
  for (const observation of observations) {
    if (!observation || Object.keys(observation).sort().join(',') !== 'atMs,generation,kind')
      throw new TypeError('Expected only observation time, generation and kind');
    observer.record(observation);
  }
  const summary = observer.summarize();
  const endMs = startMs + summary.observedMs;
  if (!Number.isSafeInteger(endMs) || Math.abs(endMs) > 8640000000000000)
    throw new RangeError('Invalid observation window end');
  return { implementation, platform, qqVersion, scenario, startMs, endMs, summary };
}

export function compareOnlineWindows(whale, napcat) {
  const windows = [whale, napcat];
  const [candidate, baseline] = windows.map(summarize);
  if (candidate.implementation !== 'whale-onebot' || baseline.implementation !== 'napcat')
    throw new TypeError('Expected a Whale OneBot window and a NapCat window, in that order');
  const blockers = [];
  for (const key of ['platform', 'qqVersion', 'scenario'])
    if (candidate[key] !== baseline[key]) blockers.push('mismatch:' + key);
  if (candidate.summary.maxGapMs !== baseline.summary.maxGapMs) blockers.push('mismatch:maxGapMs');
  if (candidate.startMs < baseline.endMs && baseline.startMs < candidate.endMs) blockers.push('overlapping-windows');
  const summaries = [candidate, baseline];
  for (const [index, { implementation, summary }] of summaries.entries())
    blockers.push(...windowBlockers(windows[index], summary).map(reason => implementation + ':' + reason));
  return {
    comparable: blockers.length === 0,
    blockers,
    windows: Object.fromEntries(summaries.map(({ implementation, summary }) => [implementation, summary])),
    observedKicksPerHour: blockers.length ? null : Object.fromEntries(summaries.map(({ implementation, summary }) =>
      [implementation, summary.confirmedPlatformKicks * 3600000 / summary.verifiedOnlineMs])),
  };
}

export function compareOnlineWindowSeries(windows) {
  if (!Array.isArray(windows) || windows.length < 2 || windows.length > 32)
    throw new TypeError('Expected 2 through 32 observation windows');
  const summaries = windows.map((window, index) => ({ ...summarize(window), index, window }));
  const reference = summaries[0];
  const totals = Object.fromEntries(['whale-onebot', 'napcat'].map(name => [name, {
    windowCount: 0, observedMs: 0, verifiedOnlineMs: 0, confirmedPlatformKicks: 0,
  }]));
  const blockers = [];
  for (const entry of summaries) {
    const { implementation, index, summary, window } = entry;
    const total = totals[implementation];
    total.windowCount++;
    total.observedMs += summary.observedMs;
    total.verifiedOnlineMs += summary.verifiedOnlineMs;
    total.confirmedPlatformKicks += summary.confirmedPlatformKicks;
    const prefix = implementation + '[' + (index + 1) + ']:';
    for (const key of ['platform', 'qqVersion', 'scenario'])
      if (entry[key] !== reference[key]) blockers.push(prefix + 'mismatch:' + key);
    if (summary.maxGapMs !== reference.summary.maxGapMs) blockers.push(prefix + 'mismatch:maxGapMs');
    blockers.push(...windowBlockers(window, summary).map(reason => prefix + reason));
  }
  for (const [name, total] of Object.entries(totals)) {
    if (total.windowCount === 0) blockers.push(name + ':missing-windows');
    if (!Number.isSafeInteger(total.observedMs)) throw new RangeError('Total observation time is outside the supported range');
  }
  const ordered = [...summaries].sort((left, right) => left.startMs - right.startMs);
  let endMs = -Infinity;
  for (const entry of ordered) {
    if (entry.startMs < endMs && entry.endMs > entry.startMs) {
      blockers.push('overlapping-windows');
      break;
    }
    endMs = Math.max(endMs, entry.endMs);
  }
  return { comparable: blockers.length === 0, blockers, totals,
    observedKicksPerHour: blockers.length ? null : Object.fromEntries(Object.entries(totals).map(([name, total]) =>
      [name, total.confirmedPlatformKicks * 3600000 / total.verifiedOnlineMs])) };
}

function windowBlockers(window, summary) {
  const blockers = [];
  if (summary.terminalReason === null) blockers.push('window-open');
  if (summary.verifiedOnlineMs === 0) blockers.push('no-verified-exposure');
  if (['unknown_exit', 'session_invalidated'].includes(summary.terminalReason)) blockers.push('unattributed-ending');
  if (summary.confirmedPlatformKicks && summary.verifiedOnlineMs > 0 && windowLastProofAge(window) > summary.maxGapMs)
    blockers.push('kick-outside-fresh-exposure');
  return blockers;
}

function windowLastProofAge({ observations }) {
  const last = observations.at(-1);
  const previous = observations.at(-2);
  return previous?.kind === 'verified_online' && previous.generation === last.generation
    ? last.atMs - previous.atMs : Infinity;
}
