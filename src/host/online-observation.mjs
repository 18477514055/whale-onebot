const terminalTypes = new Set(['session_invalidated', 'platform_kick_confirmed', 'native_crash',
  'operator_stop', 'observation_expired', 'unknown_exit']);
const evidenceTypes = new Set(['verified_online', 'unverified', 'network_unavailable', ...terminalTypes]);
const splitPortFields = ['httpPortReused', 'webSocketPortReused', 'httpOfflineVerified', 'webSocketOfflineVerified'];

export function hasThreePathReadback(report) {
  return report?.reverseConnected === true && report.reverseEventVerified === true &&
    report.messageReadbackVerified === true && report.forwardMessageReadbackVerified === true &&
    report.reverseMessageReadbackVerified === true && report.reverseOfflineVerified === true &&
    report.terminalMessageIdVerified === true;
}

export function summarizeLiveRoundtripEvidence(live) {
  const roundtrip = live?.roundtripResult;
  const status = live?.postRoundtripStatus;
  const sameSession = live?.identityMatches === true && live.exactInputInventory === true &&
    live.sessionGeneration === 1 && live.qrRequests === 1 && live.sessionInitAttempts === 1 && live.automaticRetry === false;
  const offline = entry => sameSession && Number.isSafeInteger(status?.seq) && status.seq > roundtrip?.seq &&
    entry?.endpointResponded === true && entry.status?.online === false && entry.status?.good === false;
  const confirmedSend = roundtrip?.commandCompleted === true || (roundtrip?.commandCompleted === false &&
    roundtrip.postSendChecksIncomplete === true && roundtrip.terminalMessageIdVerified === true);
  const send = sameSession && confirmedSend && roundtrip.oneBotRestartVerified === true &&
    roundtrip.bridgeReattachmentVerified === true && roundtrip.outboundVerified === true &&
    roundtrip.writeOutcomeUnknown === false && roundtrip.pendingOutcomePresent === false &&
    live.sendResponse?.httpStatus === 200 && live.sendResponse?.retcode === 0 &&
    live.receiptObservation?.terminalSuccessWithValidId === 1;
  const httpReadback = send && roundtrip.messageReadbackAttempted === true && roundtrip.messageReadbackVerified === true &&
    live.messageReadback?.attempted === true && live.messageReadback?.verified === true;
  const forwardReadback = httpReadback && roundtrip.forwardMessageReadbackVerified === true;
  const reverseReadback = httpReadback && roundtrip.reverseConnected === true && roundtrip.reverseMessageReadbackVerified === true;
  const transportCoverage = {
    http: { businessActions: [], offlineStatusVerified: roundtrip?.httpOfflineVerified === true && offline(status?.data) },
    forwardWebSocket: { businessActions: forwardReadback ? ['get_msg'] : [],
      challengeEventVerified: sameSession && roundtrip?.inboundVerified === true,
      offlineStatusVerified: roundtrip?.webSocketOfflineVerified === true && offline(status?.data?.webSocket) },
    reverseWebSocket: { businessActions: reverseReadback ? ['get_msg'] : [],
      challengeEventVerified: sameSession && roundtrip?.reverseConnected === true && roundtrip.reverseEventVerified === true,
      offlineStatusVerified: roundtrip?.reverseOfflineVerified === true && status?.data?.reverseWebSocket?.connected === true &&
        status.data.reverseWebSocket.pongVerified === true && offline(status.data.reverseWebSocket) },
  };
  if (send && roundtrip.groupInfoAttempted === true && roundtrip.groupInfoVerified === true)
    transportCoverage.http.businessActions.push('get_group_info');
  if (httpReadback) transportCoverage.http.businessActions.push('get_msg');
  if (send) transportCoverage.http.businessActions.push('send_group_msg');
  const postRoundtripSessionVerified = sameSession && Number.isSafeInteger(status?.seq) && status.seq > roundtrip?.seq &&
    status.roundtripSeq === roundtrip.seq && status.sessionGeneration === live.sessionGeneration &&
    status.data?.sessionHold?.state === 'active' && status.data.nativeSession?.checked === true &&
    status.data.nativeSession.matchesAuthenticatedSession === true;
  return { transportCoverage, postRoundtripSessionVerified,
    threePathRoundtripVerified: postRoundtripSessionVerified && roundtrip?.commandCompleted === true &&
    roundtrip.verifiedSameSessionRoundtrip === true &&
    roundtrip.postSendChecksIncomplete === false && roundtrip.cleanupPending === false &&
    roundtrip.inboundVerified === true && roundtrip.offlineEndpointRestored === true &&
    hasThreePathReadback(roundtrip) && httpReadback && transportCoverage.http.offlineStatusVerified &&
    transportCoverage.forwardWebSocket.offlineStatusVerified && transportCoverage.reverseWebSocket.offlineStatusVerified };
}

// One confirmed exchange establishes reachability at the time of the test.
// Sampling the same progress snapshot repeatedly adds no online duration.
export function summarizeRoundtripReachability(state) {
  const progress = state?.roundtripProgress;
  const response = state?.roundtripSendResponse;
  const endpoint = state?.roundtripEndpointCheck;
  return {
    inboundVerified: progress?.oneBotEventVerified === true,
    ...(typeof progress?.reverseConnected === 'boolean' && { reverseConnected: progress.reverseConnected }),
    ...(typeof progress?.reverseEventVerified === 'boolean' && { reverseEventVerified: progress.reverseEventVerified }),
    ...(typeof progress?.nativeSubmissionAttempted === 'boolean' && { nativeSubmissionAttempted: progress.nativeSubmissionAttempted }),
    ...(typeof progress?.terminalMessageIdVerified === 'boolean' && { terminalMessageIdVerified: progress.terminalMessageIdVerified }),
    outboundVerified: progress?.nativeSubmissionAttempted === true &&
      progress?.oneBotSendConfirmed === true && response?.httpStatus === 200 && response?.retcode === 0,
    oneBotRestartVerified: state?.roundtripOneBotRestartVerified === true,
    bridgeReattachmentVerified: state?.roundtripBridgeRestartVerified === true,
    preLoginPortReused: endpoint?.reusesPreLoginPort === true,
    offlineEndpointRestored: endpoint?.offlineRestored === true,
    ...(typeof endpoint?.reverseOfflineVerified === 'boolean' && { reverseOfflineVerified: endpoint.reverseOfflineVerified }),
    ...Object.fromEntries(splitPortFields.filter(field => typeof endpoint?.[field] === 'boolean')
      .map(field => [field, endpoint[field]])),
    groupInfoVerified: state?.roundtripGroupRead?.attempted === true && state.roundtripGroupRead.verified === true,
    messageReadbackVerified: state?.roundtripMessageRead?.attempted === true && state.roundtripMessageRead.verified === true,
    ...(typeof state?.roundtripMessageRead?.reverseVerified === 'boolean' && {
      reverseMessageReadbackVerified: state.roundtripMessageRead.reverseVerified,
    }),
    ...(typeof state?.roundtripMessageRead?.forwardVerified === 'boolean' && {
      forwardMessageReadbackVerified: state.roundtripMessageRead.forwardVerified,
    }),
  };
}

export function summarizeRoundtripResult(state, response, pendingOutcomePresent, cleanupPending = false) {
  if (response?.command !== 'verify_onebot_roundtrip' || response.accepted !== true)
    return null;
  if (!Number.isSafeInteger(response.seq) || response.seq < 1 || typeof pendingOutcomePresent !== 'boolean')
    throw new TypeError('Invalid roundtrip result identity');
  const completed = response.status === 'completed' && response.code === 'COMPLETED';
  const reachability = summarizeRoundtripReachability(state);
  const splitChecksPassed = !splitPortFields.some(field => Object.hasOwn(reachability, field)) ||
    splitPortFields.every(field => reachability[field] === true);
  const sendConfirmed = state?.roundtripProgress?.oneBotSendConfirmed === true;
  const transportChecksPassed = state?.roundtripReadbackMode === 'http-forward-reverse'
    ? hasThreePathReadback(reachability)
    : reachability.reverseMessageReadbackVerified !== false && reachability.forwardMessageReadbackVerified !== false;
  const postSendChecksPassed = reachability.messageReadbackVerified && reachability.offlineEndpointRestored &&
    transportChecksPassed &&
    splitChecksPassed && !pendingOutcomePresent && !cleanupPending;
  return {
    seq: response.seq,
    commandCompleted: completed,
    postSendChecksIncomplete: response.code === 'SEND_CONFIRMED_CHECKS_INCOMPLETE' ||
      (sendConfirmed && !postSendChecksPassed),
    writeOutcomeUnknown: response.code === 'WRITE_OUTCOME_UNKNOWN',
    ...(response.code === 'ADAPTER_NOT_STARTED' && reachability.nativeSubmissionAttempted === false &&
      !pendingOutcomePresent && !cleanupPending && { noNativeSubmission: true }),
    pendingOutcomePresent,
    cleanupPending,
    ...reachability,
    groupInfoAttempted: state?.roundtripGroupRead?.attempted === true,
    messageReadbackAttempted: state?.roundtripMessageRead?.attempted === true,
    verifiedSameSessionRoundtrip: completed && reachability.inboundVerified && reachability.outboundVerified &&
      reachability.oneBotRestartVerified && reachability.bridgeReattachmentVerified && reachability.preLoginPortReused &&
      postSendChecksPassed && reachability.reverseEventVerified !== false && reachability.reverseConnected !== false,
  };
}

// Child terminal phases are diagnostic observations. A Linux signal or a
// generic transport disconnect cannot establish why the service ended.
export function classifyIntegratedHostExit({ phase, signal, status, deadlineElapsed = false }) {
  if (deadlineElapsed && signal === 'SIGKILL') return 'observation_expired';
  if (signal !== null) return 'unknown_exit';
  if (status === 0 && phase === 'closed') return 'operator_stop';
  if (status === 2 && phase === 'manual-session-hold-expired') return 'observation_expired';
  if (status === 2 && ['logged-out', 'changed-login-identity'].includes(phase)) return 'session_invalidated';
  return 'unknown_exit';
}

// The host supplies already classified evidence and a monotonic clock.
// A cache hit, old login callback or process heartbeat is "unverified".
export class OnlineObservation {
  #maxGapMs;
  #previous = null;
  #started = null;
  #verified = 0;
  #intervals = 0;
  #networkInterruptions = 0;
  #terminal = null;

  constructor({ maxGapMs } = {}) {
    if (!Number.isSafeInteger(maxGapMs) || maxGapMs < 1 || maxGapMs > 300000)
      throw new TypeError('A freshness bound of 1 through 300000 ms is required');
    this.#maxGapMs = maxGapMs;
  }

  record({ atMs, kind, generation }) {
    if (this.#terminal !== null) throw new Error('Observation window has ended');
    if (!Number.isSafeInteger(atMs) || atMs < 0 || !evidenceTypes.has(kind) ||
        !Number.isSafeInteger(generation) || generation < 1)
      throw new TypeError('Invalid observation');
    const previous = this.#previous;
    if (previous && (atMs <= previous.atMs || generation < previous.generation))
      throw new RangeError('Observations must advance in time and generation');
    this.#started ??= atMs;
    const gap = atMs - (previous?.atMs ?? atMs);
    if (kind === 'verified_online' && previous?.kind === 'verified_online' &&
        previous.generation === generation && gap <= this.#maxGapMs) {
      this.#verified += gap;
      this.#intervals++;
    }
    if (terminalTypes.has(kind)) this.#terminal = kind;
    if (kind === 'network_unavailable' && previous?.kind !== kind) this.#networkInterruptions++;
    this.#previous = { atMs, kind, generation };
  }

  summarize() {
    const observedMs = this.#previous === null ? 0 : this.#previous.atMs - this.#started;
    return {
      maxGapMs: this.#maxGapMs,
      observedMs,
      verifiedOnlineMs: this.#verified,
      verifiedIntervals: this.#intervals,
      unverifiedMs: observedMs - this.#verified,
      terminalReason: this.#terminal,
      confirmedPlatformKicks: Number(this.#terminal === 'platform_kick_confirmed'),
      networkInterruptions: this.#networkInterruptions,
    };
  }
}
