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
    private static final Map<String,List<Long>> retryWindows = new HashMap<>();
    private static final ArrayDeque<String> blackbox = new ArrayDeque<>();
    /** 只为「停掉之后抹掉端点文件」留一份 application context（不涉及任何凭据）。 */
    private static Context lastCtx;
    private static final class Run {
        final boolean interactive; boolean enrollment,newSlot;
        String state="starting", self, peer, token, challenge, lastError="";
        // 这次 Run 属于哪个机器人/槽位：写动作开关要按「这个槽位的行为配置」决定。
        String botId, bindingId;
        int port, received; Process proc; long at, expiresAt, lastReceived;
        Run(boolean interactive) { this.interactive=interactive; }
    }
    private static synchronized void recordEvent(String k, String msg) {
        String line = new java.text.SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date())
                + " [" + k + "] " + msg;
        blackbox.addLast(line);
        while (blackbox.size() > 80) blackbox.removeFirst();
    }
    static synchronized String blackboxLog(int maxLines) {
        if (blackbox.isEmpty()) return "（暂无 B 站黑匣子记录，发生登录、续期、退避重连或异常时会自动记入）";
        StringBuilder sb = new StringBuilder();
        int skip = Math.max(0, blackbox.size() - Math.max(1, maxLines));
        int idx = 0;
        for (String line : blackbox) {
            if (idx++ >= skip) sb.append(line).append('\n');
        }
        return sb.toString();
    }
    private static String key(String bot,String binding) {
        if(bot==null || binding==null || !bot.matches("[A-Za-z0-9_-]{1,64}") || !binding.matches("[A-Za-z0-9_-]{1,64}"))
            throw new IllegalArgumentException("Invalid ID");
        return bot+":"+binding;
    }
    /** Resume only. A missing session never spawns a child. No QR fallback or retry loop. */
    static synchronized void start(Context ctx,String bot,String binding,String peer) { begin(ctx,bot,binding,peer,false); }
    /** 独立热重启 B 站协议端（不影响 QQ 与其他平台）。 */
    static void restart(Context ctx,String bot,String binding,String peer) {
        if(ctx==null)return;
        final Context app=ctx.getApplicationContext();
        final String k=key(bot,binding);
        recordEvent(k,"manual_restart");
        new Thread(()->{
            stop(bot,binding);
            try{Thread.sleep(450L);}catch(InterruptedException ignored){}
            start(app,bot,binding,peer==null?"":peer);
        },"bili-restart").start();
    }
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

    private static void writeInput(Process p,Run r,String saved,JSONObject refreshMeta,BiliSystemResolver resolver) throws Exception {
        JSONObject input=r.enrollment?new JSONObject().put("enroll",true).put("interactive",true):new JSONObject().put("selfId",r.self).put("peerId",r.peer.isEmpty()?JSONObject.NULL:r.peer)
            .put("token",r.token).put("interactive",r.interactive);
        // ★ 写动作（发评论这类）**按能力探测**再决定传不传，不靠版本号猜：
        //   旧协议端不认这个键（实测会让协议端起不来、页面显示「授权或启动失败」），
        //   新协议端（带 actions/reply.mjs 的纯 Node 发评论实现）才接受它。
        //   判据 = 设备上真的存在那个回退实现 + 用户真的打开了「评论」。两者缺一就不传。
        if(!r.enrollment && lastCtx!=null && supportsWriteActions(lastCtx) && userAllowsWrites(r)) input.put("allowAccountWrites", true);
        // 私信对端没配、但填了「管理员 UID」时，就用管理员当私信对端 —— 否则协议端读/回私信
        // 都要求这个 peer（实测：不配 peer 时 bili_dm_sessions 直接 1400）。
        if(!r.enrollment && r.peer.isEmpty() && lastCtx!=null && r.botId!=null && r.bindingId!=null){
            try{
                String admin=com.whaleonebot.ui.BiliSettings.getString(
                    com.whaleonebot.ui.BiliSettings.get(lastCtx,r.botId,r.bindingId),"admin.uid","").trim();
                if(admin.matches("[1-9][0-9]{3,19}")) input.put("peerId",admin);
            }catch(Exception ignored){}
        }
        if(resolver!=null)input.put("androidResolver",resolver.name);
        if(saved!=null)input.put("savedCookie",saved);
        if(refreshMeta!=null)input.put("refreshMeta",refreshMeta);
        byte[] wire=input.toString().getBytes(StandardCharsets.UTF_8);
        try(OutputStream out=p.getOutputStream()){out.write(wire);}finally{Arrays.fill(wire,(byte)0);}
    }
    private static void launch(Context c,String bot,String binding,String peer,Run r) {
        String k=key(bot,binding); Process p=null; File hosts=null; BiliSystemResolver resolver=null; boolean restored=false, offered=false; String pending=null; JSONObject pendingMeta=null;
        try {
            BiliSessionStore store=BiliSessionStore.of(c);
            BiliRefreshStore refreshStore=BiliRefreshStore.of(c);
            if(r.enrollment && InstalledRuntimeHost.core(c.getFilesDir(),bot)!=null)hosts=ManagedBiliHost.enrollmentHosts(c);
            synchronized(BiliProtocolControl.class) {
                if(!current(k,r))return;
                if(r.enrollment){r.self="";r.peer="";}else{JSONObject row=selection(c,bot,binding,peer);r.self=row.getString("accountId");r.peer=row.optString("peerId");}
                String saved=r.interactive?null:store.load(bot,binding,r.self);
                JSONObject refreshMeta=r.interactive?null:refreshStore.load(bot,binding,r.self);
                if (!r.interactive && saved==null) {r.state="reauth_required";recordEvent(k,"missing_saved_session");return;}
                restored=saved!=null;
                File files=c.getFilesDir();String core=InstalledRuntimeHost.core(files,bot);ProcessBuilder builder;
                if(core!=null){try{builder=ManagedBiliHost.builder(c,bot,binding,core);if(r.enrollment){if(hosts==null)throw new IOException();List<String> args=builder.command();args.addAll(args.indexOf("-r"),Arrays.asList("-b",hosts.getCanonicalPath()+":/etc/hosts"));}}catch(Exception unavailable){r.state="runtime_missing";recordEvent(k,"runtime_missing");return;}}
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
                writeInput(p,r,saved,refreshMeta,resolver);
                recordEvent(k, r.enrollment?"launch_enroll":(r.interactive?"launch_interactive":"launch_resume"));
            }
            try(InputStream in=new BufferedInputStream(p.getInputStream())) {
                String line;
                while((line=frame(in))!=null) {
                    JSONObject msg=new JSONObject(line); boolean notify=false; boolean notifyReauth=false;
                    synchronized(BiliProtocolControl.class) {
                        if(!current(k,r))return;
                        if(msg.has("type")) {
                            // Private, one-shot event, NEVER pass msg/line to status, UI, logs or HTTP.
                            if(r.enrollment){
                                if(!"enrolled_session".equals(msg.optString("type"))||!"awaiting_confirmation".equals(r.state)||!BiliSessionStore.validCookie(msg.optString("cookie")))throw new IOException();
                                final String uid=msg.getString("selfId"),cookie=msg.getString("cookie");
                                final JSONObject eMeta=msg.optJSONObject("meta");
                                String problem=com.whaleonebot.ui.BotRegistry.enrollBili(bot,binding,r.newSlot,uid,new com.whaleonebot.ui.BotRegistry.NewSession(){
                                    public void save()throws Exception{if(store.present(bot,binding))throw new IOException();store.save(bot,binding,uid,cookie);if(eMeta!=null)refreshStore.save(bot,binding,uid,eMeta);}
                                    public void discard()throws Exception{store.forget(bot,binding);refreshStore.forget(bot,binding);}
                                });r.state=problem==null?"enrolled":problem;r.challenge=null;recordEvent(k,"enroll_done state="+r.state);return;
                            }
                            if("refresh_meta".equals(msg.optString("type"))){
                                if(r.self!=null && r.self.equals(msg.optString("selfId"))){
                                    JSONObject rm=msg.optJSONObject("meta");
                                    if(rm!=null){
                                        if(r.interactive && !restored) pendingMeta=rm;
                                        else refreshStore.save(bot,binding,r.self,rm);
                                        recordEvent(k,"refresh_meta_saved");
                                    }
                                }
                                continue;
                            }
                            if(!"persist_session".equals(msg.optString("type"))||(!r.interactive && !restored)||
                               !r.self.equals(msg.optString("selfId"))||!BiliSessionStore.validCookie(msg.optString("cookie")))throw new IOException();
                            if(r.interactive && !restored){
                                if(offered)throw new IOException();
                                offered=true; pending=msg.getString("cookie");
                            }else{
                                // 自动续期回写的最新 Cookie：立即加密替换主会话密文
                                store.save(bot,binding,r.self,msg.getString("cookie"));
                                recordEvent(k,"cookie_auto_refreshed");
                            }
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
                                notify=!"verified".equals(r.state);r.port=port;r.received=Math.max(0,msg.optInt("received"));r.lastReceived=msg.optLong("lastReceived");r.lastError="";
                                if(notify){retryWindows.remove(k);recordEvent(k,"verified port="+port);}
                                break;
                            }
                            case "disconnected": break;
                            case "reauth_required": case "identity_mismatch":
                                // ★ 2026-11-28 问答 Q18 拍板：任何情况绝不自动删除绑定槽位、配置或旧密文，仅标为需重登并高优告警！
                                r.state="reauth_required";r.lastError="B 站会话已确认失效（-101/账号不匹配），请重新授权";
                                recordEvent(k,"reauth_required_preserved_slot");
                                notifyReauth=true;
                                break;
                            case "session_unconfirmed": case "authorization_required": case "authorization_failed": case "expired":
                            case "stopped": case "failed": case "invalid_configuration":
                                r.state=state;r.lastError=state;recordEvent(k,"terminal_state="+state);return;
                            default: throw new IOException();
                            }
                            r.state=state;r.at=android.os.SystemClock.elapsedRealtime();
                            if(notifyReauth){
                                ContainerService.postPlatformAlertNotification(c,"bilibili",
                                        "B 站账号需要重新授权（UID "+r.self+"）",
                                        "检测到 B 站登录态已过期，原有配置与绑定槽位已完整保留，点击前往重新扫码或网页登录。",null);
                                return;
                            }
                            if("verified".equals(state)&&r.port>=1024){
                                com.whaleonebot.ui.BiliRuntime.publishProtocol(c,bot,r.self,r.port,r.token);
                                if(notify){try{com.whaleonebot.ui.BiliRuntime.publish(c,bot,binding);}catch(Exception ignored){}}
                            }
                        }
                        if(pending!=null && "verified".equals(r.state)) {
                            if(!r.self.equals(selection(c,bot,binding,peer).getString("accountId")))throw new IOException();
                            store.save(bot,binding,r.self,pending);
                            if(pendingMeta!=null){refreshStore.save(bot,binding,r.self,pendingMeta);pendingMeta=null;}
                            restored=true;pending=null;
                        }
                    }
                    if(notify)ContainerService.onProtocolVerified(c,bot,binding);
                }
            }
        } catch(Exception ignored) {
            synchronized(BiliProtocolControl.class){if(current(k,r)){r.state="authorization_failed";r.lastError="异常退出";recordEvent(k,"exception_authorization_failed");}}
        } finally {
            if(resolver!=null)resolver.close();
            if(hosts!=null)hosts.delete();
            boolean scheduleRetry=false; long retryDelayMs=0L;
            synchronized(BiliProtocolControl.class){if(p!=null&&p.isAlive())p.destroy();r.token=null;r.challenge=null;
                if(Arrays.asList("starting","awaiting_confirmation","verified","disconnected").contains(r.state))r.state="failed";
                // 非 -101 / 非手动停止 / 非交互式授权 / 非配置无效，且确有已保存凭证时走指数退避自愈重连（5s→15s→30s→60s，每小时上限 6 次）
                if(current(k,r) && !r.enrollment && !r.interactive && restored
                        && Arrays.asList("session_unconfirmed","failed","disconnected","authorization_failed").contains(r.state)){
                    long now=System.currentTimeMillis();
                    List<Long> hist=retryWindows.computeIfAbsent(k,x->new ArrayList<>());
                    hist.removeIf(ts->now-ts>3600_000L);
                    if(hist.size()<6){
                        long[] delays={5000L,15000L,30000L,60000L,60000L,60000L};
                        retryDelayMs=delays[Math.min(hist.size(),delays.length-1)];
                        hist.add(now);
                        scheduleRetry=true;
                        recordEvent(k,"auto_backoff_scheduled delayMs="+retryDelayMs+" attempt="+hist.size());
                    }else{
                        recordEvent(k,"auto_backoff_exhausted");
                        ContainerService.postPlatformAlertNotification(c,"bilibili",
                                "B 站账号自动重连受限（UID "+r.self+"）",
                                "网络或风控导致 B 站持续断连（本小时已重试 6 次），请检查网络后手动点击快速登录。",null);
                    }
                }
            }
            if(scheduleRetry){
                final long delay=retryDelayMs; final Context app=c.getApplicationContext(); final String peerCopy=peer==null?"":peer;
                Thread rt=new Thread(()->{
                    try{Thread.sleep(delay);}catch(InterruptedException e){return;}
                    synchronized(BiliProtocolControl.class){if(!current(k,r))return;}
                    try{if(selection(app,bot,binding,peerCopy)!=null)start(app,bot,binding,peerCopy);}catch(Exception ignored){}
                },"bili-backoff");
                rt.setDaemon(true);rt.start();
            }
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
    static synchronized boolean forget(Context c,String bot,String binding){try{stop(bot,binding);BiliSessionStore.of(c).forget(bot,binding);BiliRefreshStore.of(c).forget(bot,binding);retryWindows.remove(key(bot,binding));recordEvent(key(bot,binding),"manual_forget");return true;}catch(Exception ignored){return false;}}
    private static boolean live(Run r){return r!=null&&"verified".equals(r.state)&&r.proc!=null&&r.proc.isAlive()&&r.token!=null;}
    static synchronized long sinceLastMessage(String bot,String binding){Run r=runs.get(key(bot,binding));return r==null?0L:r.lastReceived;}
    static synchronized String lease(String bot,JSONObject row,JSONObject projected)throws Exception{Run r=runs.get(key(bot,row.getString("id")));if(!live(r)||!r.self.equals(row.optString("accountId"))||!r.peer.equals(row.optString("peerId")))return null;projected.put("httpUrl","http://127.0.0.1:"+r.port).put("wsUrl","ws://127.0.0.1:"+r.port);return r.token;}
    static synchronized String authorizationLink(String bot,String binding){Run r=runs.get(key(bot,binding));return r!=null&&"awaiting_confirmation".equals(r.state)&&r.proc!=null&&r.proc.isAlive()&&System.currentTimeMillis()<r.expiresAt&&r.challenge!=null?r.challenge:"";}
    static synchronized JSONObject status(String bot,String binding){
        JSONObject out=new JSONObject();
        try{
            Run r=runs.get(key(bot,binding));
            boolean ok=live(r);
            String state=r==null?"stopped":r.state;
            if("awaiting_confirmation".equals(state)){
                if(System.currentTimeMillis()>=r.expiresAt)state="expired";
                else if(r.proc==null||!r.proc.isAlive())state="failed";
            }
            if(!ok&&"verified".equals(state))state="disconnected";
            out.put("state",state);
            if(r!=null){
                out.put("received",r.received).put("lastReceived",r.lastReceived);
                if(r.lastError!=null&&!r.lastError.isEmpty())out.put("lastError",r.lastError);
            }
            if(ok)out.put("selfId",r.self).put("httpUrl","http://127.0.0.1:"+r.port).put("wsUrl","http://127.0.0.1:"+r.port);
            if(lastCtx!=null&&r!=null&&r.self!=null&&!r.self.isEmpty()){
                out.put("refreshSummary",BiliRefreshStore.shortStatus(lastCtx,bot,binding,r.self));
            }
        }catch(Exception ignored){}
        return out;
    }

    /**
     * 安全导入完整 Cookie（来自官网 WebView 登录或手动粘贴）：
     * 立即联网 /nav 验真 UID 并补全 buvid3/4 指纹，加密存入 BiliSessionStore 与 BiliRefreshStore 后自动启动。
     */
    static JSONObject importManualSession(Context ctx, String bot, String binding, String expectedUid,
                                          boolean newSlot, String rawCookie, String acTimeValue) {
        JSONObject res = new JSONObject();
        try {
            if (ctx == null || rawCookie == null || rawCookie.trim().isEmpty()) {
                return res.put("ok", false).put("error", "Cookie 不能为空");
            }
            Map<String, String> parsed = new LinkedHashMap<>();
            for (String part : rawCookie.replace('\n', ';').replace('\r', ';').split(";")) {
                String p = part.trim();
                int eq = p.indexOf('=');
                if (eq > 0) {
                    String k = p.substring(0, eq).trim();
                    String v = p.substring(eq + 1).trim();
                    if (!k.isEmpty() && !v.isEmpty()) parsed.put(k, v);
                }
            }
            String sess = parsed.get("SESSDATA");
            String csrf = parsed.get("bili_jct");
            if (sess == null || sess.isEmpty() || csrf == null || csrf.isEmpty()) {
                return res.put("ok", false).put("error", "Cookie 缺少 SESSDATA 或 bili_jct 核心字段");
            }
            String minCookie = "SESSDATA=" + sess + "; bili_jct=" + csrf;
            if (!BiliSessionStore.validCookie(minCookie)) {
                return res.put("ok", false).put("error", "SESSDATA 或 bili_jct 包含非法字符或长度超限");
            }
            String sendCookie = minCookie;
            if (parsed.containsKey("buvid3")) sendCookie += "; buvid3=" + parsed.get("buvid3");
            if (parsed.containsKey("buvid4")) sendCookie += "; buvid4=" + parsed.get("buvid4");

            JSONObject nav = biliGetJson("https://api.bilibili.com/x/web-interface/nav", sendCookie);
            if (nav == null || nav.optInt("code", -1) != 0) {
                return res.put("ok", false).put("error", "B 站接口校验未通过（code=" + (nav == null ? -1 : nav.optInt("code", -1)) + "）");
            }
            JSONObject data = nav.optJSONObject("data");
            if (data == null || !data.optBoolean("isLogin", false)) {
                return res.put("ok", false).put("error", "Cookie 已失效或未登录（isLogin=false）");
            }
            String uid = String.valueOf(data.optLong("mid", 0L));
            String uname = data.optString("uname", "").trim();
            if (!uid.matches("[1-9][0-9]{0,15}")) {
                return res.put("ok", false).put("error", "无法识别有效的 B 站 UID");
            }
            if (expectedUid != null && !expectedUid.trim().isEmpty() && !expectedUid.trim().equals(uid)) {
                return res.put("ok", false).put("error", "该 Cookie 属于 UID " + uid + "（" + uname + "），与当前绑定 UID " + expectedUid + " 不一致");
            }

            String buvid3 = parsed.getOrDefault("buvid3", "");
            String buvid4 = parsed.getOrDefault("buvid4", "");
            if (buvid3.isEmpty() || buvid4.isEmpty()) {
                JSONObject spi = biliGetJson("https://api.bilibili.com/x/frontend/finger/spi", sendCookie);
                JSONObject spiData = spi == null ? null : spi.optJSONObject("data");
                if (spiData != null) {
                    if (buvid3.isEmpty()) buvid3 = spiData.optString("b_3", "").trim();
                    if (buvid4.isEmpty()) buvid4 = spiData.optString("b_4", "").trim();
                }
            }
            String refTok = (acTimeValue != null && !acTimeValue.trim().isEmpty())
                    ? acTimeValue.trim()
                    : parsed.getOrDefault("ac_time_value", "");

            BiliSessionStore store = BiliSessionStore.of(ctx);
            BiliRefreshStore rstore = BiliRefreshStore.of(ctx);
            JSONObject meta = new JSONObject();
            if (!refTok.isEmpty()) meta.put("refreshToken", refTok);
            if (!buvid3.isEmpty()) meta.put("buvid3", buvid3);
            if (!buvid4.isEmpty()) meta.put("buvid4", buvid4);

            if (expectedUid == null || expectedUid.trim().isEmpty()) {
                String problem = com.whaleonebot.ui.BotRegistry.enrollBili(bot, binding, newSlot, uid, new com.whaleonebot.ui.BotRegistry.NewSession() {
                    public void save() throws Exception {
                        store.save(bot, binding, uid, minCookie);
                        if (meta.length() > 0) rstore.save(bot, binding, uid, meta);
                    }
                    public void discard() throws Exception {
                        store.forget(bot, binding);
                        rstore.forget(bot, binding);
                    }
                });
                if (problem != null) {
                    return res.put("ok", false).put("error", "绑定入库失败：" + problem);
                }
            } else {
                store.save(bot, binding, uid, minCookie);
                if (meta.length() > 0) rstore.save(bot, binding, uid, meta);
            }
            String k = key(bot, binding);
            retryWindows.remove(k);
            recordEvent(k, "manual_import_ok uid=" + uid + " hasRef=" + !refTok.isEmpty());
            return res.put("ok", true).put("uid", uid).put("uname", uname).put("hasRefresh", !refTok.isEmpty());
        } catch (Exception ex) {
            try { return res.put("ok", false).put("error", ex.getMessage() == null ? "导入失败" : ex.getMessage()); }
            catch (JSONException ignored) { return res; }
        }
    }

    private static JSONObject biliGetJson(String urlStr, String cookie) {
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL(urlStr);
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Referer", "https://www.bilibili.com/");
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0 && bos.size() < 262144) bos.write(buf, 0, n);
                return new JSONObject(new String(bos.toByteArray(), StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
