import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { OneBotCore } from '../src/core.mjs';
import { createSessionService } from '../src/service.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

test('Lifecycle review: invalid bridge construction releases service owner lock', async t => {
  const temporaryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const parent = fs.mkdtempSync(path.join(temporaryRoot, 'lifecycle-review-'));
  const root = path.join(parent, 'qq-onebot'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  await assert.rejects(createSessionService({ projectRoot: root, token: 'synthetic-only-review-token' }));
  assert.equal(fs.existsSync(path.join(root, 'runtime/outcomes/owner.lock')), false);
});

test('Lifecycle review: closing core aborts an in-flight operation before delayed bridge submission', async () => {
  let proceed, entered, signals;
  const insideCall = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  class Bridge extends EventEmitter {
    submitted = 0;
    capabilities() { return ['send_group_msg']; }
    async probe() { return { user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-review' }; }
    async call(_action, _params, { signal }) {
      signals = signal; entered(); await gate;
      if (signal.aborted) throw new Error('Cancelled before native submission');
      this.submitted++; return { message_id: 1 };
    }
  }
  const bridge = new Bridge(), core = new OneBotCore({ bridge, minimumWriteIntervalMs: 0 });
  const pending = core.dispatch({ action: 'send_group_msg', params: { group_id: 10, message: 'synthetic' } });
  await insideCall; core.close(); const wasAborted = signals.aborted; proceed(); await pending;
  assert.equal(wasAborted, true);
  assert.equal(bridge.submitted, 0);
});
