// 补课策略：窗口判据 + 日志措辞（2026-11-23 改成「窗口外不再补进库」）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CATCHUP_REPLY_WINDOW_MS, MAX_CATCHUP_REPLY_WINDOW_MS,
  catchupReplyWindowMs, isFreshForReply, catchupLogLine
} from '../input/agent-app/src/core/catchup-policy.js';

test('默认窗口 30 分钟；非法值回落默认；上限一天', () => {
  assert.equal(DEFAULT_CATCHUP_REPLY_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(catchupReplyWindowMs({}), DEFAULT_CATCHUP_REPLY_WINDOW_MS);
  assert.equal(catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: 'abc' } }), DEFAULT_CATCHUP_REPLY_WINDOW_MS);
  assert.equal(catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: -5 } }), DEFAULT_CATCHUP_REPLY_WINDOW_MS);
  assert.equal(catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: 5 * 60 * 1000 } }), 5 * 60 * 1000);
  assert.equal(catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: 99 * 24 * 3600 * 1000 } }), MAX_CATCHUP_REPLY_WINDOW_MS);
});

test('窗口边界：等于窗口算新消息，超过一毫秒就不算', () => {
  const now = 1_000_000;
  assert.equal(isFreshForReply(now - 1000, now, 1000), true);
  assert.equal(isFreshForReply(now - 1001, now, 1000), false);
  assert.equal(isFreshForReply(now, now, 0), true);
});

test('日志：没有跳过的就不提跳过；有跳过就写「未补进库」，且旧措辞消失', () => {
  assert.equal(catchupLogLine('group:1', 0, 0), '');
  const noSkip = catchupLogLine('group:2', 3, 0);
  assert.match(noSkip, /补进 3 条/);
  assert.doesNotMatch(noSkip, /未补进库/);
  const someSkip = catchupLogLine('group:3', 3, 2);
  assert.match(someSkip, /其中 2 条超过回复窗口，未补进库/);
  const allSkip = catchupLogLine('group:4', 3, 3);
  assert.match(allSkip, /只补了 3 条/);
  assert.match(allSkip, /未补进库/);
  assert.doesNotMatch(someSkip + allSkip, /只补记录/);
});
