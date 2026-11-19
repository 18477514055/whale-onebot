import { OneBotCore as ProtocolCore } from './protocol/core.mjs';
import { qqOneBot11Profile, scopeQQProfileToGroup } from './bridge/qq-profile.mjs';

export { OfflineBridge } from './protocol/core.mjs';

// Existing QQ callers retain their profile and account guard.
export class OneBotCore extends ProtocolCore {
  constructor(options = {}) {
    const { readOnlyGroup, readOnlyChallengeText, ...coreOptions } = options;
    if (readOnlyGroup !== undefined && coreOptions.readOnly !== true)
      throw new TypeError('A test group requires read-only mode');
    if (readOnlyChallengeText !== undefined && (coreOptions.readOnly !== true || readOnlyGroup === undefined ||
        typeof readOnlyChallengeText !== 'string' || !/^whale-check-[a-f0-9]{32}$/.test(readOnlyChallengeText)))
      throw new TypeError('A protected test challenge requires scoped read-only mode');
    super({ ...coreOptions, profile: readOnlyGroup === undefined ? qqOneBot11Profile : scopeQQProfileToGroup(readOnlyGroup, readOnlyChallengeText) });
  }
}
