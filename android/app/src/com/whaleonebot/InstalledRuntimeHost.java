package com.whaleonebot;

import android.content.Context;
import com.whaleonebot.install.CoreInstaller;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** New, installed cores only. Never adopt a legacy process, account login or another core's generation. */
final class InstalledRuntimeHost {
    static final Map<String,Group> groups=new HashMap<>();
    private static final Set<String> maintenance=new HashSet<>();
    static final class Group{final String bot,core,ticket=nonce();final Map<String,Channel> channels=new HashMap<>(); final Set<String> suppressed=new HashSet<>(); boolean prepared; Group(String b,String c){bot=b;core=c;}}
    static final class Channel{final String signature,nonce=nonce(); String state="starting"; long started; Process p; Channel(String s){signature=s;}}
    private static String nonce(){return UUID.randomUUID().toString().replace("-","");}
    static boolean valid(String s){return s!=null&&s.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}");}
    private static JSONObject bot(File files,String id)throws Exception{return BindingControl.find(BindingControl.bots(files),id);}
    // No configurable executable, storage path or mount source comes from bots.json.
    static String core(File files,String id){try{JSONObject b=bot(files,id);String c=b.optString("coreInstanceId");if(!"builtin".equals(b.optString("runtimeKind"))||c.isEmpty()||c.equals("legacy-"+id))return null;return valid(c)?c:"!invalid";}catch(Exception e){return null;}}
    static File data(File files,String c){if(!valid(c))throw new IllegalArgumentException("invalid instance");return new File(files,"rootfs/opt/whale/instance-data/"+c);}
    private static JSONObject json(File f)throws Exception{if(!f.isFile()||f.length()>1048576)throw new IOException();return new JSONObject(new String(Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));}
    static boolean owner(File files,String b,String c)throws Exception{JSONObject doc=json(new File(files,"bots.json"));JSONArray bs=doc.getJSONArray("bots");int owners=0;boolean mine=false;for(int i=0;i<bs.length();i++){JSONObject v=bs.getJSONObject(i);if(c.equals(v.optString("coreInstanceId"))){owners++;mine=b.equals(v.optString("id"))&&"builtin".equals(v.optString("runtimeKind"));}}JSONObject inst=BindingControl.find(doc.getJSONArray("coreInstances"),c);return owners==1&&mine&&!inst.optBoolean("legacy",false);}
    static synchronized String request(File files,String b,boolean explicit){String c=core(files,b);if(!valid(c)||!valid(b)||maintenance.contains(b))return null;Group g=groups.get(b);if(g!=null&&!g.core.equals(c))return null;if(g==null){if(!explicit)return null;g=new Group(b,c);groups.put(b,g);}if(explicit){g.suppressed.clear();if(!busy(g))g.prepared=false;}return g.ticket;}
    static synchronized String requestPlatform(File files,String b,String platform)throws Exception {
        String c=core(files,b);if(!valid(c)||!valid(b)||maintenance.contains(b)||!owner(files,b,c))return null;
        JSONObject record=bot(files,b);if(!record.optBoolean("enabled",true))return null;
        JSONArray rows=record.getJSONArray("bindings");Set<String> selected=new HashSet<>(),others=new HashSet<>();
        for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String id=row.getString("id");if(platform.equals(row.optString("platform"))&&row.optBoolean("enabled",true))selected.add(id);else others.add(id);}
        if(selected.isEmpty())return null;Group g=groups.get(b);if(g==null){g=new Group(b,c);g.suppressed.addAll(others);groups.put(b,g);}else if(!g.core.equals(c))return null;
        g.suppressed.removeAll(selected);if(!busy(g))g.prepared=false;return g.ticket;
    }
    private static boolean busy(Group g){for(Channel ch:g.channels.values())if(ch.p!=null&&ch.p.isAlive())return true;return false;}
    static void reconcile(ContainerService svc,String b,String ticket){reconcile(svc,b,ticket,null,null);}
    static synchronized void reconcile(ContainerService svc,String b,String ticket,String platformFilter,String slotFilter){Group g=groups.get(b);if(g==null||!g.ticket.equals(ticket)||maintenance.contains(b))return; File files=svc.getFilesDir();
        try{if(!owner(files,b,g.core)||new File(data(files,g.core).getParentFile(),".maintenance-"+g.core).exists())return;
            JSONObject bot=bot(files,b);if(!bot.optBoolean("enabled",true)){stop(b);return;} JSONArray rows=bot.getJSONArray("bindings");if(rows.length()>32)return;
            String journal=CoreInstaller.pendingMaintenance(files,g.core);if(!journal.isEmpty()){if(!Arrays.asList("qq","bilibili").contains(journal))return;boolean removed=true;for(int i=0;i<rows.length();i++)if(journal.equals(rows.getJSONObject(i).optString("platform")))removed=false;CoreInstaller.recoverReset(files,g.core,removed);}
            File app=null;String unavailable="core_missing";{try{app=g.prepared||busy(g)?CoreInstaller.active(files,g.core):CoreInstaller.onNormalStart(files,g.core);if(app!=null){app=verifiedApp(files,g.core,app);g.prepared=true;}}catch(Exception e){app=null;}}
            Set<String> current=new HashSet<>();for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String k=row.optString("id");if(!valid(k)||!current.add(k))throw new IOException();}
            if(platformFilter==null&&slotFilter==null)for(String k:new ArrayList<>(g.channels.keySet()))if(!current.contains(k))terminate(g.channels.remove(k));
            for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String k=row.getString("id");if(platformFilter!=null&&!platformFilter.equals(row.optString("platform"))||slotFilter!=null&&!slotFilter.equals(k))continue;String sig=row.toString();Channel old=g.channels.get(k);if(old!=null&&sig.equals(old.signature)&&old.p!=null&&old.p.isAlive())continue;if(old!=null)terminate(old);
                Channel ch=new Channel(sig);g.channels.put(k,ch);try{if(g.suppressed.contains(k)||!row.optBoolean("enabled",true)){ch.state="stopped";continue;}String platform=row.optString("platform");if(app==null){ch.state=unavailable;continue;}
                    if(!Arrays.asList("qq","bilibili").contains(platform)){ch.state="unsupported";continue;}File plugin=new File(app,"src/platform-modules/"+platform);if(!new File(plugin,".bot-module.json").isFile()||!new File(plugin,"index.mjs").isFile()){ch.state="plugin_required";continue;}
                    if(row.optString("accountId").isEmpty()){ch.state="account_required";continue;}
                    JSONObject copy=new JSONObject(sig);String token;if(BiliProtocolControl.owned(row)){token=BiliProtocolControl.lease(b,row,copy);if(token==null){ch.state="protocol_required";continue;}}else{token=BindingControl.transientToken(b,row);if(token==null){ch.state="credentials_required";continue;}}
                    JSONObject selected=new JSONObject().put("id",b).put("runtimeKind","builtin").put("bindings",new JSONArray().put(copy));JSONObject input=new JSONObject().put("installedCoreId",g.core).put("bot",selected).put("runId",ch.nonce).put("tokens",new JSONObject().put(k,token));
                    ch.started=System.currentTimeMillis();Process p=svc.installedBuilder(files,app,data(files,g.core)).redirectOutput(new File("/dev/null")).start();ch.p=p;try(OutputStream out=p.getOutputStream()){out.write(input.toString().getBytes(StandardCharsets.UTF_8));}ch.state="starting";
                }catch(Exception e){terminate(ch);ch.state="failed";}}
        }catch(Exception ignored){/* untrusted metadata: no fallback to global app */}}
    private static File verifiedApp(File files,String id,File app)throws IOException{File root=new File(files,"core-instances/"+id+"/generations").getCanonicalFile();File dir=app.getCanonicalFile();if(!dir.equals(new File(new File(root,app.getParentFile().getName()),"agent-app"))||!dir.getName().equals("agent-app")||!root.equals(dir.getParentFile().getParentFile())||!new File(dir,".bot-module.json").isFile()||!new File(dir,"src/binding-supervisor.mjs").isFile())throw new IOException("invalid installed core");return dir;}
    private static void terminate(Channel ch){if(ch==null)return;if(ch.p!=null&&ch.p.isAlive()){ch.p.destroy();try{if(!ch.p.waitFor(3000,TimeUnit.MILLISECONDS)){ch.p.destroyForcibly();if(!ch.p.waitFor(3000,TimeUnit.MILLISECONDS))throw new IllegalStateException("worker did not stop");}}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException("stop interrupted");}}ch.state="stopped";}
    static synchronized void stop(String b){Group g=groups.get(b);if(g!=null){for(Channel ch:g.channels.values())terminate(ch);groups.remove(b);}}
    static synchronized void stopBinding(String b,String k){Group g=groups.get(b);if(g!=null){g.suppressed.add(k);terminate(g.channels.get(k));}}
    static void containerReady(ContainerService svc){final Map<String,String> selected=new HashMap<>();synchronized(InstalledRuntimeHost.class){for(Group g:groups.values())selected.put(g.bot,g.ticket);}if(!selected.isEmpty())new Thread(()->{for(Map.Entry<String,String> item:selected.entrySet())reconcile(svc,item.getKey(),item.getValue());},"installed-ready").start();}
    static synchronized void stopAll(){for(String b:new ArrayList<>(groups.keySet()))stop(b);}
    static synchronized Closeable pause(Context ctx,String b)throws IOException{File files=ctx.getFilesDir();String c=core(files,b);if(!valid(c)||!maintenance.add(b))throw new IOException("busy or unsupported instance");try{if(!owner(files,b,c))throw new IOException("ownership changed");if(groups.containsKey(b))throw new IOException("stop the requested bot explicitly first");assertQuiescent(data(files,c));return ()->{synchronized(InstalledRuntimeHost.class){maintenance.remove(b);}};}catch(Exception e){maintenance.remove(b);throw new IOException("cannot prove instance idle",e);}}
    private static void assertQuiescent(File root)throws IOException{Path channels=root.toPath().resolve("channels");if(!Files.exists(channels,LinkOption.NOFOLLOW_LINKS))return;Files.walkFileTree(channels,EnumSet.noneOf(FileVisitOption.class),12,new SimpleFileVisitor<Path>(){public FileVisitResult visitFile(Path f,BasicFileAttributes a)throws IOException{if(a.isSymbolicLink())throw new IOException("linked worker path");if(f.getFileName().toString().equals(".server.lock"))try{int pid=json(f.toFile()).getInt("pid");if(pid<=0||new File("/proc/"+pid).exists())throw new IOException("worker still alive");}catch(Exception e){throw new IOException("unresolved lock",e);}return FileVisitResult.CONTINUE;}});}
    static synchronized JSONObject status(Context ctx,String b){JSONObject out=new JSONObject();JSONArray list=new JSONArray();try{Group g=groups.get(b);JSONArray rows=bot(ctx.getFilesDir(),b).getJSONArray("bindings");boolean any=false,all=true;for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String k=row.getString("id"),state="stopped";Channel ch=g==null?null:g.channels.get(k);if(ch!=null&&ch.signature.equals(row.toString())){state=ch.state;if(ch.p!=null&&ch.p.isAlive()){state="starting";try{JSONObject proof=json(new File(data(ctx.getFilesDir(),g.core),"channels/"+k+"/"+b+"/binding-status.json"));long at=proof.getLong("updatedAt"),age=System.currentTimeMillis()-at;JSONObject p=BindingControl.find(proof.getJSONArray("bindings"),k);String s=p.optString("state");if(ch.nonce.equals(proof.optString("runId"))&&b.equals(proof.optString("botId"))&&row.optString("accountId").equals(p.optString("selfId"))&&row.optString("platform").equals(p.optString("platform"))&&at>=ch.started&&age>=0&&age<30000&&Arrays.asList("starting","disconnected","verified","failed","stopped").contains(s))state=s;else state="stale";}catch(Exception ignored){}any=true;}else if(ch.p!=null&&!"stopped".equals(state))state="failed";}
            if(!"verified".equals(state))all=false;list.put(new JSONObject().put("id",k).put("platform",row.optString("platform")).put("accountId",row.optString("accountId")).put("state",state));}out.put("state",g==null?"stopped":all&&any?"running":any?"partial":"waiting").put("bindings",list);
        }catch(Exception ignored){}return out;}
}
