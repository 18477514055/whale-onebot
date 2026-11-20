// Managed workers share only the tables defined here, never their DATA_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../core/sqlite.js';

export function safeDurableFile(file) {
  const stat = fs.lstatSync(file, {throwIfNoEntry:false});
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw Error('Redirected durable database');
  return file;
}

let cached;
export function robotDurable() {
  if (cached) return cached;
  const { QQ_AGENT_DURABLE_DIR: dir, QQ_AGENT_ROBOT_ID: robot,
    QQ_AGENT_BINDING_ID: binding, QQ_AGENT_MEMORY_SCOPE: selected,
    WHALE_AGENT_PLATFORM: platform } = process.env;
  if (![dir, robot, binding, selected].some(v => v !== undefined)) return null; // standalone legacy worker
  const scope = selected ?? 'robot';
  if (!dir || !path.isAbsolute(dir) || !robot?.trim() || !binding?.trim() ||
      !['robot','binding'].includes(scope) || !platform?.trim()) throw new Error('Incomplete managed durable scope');
  const owner = JSON.stringify([robot, scope, scope === 'binding' ? binding : '']);
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  if (path.relative(fs.realpathSync(dir),path.resolve(dir))) throw Error('Redirected durable directory');
  const file = safeDurableFile(path.join(dir, 'durable.sqlite'));
  const fd = fs.openSync(file, 'a', 0o600); fs.closeSync(fd);
  const db = openDatabase(file);
  // BEGIN IMMEDIATE covers the *read*, transform and write of each member/persona.
  // Keep rollback journaling: no WAL initialization race among first-boot workers.
  let writing = false;
  function transaction(fn) {
    if (writing) return fn(); // synchronous nested append in adoptImpressions
    db.exec('BEGIN IMMEDIATE'); writing = true;
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { writing = false; }
  }
  try {
    transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL)');
      db.prepare('INSERT OR IGNORE INTO ownership VALUES(1,?)').run(owner);
      if (db.prepare('SELECT owner FROM ownership WHERE id=1').get().owner !== owner) throw new Error('Durable scope ownership mismatch');
      db.exec(`CREATE TABLE IF NOT EXISTS people (platform TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(platform,id));
        CREATE TABLE IF NOT EXISTS persona (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, content TEXT NOT NULL, bytes INTEGER NOT NULL, mtime INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS library_catalog (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL);
        INSERT OR IGNORE INTO library_catalog VALUES(1,0,'{}');
        CREATE TABLE IF NOT EXISTS kb_version (id INTEGER PRIMARY KEY, rev INTEGER NOT NULL);
        INSERT OR IGNORE INTO kb_version VALUES(1,0);
        CREATE TRIGGER IF NOT EXISTS kb_put AFTER INSERT ON documents BEGIN UPDATE kb_version SET rev=rev+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS kb_delete AFTER DELETE ON documents BEGIN UPDATE kb_version SET rev=rev+1 WHERE id=1; END;`);
    });
    cached = {db, dir, file, platform, binding, transaction};
    return cached;
  } catch (error) { db.close(); throw error; }
}

// Map-like row access for the legacy store's normalization/retention algorithms.
// Never retain rows between calls: a second process may have just committed.
export function durablePeople({db, platform, binding}) {
  // Keep provenance per endpoint. In the local view only *this* endpoint's
  // chat keys are bare; a coincident private:42 on another account is not this chat.
  function transform(value, fn) {
    const m = {...value};
    m.sourceChatKeys = m.sourceChatKeys.map(fn);
    m.impressions = m.impressions.map(e => ({...e,sourceChatKeys:e.sourceChatKeys.map(fn)}));
    return m;
  }
  const encode = m => JSON.stringify(transform(m,k => k.includes('@') ? k : `${k}@${binding}`));
  const decode = v => transform(JSON.parse(v),k => k.endsWith('@'+binding) ? k.slice(0,-binding.length-1) : k);
  const get = db.prepare('SELECT value FROM people WHERE platform=? AND id=?');
  const put = db.prepare('INSERT INTO people VALUES(?,?,?) ON CONFLICT(platform,id) DO UPDATE SET value=excluded.value');
  const del = db.prepare('DELETE FROM people WHERE platform=? AND id=?');
  const all = db.prepare('SELECT id,value FROM people WHERE platform=?');
  return {
    get(id) { const row = get.get(platform,id); return row && decode(row.value); },
    set(id,value) { put.run(platform,id,encode(value)); },
    delete(id) { del.run(platform,id); },
    entries() { return all.all(platform).map(r => [r.id,decode(r.value)]); },
    values() { return all.all(platform).map(r => decode(r.value)); }
  };
}
