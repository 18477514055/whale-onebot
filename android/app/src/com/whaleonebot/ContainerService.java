package com.whaleonebot;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 前台服务：把 Debian rootfs 用 proot 跑起来。
 * 旧环境仅可原地使用；新实例使用独立、已验证的公共环境。
 */
public class ContainerService extends Service {

    public static final String ACTION_START = "com.whaleonebot.START";
    public static final String ACTION_STOP = "com.whaleonebot.STOP";
    public static final String ACTION_LOGIN = "com.whaleonebot.LOGIN";
    public static final String ACTION_REFRESH_QR = "com.whaleonebot.REFRESH_QR";
    /** 起真正的机器人（driver + 原生桥 + OneBot + agent）。与「登录」分开，登录只为拿二维码。 */
    public static final String ACTION_BOT = "com.whaleonebot.BOT";
    private static final String CHANNEL = "whale-container";
    private static final String ALERT_CHANNEL = "whale-qq-alert";
    private static final int ALERT_NOTIFY_ID = 2027;

    private static volatile boolean running = false;
    private static volatile Process proc = null;
    private static volatile long containerPid = -1;
    /** 容器里正在跑的登录进程（已合流至 container-bot.mjs，保留字段防旧调用崩）。 */
    private static volatile Process loginProc = null;
    /** 容器里正在跑的机器人进程（同上，必须持有）。 */
    private static volatile Process botProc = null;
    /** 网络切换监听与防抖（Wi-Fi ↔ 流量恢复后自动温和唤醒，绝不杀进程）。 */
    private android.net.ConnectivityManager.NetworkCallback netCallback = null;
    private volatile long lastNetWakeAt = 0L;
    private volatile String lastAlertSignature = "";
    private Thread alertWatcher;
    /** 容器就绪后自动拉起机器人，只拉一次。 */
    private static volatile boolean autoBotStarted = false;
    /** 用户明确要求停止（此时意外退出不再自动重启）。 */
    private static volatile boolean botStopRequested = false;
    /** 自动重启计数（防止无限重启打转）。 */
    private static volatile int botRestarts = 0;
    /** 最近一次自动重启的时刻，用于「隔久了就归零」的时间窗口。 */
    private static volatile long lastBotRestartAt = 0;
    private static PrintWriter logw = null;
    /** 日志文件（每次追加都重开，避免持有已关闭的 writer 导致整段日志悄悄丢失）。 */
    private static volatile File logFile = null;
    private PowerManager.WakeLock wakeLock = null;
    private WifiManager.WifiLock wifiLock = null;
    private Thread worker;
    private HttpStatusServer http;

    public static boolean isRunning() { return running; }
    public static long containerPid() { return containerPid; }

    public static void start(Context c) {
        Intent i = new Intent(c, ContainerService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    public static void stop(Context c) {
        c.startService(new Intent(c, ContainerService.class).setAction(ACTION_STOP));
    }

    /** 按需向单进程 container-bot.mjs 下发一次受控指令（优先毫秒级回环控制口，不可达回退原子写 cmd.json，绝不印密码）。 */
    public static boolean sendBotCommand(Context c, org.json.JSONObject cmd) {
        if (c == null || cmd == null) return false;
        try {
            File files = new File("/data/data/" + c.getPackageName() + "/files");
            if (!files.isDirectory()) files = c.getFilesDir();
            final File qq = new File(files, "rootfs/opt/whale/qq-state");
            if (!qq.isDirectory()) qq.mkdirs();
            final String payload = cmd.toString();
            final File ctlFile = new File(qq, ".ctl.json");
            if (ctlFile.isFile() && ctlFile.length() > 0 && ctlFile.length() < 4096) {
                boolean onMain = android.os.Looper.myLooper() == android.os.Looper.getMainLooper();
                if (onMain) {
                    Thread t = new Thread(() -> {
                        if (!postLocalControl(ctlFile, payload)) {
                            writeCmdJsonFallback(qq, payload);
                        }
                    }, "whale-ctl-cmd");
                    t.setDaemon(true);
                    t.start();
                    return true;
                }
                if (postLocalControl(ctlFile, payload)) {
                    return true;
                }
            }
            return writeCmdJsonFallback(qq, payload);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean postLocalControl(File ctlFile, String payload) {
        java.net.HttpURLConnection conn = null;
        try {
            byte[] raw = java.nio.file.Files.readAllBytes(ctlFile.toPath());
            org.json.JSONObject ctl = new org.json.JSONObject(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
            int port = ctl.optInt("port", 0);
            String token = ctl.optString("token", "");
            if (port <= 0 || port > 65535 || token.isEmpty()) return false;
            java.net.URL url = new java.net.URL("http://127.0.0.1:" + port + "/cmd");
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(800);
            conn.setReadTimeout(1800);
            conn.setDoOutput(true);
            byte[] body = payload.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(body.length);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body);
            }
            return conn.getResponseCode() == 200;
        } catch (Throwable ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static boolean writeCmdJsonFallback(File qq, String payload) {
        try {
            File tmp = new File(qq, "cmd.json.next");
            File dst = new File(qq, "cmd.json");
            byte[] bytes = payload.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            try (FileOutputStream os = new FileOutputStream(tmp)) {
                os.write(bytes);
                os.getFD().sync();
            }
            tmp.setReadable(false, false);
            tmp.setReadable(true, true);
            tmp.setWritable(false, false);
            tmp.setWritable(true, true);
            if (!tmp.renameTo(dst)) {
                dst.delete();
                if (!tmp.renameTo(dst)) { tmp.delete(); return false; }
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 读取本机最新 bot.json 原文（供统一状态真源 QqAuthState 解析）。 */
    public static String readBotStateJson(File files) {
        if (files == null) return "";
        File f = new File(files, "rootfs/opt/whale/qq-state/bot.json");
        if (!f.isFile() || f.length() <= 0 || f.length() > 262144) return "";
        try {
            return new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Throwable ignored) {
            return "";
        }
    }

    /** 读取本机最新一次性 qr.url（68 字节，用于一键拉起手机 QQ 或远程同步；绝不打日志）。 */
    public static String readQrUrl(File files) {
        if (files == null) return "";
        File f = new File(files, "rootfs/opt/whale/qq-state/qr.url");
        if (!f.isFile() || f.length() <= 0 || f.length() > 1024) return "";
        try {
            String s = new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8).trim();
            return com.whaleonebot.ui.QqAuthState.isSafeHttpsTencentUrl(s) ? s : "";
        } catch (Throwable ignored) {
            return "";
        }
    }

    /** 弹出高优先级系统通知（本地或远端设备掉线共用，点通知直达对应平台/QQ 上线页）。 */
    public static void postOfflineNotification(Context ctx, String title, String message, String peerId) {
        postPlatformAlertNotification(ctx, "qq", title, message, peerId);
    }

    /** 三平台（QQ / B 站 / 抖音）统一高优先级离线/过期告警通知。 */
    public static void postPlatformAlertNotification(Context ctx, String platform, String title, String message, String peerId) {
        if (ctx == null) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(
                        ALERT_CHANNEL, "多平台离线与安全提醒", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("QQ、B 站或抖音机器人掉线、Cookie 过期或需要安全验证时立即提醒");
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(ctx, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            String plat = (platform == null || platform.isEmpty()) ? "qq" : platform;
            open.putExtra("open_qq_login", "qq".equals(plat));
            open.putExtra("open_platform_health", !"qq".equals(plat));
            open.putExtra("open_platform", plat);
            if (peerId != null && !peerId.isEmpty()) open.putExtra("open_remote_peer", peerId);
            int reqCode = 2027 + Math.abs(plat.hashCode() % 50) + (peerId == null ? 0 : Math.abs(peerId.hashCode() % 50));
            int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
            android.app.PendingIntent pi = android.app.PendingIntent.getActivity(ctx, reqCode, open, flags);
            Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                    ? new Notification.Builder(ctx, ALERT_CHANNEL)
                    : new Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH);
            Notification n = b.setContentTitle(title == null ? "机器人账号需要重新上线" : title)
                    .setContentText(message == null ? "点击查看原因并一键恢复在线" : message)
                    .setStyle(new Notification.BigTextStyle().bigText(message == null ? "" : message))
                    .setSmallIcon(android.R.drawable.stat_sys_warning)
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .build();
            nm.notify(ALERT_NOTIFY_ID + Math.abs((plat + "|" + (peerId == null ? "" : peerId)).hashCode() % 200), n);
        } catch (Throwable ignored) {}
    }

    /** 在容器里按需请求 1 张二维码（单进程合流：不再另起 container-login.mjs 抢 login.db）。 */
    public static void startLogin(Context c) {
        Intent i = new Intent(c, ContainerService.class).setAction(ACTION_LOGIN);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    /** 让登录进程换一张新二维码。 */
    public static void refreshQr(Context c) {
        c.startService(new Intent(c, ContainerService.class).setAction(ACTION_REFRESH_QR));
    }

    /** 起机器人（幂等：已在跑就什么也不做）。 */
    public static void startBot(Context c) {
        Intent i = new Intent(c, ContainerService.class).setAction(ACTION_BOT);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    public static Runnable enrollBiliAccount(Context c,String bot,String slot,boolean fresh){return BiliProtocolControl.enroll(c,bot,slot,fresh);}
    public static void startBiliProtocol(Context c,String bot,String binding,String peer){BiliProtocolControl.start(c,bot,binding,peer);}
    public static void restartBiliProtocol(Context c,String bot,String binding,String peer){BiliProtocolControl.restart(c,bot,binding,peer);}
    public static void stopBiliProtocol(String bot,String binding){BiliProtocolControl.stop(bot,binding);}
    public static org.json.JSONObject biliProtocolStatus(String bot,String binding){return BiliProtocolControl.status(bot,binding);}
    public static boolean hasBiliSession(Context c,String bot,String binding){return BiliProtocolControl.hasSaved(c,bot,binding);}
    public static boolean forgetBiliSession(Context c,String bot,String binding){return BiliProtocolControl.forget(c,bot,binding);}
    public static void reauthorizeBiliProtocol(Context c,String bot,String binding,String peer){BiliProtocolControl.reauthorize(c,bot,binding,peer);}
    public static String biliAuthorizationLink(String bot,String binding){return BiliProtocolControl.authorizationLink(bot,binding);}
    public static String biliBlackboxLog(int lines){return BiliProtocolControl.blackboxLog(lines);}
    public static org.json.JSONObject importBiliCookie(Context c,String bot,String binding,String expectedUid,boolean newSlot,String rawCookie,String acTimeValue){return BiliProtocolControl.importManualSession(c,bot,binding,expectedUid,newSlot,rawCookie,acTimeValue);}
    public static void setBindingToken(Context c,String bot,String binding,String token){ BindingControl.token(c,bot,binding,token); }
    public static void startBoundBot(Context c,String bot){SavedBindingStartup.onStart(c,bot); queueBoundBot(c,bot);}
    static void queueBoundBot(Context c,String bot){
        if(InstalledRuntimeHost.core(c.getFilesDir(),bot)!=null){dispatchBoundStart(c,bot,InstalledRuntimeHost.request(c.getFilesDir(),bot,true));return;}
        dispatchBoundStart(c,bot,BindingControl.queue(bot));
    }
    static void onProtocolVerified(Context c,String bot,String binding){if(InstalledRuntimeHost.core(c.getFilesDir(),bot)!=null){dispatchBoundStart(c,bot,InstalledRuntimeHost.request(c.getFilesDir(),bot,false),"bilibili",binding);return;}dispatchBoundStart(c,bot,BindingControl.verifiedTicket(c,bot,binding));}
    private static void dispatchBoundStart(Context c,String bot,String ticket){dispatchBoundStart(c,bot,ticket,null,null);}
    private static void dispatchBoundStart(Context c,String bot,String ticket,String platform,String slot){
        if(ticket==null)return;
        Intent i=new Intent(c,ContainerService.class).setAction("com.whaleonebot.BOUND").putExtra("bot",bot).putExtra("ticket",ticket).putExtra("platform",platform).putExtra("slot",slot);
        if(Build.VERSION.SDK_INT>=26)c.startForegroundService(i);else c.startService(i);
    }
    public static void stopBoundBot(String bot){ InstalledRuntimeHost.stop(bot);BindingControl.stop(bot); }
    public static void startInstalledPlatform(Context c,String bot,String platform)throws Exception {
        File files=c.getFilesDir();String ticket=InstalledRuntimeHost.requestPlatform(files,bot,platform);if(ticket==null)throw new IllegalStateException("platform unavailable");
        if("bilibili".equals(platform)){org.json.JSONArray rows=BindingControl.find(BindingControl.bots(files),bot).getJSONArray("bindings");for(int i=0;i<rows.length();i++){org.json.JSONObject row=rows.getJSONObject(i);if(row.optBoolean("enabled",true)&&BiliProtocolControl.owned(row)&&BiliProtocolControl.hasSaved(c,bot,row.getString("id")))BiliProtocolControl.start(c,bot,row.getString("id"),row.optString("peerId"));}}
        dispatchBoundStart(c,bot,ticket,platform,null);
    }
    /** Caller has durably disabled this managed robot's platform. Leave vault and other platforms alone. */
    public static void stopInstalledPlatform(Context c,String bot,String platform)throws Exception {
        if(InstalledRuntimeHost.core(c.getFilesDir(),bot)==null)throw new IllegalStateException("not managed");
        org.json.JSONObject b=BindingControl.find(BindingControl.bots(c.getFilesDir()),bot);
        org.json.JSONArray slots=b.getJSONArray("bindings");java.util.List<String> ids=new java.util.ArrayList<>();
        for(int i=0;i<slots.length();i++){org.json.JSONObject row=slots.getJSONObject(i);if(platform.equals(row.optString("platform"))){if(row.optBoolean("enabled",true))throw new IllegalStateException("still enabled");ids.add(row.getString("id"));}}
        if(ids.isEmpty())throw new IllegalStateException("missing platform");
        if("bilibili".equals(platform))BiliProtocolControl.stopBotAccounts(bot);
        for(String id:ids)InstalledRuntimeHost.stopBinding(bot,id);
    }
    public static void stopInstalledBinding(String bot,String binding){InstalledRuntimeHost.stopBinding(bot,binding);}
    public static java.io.Closeable pauseForMaintenance(Context c,String bot)throws java.io.IOException{return InstalledRuntimeHost.pause(c,bot);}
    public static org.json.JSONObject bindingStatus(Context c,String bot){return InstalledRuntimeHost.core(c.getFilesDir(),bot)!=null?InstalledRuntimeHost.status(c,bot):BindingControl.status(c,bot); }

    /** [layer: shell-android] 供远程宿主定位受管核心的实例 config.json（与 MainActivity.botConfigFile 同源）。 */
    public static File managedConfigFile(File files, String botId) {
        String core = InstalledRuntimeHost.core(files, botId);
        return core == null ? null : new File(InstalledRuntimeHost.data(files, core), "config.json");
    }

    public static boolean botRunning() { return botProc != null && botProc.isAlive(); }

    /** [layer: shell-android] 真实活体探针结果（替代陈旧内存态，解决「运行端在跑但 UI 显示已停止」）。 */
    public static final class LiveRuntimeProbe {
        public final boolean agentAlive;
        public final boolean onebotAlive;
        public final int onebotPort;
        public final int agentPid;
        public final String phase;
        public final String uin;

        LiveRuntimeProbe(boolean agentAlive, boolean onebotAlive, int onebotPort, int agentPid, String phase, String uin) {
            this.agentAlive = agentAlive;
            this.onebotAlive = onebotAlive;
            this.onebotPort = onebotPort;
            this.agentPid = agentPid;
            this.phase = phase == null ? "" : phase;
            this.uin = uin == null ? "" : uin;
        }
    }

    private static volatile LiveRuntimeProbe cachedLiveProbe;
    private static volatile long cachedLiveProbeAt = 0L;

    /**
     * 活体探针（800ms 缓存，零阻塞）：核对 bot.json 阶段、/proc/<agent.pid> 存活与 13800/onebot 端口 LISTEN。
     */
    public static LiveRuntimeProbe probeLiveRuntime(File files) {
        long now = System.currentTimeMillis();
        LiveRuntimeProbe prev = cachedLiveProbe;
        if (prev != null && now - cachedLiveProbeAt < 800L) return prev;
        LiveRuntimeProbe fresh = computeLiveProbe(files, now);
        cachedLiveProbe = fresh;
        cachedLiveProbeAt = now;
        return fresh;
    }

    public static boolean botRunning(Context c) {
        if (botRunning()) return true;
        if (c == null) return false;
        LiveRuntimeProbe p = probeLiveRuntime(c.getFilesDir());
        return p.agentAlive || p.onebotAlive;
    }

    private static LiveRuntimeProbe computeLiveProbe(File files, long now) {
        if (files == null) return new LiveRuntimeProbe(false, false, 0, 0, "", "");
        File botJson = new File(files, "rootfs/opt/whale/qq-state/bot.json");
        if (!botJson.isFile() || botJson.length() <= 0 || botJson.length() > 262144) {
            return new LiveRuntimeProbe(false, false, 0, 0, "", "");
        }
        try {
            byte[] raw = java.nio.file.Files.readAllBytes(botJson.toPath());
            org.json.JSONObject obj = new org.json.JSONObject(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
            String phase = obj.optString("phase", "");
            String uin = obj.optString("uin", "");
            org.json.JSONObject ob = obj.optJSONObject("onebot");
            int obPort = ob == null ? 0 : ob.optInt("port", 0);
            org.json.JSONObject ag = obj.optJSONObject("agent");
            int agentPid = ag == null ? 0 : ag.optInt("pid", 0);

            boolean freshFile = (now - botJson.lastModified()) < 90_000L;
            boolean pidAlive = agentPid > 1 && new File("/proc/" + agentPid).isDirectory();
            boolean portListening = obPort > 0 && isTcpPortListening(obPort);
            boolean botProcessAlive = botProc != null && botProc.isAlive();

            boolean onebotAlive = (obPort > 0) && (portListening || (freshFile && ("onebot-ready".equals(phase) || "agent-running".equals(phase))));
            boolean agentAlive = "agent-running".equals(phase) && (pidAlive || portListening || (freshFile && (running || botProcessAlive)));
            return new LiveRuntimeProbe(agentAlive, onebotAlive, obPort, agentPid, phase, uin);
        } catch (Throwable ignored) {
            return new LiveRuntimeProbe(false, false, 0, 0, "", "");
        }
    }

    private static boolean isTcpPortListening(int port) {
        if (port <= 0 || port > 65535) return false;
        String hex = String.format(Locale.US, "%04X", port);
        for (String path : new String[]{"/proc/net/tcp", "/proc/net/tcp6"}) {
            File f = new File(path);
            if (!f.canRead()) continue;
            try (BufferedReader br = new BufferedReader(new InputStreamReader(new java.io.FileInputStream(f)))) {
                String line = br.readLine(); // skip header
                while ((line = br.readLine()) != null) {
                    String[] cols = line.trim().split("\\s+");
                    if (cols.length < 4 || !"0A".equalsIgnoreCase(cols[3])) continue;
                    int colon = cols[1].lastIndexOf(':');
                    if (colon > 0 && hex.equalsIgnoreCase(cols[1].substring(colon + 1))) return true;
                }
            } catch (Throwable ignored) {
            }
        }
        return false;
    }

    /** 停掉机器人进程（不杀容器本身）。 */
    public static void stopBot() {
        botStopRequested = true;
        Process p = botProc;
        botProc = null;
        if (p != null) { try { p.destroy(); } catch (Throwable ignored) {} }
    }

    /** 级别 1 · 进程内热重连 QQ 会话（不断 Node/proot、零影响 B 站与 Agent）；若未跑则自动冷拉起。 */
    public static void hotReconnectQq(final Context c) {
        if (c == null) return;
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            if (running && botRunning(app)) {
                try {
                    boolean sent = sendBotCommand(app, new org.json.JSONObject()
                            .put("action", "hot_reconnect")
                            .put("reason", "user_manual")
                            .put("at", System.currentTimeMillis()));
                    if (sent) return;
                } catch (Throwable ignored) {}
            }
            if (!running) start(app);
            else startBot(app);
        }, "whale-hot-reconn").start();
    }

    /** 级别 2 · 仅重启当前 QQ 通道（关 QQ → 快速清残留 → 起 QQ），不影响同容器内的 B 站、其他受管核心与主容器。 */
    public static void restartQqOnly(final Context c) {
        if (c == null) return;
        final Context app = c.getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                stopBot();
                waitStaleClear(800L);
                if (!running) {
                    start(app);
                } else {
                    startBot(app);
                }
            }
        }, "whale-restart-qq").start();
    }

    /** 级别 4 · 整容器全链路重启：关当前 QQ → 关容器 → 起容器 → 自动拉起当前 QQ（会短暂中断同容器内全部平台）。 */
    public static void restartFullContainer(final Context c) {
        if (c == null) return;
        final Context app = c.getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                stopBot();
                stop(app);
                try { Thread.sleep(1200L); } catch (InterruptedException ignored) {}
                start(app);
            }
        }, "whale-restart-all").start();
    }

    /** 诊断当前网络出口（Wi-Fi/蜂窝、精准区分 Tailscale 内网组网与全局代理 TUN），供状态页展示排查风控诱因。 */
    public static String networkDiagnosticSummary(Context c) {
        return com.whaleonebot.ui.NetworkRiskDetector.inspect(c).summary;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        com.whaleonebot.net.MirrorPrefs.attach(this);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "WhaleOneBot 容器",
                    NotificationManager.IMPORTANCE_LOW));
        }
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        try {
            startForeground(1, buildNotification());
        } catch (Throwable t) {
            android.util.Log.e("WhaleOneBot", "startForeground failed", t);
        }
        if (logFile != null) log("service onCreate");
        registerNetworkRecoveryCallback();
        startOfflineAlertWatcher();
        DouyinSessionVerifier.ensureKeepAliveLoop(this);
        // [layer: shell-android] 原生远程被控宿主挂在 ContainerService（独立于 proot 容器生命周期，容器停机也能连）。
        try {
            com.whaleonebot.ui.RemoteHostDispatcher dispatcher = new com.whaleonebot.ui.RemoteHostDispatcher(this);
            com.whaleonebot.remote.RemoteControlManager.get(this).startServices(dispatcher, dispatcher);
        } catch (Throwable t) {
            android.util.Log.w("WhaleOneBot", "remote host bootstrap failed", t);
        }
        // Managed workers use their own endpoints; only the legacy container needs its HTTP server.
    }

    /** 构造前台通知（onCreate 与每个 start 命令都要用一次，满足 5 秒规则）。 */
    private Notification buildNotification() {
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setContentTitle("WhaleOneBot")
                .setContentText("容器服务运行中")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        // ★ 每次 startForegroundService 之后系统都给 5 秒窗口要求 startForeground；
        //   onCreate 里已经调过一次，但如果服务实例还活着（onStartCommand 直接进来）就会漏掉，
        //   Android 14 会直接抛 ForegroundServiceDidNotStartInTimeException 把进程打死。
        if (Build.VERSION.SDK_INT >= 26) {
            try { startForeground(1, buildNotification()); } catch (Throwable ignored) {}
        }
        if (ACTION_STOP.equals(action)) {
            releaseKeepAliveLocks();
            stopContainer();
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireKeepAliveLocks();
        if ("com.whaleonebot.BOUND".equals(action)) {
            String bot=intent.getStringExtra("bot");
            String ticket=intent.getStringExtra("ticket");new Thread(()->{if(InstalledRuntimeHost.core(getFilesDir(),bot)!=null)InstalledRuntimeHost.reconcile(this,bot,ticket,intent.getStringExtra("platform"),intent.getStringExtra("slot"));else if(intent.getStringExtra("platform")==null)BindingControl.launch(this,bot,ticket);},"bound-start").start();
            return START_NOT_STICKY;
        }
        // ★ 2026-11-24 真机事故（这是「扫码永远不出码」的真因）：
        //   这一行以前在「rootfs 里有 .whale-public-environment（内置环境）」或「legacy 未选中」时，
        //   把 LOGIN / REFRESH_QR / BOT **全部**挡掉，只写一行 Legacy QQ not selected。
        //   而内置环境这条路 QQ 客户端就装在同一个 rootfs 的 /opt/QQ —— 扫码登录跟「核心是不是受管」无关。
        //   现在只拦「起机器人」（那确实要走受管宿主），登录与出码一律放行。
        final boolean managedEnv = new File(svcFilesDir(), "rootfs/.whale-public-environment").isFile();
        if (ACTION_BOT.equals(action) && !managedEnv && !BindingControl.legacy(svcFilesDir(),false)) {
            logLine("BOT: 非 legacy 且非受管环境不走本地机器人（登录与出码不受影响）"); return START_STICKY;
        }
        if (http==null && (ACTION_START.equals(action)||ACTION_LOGIN.equals(action)||ACTION_BOT.equals(action)||ACTION_REFRESH_QR.equals(action))) {
            http=new HttpStatusServer(this);new Thread(http,"whale-http").start();
        }
        // [layer: environment] 凡是会让 QQ 起来/重连的动作，都先把设备身份伪造物准备好（幂等，已存在就跳过）。
        if (ACTION_START.equals(action)||ACTION_LOGIN.equals(action)||ACTION_BOT.equals(action)||ACTION_REFRESH_QR.equals(action)) {
            ensureDeviceIdentity();
        }
        if (ACTION_LOGIN.equals(action) || ACTION_REFRESH_QR.equals(action)) {
            // ★ 2026-11-27 架构彻底合一（Q5/Q8）：废弃并发 container-login.mjs 抢占 login.db！
            //   确保单进程 container-bot.mjs 运行，并通过 0600 原子命令 cmd.json 发送一次按需出码指令。
            final File files = svcFilesDir();
            File qq = new File(files, "rootfs/opt/whale/qq-state");
            qq.mkdirs();
            new File(qq, "qr.png").delete();
            new File(qq, "qr.url").delete();
            try {
                sendBotCommand(this, new org.json.JSONObject().put("action", "request_qr").put("at", System.currentTimeMillis()));
            } catch (Throwable ignored) {}
            if (!running && (worker == null || !worker.isAlive())) {
                worker = new Thread(this::boot, "whale-boot");
                worker.start();
            }
            if (!botRunning()) {
                startBot(this);
            }
            logLine("LOGIN(unified): dispatched one-shot request_qr to container-bot.mjs");
            return START_STICKY;
        }
        if (ACTION_BOT.equals(action)) {
            final File files = svcFilesDir();
            new Thread(() -> {
                Process p = botProc;
                if (p != null && p.isAlive()) { logLine("BOT: already running"); return; }
                botStopRequested = false;
                try {
                    // 从 Android 侧精确清掉上一代的 bot / agent，仅在真有残留时最多轮询等待 600ms，消除固定 3s 空等。
                    int purged = purgeStale();
                    logLine("BOT: purged stale=" + purged);
                    if (purged > 0) {
                        waitStaleClear(600L);
                    }
                    final boolean isManagedEnv = new File(files, "rootfs/.whale-public-environment").isFile();
                    final Process np = spawnInContainerTo(files,
                            "cd /opt/whale && WHALE_FAKE_HOSTNAME=" + fakeHostname(files) + " LD_PRELOAD=/opt/whale/native/libwhale-device.so:/usr/lib/aarch64-linux-gnu/libgnutls.so.30 "
                            + "exec node container-bot.mjs" + (isManagedEnv ? "" : " --with-agent"),
                            new File(files, "rootfs/opt/whale/qq-state/bot.log"));
                    botProc = np;
                    logLine("BOT: started");
                    int rc = np.waitFor();
                    botProc = null;
                    logLine("BOT: exit rc=" + rc);
                    // ★ 2026-11-27：若退出前状态已是风控被踢/票据过期/待人工登录，严禁 8s 循环自动重启加重风控！
                    com.whaleonebot.ui.QqAuthState lastAuth = com.whaleonebot.ui.QqAuthState.parseBotJson(readBotStateJson(files));
                    if (lastAuth.isOfflineAlert()) {
                        logLine("BOT: 处于需人工介入状态 (" + lastAuth.phase + "/" + lastAuth.offlineReason + ")，停止自动重启");
                    } else if (!botStopRequested && running && botRestarts < 20) {
                        long now = System.currentTimeMillis();
                        if (botRestarts > 0 && now - lastBotRestartAt > 30L * 60L * 1000L) {
                            logLine("BOT: 距上次重启超过 30 分钟，重启计数归零（原 " + botRestarts + " 次）");
                            botRestarts = 0;
                        }
                        lastBotRestartAt = now;
                        botRestarts++;
                        logLine("BOT: 8s 后自动重启（第 " + botRestarts + " 次）");
                        try { Thread.sleep(8000); } catch (InterruptedException ignored) {}
                        if (!botStopRequested && running) startBot(this);
                    }
                } catch (Throwable t) { logLine("BOT FAIL: " + t); }
            }, "whale-bot").start();
            return START_STICKY;
        }
        if (worker == null || !worker.isAlive()) {
            worker = new Thread(new Runnable() { @Override public void run() { boot(); } }, "whale-boot");
            worker.start();
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        log("service onDestroy");
        unregisterNetworkRecoveryCallback();
        if (alertWatcher != null) { alertWatcher.interrupt(); alertWatcher = null; }
        releaseKeepAliveLocks();
        if(http!=null)http.stop();
        stopContainer();
        super.onDestroy();
    }

    /** 监听 Android 网络切换/恢复（Wi-Fi ↔ 流量 / 夜间重拨），防抖 5s 后温和唤醒容器会话（绝不杀进程）。 */
    private void registerNetworkRecoveryCallback() {
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            android.net.ConnectivityManager.NetworkCallback cb = new android.net.ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(android.net.Network network) {
                    long now = System.currentTimeMillis();
                    if (now - lastNetWakeAt < 5000L) return;
                    lastNetWakeAt = now;
                    if (!running || !botRunning()) return;
                    try {
                        sendBotCommand(ContainerService.this,
                                new org.json.JSONObject().put("action", "wake_session").put("reason", "network_available"));
                        logLine("NET_RECOVERY: dispatched gentle wake_session");
                    } catch (Throwable ignored) {}
                }
            };
            cm.registerDefaultNetworkCallback(cb);
            netCallback = cb;
        } catch (Throwable t) {
            android.util.Log.w("WhaleLog", "registerNetworkRecoveryCallback failed", t);
        }
    }

    private void unregisterNetworkRecoveryCallback() {
        android.net.ConnectivityManager.NetworkCallback cb = netCallback;
        netCallback = null;
        if (cb == null) return;
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(cb);
        } catch (Throwable ignored) {}
    }

    /** 后台每 5 秒检查一次本机 bot.json 状态跃迁：一旦进入被踢/票据过期/滑块/离线态即弹高优先级本地通知。 */
    private void startOfflineAlertWatcher() {
        if (alertWatcher != null && alertWatcher.isAlive()) return;
        Thread th = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(5000L);
                    if (!running) continue;
                    com.whaleonebot.ui.QqAuthState st =
                            com.whaleonebot.ui.QqAuthState.parseBotJson(readBotStateJson(svcFilesDir()));
                    if (st.isOnline()) {
                        lastAlertSignature = "";
                    } else if ("kicked-offline".equals(st.phase)
                            || "token-expired".equals(st.phase)
                            || "verify-required".equals(st.phase)
                            || ("degraded".equals(st.phase) && (st.needsManualLogin || (st.offlineReason != null && !st.offlineReason.isEmpty())))) {
                        String sig = st.phase + "|" + st.offlineReason + "|" + st.verifyAt;
                        if (!sig.equals(lastAlertSignature)) {
                            lastAlertSignature = sig;
                            postOfflineNotification(
                                    ContainerService.this,
                                    "QQ 机器人：" + st.shortBadge(true),
                                    st.detailMessage(true),
                                    null);
                        }
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Throwable ignored) {}
            }
        }, "whale-offline-alert");
        th.setDaemon(true);
        alertWatcher = th;
        th.start();
    }

    private synchronized void acquireKeepAliveLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "whaleonebot:container");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
            }
        } catch (Throwable t) {
            android.util.Log.w("WhaleLog", "acquire wakeLock failed", t);
        }
        try {
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    @SuppressWarnings("deprecation")
                    int mode = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, "whaleonebot:wifi");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } catch (Throwable t) {
            android.util.Log.w("WhaleLog", "acquire wifiLock failed", t);
        }
    }

    private synchronized void releaseKeepAliveLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Throwable ignored) {}
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Throwable ignored) {}
    }

    // ------------------------------------------------------------------ boot

    private void boot() {
        try {
            File files = svcFilesDir();
            File bin = new File(files, "bin");
            File logs = new File(files, "logs");
            File rootfs = new File(files, "rootfs");
            File tmp = new File(files, "tmp");
            // The authenticated first-use installer atomically creates rootfs; do not pre-create an empty one.
            mkdirs(bin, logs, tmp);
            logw = new PrintWriter(new FileOutputStream(new File(logs, "container.log"), true), true);
            logFile = new File(logs, "container.log");
            log("=== boot " + now() + " ===");

            log("释放运行时（proot / busybox / 依赖库）");
            extractAsset("proot", new File(bin, "proot"), 0755);
            extractAsset("libtalloc.so.2", new File(bin, "libtalloc.so.2"), 0644);
            extractAsset("libandroid-shmem.so", new File(bin, "libandroid-shmem.so"), 0644);
            extractAsset("busybox", new File(bin, "busybox"), 0755);
            extractAsset("libbusybox.so.1.38.0", new File(bin, "libbusybox.so.1.38.0"), 0644);
            extractAsset("libandroid-selinux.so", new File(bin, "libandroid-selinux.so"), 0644);
            extractAsset("libpcre2-8.so", new File(bin, "libpcre2-8.so"), 0644);
            // proot 需要它自己的 loader（编译期路径 <prefix>/libexec/proot/loader）；
            // 我们把 files/ 当作 termux 的 usr 之外的 prefix，所以放到 files/libexec/proot/。
            File ld = new File(files, "libexec/proot");
            mkdirs(ld);
            extractAsset("libexec/proot/loader", new File(ld, "loader"), 0755);
            extractAsset("libexec/proot/loader32", new File(ld, "loader32"), 0755);

            File envReceipt=new File(rootfs,".whale-public-environment");
            final boolean managedImage=envReceipt.isFile();
            if(managedImage && (!new File(rootfs,"bin/bash").isFile()||!new File(rootfs,"usr/bin/node").isFile())){writeRootfsState(false,"公共运行环境不完整；请修复后再启动");return;}
            if (!managedImage && !isRootfsReady(rootfs)) {writeRootfsState(false,"请在设置 → 机器人下载核心并准备公共环境；旧环境包不再导入");return;}
            log("rootfs ok: " + rootfs);
        writeRootfsState(true, "");
            // 登录脚本随 APK 走（每次启动覆盖 rootfs 里的旧副本）。
            // 这样「出码 + 拉起手机 QQ」的改动只需重装 APK，不必重打 1.2GB 的 rootfs 包。
            File whaleDir = new File(rootfs, "opt/whale");
            mkdirs(whaleDir);
            mkdirs(new File(whaleDir, "qq-state"));
            String apkStamp = currentApkStamp();
            File stampFile = new File(whaleDir, ".whale-assets-stamp");
            String prevStamp = "";
            try {
                if (stampFile.isFile()) {
                    prevStamp = new String(java.nio.file.Files.readAllBytes(stampFile.toPath()), java.nio.charset.StandardCharsets.UTF_8).trim();
                }
            } catch (Throwable ignored) {}
            File bridgeDir = new File(new File(rootfs, "qq-onebot/src"), "bridge");
            boolean assetsIntact = !apkStamp.isEmpty() && apkStamp.equals(prevStamp)
                    && new File(whaleDir, "container-bot.mjs").isFile()
                    && new File(whaleDir, "container-watchdog.mjs").isFile()
                    && new File(bridgeDir, "native-bridge.mjs").isFile()
                    && new File(rootfs, "qq-onebot/src/service.mjs").isFile();
            if (!assetsIntact) {
                extractAssetAlways("container-login.mjs", new File(whaleDir, "container-login.mjs"), 0644);
                extractAssetAlways("container-bot.mjs", new File(whaleDir, "container-bot.mjs"), 0644);
                extractAssetAlways("container-watchdog.mjs", new File(whaleDir, "container-watchdog.mjs"), 0644);
                extractAssetAlways("binding-host.mjs", new File(whaleDir,"binding-host.mjs"),0644);
                extractAssetAlways("bili-protocol-host.mjs",new File(whaleDir,"bili-protocol-host.mjs"),0644);
                File whaleNativeDir = new File(whaleDir, "native");
                mkdirs(whaleNativeDir);
                try { extractAssetAlways("native/libwhale-device.so", new File(whaleNativeDir, "libwhale-device.so"), 0755); }
                catch (Throwable t) { logLine("device shim: " + t); }
                mkdirs(bridgeDir);
                for(String n:new String[]{"error.mjs","native-bridge.mjs","qq-profile.mjs","rkey.mjs","web-cgi.mjs"}){
                    try { extractAssetAlways("bridge/"+n,new File(bridgeDir,n),0644); } catch (Throwable ignored) {}
                }
                extractAssetTree("qq-protocol", new File(rootfs, "qq-onebot/src"), 0644);
                // 同步最新版本 B 站协议层核心至 legacy rootfs（与 ManagedBiliHost 保持同源）
                File legacyBiliDir = new File(whaleDir, "bili-protocol/src/platforms/bilibili");
                if (legacyBiliDir.isDirectory()) {
                    try { extractAssetAlways("bili-client.mjs", new File(legacyBiliDir, "client.mjs"), 0644); } catch (Throwable ignored) {}
                    try { extractAssetAlways("authorized-client.mjs", new File(legacyBiliDir, "authorized-client.mjs"), 0644); } catch (Throwable ignored) {}
                    try { extractAssetAlways("bili-passport.mjs", new File(legacyBiliDir, "passport.mjs"), 0644); } catch (Throwable ignored) {}
                }
                if (!apkStamp.isEmpty()) {
                    try { writeUtf8(stampFile, apkStamp + "\n"); } catch (Throwable ignored) {}
                }
            } else {
                log("assets stamp matched (" + apkStamp + "), fast-skipped redundant copy");
            }
            // ★ 2026-11-24 修正：native 桥与那 525 个图形库**只在「内置环境」这条路上释放**。
            //   legacy（debug 的老 Debian rootfs）本来就有这些，且版本更新；无条件覆盖会把它换成旧库，
            //   真机后果是 QQ 内核每收一条消息都打 `dlsym failed NodeContextifyContextMetrics1`，
            //   协议端 online 起不来、发送侧 http identity probe 一直被拒（机器人"活着但不回话"）。
            if(managedImage){
            // [layer: shell-android] 外壳层释放协议端 ARM64 原生桥产物到容器 /opt/whale/native/。
            // loader.node 已于 2026-11-25 改用 dladdr 同目录解析 libonebot-node-host.so（src/native/loader-bootstrap.cc），
            // 彻底根治旧编译机绝对路径硬编码，原 /mnt/d/qq-onebot/.tmp/... 伪造目录补偿层已按 P3 删除。
            File nativeDir=new File(whaleDir,"native");
            mkdirs(nativeDir);
            for(String n:new String[]{"loader.node","libonebot-node-host.so","consumer.node","probe.node"}){
                extractAssetAlways("native/"+n,new File(nativeDir,n),0700);
            }
            // ★ 2026-11-24 真机事故：QQ 的 wrapper.node（Electron/Chromium）依赖一整套图形库
            //   （libX11 / libxcb / libglib / libvips …）。内置环境是"只够跑 node"的迷你系统，缺这些 ——
            //   真机日志：FATAL Error: libX11.so.6: cannot open shared object file（container-login.mjs:35）。
            //   assets/native/gui 里是 38 个实体 + 其 SONAME 别名（共 12 MB），释放进 rootfs 的系统库目录。
            File sysLib=new File(rootfs,"usr/lib/aarch64-linux-gnu");
            mkdirs(sysLib);
            // 增加印记跳过重复覆写 525 个基础图形库（138MB），消除每次启动长达数十秒的 IO 阻塞与 chmod 风暴
            File guiStamp=new File(sysLib,".whale-gui-ready-v1");
            if(!guiStamp.isFile()){
                try{
                    String[] gui=getAssets().list("native/gui");
                    if(gui!=null){
                        for(String g:gui){
                            File targetLib=new File(sysLib,g);
                            if(!targetLib.isFile() || targetLib.length()==0) extractAssetAlways("native/gui/"+g,targetLib,0644);
                        }
                    }
                    guiStamp.createNewFile();
                    logLine("native/gui: 基础运行库已增量就绪");
                }catch(Exception e){
                    android.util.Log.w("WhaleLog","释放 native/gui 失败",e);
                }
            }
            }

            File bash = new File(rootfs, "usr/bin/bash");
            log("bash canExec=" + bash.canExecute() + " size=" + bash.length());

            File prootBin = new File(bin, "proot");
            if (!prootBin.isFile()) { log("!! proot 缺失"); return; }

            List<String> cmd = new ArrayList<>();
            cmd.add(prootBin.getAbsolutePath());
            cmd.add("--root-id"); cmd.add("--cwd=/root"); cmd.add("-L");
            cmd.add("--link2symlink"); cmd.add("--sysvipc"); cmd.add("--kill-on-exit");
            // ★ 统一全链路设备指纹内核版本为 6.1.0-28-arm64（与 containerBuilder 保持一致，消除 6.2.1-perf 漂移）
            cmd.add("--kernel-release=6.1.0-28-arm64");
            cmd.add("-b"); cmd.add("/dev"); cmd.add("-b"); cmd.add("/proc"); cmd.add("-b"); cmd.add("/sys");
            cmd.add("-r"); cmd.add(rootfs.getAbsolutePath());
            cmd.add("/bin/bash"); cmd.add("-lc");
            if(managedImage){cmd.add("exec /usr/bin/node --input-type=module -e \"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');db.close();console.log('--- container ready ---');setInterval(()=>{},3600000)\"");}
            else cmd.add("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;"
                    + " export HOME=/root; export LANG=C.UTF-8;"
                    + " echo NODE=$(node -v 2>&1);"
                    + " echo PY=$(python3 -V 2>&1);"
                    + " echo FFMPEG=$(ffmpeg -version 2>&1 | head -1);"
                    + " echo GIT=$(git --version 2>&1);"
                    + " echo UV=$(uv --version 2>&1);"
                    + " echo DEBIAN=$(cat /etc/debian_version 2>&1);"
                    + " echo '--- container ready ---';"
                    + " exec sleep 100000000");

            ProcessBuilder pb = new ProcessBuilder(cmd);
            Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", bin.getAbsolutePath());
            env.put("PROOT_TMP_DIR", tmp.getAbsolutePath());
            env.put("PROOT_NO_SECCOMP", "1");
            // proot 默认去 <termux模仿的prefix>/libexec/proot/loader 找它的 loader；
            // 那个路径属于 Termux（读不到 → execve 全部 Permission denied），必须指到我们自己的。
            env.put("PROOT_LOADER", new File(new File(files, "libexec/proot"), "loader").getAbsolutePath());
            env.put("TMPDIR", tmp.getAbsolutePath());
            pb.redirectErrorStream(true);

            // ★ 每次重新起容器都要把「已自动拉起机器人」的闩复位：
            // 这个标记是 static volatile，会跨「停止容器 → 启动容器」保留，
            // 于是同一个 App 进程里第二次起容器时机器人不会自己回来（2026-11-23 05:07 真机复现）。
            autoBotStarted = false;
            log("exec proot -> /bin/bash -lc <版本检查>");
            proc = pb.start();
            running = true;
            containerPid = pidOf(proc);
            log("容器 pid=" + containerPid);
            BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), "UTF-8"));
            String line;
            boolean savedBindingsChecked=false;
            while ((line = r.readLine()) != null) {
                log("[container] " + line);
                if(!savedBindingsChecked && line.contains("--- container ready ---")){savedBindingsChecked=true;InstalledRuntimeHost.containerReady(this);SavedBindingStartup.onReady(this);}
                // 容器一就绪就把机器人拉起来：不依赖任何按钮/HTTP，App 一开就是"能用的机器人"。
                if (!managedImage && !autoBotStarted && line.contains("--- container ready ---") && BindingControl.legacy(files,true)) {
                    autoBotStarted = true;
                    log("容器就绪 → 自动启动机器人");
                    startBot(this);
                }
            }
            int rc = proc.waitFor();
            log("容器退出 rc=" + rc);
        } catch (Throwable t) {
            log("!! boot 异常: " + t);
        } finally {
            running = false;
            proc = null;
            if (logw != null) logw.close();
        }
    }

    private void stopContainer() {
        InstalledRuntimeHost.stopAll();
        BindingControl.stopAll();
        BiliProtocolControl.stopAll();
        running = false;
        Process p = proc;
        if (p != null) { try { p.destroy(); } catch (Throwable ignored) {} }
        Process lp = loginProc;
        loginProc = null;
        if (lp != null) { try { lp.destroy(); } catch (Throwable ignored) {} }
        Process bp = botProc;
        botProc = null;
        if (bp != null) { try { bp.destroy(); } catch (Throwable ignored) {} }
    }

    // ------------------------------------------------------------- rootfs

    private static boolean isRootfsReady(File rootfs) {
        return com.whaleonebot.ui.RootfsLayout.isReady(rootfs);
    }

    private void extractAsset(String name, File dest, int mode) {
        try {
            if (dest.isFile() && dest.length() > 0) { chmod(dest, mode); return; }
            try (InputStream in = getAssets().open(name);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[65536]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            chmod(dest, mode);
            log("asset " + name + " -> " + dest);
        } catch (Throwable t) {
            log("!! 释放 " + name + " 失败: " + t);
        }
    }

    /** 与 extractAsset 相反：总是覆盖。登录脚本必须跟着 APK 版本走，不能让 rootfs 里的旧副本一直生效。 */
    private void extractAssetAlways(String name, File dest, int mode) {
        try {
            File p = dest.getParentFile();
            if (p != null && !p.isDirectory()) p.mkdirs();
            try (InputStream in = getAssets().open(name);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[65536]; int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            chmod(dest, mode);
            log("asset* " + name + " -> " + dest);
        } catch (Throwable t) {
            log("!! 覆盖释放 " + name + " 失败: " + t);
        }
    }

    private void extractAssetTree(String assetPath, File destDir, int mode) {
        try {
            String[] list = getAssets().list(assetPath);
            if (list == null || list.length == 0) {
                if ("qq-protocol/config/account.mjs".equals(assetPath) && destDir.isFile()) {
                    try {
                        byte[] raw = java.nio.file.Files.readAllBytes(destDir.toPath());
                        String existing = new String(raw, java.nio.charset.StandardCharsets.UTF_8);
                        if (!existing.contains("'10000'") && !existing.contains("\"10000\"")) {
                            log("asset skip placeholder over custom " + destDir);
                            return;
                        }
                    } catch (Throwable ignored) {}
                }
                extractAssetAlways(assetPath, destDir, mode);
                return;
            }
            mkdirs(destDir);
            for (String child : list) {
                if (child == null || child.isEmpty()) continue;
                extractAssetTree(assetPath + "/" + child, new File(destDir, child), mode);
            }
        } catch (Throwable t) {
            log("!! 同步目录 " + assetPath + " 失败: " + t);
        }
    }

    private static void chmod(File f, int mode) {
        try {
            new ProcessBuilder("/system/bin/chmod", Integer.toOctalString(mode), f.getAbsolutePath())
                    .start().waitFor();
        } catch (Throwable ignored) {}
    }

    private static void mkdirs(File... dirs) { for (File d : dirs) if (!d.isDirectory()) d.mkdirs(); }

    private static void touch(File f) {
        try {
            File p = f.getParentFile();
            if (p != null) p.mkdirs();
            new FileOutputStream(f).close();
        } catch (Throwable ignored) {}
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static long pidOf(Process p) {
        try {
            Object v = Process.class.getMethod("pid").invoke(p);
            return v instanceof Long ? (Long) v : Long.parseLong(String.valueOf(v));
        } catch (Throwable t) {
            return -1;
        }
    }

    /**
     * [layer: environment] 设备身份伪造：每机稳定派生的 hostname / machine-id，外加一份假的 /proc/mounts。
     *
     * <p>起因（2026-11-26）：QQ 安全中心把容器判成「设备存在外挂或其他软件影响 QQ 正常使用」并强制下线，
     * 界面上设备名直接显示 **localhost** —— 那是 Android 内核的默认 hostname。容器跑在 proot 里，
     * {@code gethostname()} 走 syscall，改 /etc/hostname 无效，所以另配 {@code libwhale-device.so} 做 LD_PRELOAD 拦截；
     * 这里负责**生成那些能用文件覆盖的部分**（machine-id、假挂载表）以及派生一个稳定的设备名。
     *
     * <p>★ 取值规则：**同一台手机每次都一样**（否则每次登录都像新设备，更容易被风控），
     * **不同手机不同**（否则多台机器共用一个设备指纹会被关联）。种子里优先用 ANDROID_ID。
     */
    void ensureDeviceIdentity() {
        try {
            File files = svcFilesDir();
            File dir = new File(files, "rootfs/opt/whale/device");
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            File hostFile = new File(dir, "hostname");
            File midFile = new File(dir, "machine-id");
            File mountsFile = new File(dir, "mounts");
            if (hostFile.isFile() && midFile.isFile() && mountsFile.isFile()) return;
            String seed = null;
            try {
                seed = android.provider.Settings.Secure.getString(getContentResolver(),
                        android.provider.Settings.Secure.ANDROID_ID);
            } catch (Throwable ignored) {}
            if (seed == null || seed.length() < 8) {
                seed = android.os.Build.FINGERPRINT + "|" + android.os.Build.SERIAL + "|" + files.getAbsolutePath();
            }
            String hs = deviceHash(seed, "whale-host");
            String mid = deviceHash(seed, "whale-mid");
            writeUtf8(hostFile, "deb-arm64-" + hs.substring(0, 8) + "\n");
            writeUtf8(midFile, mid + "\n");
            // ★ machine-id 必须落在 rootfs 的 /etc 下（那才是程序实际读的路径），device/ 里那份只是留档。
            File etcDir = new File(files, "rootfs/etc");
            if (etcDir.isDirectory() || etcDir.mkdirs()) {
                File realMid = new File(etcDir, "machine-id");
                if (!realMid.isFile()) writeUtf8(realMid, mid + "\n");
            }
            // Android 的根分区是 /dev/block/dm-N + erofs，桌面 Linux 是 /dev/vda1 或 /dev/mmcblk0pN + ext4。
            writeUtf8(mountsFile,
                      "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0\n"
                    + "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n"
                    + "/dev/vda1 / ext4 rw,relatime,errors=remount-ro 0 0\n"
                    + "tmpfs /tmp tmpfs rw,nosuid,nodev 0 0\n");
            logLine("device identity: ready (host=" + "deb-arm64-" + hs.substring(0, 8) + ")");
        } catch (Throwable t) { logLine("device identity FAIL: " + t); }
    }

    /** 读 ensureDeviceIdentity() 生成的设备名；没有就退回 debian（不阻塞启动）。 */
    static String fakeHostname(File files) {
        try {
            File f = new File(files, "rootfs/opt/whale/device/hostname");
            if (f.isFile()) {
                java.io.BufferedReader r = new java.io.BufferedReader(
                        new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
                try { String s = r.readLine(); if (s != null && s.trim().length() > 0) return s.trim(); }
                finally { r.close(); }
            }
        } catch (Throwable ignored) {}
        return "debian";
    }

    private static String deviceHash(String seed, String salt) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest((salt + "|" + seed).getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) sb.append(String.format(java.util.Locale.ROOT, "%02x", d[i]));
            return sb.toString();
        } catch (Throwable t) { return "0123456789abcdef0123456789abcdef"; }
    }

    private static void writeUtf8(File f, String s) throws Exception {
        File tmp = new File(f.getParentFile(), f.getName() + ".next");
        java.io.FileOutputStream o = new java.io.FileOutputStream(tmp);
        try { o.write(s.getBytes("UTF-8")); } finally { try { o.close(); } catch (Throwable ignored) {} }
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new java.io.IOException("rename failed: " + f); }
    }

    /** 容器的私有 files 目录（用 /data/data 而不是 /data/user/0，避免 tar 的 realpath 比较出错）。 */
    File svcFilesDir() {
        File direct = new File("/data/data/" + getPackageName() + "/files");
        return direct.isDirectory() ? direct : getFilesDir();
    }

    /**
     * 容器日志。
     *
     * <p>★ 2026-11-24：除了写 {@code files/logs/container.log}，**同时进 logcat**（tag {@code WhaleLog}）。
     * 原因：release 签名的并排测试包没有 {@code run-as}，私有目录里的日志等于读不到 ——
     * 「扫码不出码」这种问题就完全没法定位（只能猜）。以后排查一律 {@code adb logcat -s WhaleLog}。
     */
    void logLine(String s) {
        log(s);
        try { android.util.Log.i("WhaleLog", String.valueOf(s)); } catch (Throwable ignored) { }
    }

    private static String now() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }

    private void log(String s) {
        File f = logFile;
        if (f == null) return;
        String line = "[" + now() + "] " + s + "\n";
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(f, true)) {
            out.write(line.getBytes("UTF-8"));
        } catch (Throwable ignored) {}
    }

    /** 直接在 Android 侧执行一条 shell 命令（不经过 proot），只给本地调试端点用。 */
    static String execHost(File files, String cmd) {
        try {
            ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c", cmd);
            pb.directory(files);
            pb.environment().put("PATH", "/system/bin:/system/xbin");
            pb.redirectErrorStream(true);
            Process p = pb.start();
            p.getOutputStream().close();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line).append('\n');
                if (sb.length() > 200000) break;
            }
            p.waitFor();
            return sb.toString();
        } catch (Throwable t) {
            return "HOST_EXEC_FAIL " + t;
        }
    }

    /** 组装「在容器里跑一条命令」的进程：execInContainer / spawnInContainer 共用一份参数。 */
    synchronized ProcessBuilder installedBuilder(File files,File app,File state)throws Exception {
        File envRoot=com.whaleonebot.install.CoreInstaller.environmentForApp(files,app);
        File bin=new File(files,"bin"),ld=new File(files,"libexec/proot");mkdirs(bin,ld,new File(files,"tmp"),state);
        for(String n:new String[]{"proot","libtalloc.so.2","libandroid-shmem.so"})extractAsset(n,new File(bin,n),n.equals("proot")?0755:0644);
        for(String n:new String[]{"loader","loader32"})extractAsset("libexec/proot/"+n,new File(ld,n),0755);
        java.io.ByteArrayOutputStream buf=new java.io.ByteArrayOutputStream();try(InputStream in=getAssets().open("binding-host.mjs")){byte[] block=new byte[8192];int n;while((n=in.read(block))>0)buf.write(block,0,n);}byte[] bytes=buf.toByteArray();StringBuilder hex=new StringBuilder();for(byte v:java.security.MessageDigest.getInstance("SHA-256").digest(bytes))hex.append(String.format(Locale.ROOT,"%02x",v));
        File adapter=new File(files,"managed-adapters/"+hex),script=new File(adapter,"binding-host.mjs");mkdirs(adapter);if(!script.isFile()||!java.util.Arrays.equals(bytes,java.nio.file.Files.readAllBytes(script.toPath()))){File partial=File.createTempFile("script",".tmp",adapter);java.nio.file.Files.write(partial.toPath(),bytes);java.nio.file.Files.move(partial.toPath(),script.toPath(),java.nio.file.StandardCopyOption.ATOMIC_MOVE,java.nio.file.StandardCopyOption.REPLACE_EXISTING);}
        ProcessBuilder pb=containerBuilder(files,"exec /usr/bin/node /opt/whale/host-adapter/binding-host.mjs");List<String> args=pb.command();int at=args.indexOf("-r");args.set(at+1,envRoot.getCanonicalPath());args.addAll(at,Arrays.asList("-b",app.getCanonicalPath()+":/opt/whale/instance-app","-b",state.getCanonicalPath()+":/opt/whale/instance-state","-b",adapter.getCanonicalPath()+":/opt/whale/host-adapter"));return pb;
    }
    static ProcessBuilder containerBuilder(File files, String cmd) {
        File bin = new File(files, "bin");
        File rootfs = new File(files, "rootfs");
        File tmp = new File(files, "tmp");
        List<String> c = new ArrayList<>();
        c.add(new File(bin, "proot").getAbsolutePath());
        c.add("--root-id"); c.add("--cwd=/root"); c.add("-L");
        c.add("--link2symlink"); c.add("--sysvipc"); c.add("--kill-on-exit");
        c.add("--kernel-release=6.1.0-28-arm64");
        c.add("-b"); c.add("/dev"); c.add("-b"); c.add("/proc"); c.add("-b"); c.add("/sys");
        // ★ 2026-11-26 实测：`-b 假文件:/proc/mounts` **不生效**（procfs 是内核特例，bind 被绕过，
        //   读到的仍是 /dev/block/dm-9 erofs）。而 QQ 是即时通讯，不枚举磁盘，这个字段优先级最低 ——
        //   先不做，等真有证据说它被采集再想办法（改内核参数或 proot 源码，成本高一个量级）。
        c.add("-r"); c.add(rootfs.getAbsolutePath());
        c.add("/bin/bash"); c.add("-lc");
        c.add("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;"
                + " export HOME=/root; export LANG=C.UTF-8; " + cmd);
        ProcessBuilder pb = new ProcessBuilder(c);
        pb.environment().put("LD_LIBRARY_PATH", bin.getAbsolutePath());
        // ★ 绝不要在这里设 LD_PRELOAD：这个环境是给 Android 侧（bionic）的 proot 进程用的，
        //   塞一个 glibc 的 libgnutls 进去会让 proot 自己起不来
        //   （实测：CANNOT LINK EXECUTABLE "bin/proot": library ".../libgnutls.so.30" not found）。
        //   gnutls 必须在「容器内」给 node 预加载 —— 见 ACTION_LOGIN 里那条命令。
        pb.environment().put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        pb.environment().put("PROOT_NO_SECCOMP", "1");
        pb.environment().put("PROOT_LOADER", new File(new File(files, "libexec/proot"), "loader").getAbsolutePath());
        pb.redirectErrorStream(true);
        return pb;
    }

    /**
     * 从 Android 侧按 /proc 精确清理上一代的 bot / agent 进程。
     * ★ 为什么必须在 Java 侧做：容器里的 proot 子进程不会随 App 重启而消失，
     *   而在容器里 `pkill -f` 又会因为「同一行命令里就含该字符串」把自己打死；
     *   这里读 /proc/<pid>/cmdline 逐个比对，全是本 App uid 的进程，直接 killProcess 即可。
     */
    private String currentApkStamp() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionCode + "-" + pi.lastUpdateTime;
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static void waitStaleClear(long maxWaitMs) {
        long deadline = System.currentTimeMillis() + maxWaitMs;
        while (System.currentTimeMillis() < deadline) {
            if (!hasStaleBotOrAgent()) return;
            try { Thread.sleep(60L); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
        purgeStale();
    }

    private static boolean hasStaleBotOrAgent() {
        File[] all = new File("/proc").listFiles();
        if (all == null) return false;
        int self = android.os.Process.myPid();
        for (File dir : all) {
            String name = dir.getName();
            if (name.isEmpty() || !Character.isDigit(name.charAt(0))) continue;
            int pid;
            try { pid = Integer.parseInt(name); } catch (Throwable t) { continue; }
            if (pid == self) continue;
            try (java.io.FileInputStream in = new java.io.FileInputStream(new File(dir, "cmdline"))) {
                byte[] b = new byte[1024];
                int n = in.read(b);
                if (n <= 0) continue;
                String cmd = new String(b, 0, n, "UTF-8").replace('\0', ' ');
                if (!cmd.contains("--whale-binding-worker") && (cmd.contains("container-bot.mjs") || cmd.contains("agent-app/src/server.js"))) {
                    return true;
                }
            } catch (Throwable ignored) {}
        }
        return false;
    }

    static int purgeStale() {
        int killed = 0;
        File[] all = new File("/proc").listFiles();
        if (all == null) return 0;
        int self = android.os.Process.myPid();
        for (File dir : all) {
            String name = dir.getName();
            if (name.isEmpty() || !Character.isDigit(name.charAt(0))) continue;
            int pid;
            try { pid = Integer.parseInt(name); } catch (Throwable t) { continue; }
            if (pid == self) continue;
            String cmd;
            try {
                byte[] b = new byte[4096];
                try (java.io.FileInputStream in = new java.io.FileInputStream(new File(dir, "cmdline"))) {
                    int n = in.read(b);
                    if (n <= 0) continue;
                    cmd = new String(b, 0, n, "UTF-8").replace('\0', ' ');
                }
            } catch (Throwable t) { continue; }
            if (!cmd.contains("--whale-binding-worker") && (cmd.contains("container-bot.mjs") || cmd.contains("agent-app/src/server.js"))) {
                try { android.os.Process.killProcess(pid); killed++; } catch (Throwable ignored) {}
            }
        }
        return killed;
    }

    /**
     * 在容器里「长期」跑一条命令，并返回进程句柄。
     * 必须由调用方持有这个进程：proot 带 --kill-on-exit，一旦这个 proot 退出，
     * 它在容器里拉起的子进程会被一起带走 —— 所以登录进程不能靠 `nohup ... &` 起，
     * 那样 proot 一退出 node 就没了（实测：connect returned 之后进程直接消失，永远等不到 login-connected）。
     */
    static Process spawnInContainer(File files, String cmd) throws java.io.IOException {
        return containerBuilder(files, cmd).start();
    }

    /**
     * 同 spawnInContainer，但把子进程的 stdout/stderr 直接定向到文件。
     * ★ 这样 Java 侧根本不持有管道：QQ 原生层那句「BuglyManager fatalHandler signo: 13」(SIGPIPE)
     *   就是因为往一个没人读/已关闭的管道写而把整个 node 打死的。
     */
    static Process spawnInContainerTo(File files, String cmd, File out) throws java.io.IOException {
        ProcessBuilder pb = containerBuilder(files, cmd);
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(out));
        return pb.start();
    }

    /** 在容器里执行一条命令并返回输出（供本地调试端点 /exec 用）。 */
    /** 对外（ui 包）暴露同一个入口：QQ 客户端解包要用，语义与内部完全一致。 */
  public static String execInContainerPublic(File files, String cmd) { return execInContainer(files, cmd); }

  static String execInContainer(File files, String cmd) {
        try {
            ProcessBuilder pb = containerBuilder(files, cmd);
            Process p = pb.start();
            p.getOutputStream().close();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line).append('\n');
                if (sb.length() > 200000) break;
            }
            p.waitFor();
            return sb.toString();
        } catch (Throwable t) {
            return "EXEC_FAIL " + t;
        }
    }

    /**
     * 把「容器骨架能不能用」写成一个小组状态文件，供启动页显示。
     *
     * <p>为什么要有它：新用户装完 APK 点启动，如果缺 1.2GB 的 rootfs，界面只会一直显示「未运行」，
     * 真实原因只躺在 bot.log 里。写一个 {ready, reason} 让面板能直接说清楚缺什么。
     */
    private void writeRootfsState(boolean ready, String reason) {
        File f = new File(svcFilesDir(), "rootfs-state.json");
        String json = "{\"ready\":" + ready + ",\"reason\":\"" + (reason == null ? "" : reason.replace("\"", "'"))
                + "\",\"at\":" + System.currentTimeMillis() + "}";
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(json.getBytes("UTF-8"));
        } catch (Throwable ignored) {
            // 写不进去不影响启动
        }
    }

}
