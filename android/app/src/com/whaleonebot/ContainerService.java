package com.whaleonebot;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

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

    private static volatile boolean running = false;
    private static volatile Process proc = null;
    private static volatile long containerPid = -1;
    /** 容器里正在跑的登录进程（必须由 Java 侧持有：proot --kill-on-exit 会连带杀掉它拉起的 node）。 */
    private static volatile Process loginProc = null;
    /** 容器里正在跑的机器人进程（同上，必须持有）。 */
    private static volatile Process botProc = null;
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

    /** 在容器里拉起登录进程（幂等：已在跑就不重复启动），并请求一张新二维码。 */
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
    public static void stopBiliProtocol(String bot,String binding){BiliProtocolControl.stop(bot,binding);}
    public static org.json.JSONObject biliProtocolStatus(String bot,String binding){return BiliProtocolControl.status(bot,binding);}
    public static boolean hasBiliSession(Context c,String bot,String binding){return BiliProtocolControl.hasSaved(c,bot,binding);}
    public static boolean forgetBiliSession(Context c,String bot,String binding){return BiliProtocolControl.forget(c,bot,binding);}
    public static void reauthorizeBiliProtocol(Context c,String bot,String binding,String peer){BiliProtocolControl.reauthorize(c,bot,binding,peer);}
    public static String biliAuthorizationLink(String bot,String binding){return BiliProtocolControl.authorizationLink(bot,binding);}
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

    public static boolean botRunning() { return botProc != null && botProc.isAlive(); }

    /** 停掉机器人进程（不杀容器本身）。 */
    public static void stopBot() {
        botStopRequested = true;
        Process p = botProc;
        botProc = null;
        if (p != null) { try { p.destroy(); } catch (Throwable ignored) {} }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
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
            stopContainer();
            stopSelf();
            return START_NOT_STICKY;
        }
        if ("com.whaleonebot.BOUND".equals(action)) {
            String bot=intent.getStringExtra("bot");
            String ticket=intent.getStringExtra("ticket");new Thread(()->{if(InstalledRuntimeHost.core(getFilesDir(),bot)!=null)InstalledRuntimeHost.reconcile(this,bot,ticket,intent.getStringExtra("platform"),intent.getStringExtra("slot"));else if(intent.getStringExtra("platform")==null)BindingControl.launch(this,bot,ticket);},"bound-start").start();
            return START_NOT_STICKY;
        }
        if ((ACTION_LOGIN.equals(action)||ACTION_REFRESH_QR.equals(action)||ACTION_BOT.equals(action)) && (new File(svcFilesDir(),"rootfs/.whale-public-environment").isFile()||!BindingControl.legacy(svcFilesDir(),false))) {
            logLine("Legacy QQ not selected by registry"); return START_STICKY;
        }
        if (http==null && (ACTION_START.equals(action)||ACTION_LOGIN.equals(action)||ACTION_BOT.equals(action)||ACTION_REFRESH_QR.equals(action))) {
            http=new HttpStatusServer(this);new Thread(http,"whale-http").start();
        }
        if (ACTION_LOGIN.equals(action)) {
            final File files = svcFilesDir();
            File qq = new File(files, "rootfs/opt/whale/qq-state");
            qq.mkdirs();
            // 同步清掉上一轮的登录地址：App 随后只认本次新写出来的那一张码。
            new File(qq, "qr.url").delete();
            Process p = loginProc;
            if (p != null && p.isAlive()) {
                touch(new File(qq, "refresh.request"));
                logLine("LOGIN: already running -> refresh.request");
                return START_STICKY;
            }
            try {
                final Process np = spawnInContainer(files,
                        "cd /opt/whale && LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libgnutls.so.30 "
                        + "exec node container-login.mjs");
                loginProc = np;
                logLine("LOGIN: started");
                new Thread(() -> {
                    try {
                        BufferedReader r = new BufferedReader(
                                new InputStreamReader(np.getInputStream(), "UTF-8"));
                        String line;
                        while ((line = r.readLine()) != null) logLine("[login] " + line);
                        logLine("LOGIN: exit rc=" + np.waitFor());
                    } catch (Throwable t) { logLine("LOGIN pump: " + t); }
                }, "whale-login-pump").start();
            } catch (Throwable t) { logLine("LOGIN FAIL: " + t); }
            return START_STICKY;
        }
        if (ACTION_BOT.equals(action)) {
            final File files = svcFilesDir();
            new Thread(() -> {
                Process p = botProc;
                if (p != null && p.isAlive()) { logLine("BOT: already running"); return; }
                botStopRequested = false;
                try {
                    // 从 Android 侧精确清掉上一代的 bot / agent（容器里的 pkill 既不可靠又会误杀自己）。
                    int purged = purgeStale();
                    logLine("BOT: purged stale=" + purged);
                    try { Thread.sleep(1500); } catch (InterruptedException ignored) {}
                    int left = purgeStale();
                    if (left > 0) { logLine("BOT: 仍有 " + left + " 个残留未清掉"); try { Thread.sleep(1500); } catch (InterruptedException ignored) {} }
                    // 输出直接重定向进容器里的 bot.log：不走管道，就不会因为父进程没读而 SIGPIPE。
                    final Process np = spawnInContainerTo(files,
                            "cd /opt/whale && LD_PRELOAD=/usr/lib/aarch64-linux-gnu/libgnutls.so.30 "
                            + "exec node container-bot.mjs --with-agent",
                            new File(files, "rootfs/opt/whale/qq-state/bot.log"));
                    botProc = np;
                    logLine("BOT: started");
                    int rc = np.waitFor();
                    botProc = null;
                    logLine("BOT: exit rc=" + rc);
                    // 无人值守：意外退出就自动重启（有上限，听命令停下就不重启）。
                    // 无人值守：意外退出就自动重启（有上限，听命令停下就不重启）。
                    // 上限用**时间窗口**而不是永久计数：连续崩溃才停，隔了半小时再崩就重新开始数，
                    // 否则跑几天之后一次偶发崩溃就会永久停摆（实测打到过 20 次上限）。
                    if (!botStopRequested && running && botRestarts < 20) {
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
        if (ACTION_REFRESH_QR.equals(action)) {
            try {
                File files = svcFilesDir();
                File qq = new File(files, "rootfs/opt/whale/qq-state");
                qq.mkdirs();
                // 旧码直接丢掉：界面只展示本次请求之后新生成的码。
                new File(qq, "qr.png").delete();
                Process p = loginProc;
                if (p == null || !p.isAlive()) {
                    logLine("REFRESH_QR: 登录进程不在，改为启动");
                    return onStartCommand(new Intent(this, ContainerService.class)
                            .setAction(ACTION_LOGIN), flags, startId);
                }
                touch(new File(qq, "refresh.request"));
                logLine("REFRESH_QR requested");
            } catch (Throwable t) { logLine("REFRESH_QR FAIL: " + t); }
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
        if(http!=null)http.stop();
        stopContainer();
        super.onDestroy();
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
            if(!managedImage){mkdirs(new File(whaleDir, "qq-state"));
            extractAssetAlways("container-login.mjs", new File(whaleDir, "container-login.mjs"), 0644);
            extractAssetAlways("container-bot.mjs", new File(whaleDir, "container-bot.mjs"), 0644);}
            extractAssetAlways("binding-host.mjs", new File(whaleDir,"binding-host.mjs"),0644);
            extractAssetAlways("bili-protocol-host.mjs",new File(whaleDir,"bili-protocol-host.mjs"),0644);
            File bash = new File(rootfs, "usr/bin/bash");
            log("bash canExec=" + bash.canExecute() + " size=" + bash.length());

            File prootBin = new File(bin, "proot");
            if (!prootBin.isFile()) { log("!! proot 缺失"); return; }

            List<String> cmd = new ArrayList<>();
            cmd.add(prootBin.getAbsolutePath());
            cmd.add("--root-id"); cmd.add("--cwd=/root"); cmd.add("-L");
            cmd.add("--link2symlink"); cmd.add("--sysvipc"); cmd.add("--kill-on-exit");
            cmd.add("--kernel-release=6.2.1-perf");
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

    /** 容器的私有 files 目录（用 /data/data 而不是 /data/user/0，避免 tar 的 realpath 比较出错）。 */
    File svcFilesDir() {
        File direct = new File("/data/data/" + getPackageName() + "/files");
        return direct.isDirectory() ? direct : getFilesDir();
    }

    void logLine(String s) { log(s); }

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
        c.add("--kernel-release=6.2.1-perf");
        c.add("-b"); c.add("/dev"); c.add("-b"); c.add("/proc"); c.add("-b"); c.add("/sys");
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
