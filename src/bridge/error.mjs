export class BridgeError extends Error {
  constructor(code, message, { retcode = 1400, outcome = 'not_started' } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.retcode = retcode;
    this.outcome = outcome;
  }
}
