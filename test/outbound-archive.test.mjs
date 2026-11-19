import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OutboundArchive, flattenSegments, chatOf, readArchive } from '../src/archive/outbound-archive.mjs';

function workspace(t) {
  const dir = fs.mkdtempSync(path.resolve('.tmp/outbound-archive-test-'));
  t.after(() => { assert.equal(fs.realpathSync(dir), dir); fs.rmSync(dir, { recursive: true }); });
  return path.join(dir, 'runtime', 'outbound-archive.jsonl');
}

test('消息段摊成人话：文本、@、引用、表情、图片', () => {
  assert.equal(flattenSegments([{ type: 'text', data: { text: '你好' } }]), '你好');
  assert.equal(flattenSegments([
    { type: 'reply', data: { id: '42' } },
    { type: 'at', data: { qq: '100000001' } },
    { type: 'text', data: { text: ' 在吗' } },
    { type: 'face', data: { id: '212' } },
    { type: 'image', data: { file: 'x.png' } },
  ]), '[回复:42][@100000001] 在吗[表情212][图片]');
  assert.equal(flattenSegments('纯字符串'), '纯字符串');
  assert.equal(flattenSegments(undefined), '');
});

test('会话键：群聊记群号，私聊记对方号', () => {
  assert.equal(chatOf('send_group_msg', { group_id: 200000001 }), 'group:200000001');
  assert.equal(chatOf('send_private_msg', { user_id: 100000002 }), 'private:100000002');
  assert.equal(chatOf('send_msg', {}), 'unknown');
});

test('只有被接受的发送才落库，非发送动作与非 0 结果都不写', t => {
  const file = workspace(t);
  const archive = new OutboundArchive(file, { now: () => 1795091568904 });
  assert.equal(archive.maybeRecord({ action: 'get_status', params: {} }, { retcode: 0, data: {} }), false);
  assert.equal(archive.maybeRecord({ action: 'send_group_msg', params: { group_id: 1, message: [] } },
    { retcode: 1503, wording: 'Action was not submitted' }), false);
  assert.equal(archive.maybeRecord({ action: 'send_group_msg', params: { group_id: 200000001,
    message: [{ type: 'text', data: { text: '我这边就是自带那套 没装别的' } }] } },
    { retcode: 0, data: { message_id: 795087261 } }), true);

  const rows = readArchive(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chat, 'group:200000001');
  assert.equal(rows[0].text, '我这边就是自带那套 没装别的');
  assert.equal(rows[0].message_id, 795087261);
  assert.equal(rows[0].accepted_without_receipt, false);
  assert.equal(rows[0].at, new Date(1795091568904).toISOString());
  assert(Array.isArray(rows[0].segments));
});

test('拿不到回执的发送也要落库，并标记 accepted_without_receipt', t => {
  const file = workspace(t);
  const archive = new OutboundArchive(file);
  archive.maybeRecord({ action: 'send_group_msg', params: { group_id: 200000001,
    message: [{ type: 'text', data: { text: '活着' } }] } },
    { retcode: 0, data: { message_id: null, accepted_without_receipt: true } });
  const [row] = readArchive(file);
  assert.equal(row.message_id, null);
  assert.equal(row.accepted_without_receipt, true);
  assert.equal(row.text, '活着');
});

test('归档写不进去时只返回 false，绝不抛错（不能影响发送）', t => {
  const file = workspace(t);
  // 用一个**目录**当文件路径：append 必然失败。
  fs.mkdirSync(file, { recursive: true });
  const archive = new OutboundArchive(file);
  assert.equal(archive.maybeRecord({ action: 'send_group_msg', params: { group_id: 1,
    message: [{ type: 'text', data: { text: 'x' } }] } }, { retcode: 0, data: { message_id: 1 } }), false);
});

test('超过单文件上限时滚成 .1，不无限增长', t => {
  const file = workspace(t);
  const archive = new OutboundArchive(file, { maxBytes: 1024 });
  const send = () => archive.maybeRecord({ action: 'send_group_msg', params: { group_id: 200000001,
    message: [{ type: 'text', data: { text: 'x'.repeat(120) } }] } }, { retcode: 0, data: { message_id: 1 } });
  for (let i = 0; i < 20; i++) send();
  assert(fs.existsSync(file), '当前文件应存在');
  assert(fs.existsSync(file + '.1'), '应滚出 .1');
  assert(fs.statSync(file).size <= 1024, '当前文件不应超过上限');
});

test('readArchive 跳过坏行而不是整篇读不出', t => {
  const file = workspace(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"at":"ok-1"}\n{坏行\n{"at":"ok-2"}\n');
  assert.deepEqual(readArchive(file).map(r => r.at), ['ok-1', 'ok-2']);
  assert.deepEqual(readArchive(file + '.missing'), []);
});
