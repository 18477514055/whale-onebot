const responseFields = ['result', 'helloInterval', 'status', 'extStatus', 'batteryInterval', 'statusInterval'];
const observationNames = ['onSelfStatusChanged', 'onUserOnlineResult', 'onRegisterProxyOnlineResp'];

// Input values are already redacted by the fixed native callback adapters.
export function describeOnlineObservations(events, { generation, nowMs, maxAgeMs }) {
  if (!Number.isSafeInteger(generation) || generation < 1 ||
      !Number.isFinite(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 300000)
    throw new TypeError('Invalid observation clock or generation');
  const observations = {};
  for (const name of observationNames) {
    const event = events[name];
    if (!event) continue;
    const age = nowMs - event.observedAtMonotonicMs;
    if (event.generation !== generation || !Number.isFinite(age) || age < 0) continue;
    observations[name] = { ...event, ageMs: Math.floor(age),
      withinObservationWindow: age <= maxAgeMs };
  }
  return { events: observations, onlineProof: false };
}

export function summarizeOnlineSignal(args, identity, sessionId) {
  const [code, identifier, response] = args;
  const scalars = {};
  if (response && typeof response === 'object') {
    for (const key of responseFields) {
      const value = Object.getOwnPropertyDescriptor(response, key)?.value;
      if (Number.isInteger(value) && value >= -2147483648 && value <= 4294967295) scalars[key] = value;
    }
  }
  return {
    argumentCount: args.length,
    code: Number.isInteger(code) && code >= -2147483648 && code <= 2147483647 ? code : null,
    identifierType: typeof identifier,
    matchesAccount: typeof identifier === 'string' && identifier === identity?.uin,
    matchesUid: typeof identifier === 'string' && identifier === identity?.uid,
    matchesSession: typeof identifier === 'string' && identifier === sessionId,
    response: scalars,
    onlineProof: false,
  };
}
