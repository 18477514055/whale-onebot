// listUnsentAll：跨会话/长窗口/带总量；且工具真的在 defs 里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../input/agent-app/src/core/store.js';
import { buildToolDefs } from '../input/agent-app/src/tools/tools-core.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-unsent-all-'));
  return new ChatStore(0, { dataDir: dir });
}

test('listUnsentAll：跨会话能一次拿到，并给总量；chatKey 过滤生效', () => {
  const store = fresh();
  const a = store.beginSend('group:1', null, { messages: ['群一的失败'] });
  store.finishSend(a, { error: 'x', outcome: 'failed' });
  const b = store.beginSend('private:2', null, { messages: ['私聊的未知'] });
  store.finishSend(b, { error: 'timeout', outcome: 'unknown' });
  const c = store.beginSend('group:3', null, { messages: ['已发出'] });
  store.finishSend(c, { messageId: '1' });

  const all = store.listUnsentAll({ limit: 10, withinMs: 24 * 3600 * 1000 });
  assert.equal(all.total, 2);
  assert.deepEqual(all.items.map((r) => r.text).sort(), ['群一的失败', '私聊的未知'].sort());

  const onlyOne = store.listUnsentAll({ limit: 10, withinMs: 24 * 3600 * 1000, chatKey: 'group:1' });
  assert.equal(onlyOne.total, 1);
  assert.equal(onlyOne.items[0].text, '群一的失败');
});

test('listUnsentAll：limit 只截页、total 仍是全量（模型据此知道还有更多）', () => {
  const store = fresh();
  for (let i = 0; i < 5; i += 1) {
    const id = store.beginSend('group:9', null, { messages: [`第${i}条`] });
    store.finishSend(id, { error: 'boom', outcome: 'failed' });
  }
  const page = store.listUnsentAll({ limit: 2, withinMs: 3600 * 1000 });
  assert.equal(page.total, 5);
  assert.equal(page.items.length, 2);
});

test('list_unsent_messages 工具已注册，且有 scope/within_hours/limit 三个参数', () => {
  const defs = buildToolDefs({});
  const list = (defs.tools || defs).map((d) => d.name || d.function?.name);
  assert.ok(list.includes('list_unsent_messages'), '缺 list_unsent_messages');
  assert.ok(list.includes('resend_unsent_message'), '缺 resend_unsent_message');
  const def = (defs.tools || defs).find((d) => (d.name || d.function?.name) === 'list_unsent_messages');
  const params = def.parameters || def.function?.parameters;
  assert.deepEqual(Object.keys(params.properties).sort(), ['limit', 'scope', 'within_hours']);
});
