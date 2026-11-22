// 三个库（B 站资料库 / QQ 知识库 / QQ 记忆库）在同一个只读入口下：来源分开、缺库不炸。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { createKnowledgeHub } = await import('../input/agent-app/src/features/bili-behavior/knowledge-hub.mjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  fs.mkdirSync(path.join(dir, 'bili-library'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bili-library', 'videos.jsonl'),
    JSON.stringify({ bvid: 'BV1zsSyBmEej', title: '神秘的南极水域', author: 'Alan阿伦说', desc: '死亡冰柱', at: 1795293000000 }) + '\n');
  fs.writeFileSync(path.join(dir, 'bili-library', 'comments.jsonl'),
    JSON.stringify({ bvid: 'BV1zsSyBmEej', rpid: '320937000625', text: '白血鱼真的没血红蛋白', at: 1795294000000 }) + '\n');

  fs.mkdirSync(path.join(dir, 'knowledge-lib'), { recursive: true });
  const kb = new DatabaseSync(path.join(dir, 'knowledge-lib', 'index.sqlite'));
  kb.exec('CREATE TABLE docs(id INTEGER PRIMARY KEY AUTOINCREMENT, lib TEXT, source TEXT, chunk_no INTEGER, text TEXT)');
  kb.prepare('INSERT INTO docs(lib,source,chunk_no,text) VALUES(?,?,?,?)')
    .run('生物', '/kb/antarctic.md', 0, '南极冰鱼血液中缺少血红蛋白，靠血浆溶氧生存。');
  kb.close();

  fs.mkdirSync(path.join(dir, 'living-memory'), { recursive: true });
  const mem = new DatabaseSync(path.join(dir, 'living-memory', 'living-memory.sqlite'));
  mem.exec('CREATE TABLE memories(id TEXT PRIMARY KEY, scope_key TEXT, summary TEXT, content TEXT, search_text TEXT, importance REAL)');
  mem.prepare('INSERT INTO memories(id,scope_key,summary,content,search_text,importance) VALUES(?,?,?,?,?,?)')
    .run('m1', 'group:123', '他对极地纪录片很感兴趣', '上次聊到南极纪录片时他说想看更多', '南极 极地 纪录片', 0.8);
  mem.close();
  return dir;
}

test('三个库合并检索，命中项各标来源', () => {
  const dir = fixture();
  const hub = createKnowledgeHub({ dataDir: dir });
  const hits = hub.search('南极', { limit: 6 });
  const sources = new Set(hits.map((h) => h.source));
  assert.deepEqual([...sources].sort(), ['bili', 'knowledge', 'memory']);
  assert.ok(hits.every((h) => typeof h.text === 'string' && h.text.length > 0));
  assert.ok(hits.some((h) => h.source === 'bili' && h.ref === 'BV1zsSyBmEej'));
});

test('可以只查指定来源', () => {
  const dir = fixture();
  const hub = createKnowledgeHub({ dataDir: dir });
  const only = hub.search('南极', { sources: ['memory'], limit: 6 });
  assert.equal(only.length, 1);
  assert.equal(only[0].source, 'memory');
});

test('availability 报告每个库能不能读', () => {
  const dir = fixture();
  const hub = createKnowledgeHub({ dataDir: dir });
  assert.deepEqual(hub.availability(), { bili: true, knowledge: true, memory: true });
});

test('库不存在时只是这一路没结果，不抛错', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-empty-'));
  const hub = createKnowledgeHub({ dataDir: empty });
  assert.deepEqual(hub.search('南极'), []);
  assert.deepEqual(hub.availability(), { bili: false, knowledge: false, memory: false });
});

test('坏掉的 sqlite 也只是跳过这一路', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-broken-'));
  fs.mkdirSync(path.join(dir, 'knowledge-lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge-lib', 'index.sqlite'), 'not a database');
  const hub = createKnowledgeHub({ dataDir: dir, logger: { warn: () => {} } });
  assert.deepEqual(hub.search('南极', { sources: ['knowledge'] }), []);
});
