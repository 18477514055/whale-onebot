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
 * 首启会从 /sdcard/Download/whale/rootfs.tar.gz 解包到私有目录，然后用 proot 进入容器执行。
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
        http = new HttpStatusServer(this);
        new Thread(http, "whale-http").start();
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
            mkdirs(bin, logs, rootfs, tmp);
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

            if (!isRootfsReady(rootfs)) {
                log("rootfs 未就绪，开始解包");
                if (!unpackRootfs(rootfs, bin)) {
            log("!! rootfs 解包失败，无法继续");
            writeRootfsState(false, "没有可用的容器骨架：把 rootfs.tar.gz 放到 Download/whale/，或在「配置 → 内置运行端」里下载");
            return;
        }
            }
            log("rootfs ok: " + rootfs);
        writeRootfsState(true, "");
            // 登录脚本随 APK 走（每次启动覆盖 rootfs 里的旧副本）。
            // 这样「出码 + 拉起手机 QQ」的改动只需重装 APK，不必重打 1.2GB 的 rootfs 包。
            File whaleDir = new File(rootfs, "opt/whale");
            mkdirs(whaleDir, new File(whaleDir, "qq-state"));
            extractAssetAlways("container-login.mjs", new File(whaleDir, "container-login.mjs"), 0644);
            extractAssetAlways("container-bot.mjs", new File(whaleDir, "container-bot.mjs"), 0644);
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
            cmd.add("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;"
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
            while ((line = r.readLine()) != null) {
                log("[container] " + line);
                // 容器一就绪就把机器人拉起来：不依赖任何按钮/HTTP，App 一开就是"能用的机器人"。
                if (!autoBotStarted && line.contains("--- container ready ---")) {
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

    /** 只保留最近一份换下来的旧骨架，别让 .old-* 越攒越多把手机塞满。 */
    private void pruneRetired(File rootfs) {
        File parent = rootfs.getParentFile();
        File[] kids = parent == null ? null : parent.listFiles();
        if (kids == null || kids.length == 0) return;
        java.util.List<File> olds = new java.util.ArrayList<>();
        for (File k : kids) {
            if (k != null && k.isDirectory() && k.getName().startsWith(rootfs.getName() + com.whaleonebot.ui.RootfsLayout.RETIRED_PREFIX)) {
                olds.add(k);
            }
        }
        if (olds.size() <= 1) return;
        java.util.Collections.sort(olds, new java.util.Comparator<File>() {
            @Override public int compare(File a, File b) { return a.getName().compareTo(b.getName()); }
        });
        for (int i = 0; i < olds.size() - 1; i++) {
            log("清理更旧的骨架副本 " + olds.get(i).getName());
            deleteRecursive(olds.get(i));
        }
    }

    /**
     * 找**从 App 里下载下来**的运行端包（`files/runtimes/<版本>/` 下的 `rootfs.tar.gz` /
     * `runtime.tar.gz` / `runtime.zip`），找不到返回 {@code null}。
     *
     * <p>这是「内置运行端」下载链路的落地点：下载器把包放在那里，这里负责解包。
     * 之所以扫目录而不是耦合 `ui.RuntimeCatalog`：本类属于服务层，不该依赖面板包；
     * 目录名就是版本号，挑一个**解出来的就能用**的即可（版本目录按名字倒序试）。
     */
    private File downloadedRuntimeArchive() {
        return com.whaleonebot.ui.RuntimeArchivePick.pick(new File(getFilesDir(), "runtimes"));
    }

    /** 在解包结果里找第一个「文件名含反斜杠」的条目（Windows 打包的典型症状），没有返回 null。 */
    private static String firstBackslashEntry(File dir) {
        return firstBackslashEntry(dir, 0);
    }

    private static String firstBackslashEntry(File dir, int depth) {
        if (dir == null || depth > 4) return null;
        File[] kids = dir.listFiles();
        if (kids == null) return null;
        for (File k : kids) {
            if (k == null) continue;
            if (k.getName().indexOf('\\') >= 0) return k.getName();
            if (k.isDirectory()) {
                String deeper = firstBackslashEntry(k, depth + 1);
                if (deeper != null) return deeper;
            }
        }
        return null;
    }

    /**
     * 按文件头判断是不是 zip：`PK\x03\x04`（本地文件头）或 `PK\x05\x06`（空包）。
     *
     * <p>为什么不信扩展名：下载器把包统一存成 `runtime.zip`，但索引里指向的资产完全可能是
     * `rootfs.tar.gz`（`1f 8b`）—— 扩展名和内容不一致时，用错解包器会直接把包解废。
     */
    private static boolean looksLikeZip(File f) {
        return com.whaleonebot.ui.RuntimeArchivePick.looksLikeZip(f);
    }

    /** 用 busybox tar 解包：toybox tar 会拒绝「符号链接目标不在解包根下」的条目，整包必失败。 */
    private boolean unpackRootfs(File rootfs, File bin) {
        // ① 优先用 App 内下载下来的包（内置运行端链路）；② 才是用户手动放进 /sdcard 的那份。
        File src = downloadedRuntimeArchive();
        boolean fromDownload = src != null;
        if (src == null) {
            File dir = new File("/sdcard/Download/whale");
            File gz = new File(dir, "rootfs.tar.gz");
            File plain = new File(dir, "rootfs.tar");
            src = gz.isFile() ? gz : (plain.isFile() ? plain : null);
        }
        if (src == null) { log("!! /sdcard/Download/whale/ 下没有 rootfs.tar.gz，App 内也没有下载好的运行端"); return false; }

        File bb = new File(bin, "busybox");
        if (!bb.isFile()) { log("!! busybox 缺失"); return false; }

        // 格式按**文件头**判，不按扩展名：下载器统一存成 runtime.zip，但索引里的资产也可能是
        // rootfs.tar.gz（1f 8b）或未压缩 tar。
        final boolean isZip = looksLikeZip(src);
        // 解到暂存目录：包坏了也只是暂存目录白解一次，正在用的 rootfs 一根头发都不动。
        final File staging = com.whaleonebot.ui.RootfsLayout.stagingDir(rootfs);
        deleteRecursive(staging);
        mkdirs(staging);
        log("解包到暂存目录 " + staging.getName() + "（" + (src.length() / 1048576) + " MB，来源="
                + (fromDownload ? "App 内下载" : "/sdcard") + "，格式=" + (isZip ? "zip" : "tar") + "）");

        try {
            ProcessBuilder pb = isZip
                    ? new ProcessBuilder(bb.getAbsolutePath(), "unzip", "-o", "-q",
                            src.getAbsolutePath(), "-d", staging.getAbsolutePath())
                    : new ProcessBuilder(bb.getAbsolutePath(), "tar", "-xzf",
                            src.getAbsolutePath(), "-C", staging.getAbsolutePath());
            pb.redirectErrorStream(true);
            pb.environment().put("LD_LIBRARY_PATH", bin.getAbsolutePath());
            Process p = pb.start();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), "UTF-8"));
            String line; int n = 0;
            while ((line = r.readLine()) != null) { if ((n++ % 500) == 0) log((isZip ? "unzip: " : "tar: ") + line); }
            int rc = p.waitFor();
            log((isZip ? "unzip rc=" : "tar rc=") + rc);
            if (rc != 0) return false;
            // 统一补齐读/执行位（a+rX：目录与本来可执行的文件可执行），避免个别条目丢位导致 EACCES/EPERM。
            try {
                Process c = new ProcessBuilder("/system/bin/chmod", "-R", "a+rX",
                        staging.getAbsolutePath()).redirectErrorStream(true).start();
                int crc = c.waitFor();
                log("chmod -R a+rX rc=" + crc);
            } catch (Throwable t) {
                log("chmod 失败: " + t);
            }
            File ldr = new File(staging, "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1");
            log("loader canExec=" + ldr.canExecute() + " size=" + ldr.length());
            boolean ready = com.whaleonebot.ui.RootfsLayout.isReady(staging);
            if (!ready && isZip) {
                // 实测过的坑：用 Windows 的 Compress-Archive 打的包，条目名里是**反斜杠**，
                // 解出来会变成一个叫 `usr\bin\x` 的怪文件（而不是目录层级）⇒ rootfs 永远不就绪。
                String bad = firstBackslashEntry(staging);
                if (bad != null) {
                    log("!! 包内路径用了反斜杠（示例：" + bad + "），请在 Linux 下用 zip -r 打包，"
                            + "或改用 rootfs.tar.gz");
                }
            }
            if (!ready) {
                log("!! 暂存目录未就绪（包不完整或格式不对），继续用原来的 rootfs");
                return false;
            }
            long stamp = System.currentTimeMillis();
            if (!com.whaleonebot.ui.RootfsLayout.promote(staging, rootfs, stamp)) {
                log("!! 换上新骨架失败，继续用原来的 rootfs");
                return false;
            }
            log("骨架已切换：rootfs 更新，" + com.whaleonebot.ui.RootfsLayout.retiredDir(rootfs, stamp).getName()
                    + " 是换下来的旧副本");
            pruneRetired(rootfs);
            return true;
        } catch (Throwable t) {
            log("!! tar 异常: " + t);
            return false;
        }
    }

    // ------------------------------------------------------------- 工具

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
    private static ProcessBuilder containerBuilder(File files, String cmd) {
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
            if (cmd.contains("container-bot.mjs") || cmd.contains("agent-app/src/server.js")) {
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
