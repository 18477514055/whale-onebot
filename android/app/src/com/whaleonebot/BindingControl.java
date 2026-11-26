package com.whaleonebot;

import android.content.Context;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;

/** App-private registry projection and process ownership. Never accept endpoints, commands or credentials from HTTP. */
final class BindingControl {
    private static final Map<String,Run> runs = new HashMap<>();
    private static final Map<String,String[]> credentials = new HashMap<>();
    private static final class Run { final String runId=UUID.randomUUID().toString().replace("-",""); String state="starting",selection; VerifiedAttachBarrier pending; Process proc; long since; }
    private static boolean id(String s) { return s!=null && s.matches("[A-Za-z0-9_-]{1,64}"); }
    private static JSONObject read(File file) throws Exception {
        if (!file.isFile() || file.length()>1048576) throw new IOException();
        return new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
    }
    static JSONArray bots(File files) throws Exception { return read(new File(files,"bots.json")).getJSONArray("bots"); }
    static JSONObject find(JSONArray a,String id) throws Exception {
        JSONObject found=null;
        for(int i=0;i<a.length();i++) { JSONObject b=a.getJSONObject(i); if(id.equals(b.optString("id"))) {if(found!=null) throw new IOException();found=b;} }
        if(found==null) throw new IOException(); return found;
    }
    static boolean implicitQQ(JSONObject r){return "qq".equals(r.optString("platform"))&&r.optString("accountId").isEmpty()&&r.optString("wsUrl").isEmpty()&&r.optString("httpUrl").isEmpty();}
    static boolean legacy(File files, boolean auto) {
        if(!new File(files,"bots.json").exists()) return true; // pre-registry installations
        try {
            JSONArray all=bots(files); if(auto && all.length()!=1) return false;
            JSONObject b=find(all,"whale-1"); JSONArray p=b.getJSONArray("platforms"), rows=b.optJSONArray("bindings");
            if(!b.optBoolean("enabled",true)||!"builtin".equals(b.optString("runtimeKind")))return false;
            if(!b.has("bindings"))return p.length()==1&&"qq".equals(p.getString(0));
            int implicit=0; if(rows==null)return false;
            for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);if(implicitQQ(r))implicit++;else if(!"bilibili".equals(r.optString("platform")))return false;}
            return implicit==1;
        }catch(Exception e){return false;}
    }
    private static String target(JSONObject b) throws Exception {return new JSONArray().put(b.getString("platform")).put(b.getString("accountId")).put(b.getString("httpUrl")).put(b.getString("wsUrl")).toString();}
    static synchronized void token(Context c,String bot,String binding,String value){
        if(!id(bot)||!id(binding)) throw new IllegalArgumentException("Invalid binding ID");
        String key=bot+":"+binding; credentials.remove(key); if(value==null||value.isEmpty())return;
        if(!value.matches("[!-~]{1,4096}")||value.matches("(?i).*(SESSDATA|bili_jct|DedeUserID)=.*"))throw new IllegalArgumentException("Expected OneBot token, not cookies");
        try {JSONObject row=find(find(bots(c.getFilesDir()),bot).getJSONArray("bindings"),binding);credentials.put(key,new String[]{target(row),value});}
        catch(Exception e){throw new IllegalArgumentException("Save the binding first");}
    }
    static synchronized String transientToken(String bot,JSONObject row)throws Exception{String[] t=credentials.get(bot+":"+row.getString("id"));return t!=null&&t[0].equals(target(row))?t[1]:null;}
    static synchronized String queue(String bot){if(!id(bot))return null; Run old=runs.get(bot); if(old!=null&&("starting".equals(old.state)||old.proc!=null&&old.proc.isAlive()))return null; Run fresh=new Run();runs.put(bot,fresh);return fresh.runId;}
    static synchronized String verifiedTicket(Context c,String bot,String binding){
        Run run=runs.get(bot);if(run==null||!"protocol_required".equals(run.state)||run.pending==null)return null;
        try{JSONObject b=find(bots(c.getFilesDir()),bot);if(!b.optBoolean("enabled",true)||!"builtin".equals(b.optString("runtimeKind")))return null;
            JSONArray rows=b.getJSONArray("bindings");Set<String> live=new HashSet<>();
            for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if(BiliProtocolControl.owned(row)&&BiliProtocolControl.lease(bot,row,new JSONObject())!=null)live.add(row.getString("id"));}
            if(!run.pending.accept(rows.toString(),binding,live))return null;
            run.pending=null;run.state="starting";return run.runId;
        }catch(Exception ignored){return null;}
    }
    // No polling: only a matching verification notification may pass this one-shot barrier.
    static final class VerifiedAttachBarrier {
        final String selection; final Set<String> required; boolean consumed;
        VerifiedAttachBarrier(String selected,Set<String> ids){selection=selected;required=new HashSet<>(ids);}
        boolean accept(String selected,String binding,Set<String> live){if(consumed||!selection.equals(selected)||!required.contains(binding)||!live.containsAll(required))return false;consumed=true;return true;}
    }
    static synchronized void stop(String bot){Run r=runs.get(bot);if(r!=null){r.state="stopped";if(r.proc!=null)r.proc.destroy();}}
    static synchronized void stopAll(){for(String id:runs.keySet())stop(id);credentials.clear();}
    static void launch(ContainerService svc,String bot,String ticket){
        final Run run; final Process proc;
        synchronized(BindingControl.class){ run=runs.get(bot); if(run==null||!run.runId.equals(ticket)||!"starting".equals(run.state)||run.proc!=null)return;
            try {
                File files=svc.getFilesDir();JSONObject b=find(bots(files),bot);
                if(!b.optBoolean("enabled",true)){run.state="disabled";return;}
                if("custom".equals(b.optString("runtimeKind"))){run.state="external";return;}
                if(!ContainerService.isRunning()){run.state="container_required";return;}
                if(!new File(files,"rootfs/input/agent-app/src/binding-supervisor.mjs").isFile()||!new File(files,"rootfs/opt/whale/binding-host.mjs").isFile()){run.state="runtime_missing";return;}
                JSONArray rows=b.getJSONArray("bindings"); if(rows.length()<1||rows.length()>32) throw new IOException();
                String selected=rows.toString();if(run.selection!=null&&!run.selection.equals(selected)){run.state="configuration_changed";return;}
                Set<String> owned=new HashSet<>();for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if(BiliProtocolControl.owned(row))owned.add(row.getString("id"));}
                boolean companion="whale-1".equals(bot)&&legacy(files,false);
                JSONObject tokens=new JSONObject();JSONArray projected=new JSONArray();for(int i=0;i<rows.length();i++) {JSONObject row=rows.getJSONObject(i);if(companion&&implicitQQ(row))continue;
                    JSONObject copy=new JSONObject(row.toString());String k=row.getString("id");String value;
                    if(BiliProtocolControl.owned(row)){value=BiliProtocolControl.lease(bot,row,copy);if(value==null){run.selection=selected;run.pending=new VerifiedAttachBarrier(selected,owned);run.state="protocol_required";return;}}
                    else{String[] token=credentials.get(bot+":"+k);if(token==null||!token[0].equals(target(row))){run.state="credentials_required";return;}value=token[1];}
                    projected.put(copy);tokens.put(k,value);}
                if(projected.length()==0){run.state="stopped";return;}
                run.selection=rows.toString();run.since=System.currentTimeMillis();b.put("bindings",projected);
                proc=ContainerService.containerBuilder(files,"exec node /opt/whale/binding-host.mjs").redirectOutput(new File("/dev/null")).start();run.proc=proc;
                // Pipe directly to our fixed Node entry, never through shell, argv, a file, or Android Intent extras.
                try(OutputStream in=proc.getOutputStream()){in.write(new JSONObject().put("bot",b).put("tokens",tokens).put("runId",run.runId).put("companion",companion).toString().getBytes(StandardCharsets.UTF_8));}
                run.state="running";
            }catch(Exception e){if(run.proc!=null)run.proc.destroy();run.state="failed";return;}
        }
        try {proc.waitFor();}catch(InterruptedException e){Thread.currentThread().interrupt();}
        synchronized(BindingControl.class){if(runs.get(bot)==run&&!"stopped".equals(run.state))run.state="failed";}
    }
    static synchronized JSONObject status(Context c,String bot){
        JSONObject out=new JSONObject();JSONArray result=new JSONArray();String state="stopped";
        try {
            if(!id(bot))throw new IOException();JSONObject b=find(bots(c.getFilesDir()),bot); Run run=runs.get(bot);
            state="custom".equals(b.optString("runtimeKind"))?"external":run==null?"stopped":run.state;
            // ★ 2026-11-26（第 230 轮实测真因）：legacy 实例（whale-1）在 App 重启或未走 queue()+launch() 时
            //   内存 runs 为空导致恒报 stopped（实际上容器内 container-bot + agent 一直在跑、13800 LISTEN）。
            //   此处改用真实活体探针（bot.json phase + /proc/<pid> + 端口 LISTEN）核验，不再只信静态 Map。
            int liveOnebotPort = 0;
            int liveAgentPid = 0;
            if (!"external".equals(state) && ("stopped".equals(state) || "stale".equals(state))
                    && "whale-1".equals(bot) && legacy(c.getFilesDir(), false)) {
                ContainerService.LiveRuntimeProbe probe = ContainerService.probeLiveRuntime(c.getFilesDir());
                liveOnebotPort = probe.onebotPort;
                liveAgentPid = probe.agentPid;
                if (probe.agentAlive) {
                    state = "running";
                } else if (probe.onebotAlive) {
                    state = "protocol_only";
                }
            }
            JSONArray rows=b.optJSONArray("bindings"), live=null;
            // ★ 2026-11-22：以前这里只要拿不到「30 秒内刷新的 binding-status.json」就把整台机器判成
            //   "stale"，于是每个绑定都显示「未连接」—— 而 legacy 运行端**根本不写那个证明文件**
            //   （真机实测：rootfs/opt/whale/bindings 下没有 binding-status.json），所以启动页永远
            //   显示未连接。现在区分两件事：进程活着 = running；账号是否核验过 = 证明文件说了算，
            //   没有证明就是 unknown（状态未知），不冒充"未连接"。
            boolean proofFresh=false;
            if("running".equals(state)){
                try {JSONObject proof=read(new File(c.getFilesDir(),"rootfs/opt/whale/bindings/"+bot+"/binding-status.json"));long at=proof.getLong("updatedAt"),age=System.currentTimeMillis()-at;
                    if(run!=null&&run.proc!=null&&run.proc.isAlive()&&rows!=null&&rows.toString().equals(run.selection)&&bot.equals(proof.getString("botId"))&&run.runId.equals(proof.optString("runId"))&&at>=run.since&&age>=0&&age<30000){live=proof.getJSONArray("bindings");proofFresh=true;}
                }catch(Exception ignored){}
                // 没有可用的证明文件时：受管进程或活体探针任一确认活着就仍是 running。
                if(!proofFresh) {
                    boolean aliveNow = (run!=null&&run.proc!=null&&run.proc.isAlive()) || liveOnebotPort > 0 || liveAgentPid > 0;
                    state = aliveNow ? "running" : "stale";
                }
            }
            for(int i=0;rows!=null&&i<rows.length();i++){JSONObject r=rows.getJSONObject(i);String k=r.optString("id"),s="external".equals(state)?"external":"stopped";
                // 运行端在跑但没有账号核验证明 ⇒ 状态未知（不是"未连接"）。
                if("running".equals(state)&&live==null)s="unknown";
                if(live!=null){s="disconnected";try {JSONObject v=find(live,k);String raw=v.optString("state"); if(r.optString("accountId").equals(v.optString("selfId"))&&r.optString("platform").equals(v.optString("platform"))&&Arrays.asList("starting","disconnected","verified","failed","disabled","stopped").contains(raw))s=raw;}catch(Exception ignored){}}
                result.put(new JSONObject().put("id",k).put("platform",r.optString("platform")).put("accountId",r.optString("accountId")).put("state",s));}
            if (liveOnebotPort > 0) out.put("onebotPort", liveOnebotPort);
            if (liveAgentPid > 0) out.put("agentPid", liveAgentPid);
        }catch(Exception e){state="failed";}
        try{out.put("state",state).put("bindings",result);}catch(Exception ignored){}return out;
    }
}
