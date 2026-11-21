package com.whaleonebot.backup;

import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Logical projection. Database pages, sessions, credentials and schema SQL never travel. */
final class CoreBackupProjection {
    static void capture(Path live,String owner,CoreArchive a,PortableDatabase.Backend backend)throws Exception{
        if(!BindingCompartments.directory(live))return;
        Path cfg=live.resolve("config.json");if(CoreDataTransaction.exists(cfg)){
            backend.regular(cfg,2*1024*1024);JSONObject config=new JSONObject(new String(Files.readAllBytes(cfg),StandardCharsets.UTF_8));
            Set<String> keys=new HashSet<>(CoreArchive.BOOL);keys.addAll(CoreArchive.DEC);keys.addAll(CoreArchive.TEXT);
            for(String key:keys){String[] parts=key.split("\\.");JSONObject group=config;for(int i=0;i<parts.length-1&&group!=null;i++)group=group.optJSONObject(parts[i]);String leaf=parts[parts.length-1];if(group!=null&&group.has(leaf)){Object v=group.get(leaf);CoreArchive.check(CoreArchive.TEXT.contains(key)?v instanceof String:CoreArchive.BOOL.contains(key)?v instanceof Boolean:v instanceof Number);a.add("setting",key,"",String.valueOf(v));}}
        }
        BindingCompartments.capture(live,owner,a,(dir,binding,suffix)->{
            if(!BindingCompartments.directory(dir))return;
            if(CoreDataTransaction.exists(dir.resolve("corpus")))throw new IOException("BACKUP_EXTERNAL_CORPUS");
            Path file=dir.resolve("durable.sqlite");if(!CoreDataTransaction.exists(file))return;
            backend.regular(file,512L*1024*1024);for(String ext:new String[]{"-wal","-shm","-journal"}){Path side=dir.resolve("durable.sqlite"+ext);if(!CoreDataTransaction.exists(side))continue;
                // Android may commit in PERSIST mode: SQLite invalidates the header rather than unlinking the rollback journal.
                // The instance is paused; never delete a sidecar. Accept only an empty or completely zeroed 28-byte header.
                if("-journal".equals(ext)){backend.regular(side,512L*1024*1024);if(Files.size(side)==0)continue;byte[] header=new byte[28];if(Files.size(side)>=header.length){try(DataInputStream in=new DataInputStream(Files.newInputStream(side))){in.readFully(header);}if(Arrays.equals(header,new byte[28]))continue;}}
                throw new IOException("BACKUP_SQLITE_SIDECAR_"+ext.substring(1).toUpperCase(Locale.ROOT));}
            try(PortableDatabase db=backend.open(file,false)){
                CoreArchive.check("4".equals(scalar(db,"SELECT count(*) FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE TABLE %' AND name IN ('people','persona','documents','ownership')")));
                JSONArray v=new JSONArray(scalar(db,"SELECT owner FROM ownership WHERE id=1"));CoreArchive.check(v.length()==3&&owner.equals(v.getString(0))&&(binding.isEmpty()?"robot":"binding").equals(v.getString(1))&&binding.equals(v.getString(2)));
                if(!"0".equals(scalar(db,"SELECT count(*) FROM sqlite_master WHERE name='library_catalog'"))){CoreArchive.check("1".equals(scalar(db,"SELECT count(*) FROM sqlite_master WHERE name='library_catalog' AND type='table' AND sql LIKE 'CREATE TABLE %'")));if(new JSONObject(scalar(db,"SELECT value FROM library_catalog WHERE id=1")).length()!=0)throw new IOException("目录型知识库需要另行迁移；未释放核心");}
                rows(db,"SELECT platform,id,value FROM people","person",suffix,a);rows(db,"SELECT id,'',value FROM persona","persona",suffix,a);rows(db,"SELECT name,mtime,content FROM documents","doc",suffix,a);
            }
        });
    }
    static String scalar(PortableDatabase db,String query)throws Exception{try(PortableDatabase.Rows r=db.query(query)){CoreArchive.check(r.next());String s=r.text(0);CoreArchive.check(!r.next());return s;}}
    static void rows(PortableDatabase db,String sql,String kind,String suffix,CoreArchive a)throws Exception{try(PortableDatabase.Rows c=db.query(sql)){while(c.next()){String value=c.text(2);if(!kind.equals("doc"))value=project(kind,new JSONObject(value)).toString();a.add(kind+suffix,c.text(0),c.text(1),value);}}}
    static JSONObject scalars(JSONObject src,String fields)throws Exception{JSONObject out=new JSONObject();for(String k:fields.split(" ")){Object v=src.opt(k);if(v instanceof Number||v instanceof Boolean||v instanceof String)out.put(k,v);}return out;}
    static JSONArray strings(JSONArray src)throws Exception{JSONArray out=new JSONArray();if(src!=null)for(int i=0;i<src.length();i++){Object s=src.get(i);CoreArchive.check(s instanceof String);out.put(s);}return out;}
    static JSONObject project(String kind,JSONObject s)throws Exception{
        if(kind.equals("persona"))return scalars(s,"version key energy mood activity sleeping updatedAt lastInteractionAt savedAt");
        JSONObject p=scalars(s,"version userId name updatedAt lastConsolidatedAt");p.put("sourceChatKeys",strings(s.optJSONArray("sourceChatKeys")));
        JSONArray src=s.optJSONArray("impressions"),list=new JSONArray();if(src!=null)for(int i=0;i<src.length();i++){JSONObject item=src.getJSONObject(i),e=scalars(item,"content createdAt lastObservedAt origin");e.put("sourceChatKeys",strings(item.optJSONArray("sourceChatKeys")));list.put(e);}p.put("impressions",list);
        if(s.optJSONObject("relationship")!=null)p.put("relationship",scalars(s.getJSONObject("relationship"),"interactions warmth lastInteractionAt"));return p;
    }
    static void restore(Path stage,String owner,CoreArchive archive,PortableDatabase.Backend backend)throws Exception{
        JSONObject cfg=new JSONObject();BindingCompartments.restore(stage,owner,archive,(dir,binding,suffix)->{
            try(PortableDatabase db=backend.open(dir.resolve("durable.sqlite"),true)){
                db.exec("BEGIN");db.exec("CREATE TABLE ownership(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL)");db.exec("INSERT INTO ownership VALUES(1,?)",new JSONArray(Arrays.asList(owner,binding.isEmpty()?"robot":"binding",binding)).toString());
                db.exec("CREATE TABLE people(platform TEXT,id TEXT,value TEXT NOT NULL,PRIMARY KEY(platform,id))");db.exec("CREATE TABLE persona(id TEXT PRIMARY KEY,value TEXT NOT NULL)");db.exec("CREATE TABLE documents(name TEXT PRIMARY KEY,content TEXT NOT NULL,bytes INTEGER NOT NULL,mtime INTEGER NOT NULL)");
                for(String[] r:archive.rows){int cut=r[0].indexOf('@');String scope=cut<0?"":r[0].substring(cut);if(!suffix.equals(scope))continue;String kind=cut<0?r[0]:r[0].substring(0,cut);switch(kind){
                case "slot":case "scope":break;
                case "setting":String[] path=r[1].split("\\.");JSONObject group=cfg;for(int j=0;j<path.length-1;j++){JSONObject next=group.optJSONObject(path[j]);if(next==null){next=new JSONObject();group.put(path[j],next);}group=next;}group.put(path[path.length-1],CoreArchive.TEXT.contains(r[1])?(Object)r[3]:CoreArchive.BOOL.contains(r[1])?(Object)Boolean.valueOf(r[3]):Double.valueOf(r[3]));break;
                case "person":db.exec("INSERT INTO people VALUES(?,?,?)",r[1],r[2],project(kind,new JSONObject(r[3])).toString());break;
                case "persona":db.exec("INSERT INTO persona VALUES(?,?)",r[1],project(kind,new JSONObject(r[3])).toString());break;
                case "doc":db.exec("INSERT INTO documents VALUES(?,?,?,?)",r[1],r[3],r[3].getBytes(StandardCharsets.UTF_8).length,Long.parseLong(r[2]));break;
                default:throw CoreArchive.invalid();}}db.exec("COMMIT");
            }
        });
        JSONObject persona=cfg.optJSONObject("persona");if(persona==null)persona=new JSONObject();if(!persona.has("botName"))persona.put("botName",archive.name);if(!persona.has("roleText")&&!archive.persona.isEmpty())persona.put("roleText",archive.persona);if(persona.has("roleText"))persona.put("templateId","");cfg.put("persona",persona);
        try(FileOutputStream f=new FileOutputStream(stage.resolve("config.json").toFile())){f.write(cfg.toString().getBytes(StandardCharsets.UTF_8));f.getFD().sync();}
    }
}
