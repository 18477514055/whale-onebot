import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { OutcomeStore, releaseExitedChildLock } from '../src/outcome-store.mjs';
import { OneBotCore } from '../src/core.mjs';
import { BOT_UIN } from '../src/config/account.mjs';
const temp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.tmp');
function root(t){fs.mkdirSync(temp,{recursive:true});const parent=fs.mkdtempSync(path.join(temp,'outcome-'));const dir=path.join(parent,'qq-onebot');fs.mkdirSync(dir);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));return dir;}
// ★ 契约变更（2026-11-18）：别的进程留下的 pending 不再关本次的闸。
//   旧行为会把写闸永久关死 ⇒ 机器人静默（用户反复遇到的"更新完一会儿就不说话"）。
//   新契约：隔离成 pending.orphaned-*（留证）→ 闸打开 → 由 status 报数量。
test('cross-process crash latch is quarantined on restart and the gate opens',t=>{
  const dir=root(t);const store=new OutcomeStore(dir);store.begin('send_group_msg');
  const raw=fs.readFileSync(store.file,'utf8');assert(!raw.includes('token'));assert(!raw.includes('message:'));
  store.close();
  const reopened=new OutcomeStore(dir, undefined, { adoptForeign: true });
  assert.equal(reopened.pending,false,'别的进程写的 pending 不该关本次的闸');
  assert.equal(reopened.orphaned.action,'send_group_msg','隔离时要保留动作名作证据');
  assert.ok(fs.existsSync(path.join(reopened.dir,reopened.orphaned.file)),'隔离文件必须真的存在');
  assert.equal(fs.existsSync(reopened.file),false,'原 pending.json 应已被移走');
  assert.doesNotThrow(()=>reopened.begin('send_group_msg'),'闸已打开，可以重新开始');
  reopened.confirmed();reopened.close();
});
test('owner lock rejects competing instances; a corrupt latch is quarantined as unreadable',t=>{
  const dir=root(t),store=new OutcomeStore(dir);assert.throws(()=>new OutcomeStore(dir),'同一目录不能有两个 owner');
  fs.writeFileSync(store.file,'invalid');store.close();
  const next=new OutcomeStore(dir, undefined, { adoptForeign: true });
  assert.equal(next.pending,false,'损坏的记录也只隔离、不关闸（它同样无法在本次会话里对账）');
  assert.equal(next.orphaned.state,'unreadable');
  next.close();
});

test('exited-child cleanup leaves other owner locks and pending data intact', t => {
  const dir = root(t);
  const store = new OutcomeStore(dir, 'assigned-instance');
  try {
    store.begin('send_group_msg');
    releaseExitedChildLock(dir, process.pid, 'different-instance');
    releaseExitedChildLock(dir, process.pid + 1, 'assigned-instance');
    assert(fs.existsSync(store.lock));
    assert(fs.existsSync(store.file));
  } finally { store.close(); }
});
test('a latch written by THIS process no longer blocks submission; it is retired with evidence',async t=>{
  const dir=root(t);const store=new OutcomeStore(dir);store.begin('send_group_msg');let calls=0;
  const bridge=new EventEmitter();bridge.capabilities=()=>['send_group_msg'];bridge.probe=async()=>({user_id:Number(BOT_UIN),online:true,sessionId:'synthetic'});bridge.call=async()=>{calls++;return {message_id:7};};
  const core=new OneBotCore({bridge,outcomeStore:store,minimumWriteIntervalMs:0});
  // 外发优先（2026-11-19）：上一次的未决记录照旧留证，但不拦这一条。
  assert.equal((await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'x'}})).retcode,0);
  assert.equal(calls,1);
  assert.equal(store.pending,false,'发完之后不应再有未决记录');
  core.close();store.close();
});
test('confirmed send clears crash latch; an unconfirmed send is accepted and leaves no latch',async t=>{
  const store=new OutcomeStore(root(t));const bridge=new EventEmitter();bridge.capabilities=()=>['send_group_msg'];bridge.probe=async()=>({user_id:Number(BOT_UIN),online:true,sessionId:'synthetic'});bridge.call=async()=>({message_id:1});
  const core=new OneBotCore({bridge,outcomeStore:store,minimumWriteIntervalMs:0,timeoutMs:20});
  const request={action:'send_group_msg',params:{group_id:900001,message:'x'}};
  assert.equal((await core.dispatch(request)).retcode,0);assert.equal(store.pending,false);
  // P4：拿不到回执也按「已接受」回成功（message_id:null），且不留未决记录、不关闸。
  bridge.call=async()=>new Promise(()=>{});
  const late=await core.dispatch(request);
  assert.equal(late.retcode,0);
  assert.equal(late.data.message_id,null);
  assert.equal(store.pending,false);
  core.close();store.close();
});

test('an unconfirmable poke never leaves the crash latch or freezes later sends',async t=>{
  // 戳一戳同样属于「发送类 side effect」：没有确认就按已接受放行，绝不冻结后续消息。
  const store=new OutcomeStore(root(t));const bridge=new EventEmitter();
  bridge.capabilities=()=>['friend_poke','send_group_msg'];
  bridge.probe=async()=>({user_id:Number(BOT_UIN),online:true,sessionId:'synthetic'});
  bridge.call=async()=>new Promise(()=>{});
  const core=new OneBotCore({bridge,outcomeStore:store,minimumWriteIntervalMs:0,timeoutMs:20});
  const poke={action:'friend_poke',params:{user_id:10001}};
  assert.equal((await core.dispatch(poke)).retcode,0);
  assert.equal(store.pending,false);
  bridge.call=async()=>({message_id:1});
  assert.equal((await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'x'}})).retcode,0);
  core.close();store.close();
});

test('fsync failure while recording the outcome does not stop the message', async t => {
  const dir = root(t);
  const store = new OutcomeStore(dir);
  const bridge = new EventEmitter();
  let calls = 0;
  bridge.capabilities = () => ['send_group_msg'];
  bridge.probe = async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic' });
  bridge.call = async () => { calls++; return { message_id: 1 }; };
  const core = new OneBotCore({ bridge, outcomeStore: store, minimumWriteIntervalMs: 0 });
  const request = { action: 'send_group_msg', params: { group_id: 900001, message: 'synthetic' } };
  const fault = t.mock.method(fs, 'fsyncSync', () => { throw new Error('SYNTHETIC_DISK_FAILURE'); });
  try {
    // 外发优先（2026-11-19）：写不下留证记录 ≠ 不发这条消息。
    const response = await core.dispatch(request);
    assert.equal(response.retcode, 0);
    assert.equal(calls, 1);
    assert.equal(core.metrics.outcomeRecordFailed, 1);
    assert.equal(store.pending, false, '发成功之后不留未决记录');
    assert.deepEqual(core.status(), { online: true, good: true });
    assert.equal((await core.dispatch(request)).retcode, 0);
    assert.equal(calls, 2);
  } finally {
    fault.mock.restore();
    core.close();
    store.close();
  }
  // adoptForeign 仍然要能隔离「别的进程写的」未决记录并留证。
  fs.mkdirSync(path.join(dir, 'runtime', 'outcomes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime', 'outcomes', 'pending.json'), JSON.stringify({ action: 'send_group_msg', boot: 'other-process' }));
  const reopened = new OutcomeStore(dir, undefined, { adoptForeign: true });
  try {
    assert.equal(reopened.pending, false, '跨进程遗留不该继续冻结');
    assert.equal(reopened.orphaned.action, 'send_group_msg', '隔离仍要留证');
    assert.equal(calls, 2, '隔离不等于重发：内核调用次数不变');
  } finally {
    reopened.close();
  }
});
