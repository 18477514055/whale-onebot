import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { injectTokenParameters, transformPinnedClient } from '../experiments/clean-agent-preload.mjs';
import { SyntheticAgentGate } from '../experiments/clean-agent-full-linux.mjs';
import { cleanInventory, validNamespaces } from '../scripts/lib/run-clean-agent-isolation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { OutcomeStore } from '../src/outcome-store.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

test('full application fixture preserves original dedicated OutcomeStore root guard', () => {
  const root = fs.realpathSync('.'), base = fs.mkdtempSync(path.join(root, '.tmp/clean-outcome-root-'));
  let store;
  try {
    const wrong = path.join(base, 'onebot'), right = path.join(base, 'qq-onebot');
    fs.mkdirSync(wrong); fs.mkdirSync(right);
    assert.throws(() => new OutcomeStore(wrong), /Dedicated qq-onebot project required/);
    store = new OutcomeStore(right); assert.equal(store.pending, false); store.close();
    assert.equal(fs.existsSync(path.join(right, 'runtime/outcomes/owner.lock')), false);
  } finally {
    store?.close(); assert(base.startsWith(path.join(root, '.tmp') + path.sep)); fs.rmSync(base, { recursive: true, force: true });
  }
});
const ctor = "  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent, heartbeat = 'auto', heartbeatMs = HEARTBEAT_MS }) {";
test('constructor-local token injection neither writes config nor embeds a credential', () => {
  const transformed = injectTokenParameters(`class Client {\n${ctor}\nthis.token = accessToken;\n}\n}`);
  assert.match(transformed, /accessToken = process.env.WHALE_ONEBOT_TOKEN/);
  assert.match(transformed, /httpToken = process.env.WHALE_ONEBOT_TOKEN/);
  assert(!transformed.includes('writeFile') && !transformed.includes('getConfig'));
});
test('unknown and duplicated constructor versions fail closed', () => {
  assert.throws(() => injectTokenParameters('class Client {}'), /CONSTRUCTOR_MISMATCH/);
  assert.throws(() => injectTokenParameters(ctor + ctor), /CONSTRUCTOR_MISMATCH/);
  assert.throws(() => transformPinnedClient(ctor), /SOURCE_MISMATCH/);
});
function fixture() {
  const raw = new EventEmitter(), calls = [];
  raw.probe = () => ({ user_id: Number(BOT_UIN), online: true });
  raw.capabilities = () => ['get_login_info', 'get_status', 'get_group_info', 'send_group_msg', 'send_private_msg',
    'get_group_msg_history', 'get_friend_list', 'set_online_status', 'get_msg'];
  raw.call = (action, params) => { calls.push({ action, params }); return { ok: true }; };
  return { raw, calls, gate: new SyntheticAgentGate(raw, 123456) };
}
test('synthetic gate forwards only the explicitly scoped group event', () => {
  const { raw, gate } = fixture(), received = []; gate.on('event', event => received.push(event));
  const valid = { post_type: 'message', message_type: 'group', group_id: 123456 };
  raw.emit('event', valid);
  for (const event of [{ ...valid, group_id: 123457 }, { ...valid, message_type: 'private' }, { post_type: 'request' }]) raw.emit('event', event);
  assert.deepEqual(received, [valid]); assert.equal(gate.blockedEvents, 3); gate.close();
  assert.equal(raw.listenerCount('event'), 0); assert.equal(raw.listenerCount('offline'), 0);
});
for (const action of ['send_private_msg', 'get_group_msg_history', 'get_friend_list', 'set_online_status']) {
  test(`synthetic gate rejects ${action} before any native operation`, () => {
    const { gate, calls } = fixture();
    assert.throws(() => gate.call(action, { group_id: 123456 }), /scope denied/);
    assert.equal(calls.length, 0); gate.close();
  });
}
test('group writes cannot escape scope; allowed calls preserve parameters', () => {
  const { gate, calls } = fixture();
  assert.throws(() => gate.call('send_group_msg', { group_id: 123457 }), /scope denied/);
  const params = { group_id: 123456, message: 'synthetic' }; gate.call('send_group_msg', params);
  assert.deepEqual(calls, [{ action: 'send_group_msg', params }]); gate.close();
});
test('offline signals preserve fail-closed notifications', () => {
  const { raw, gate } = fixture(); let signal;
  gate.on('offline', event => { signal = event; });
  raw.emit('offline', { reason: 'synthetic' }); assert.deepEqual(signal, { reason: 'synthetic' });
  let ready; gate.on('bridge-ready', value => { ready = value; });
  raw.emit('bridge-ready', { generation: 2 }); assert.deepEqual(ready, { generation: 2 });
  gate.close(); assert.equal(raw.listenerCount('bridge-ready'), 0);
});
test('namespace evidence must be complete, typed, syntactically valid and different', () => {
  const parent = { net: 'net:[1]', pid: 'pid:[2]', mnt: 'mnt:[3]', user: 'user:[4]' };
  assert.equal(validNamespaces(undefined, parent), false);
  assert.equal(validNamespaces({}, parent), false);
  assert.equal(validNamespaces({ net: true, pid: 3, mnt: 'x', user: 'y' }, parent), false);
  assert.equal(validNamespaces(parent, parent), false);
  assert.equal(validNamespaces(Object.create({ net: 'net:[10]', pid: 'pid:[20]', mnt: 'mnt:[30]', user: 'user:[40]' }), parent), false);
  assert.equal(validNamespaces({ net: 'net:[10]', pid: 'pid:[20]', mnt: 'mnt:[30]', user: 'user:[40]' }, parent), true);
});
test('closed input inventory detects added/removed/modified source and dependency bytes', () => {
  const root = fs.realpathSync('.');
  const dir = fs.mkdtempSync(path.join(root, '.tmp/clean-inventory-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'source.js'), 'synthetic');
    const initial = cleanInventory(dir);
    fs.writeFileSync(path.join(dir, 'extra.js'), 'new'); assert.notDeepEqual(cleanInventory(dir), initial);
    const extra = path.resolve(dir, 'extra.js'); assert(extra.startsWith(dir + path.sep)); fs.unlinkSync(extra);
    fs.writeFileSync(path.join(dir, 'source.js'), 'modified'); assert.notDeepEqual(cleanInventory(dir), initial);
    fs.writeFileSync(path.join(dir, 'source.js'), 'synthetic'); assert.deepEqual(cleanInventory(dir), initial);
    fs.writeFileSync(path.join(dir, 'node_modules/dep.js'), 'synthetic-dependency'); assert.notDeepEqual(cleanInventory(dir), initial);
    const linked = path.join(dir, 'hardlink.js'); fs.linkSync(path.join(dir, 'source.js'), linked);
    assert.throws(() => cleanInventory(dir), /INPUT_TYPE/);
  } finally {
    assert(dir.startsWith(path.join(root, '.tmp') + path.sep)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
