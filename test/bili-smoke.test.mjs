import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runSmoke } from '../scripts/bili-dm-smoke.mjs';

// Synthetic upstream only. Everything from the bridge through localhost WS/HTTP
// to the guarded agent, including arming and reply dispatch, is the CLI path.
async function fixture({ args = [], invalidOnly = false, receipt = '587284', timeoutMs = 5000 } = {}) {
  const env = { BILI_SELF_ID: '900101', BILI_PEER_ID: '900102', BILI_COOKIE: `SESSDATA=${randomUUID()}` };
  if (args.includes('--reply')) { env.BILI_DEVICE_ID = randomUUID(); env.BILI_COOKIE += `; bili_jct=${randomUUID()}`; }
  const history = [], writes = [], logs = [];
  const push = (text, patch = {}) => {
    const seq = history.length + 1;
    history.unshift({ sender_uid: Number(env.BILI_PEER_ID), receiver_id: Number(env.BILI_SELF_ID), receiver_type: 1,
      msg_type: 1, msg_source: 0, timestamp: Math.floor(Date.now()/1000), msg_seqno: seq, msg_key: String(190000 + seq),
      content: JSON.stringify({content:text}), ...patch });
  };
  push('BASELINE_PRIVATE_TEXT');
  let challenge;
  const code = await runSmoke({ args, env, timeoutMs, pollMs: 10,
    client: { identity: async () => ({user_id:Number(env.BILI_SELF_ID), nickname:'UNLOGGED_NAME'}),
      messages: async end => history.filter(m => end === undefined || m.msg_seqno < Number(end)),
      sendText: async text => { writes.push(text); return { msg_key: receipt }; } },
    log(line) {
      logs.push(line);
      if (line.startsWith('READY')) {
        challenge = /DM-[0-9a-f]{10}$/.exec(line)?.[0];
        assert.ok(challenge);
        push('UNRELATED_PRIVATE_TEXT'); push(challenge + ' '); push(challenge, {timestamp:1});
        push(challenge, {sender_uid:900103}); push(challenge, {sender_uid:900101,receiver_id:900102});
        if (!invalidOnly) {
          // Both valid frames share a skewed upstream clock; neither has host wall time.
          const patch = {timestamp:Math.floor(Date.now()/1000) + (args.includes('--reply') ? 90 : -90)};
          push(challenge, patch); push(challenge, patch);
        }
      }
    } });
  assert.doesNotMatch(logs.join('\n'), /BASELINE_PRIVATE_TEXT|UNRELATED_PRIVATE_TEXT|UNLOGGED_NAME|90010[123]|SESSDATA=/);
  return { code, writes, logs, challenge };
}

test('default validates a fresh peer challenge via the actual guarded OneBot client, without sending', async () => {
  const r = await fixture(); assert.equal(r.code, 0, r.logs.join('\n')); assert.deepEqual(r.writes, []);
});
test('--reply consumes duplicate valid events once and reports receipt, not delivery', async () => {
  const r = await fixture({args:['--reply']}); assert.equal(r.code, 0, r.logs.join('\n'));
  assert.deepEqual(r.writes, [r.challenge]); assert.match(r.logs.at(-1), /Recipient must confirm/);
});
test('wrong sender, self echo, stale timestamp and near match cannot trigger a reply', async () => {
  const r = await fixture({args:['--reply'], invalidOnly:true, timeoutMs:1200});
  assert.ok(r.challenge); assert.equal(r.code, 1); assert.deepEqual(r.writes, []);
});
test('a send without a positive upstream receipt is not success and never retries', async () => {
  const r = await fixture({args:['--reply'], receipt:'0'}); assert.equal(r.code, 1, r.logs.join('\n'));
  assert.deepEqual(r.writes, [r.challenge]); assert.match(r.logs.at(-1), /no retry/);
});
test('identity failure never arms the challenge or leaks the upstream error', async () => {
  const logs = [];
  const cookie = `SESSDATA=${randomUUID()}`;
  const code = await runSmoke({env:{BILI_SELF_ID:'101', BILI_PEER_ID:'102', BILI_COOKIE:cookie},
    client:{identity:async () => { throw Error(cookie); }, messages:async () => [], sendText:async () => {}},
    log:line => logs.push(line)});
  assert.equal(code,1); assert.deepEqual(logs,['NOT VERIFIED (startup: BILI_IDENTITY_UNAVAILABLE). No reply attempted.']);
});
test('invalid opt-in, invalid device and missing inputs fail before any upstream request', async () => {
  for (const [args,env] of [[['--reply=true'],{}], [[],{}], [['--reply'],{ BILI_SELF_ID:'1', BILI_PEER_ID:'2',
    BILI_COOKIE:`SESSDATA=${randomUUID()}; bili_jct=${randomUUID()}`, BILI_DEVICE_ID:'not-a-device' }]]) {
    let touched = false;
    assert.equal(await runSmoke({args,env,client:{identity(){touched=true;}}, log(){} }),2); assert.equal(touched,false);
  }
});
