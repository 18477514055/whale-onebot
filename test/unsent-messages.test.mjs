// 【没发出去的消息】—— 列给模型看的那一段，以及"补发后收口"这两个动作。
// 用户口径（2026-11-23）：让 AI 知道自己有哪些消息没发出去，结合上下文决定要不要补发、要不要 @ / 引用；
// 现有机制（自动重试、unknown 人工核对）保持不动。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../input/agent-app/src/core/store.js';
import { renderUnsentSegment } from '../input/agent-app/src/llm/local-prompt-segments.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-unsent-'));
  return { store: new ChatStore(0, { dataDir: dir }), dir };
}

test('listUnsentMessages 只列 failed/unknown，且带原文', () => {
  const { store } = fresh();
  const chat = 'group:100';
  const failed = store.beginSend(chat, null, { messages: ['第一句没发出去'] });
  store.finishSend(failed, { error: '限频', outcome: 'failed' });
  const unknown = store.beginSend(chat, null, { messages: ['第二句不知道发没发'] });
  store.finishSend(unknown, { error: 'timeout', outcome: 'unknown' });
  const sent = store.beginSend(chat, null, { messages: ['这句发出去了'] });
  store.finishSend(sent, { messageId: '1' });
  // 别的会话不该混进来
  const other = store.beginSend('group:200', null, { messages: ['另一个群'] });
  store.finishSend(other, { error: 'x', outcome: 'failed' });

  const rows = store.listUnsentMessages(chat, { limit: 10 });
  const texts = rows.map((r) => r.text);
  assert.deepEqual(texts.sort(), ['第一句没发出去', '第二句不知道发没发'].sort());
  assert.ok(rows.some((r) => r.state === 'unknown'), 'unknown 也要列出来（模型要知道"可能已经发过"）');
  assert.ok(!texts.includes('这句发出去了'), 'sent 的不该出现');
  assert.ok(!texts.includes('另一个群'), '别的会话不该串进来');
});

test('markOutboxResent 只收口 failed/unknown，不碰 already sent', () => {
  const { store } = fresh();
  const chat = 'group:101';
  const failed = store.beginSend(chat, null, { messages: ['补发我'] });
  store.finishSend(failed, { error: 'boom', outcome: 'failed' });
  assert.equal(store.markOutboxResent(failed, '999'), 1);

  const sent = store.beginSend(chat, null, { messages: ['别动我'] });
  store.finishSend(sent, { messageId: '1' });
  assert.equal(store.markOutboxResent(sent, '888'), 0, '已发送的行不许被改成"补发"');
  assert.equal(store.listUnsentMessages(chat, { limit: 10 }).length, 0, '收口后不该再列出来');
});

test('renderUnsentSegment：空数组一个字都不出；有内容才出段，并带 #短id 与"结果未知"提示', () => {
  assert.equal(renderUnsentSegment([]), '');
  assert.equal(renderUnsentSegment(null), '');
  assert.equal(renderUnsentSegment([{ id: 'x' }]), '', '没有正文的条目不算');
  const text = renderUnsentSegment([
    { id: 'abcdef123456', state: 'failed', text: '刚才那句话' },
    { id: 'zzzzzz999999', state: 'unknown', text: '另一句' }
  ]);
  assert.match(text, /【没发出去的消息】/);
  assert.match(text, /#abcdef12/);
  assert.match(text, /结果未知/);
  assert.match(text, /resend_unsent_message/);
  assert.ok(!text.includes('zzzzzz99zz'), 'id 只给短号，不泄漏整串');
});
