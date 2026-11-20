// Read-through projections for the enrolled primary only. No enumeration of profiles,
// no migration, and no writes/repair of legacy files. Closed if any path redirects.
import fs from 'node:fs';
import path from 'node:path';
import {openDatabase} from '../core/sqlite.js';

function primary() { return null; }
function checked(...parts) {
  const root=primary(); if (!root) return null;
  const file=path.join(root,...parts);
  try {
    const s=fs.lstatSync(file);
    if(path.relative(fs.realpathSync(file),path.resolve(file)) || (!s.isDirectory() && (!s.isFile() || s.nlink!==1))) return null;
    return {file,s};
  } catch {return null;}
}
function json(parts,maxBytes) {
  const f=checked(...parts); if(!f?.s.isFile() || f.s.size>maxBytes) return null;
  try{return JSON.parse(fs.readFileSync(f.file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}
}
export function primaryPersona(key) {
  const states=json(['persona-state.json'],1024*1024);
  if(!states || !Object.hasOwn(states,key)) return null;
  const s=states[key]; if(!s || typeof s!=='object') return null;
  return Object.fromEntries(['energy','mood','lastInteractionAt','updatedAt','savedAt'].filter(k=>Number.isFinite(s[k])).map(k=>[k,s[k]]));
}
export function primaryImpressions(userId,query,visibility,limit) {
  const uid=/^qq:([1-9]\d{0,14})$/.exec(userId)?.[1];
  if(!uid || !query || visibility.mode==='perChat') return [];
  const member=json(['memory','people',uid+'.json'],512*1024);
  if(String(member?.userId)!==uid || !Array.isArray(member.impressions)) return [];
  const q=String(query).toLowerCase();
  return member.impressions.filter(e=>typeof e?.content==='string' && e.content.toLowerCase().includes(q) &&
    Array.isArray(e.sourceChatKeys) && e.sourceChatKeys.length && e.sourceChatKeys.every(k=>/^group:\d+$/.test(k)))
    .slice(-limit).reverse().map(e=>({userId,target:`[qq] ${String(member.name||uid).slice(0,80)}`,content:e.content.slice(0,300),score:1,origin:e.origin}));
}
export function primaryDocumentHits(query,limit) {
  const base=checked('knowledge'); if(!base?.s.isDirectory() || !query) return [];
  const q=String(query).toLowerCase(),hits=[]; let bytes=0,count=0;
  function walk(parts,depth) {
    const dir=checked('knowledge',...parts); if(!dir?.s.isDirectory()) return;
    for(const ent of fs.readdirSync(dir.file,{withFileTypes:true})) {
      if(hits.length>=limit || count>=500 || bytes>=16*1024*1024) return;
      if(ent.name.startsWith('.') || ent.isSymbolicLink()) continue;
      const rel=[...parts,ent.name];
      if(ent.isDirectory() && depth<3) walk(rel,depth+1);
      else if(ent.isFile() && /\.(txt|md)$/i.test(ent.name)) {
        count++; const f=checked('knowledge',...rel);
        if(!f || f.s.size>2*1024*1024 || bytes+f.s.size>16*1024*1024) continue;
        bytes+=f.s.size; const text=fs.readFileSync(f.file,'utf8'); const at=text.toLowerCase().indexOf(q);
        if(at>=0) hits.push({source:'qq:'+rel.join('/'),snippet:text.slice(Math.max(0,at-180),at+420),score:1});
      }
    }
  }
  try{walk([],0);}catch{/* primary may concurrently remove documents */} return hits;
}
export function primaryLibraryHits(query,libs,limit) {
  const catalog=json(['knowledge-lib','libraries.json'],1024*1024)?.libraries;
  if(!catalog || !query) return [];
  const ids=Object.keys(catalog).filter(id=>catalog[id] && catalog[id].enabled!==false && (!libs?.length || libs.includes(id) || libs.includes('qq:'+id))).slice(0,100);
  if(!ids.length) return [];
  const f=checked('knowledge-lib','index.sqlite'); if(!f?.s.isFile()) return [];
  // Do not open a WAL-mode primary DB: even SQLITE_OPEN_READONLY can create -shm.
  const header=Buffer.alloc(20); let fd,db;
  try {
    fd=fs.openSync(f.file,'r'); if(fs.readSync(fd,header,0,20,0)!==20 || header[18]!==1 || header[19]!==1) return [];
    db=openDatabase(f.file,{readOnly:true}); db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    if(db.prepare("SELECT type FROM sqlite_master WHERE name='docs'").get()?.type!=='table') return [];
    return db.prepare(`SELECT lib,source,substr(text,1,1200) AS text FROM docs WHERE lib IN (${ids.map(()=>'?').join(',')}) AND instr(lower(text),lower(?))>0 LIMIT ?`)
      .all(...ids,String(query).slice(0,300),limit).map(r=>({lib:'qq:'+r.lib,libName:String(catalog[r.lib]?.name||r.lib),source:r.source,text:r.text,score:1,how:'legacy-keyword'}));
  }catch{return [];}finally{db?.close();if(fd!=null)fs.closeSync(fd);}
}
