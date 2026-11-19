import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planCompaction, rewriteArchive } from '../scripts/compact-outbound-archive.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 13, 0, 0);

function row(chat, msAgo, text) {
  return { at: new Date(NOW - msAgo).toISOString(), at_ms: NOW - msAgo, action: 'send_group_msg', chat, text, message_id: 1 };
}

test('只整理够老的，且按会话按天分组、组太小不整理', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row('group:1', 5 * DAY + i * 1000, '旧-' + i)),
    ...Array.from({ length: 3 }, (_, i) => row('group:2', 5 * DAY + i * 1000, '小样本-' + i)),
    row('group:1', 60 * 1000, '刚刚'),
  ];
  const plan = planCompaction(rows, { now: NOW, keepDays: 3, min: 5 });
  assert.equal(plan.length, 1, '只有 group:1 那一组够 5 条');
  assert.equal(plan[0].chat, 'group:1');
  assert.equal(plan[0].rows.length, 5);
  assert(!plan[0].rows.some(r => r.text === '刚刚'), '最近的不该进整理范围');
  assert.equal(plan[0].from, plan[0].rows[0].at);
});

test('最近若干天一律不动，即使条数很多', () => {
  const rows = Array.from({ length: 100 }, (_, i) => row('group:1', i * 1000, 't' + i));
  assert.deepEqual(planCompaction(rows, { now: NOW, keepDays: 3, min: 5 }), []);
});

test('不同天的同一会话会分成两组，互不牵连', () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row('group:9', 4 * DAY + i * 1000, 'a' + i)),
    ...Array.from({ length: 6 }, (_, i) => row('group:9', 6 * DAY + i * 1000, 'b' + i)),
  ];
  const plan = planCompaction(rows, { now: NOW, keepDays: 3, min: 5 });
  assert.equal(plan.length, 2);
  assert.notEqual(plan[0].day, plan[1].day);
  assert.equal(plan[0].rows.length + plan[1].rows.length, 12);
});

test('重写归档时先备份，剩下的行原样保留', t => {
  const dir = fs.mkdtempSync(path.resolve('.tmp/compaction-test-'));
  t.after(() => { assert.equal(fs.realpathSync(dir), dir); fs.rmSync(dir, { recursive: true }); });
  const file = path.join(dir, 'archive.jsonl');
  const keep = [row('group:1', 1000, '留着我'), row('group:1', 2000, '也留着我')];
  fs.writeFileSync(file, keep.map(r => JSON.stringify(r) + '\n').join(''), 'utf8');
  const backup = rewriteArchive(file, keep.slice(0, 1), { stamp: 'T' });
  assert.equal(backup, file + '.before-compact-T');
  assert.equal(fs.readFileSync(backup, 'utf8').split('\n').filter(Boolean).length, 2, '备份是原始两份');
  const after = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(after.length, 1);
  assert.equal(JSON.parse(after[0]).text, '留着我');
});
