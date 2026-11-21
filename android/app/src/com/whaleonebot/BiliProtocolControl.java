package com.whaleonebot;

import android.content.Context;
import org.json.*;
import java.io.*;
import java.util.*;
import java.security.SecureRandom;
import java.nio.charset.StandardCharsets;

/** Owns a fixed child entry point. Only private anonymous process pipes carry login material. */
final class BiliProtocolControl {
    private static final Map<String,Run> runs = new HashMap<>();
    /** 只为「停掉之后抹掉端点文件」留一份 application context（不涉及任何凭据）。 */
    private static Context lastCtx;
    private static final class Run {
        final boolean interactive; boolean enrollment,newSlot;
        String state="starting", self, peer, token, challenge;
        // 这次 Run 属于哪个机器人/槽位：写动作开关要按「这个槽位的行为配置」决定。
        String botId, bindingId;
        int port, received; Process proc; long at, expiresAt, lastReceived;
        Run(boolean interactive) { this.interactive=interactive; }
    }
    private static String key(String bot,String binding) {
        if(bot==null || binding==null || !bot.matches("[A-Za-z0-9_-]{1,64}") || !binding.matches("[A-Za-z0-9_-]{1,64}"))
            throw new IllegalArgumentException("Invalid ID");
        return bot+":"+binding;
    }
    /** Resume only. A missing session never spawns a child. No QR fallback or retry loop. */
    static synchronized void start(Context ctx,String bot,String binding,String peer) { begin(ctx,bot,binding,peer,false); }
    /** Only explicit UI reauthorization may request an interactive child. Keep old ciphertext until replacement verifies. */
    static synchronized void reauthorize(Context ctx,String bot,String binding,String peer) { begin(ctx,bot,binding,peer,true); }
    static synchronized Runnable enroll(Context ctx,String bot,String binding,boolean newSlot){
        String k=key(bot,binding);Run old=runs.get(k);if(old!=null&&("starting".equals(old.state)||old.proc!=null&&old.proc.isAlive()))return null;
        Run r=new Run(true);r.enrollment=true;r.newSlot=newSlot;runs.put(k,r);Context c=ctx.getApplicationContext();new Thread(()->launch(c,bot,binding,"",r),"bili-enrollment").start();
        return ()->cancelEnrollment(k,r);
    }
    private static synchronized void cancelEnrollment(String k,Run r){
        if(r.enrollment && current(k,r) && ("starting".equals(r.state)||"awaiting_confirmation".equals(r.state)))halt(r);
    }
    private static void begin(Context ctx,String bot,String binding,String peer,boolean interactive) {
        lastCtx = ctx.getApplicationContext();
        String k=key(bot,binding); Run old=runs.get(k);
        if (old!=null && ("starting".equals(old.state) || old.proc!=null && old.proc.isAlive())) {
            if(!interactive || old.interactive && Arrays.asList("starting","awaiting_confirmation").contains(old.state)) return;
            halt(old);
        }
        Run r=new Run(interactive); r.botId=bot; r.bindingId=binding; runs.put(k,r); Context c=ctx.getApplicationContext();
        new Thread(()->launch(c,bot,binding,peer,r),"bili-protocol").start();
    }
    private static JSONObject selection(Context c,String bot,String binding,String peer) throws Exception {
        JSONObject b=BindingControl.find(BindingControl.bots(c.getFilesDir()),bot);
        JSONObject row=BindingControl.find(b.getJSONArray("bindings"),binding);
        if(!b.optBoolean("enabled",true)||!row.optBoolean("enabled",true)||!owned(row)||!row.optString("peerId").equals(peer==null?"":peer))throw new IOException();
        return row;
    }
    private static boolean current(String k, Run r) { return runs.get(k)==r && !"stopped".equals(r.state); }
    private static String frame(InputStream in) throws IOException {
        byte[] data = new byte[8192]; int n=0;
        try {
            for (;;) {
                int next=in.read();
                if (next==-1 && n==0) return null;
                if (next=='\n') return new String(data,0,n,StandardCharsets.UTF_8);
                if (next<0 || n==data.length) throw new IOException();
                data[n++]=(byte)next;
            }
        } finally { Arrays.fill(data,(byte)0); }
    }
    /** 设备上的协议端是否带「纯 Node 发评论」实现（= 新协议端）。老协议没有这个文件，绝不能传写开关。 */
    private static boolean supportsWriteActions(Context c){
        try{
            File files=c.getFilesDir();
            return new File(files,"rootfs/opt/whale/bili-protocol/src/platforms/bilibili/actions/reply.mjs").isFile();
        }catch(Exception e){return false;}
    }
    /** 用户在 B 站行为里开了「评论」才允许公开写；读不到就当不允许。 */
    private static boolean userAllowsWrites(Run r){
        try{
            if(lastCtx==null||r==null||r.botId==null||r.bindingId==null)return false;
            return com.whaleonebot.ui.BiliSettings.getBool(lastCtx,r.botId,r.bindingId,"write.enabled",false);
        }catch(Exception e){return false;}
    }

    private static void writeInput(Process p,Run r,String saved,BiliSystemResolver resolver) throws Exception {
        JSONObject input=r.enrollment?new JSONObject().put("enroll",true).put("interactive",true):new JSONObject().put("selfId",r.self).put("peerId",r.peer.isEmpty()?JSONObject.NULL:r.peer)
            .put("token",r.token).put("interactive",r.interactive);
        // ★ 写动作（发评论这类）**按能力探测**再决定传不传，不靠版本号猜：
        //   旧协议端不认这个键（实测会让协议端起不来、页面显示「授权或启动失败」），
        //   新协议端（带 actions/reply.mjs 的纯 Node 发评论实现）才接受它。
        //   判据 = 设备上真的存在那个回退实现 + 用户真的打开了「评论」。两者缺一就不传。
        if(!r.enrollment && lastCtx!=null && supportsWriteActions(lastCtx) && userAllowsWrites(r)) input.put("allowAccountWrites", true);
        if(resolver!=null)input.put("androidResolver",resolver.name);
        if(saved!=null)input.put("savedCookie",saved);
        byte[] wire=input.toString().getBytes(StandardCharsets.UTF_8);
        try(OutputStream out=p.getOutputStream()){out.write(wire);}finally{Arrays.fill(wire,(byte)0);}
    }
    private static void launch(Context c,String bot,String binding,String peer,Run r) {
        String k=key(bot,binding); Process p=null; File hosts=null; BiliSystemResolver resolver=null; boolean restored=false, offered=false; String pending=null;
        try {
            BiliSessionStore store=BiliSessionStore.of(c);
            if(r.enrollment && InstalledRuntimeHost.core(c.getFilesDir(),bot)!=null)hosts=ManagedBiliHost.enrollmentHosts(c);
            synchronized(BiliProtocolControl.class) {
                if(!current(k,r))return;
                if(r.enrollment){r.self="";r.peer="";}else{JSONObject row=selection(c,bot,binding,peer);r.self=row.getString("accountId");r.peer=row.optString("peerId");}
                String saved=r.interactive?null:store.load(bot,binding,r.self);
                if (!r.interactive && saved==null) {r.state="reauth_required";return;}
                restored=saved!=null;
                File files=c.getFilesDir();String core=InstalledRuntimeHost.core(files,bot);ProcessBuilder builder;
                if(core!=null){try{builder=ManagedBiliHost.builder(c,bot,binding,core);if(r.enrollment){if(hosts==null)throw new IOException();List<String> args=builder.command();args.addAll(args.indexOf("-r"),Arrays.asList("-b",hosts.getCanonicalPath()+":/etc/hosts"));}}catch(Exception unavailable){r.state="runtime_missing";return;}}
                else {if(!ContainerService.isRunning()){r.state="container_required";return;}
                if(!new File(files,"rootfs/opt/whale/bili-protocol/src/platforms/bilibili/service.mjs").isFile() ||
                   !new File(files,"rootfs/opt/whale/bili-protocol-host.mjs").isFile()){r.state="runtime_missing";return;}
                builder=ContainerService.containerBuilder(files,"exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TZ=Asia/Shanghai node /opt/whale/bili-protocol-host.mjs");}
                byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);
                r.token=android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP|android.util.Base64.NO_PADDING|android.util.Base64.URL_SAFE);
                Arrays.fill(bytes,(byte)0);
                p=builder
                    .redirectErrorStream(false).redirectError(new File("/dev/null")).start();r.proc=p;
                if(core!=null&&!r.enrollment)resolver=new BiliSystemResolver();
                writeInput(p,r,saved,resolver);
            }
            try(InputStream in=new BufferedInputStream(p.getInputStream())) {
                String line;
                while((line=frame(in))!=null) {
                    JSONObject msg=new JSONObject(line); boolean notify=false;
                    synchronized(BiliProtocolControl.class) {
                        if(!current(k,r))return;
                        if(msg.has("type")) {
                            // Private, one-shot event, NEVER pass msg/line to status, UI, logs or HTTP.
                            if(r.enrollment){
                                if(!"enrolled_session".equals(msg.optString("type"))||!"awaiting_confirmation".equals(r.state)||!BiliSessionStore.validCookie(msg.optString("cookie")))throw new IOException();
                                final String uid=msg.getString("selfId"),cookie=msg.getString("cookie");
                                String problem=com.whaleonebot.ui.BotRegistry.enrollBili(bot,binding,r.newSlot,uid,new com.whaleonebot.ui.BotRegistry.NewSession(){
                                    public void save()throws Exception{if(store.present(bot,binding))throw new IOException();store.save(bot,binding,uid,cookie);}
                                    public void discard()throws Exception{store.forget(bot,binding);}
                                });r.state=problem==null?"enrolled":problem;r.challenge=null;return;
                            }
                            if(!"persist_session".equals(msg.optString("type"))||!r.interactive||offered||
                               !r.self.equals(msg.optString("selfId"))||!BiliSessionStore.validCookie(msg.optString("cookie")))throw new IOException();
                            offered=true; pending=msg.getString("cookie");
                        } else {
                            String state=msg.getString("state");r.challenge=null;
                            switch(state) {
                            case "awaiting_confirmation": {
                                String u=msg.getString("url"); long end=msg.getLong("expiresAt"),now=System.currentTimeMillis();
                                if(!r.interactive || !(u.startsWith("https://passport.bilibili.com/h5-app/passport/login/scan?")||u.startsWith("https://account.bilibili.com/h5/account-h5/auth/scan-web?")) || u.length()>512||end<=now||end>now+185000)throw new IOException();
                                r.challenge=u;r.expiresAt=end;break;
                            }
                            case "verified": {
                                if(!r.self.equals(msg.optString("selfId")))throw new IOException();
                                int port=msg.getInt("port");if(port<1024||port>65535)throw new IOException();
                                notify=!"verified".equals(r.state);r.port=port;r.received=Math.max(0,msg.optInt("received"));r.lastReceived=msg.optLong("lastReceived");break;
                            }
                            case "disconnected": break;
                            case "reauth_required": case "identity_mismatch":
                                // Only a definitive refusal of this restored credential invalidates its copy.
                                if(restored)store.forget(bot,binding);
                                r.state="reauth_required";return;
                            case "session_unconfirmed": case "authorization_required": case "authorization_failed": case "expired":
                            case "stopped": case "failed": case "invalid_configuration": r.state=state;return;
                            default: throw new IOException();
                            }
                            r.state=state;r.at=android.os.SystemClock.elapsedRealtime();
                            // 端口与令牌只有这里知道 ⇒ 已验证就把它们交给容器里的行为 worker。
                            // 不做这件事，行为层永远连不上协议端（它自己猜不出随机端口和令牌）。
                            if("verified".equals(state)&&r.port>=1024)com.whaleonebot.ui.BiliRuntime.publishProtocol(c,bot,r.self,r.port,r.token);
                        }
                        // The child's own identity check AND a verified state with the same expected UID.
                        if(pending!=null && "verified".equals(r.state)) {
                            if(!r.self.equals(selection(c,bot,binding,peer).getString("accountId")))throw new IOException();
                            store.save(bot,binding,r.self,pending);restored=true;pending=null;
                        }
                    }
                    // BindingControl acquires our lock to take a lease: never reverse that lock order.
                    if(notify)ContainerService.onProtocolVerified(c,bot,binding);
                }
            }
        } catch(Exception ignored) {
            // Keystore unavailable, bad envelope, malformed IPC, network/IO failure: preserve the old copy.
            synchronized(BiliProtocolControl.class){if(current(k,r))r.state="authorization_failed";}
        } finally {
            if(resolver!=null)resolver.close();
            if(hosts!=null)hosts.delete();
            synchronized(BiliProtocolControl.class){if(p!=null&&p.isAlive())p.destroy();r.token=null;r.challenge=null;
                if(Arrays.asList("starting","awaiting_confirmation","verified","disconnected").contains(r.state))r.state="failed";}
        }
    }
    static boolean owned(JSONObject row){return "bilibili".equals(row.optString("platform"))&&row.optString("accountId").matches("[1-9][0-9]{0,15}")&&row.optString("httpUrl").isEmpty()&&row.optString("wsUrl").isEmpty();}
    private static void halt(Run r){if(r!=null){r.state="stopped";r.token=null;r.challenge=null;if(r.proc!=null)r.proc.destroy();}}
    /** 停掉的 Run 的端口/令牌已经没用了：把端点文件抹掉，免得行为 worker 一直往死端口上撞。 */
    private static void forgetEndpoint(String bot){try{if(lastCtx!=null)com.whaleonebot.ui.BiliRuntime.clearProtocol(lastCtx,bot);}catch(Exception ignored){}}
    static synchronized void stop(String bot,String binding){halt(runs.get(key(bot,binding)));forgetEndpoint(bot);}
    static synchronized void stopBotAccounts(String bot){String prefix=key(bot,"scope");prefix=prefix.substring(0,prefix.indexOf(':')+1);for(Map.Entry<String,Run> e:runs.entrySet())if(e.getKey().startsWith(prefix))halt(e.getValue());forgetEndpoint(bot);}
    static synchronized void stopAll(){for(Run r:runs.values())halt(r);}
    static synchronized boolean hasSaved(Context c,String bot,String binding){try{return BiliSessionStore.of(c).present(bot,binding);}catch(Exception ignored){return false;}}
    static synchronized boolean forget(Context c,String bot,String binding){try{stop(bot,binding);BiliSessionStore.of(c).forget(bot,binding);return true;}catch(Exception ignored){return false;}}
    private static boolean live(Run r){return r!=null&&"verified".equals(r.state)&&r.proc!=null&&r.proc.isAlive()&&android.os.SystemClock.elapsedRealtime()-r.at<15000&&r.token!=null;}
    static synchronized String lease(String bot,JSONObject row,JSONObject projected)throws Exception{Run r=runs.get(key(bot,row.getString("id")));if(!live(r)||!r.self.equals(row.optString("accountId"))||!r.peer.equals(row.optString("peerId")))return null;projected.put("httpUrl","http://127.0.0.1:"+r.port).put("wsUrl","ws://127.0.0.1:"+r.port);return r.token;}
    static synchronized String authorizationLink(String bot,String binding){Run r=runs.get(key(bot,binding));return r!=null&&"awaiting_confirmation".equals(r.state)&&r.proc!=null&&r.proc.isAlive()&&System.currentTimeMillis()<r.expiresAt&&r.challenge!=null?r.challenge:"";}
    static synchronized JSONObject status(String bot,String binding){JSONObject out=new JSONObject();try{Run r=runs.get(key(bot,binding));boolean ok=live(r);String state=r==null?"stopped":r.state;if("awaiting_confirmation".equals(state)){if(System.currentTimeMillis()>=r.expiresAt)state="expired";else if(r.proc==null||!r.proc.isAlive())state="failed";}if(!ok&&"verified".equals(state))state="disconnected";out.put("state",state);if(r!=null)out.put("received",r.received).put("lastReceived",r.lastReceived);if(ok)out.put("selfId",r.self).put("httpUrl","http://127.0.0.1:"+r.port).put("wsUrl","ws://127.0.0.1:"+r.port);}catch(Exception ignored){}return out;}
}
