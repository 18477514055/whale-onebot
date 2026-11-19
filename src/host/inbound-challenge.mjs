import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BOT_UIN, OWNER_UIN } from '../config/account.mjs';

const bot = BOT_UIN;
const protectedAccount = OWNER_UIN;
const matchWindowMs = 30000;
const bump = value => Math.min(10000, value + 1);
const verifiedProtectedMessages = new WeakSet();

export const isVerifiedProtectedChallenge = message => verifiedProtectedMessages.has(message);

function qqNumber(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && /^[1-9]\d{4,15}$/.test(value) &&
    Number.isSafeInteger(Number(value)) ? value : null;
}

export class InboundChallenge {
  #current;
  #clock;
  #attempts = 0;
  #allowProtectedSender;

  constructor(clock = () => performance.now(), { allowProtectedSender = false } = {}) {
    this.#clock = clock;
    this.#allowProtectedSender = allowProtectedSender;
  }

  arm(generation, groupId, { readbackOnly = false, allowAdminChallenge = false } = {}) {
    if (typeof readbackOnly !== 'boolean' || typeof allowAdminChallenge !== 'boolean' ||
        (allowAdminChallenge && !readbackOnly)) throw new TypeError('Admin challenge requires explicit receive-only mode');
    if (typeof groupId !== 'string' || !/^[1-9]\d{4,15}$/.test(groupId) || !Number.isSafeInteger(Number(groupId)))
      throw new TypeError('A valid test group is required');
    const now = this.#clock();
    if (this.#attempts >= 3 || (this.#current && (
      this.#current.generation !== generation || this.#current.groupId !== groupId ||
      (this.#current.matched
        ? (!this.#current.message || now - this.#current.matchedAt < matchWindowMs)
        : now < this.#current.expiresAt))))
      throw new Error('Challenge cannot be rearmed for this host');
    const text = 'whale-check-' + randomBytes(16).toString('hex');
    this.#attempts++;
    this.#current = { generation, groupId, text, readbackOnly, allowAdminChallenge, expiresAt: now + 180000,
      callbacks: 0, groupCandidates: 0, testGroupMessages: 0 };
    return { text, expiresInMs: 180000, attempt: this.#attempts };
  }

  observe(messages, generation) {
    const challenge = this.#current;
    if (!challenge || challenge.matched || challenge.generation !== generation ||
        this.#clock() >= challenge.expiresAt) return;
    challenge.callbacks = bump(challenge.callbacks);
    if (!Array.isArray(messages) || messages.length > 128) return;
    for (const message of messages) {
      if (!message || message.chatType !== 2 || qqNumber(message.peerUid) !== challenge.groupId) continue;
      challenge.groupCandidates = bump(challenge.groupCandidates);
      const sender = qqNumber(message.senderUin);
      if (message.sendStatus === 1 || !sender || sender === bot ||
          (sender === protectedAccount && (!this.#allowProtectedSender || (challenge.readbackOnly && !challenge.allowAdminChallenge))) ||
          typeof message.msgId !== 'string' || !/^[1-9]\d{0,127}$/.test(message.msgId) ||
          !Array.isArray(message.elements) || message.elements.length < 1 || message.elements.length > 8) continue;
      if (sender !== protectedAccount) challenge.testGroupMessages = bump(challenge.testGroupMessages);
      let offset = 0;
      const exactText = message.elements.every(element => {
        const part = element?.textElement?.content;
        if (element?.elementType !== 1 || (element.textElement?.atType !== undefined && element.textElement.atType !== 0) ||
            typeof part !== 'string' || !part || offset + part.length > challenge.text.length ||
            !challenge.text.startsWith(part, offset)) return false;
        offset += part.length;
        return true;
      });
      if (exactText && offset === challenge.text.length) {
        if (typeof message.msgTime !== 'string' && typeof message.msgTime !== 'number') continue;
        const time = Number(message.msgTime);
        if (!Number.isSafeInteger(time) || time <= 0) continue;
        challenge.message = { chatType: 2, peerUid: challenge.groupId, senderUin: sender,
          msgId: message.msgId, msgTime: time,
          elements: [{ elementType: 1, textElement: { content: challenge.text } }] };
        if (sender === protectedAccount) {
          Object.freeze(challenge.message.elements[0].textElement);
          Object.freeze(challenge.message.elements[0]);
          Object.freeze(challenge.message.elements);
          verifiedProtectedMessages.add(Object.freeze(challenge.message));
          challenge.testGroupMessages = bump(challenge.testGroupMessages);
        }
        challenge.matchedAt = this.#clock();
        challenge.matched = true;
        break;
      }
    }
  }

  hasFreshMatch(generation, readbackOnly = false) {
    const challenge = this.#current;
    if (!challenge?.matched || generation !== challenge.generation || challenge.readbackOnly !== readbackOnly) return false;
    const age = this.#clock() - challenge.matchedAt;
    return age >= 0 && age < matchWindowMs;
  }

  canTakeRecent(generation, readbackOnly = false, allowAdminChallenge = false) {
    const message = this.#current?.message;
    return Boolean(message && this.hasFreshMatch(generation, readbackOnly) &&
      !(readbackOnly && isVerifiedProtectedChallenge(message) && !allowAdminChallenge));
  }

  freshGroup(generation, readbackOnly = false) {
    return this.hasFreshMatch(generation, readbackOnly) ? this.#current.groupId : null;
  }

  takeRecent(generation, readbackOnly = false, allowAdminChallenge = false) {
    if (!this.canTakeRecent(generation, readbackOnly, allowAdminChallenge)) return null;
    const message = this.#current.message;
    this.#current.message = undefined;
    return message;
  }

  status(generation) {
    const challenge = this.#current;
    if (!challenge || challenge.generation !== generation) return { state: 'unarmed' };
    const counts = { attempt: this.#attempts, callbacks: challenge.callbacks,
      testGroupCandidates: challenge.groupCandidates,
      eligibleTestGroupMessages: challenge.testGroupMessages,
      ...(challenge.readbackOnly && { readbackOnly: true }),
      ...(challenge.allowAdminChallenge && { allowAdminChallenge: true }) };
    if (challenge.matched) return { state: 'matched', groupMessageObserved: true,
      ageMs: Math.floor(this.#clock() - challenge.matchedAt),
      consumed: challenge.message === undefined,
      ...counts };
    return { state: this.#clock() >= challenge.expiresAt ? 'expired' : 'waiting', ...counts };
  }
}
