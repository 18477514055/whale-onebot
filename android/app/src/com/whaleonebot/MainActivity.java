package com.whaleonebot;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.widget.Toast;

import com.whaleonebot.ui.AppShell;
import com.whaleonebot.ui.BotRegistry;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 宿主：把「容器 / 登录 / 二维码 / 日志」这些真数据喂给 {@link AppShell}，界面全部由它画。
 *
 * 二维码规则（用户要求）：只有点了「QQ 登录 / 换一张码」之后才认码，
 * 且只认那一刻之后新生成的、没过期的码 —— 旧的宁可不显示。
 */
public class MainActivity extends Activity implements AppShell.Host, com.whaleonebot.ui.BotConfigHost {

    /** 二维码有效期（原生 expireTime 约 120s）。 */
    private static final long QR_TTL_MS = 115000L;

    private AppShell shell;
    private final Handler handler = new Handler(Looper.getMainLooper());
    /** 本进程是否已经拉过运行端索引（一次就够，别每次进前台都发请求）。 */
    private boolean runtimeIndexTried;
    private boolean polling = true;

    /** 点了「QQ 登录 / 换一张码」的时刻；早于它的 qr.png 一律视为旧码。 */
    private long requestAt = 0;
    private Bitmap qrCache;
    private long qrCacheMtime = -1;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!polling) return;
            if (shell != null) shell.refresh();
            handler.postDelayed(this, 1000);
        }
    };

    // ------------------------------------------------------------------ 生命周期

    @Override protected void onCreate(Bundle state) {
        // 原生控件（AlertDialog / Spinner 下拉 / EditText 提示字）要跟深浅主题走，
        // 必须在 super.onCreate 之前定下来；否则浅色主题下弹窗是深底、白字压浅底读不出来。
        com.whaleonebot.ui.ThemeBridge.apply(this);
        super.onCreate(state);
        com.whaleonebot.net.MirrorPrefs.attach(this);
        if (!ContainerService.isRunning()) ContainerService.start(this);
        if (checkSelfPermission("android.permission.READ_EXTERNAL_STORAGE")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{
                    "android.permission.READ_EXTERNAL_STORAGE",
                    "android.permission.WRITE_EXTERNAL_STORAGE"}, 1);
        }
        com.whaleonebot.ui.BotRegistry.init(getFilesDir());
        // [layer: shell-android] 启动远程设备管理器与全量远端快照同步钩子
        final com.whaleonebot.remote.RemoteControlManager remoteMgr = com.whaleonebot.remote.RemoteControlManager.get(this);
        com.whaleonebot.ui.RemoteHostDispatcher dispatcher = new com.whaleonebot.ui.RemoteHostDispatcher(this);
        remoteMgr.startServices(dispatcher, dispatcher);
        remoteMgr.setSnapshotListener((peerId, botsJson, coresJson) -> {
            com.whaleonebot.ui.BotRegistry.applyRemoteSnapshot(peerId, botsJson);
        });
        com.whaleonebot.ui.BotRegistry.setRemotePersistHook(snapshotJson -> {
            try {
                org.json.JSONObject res = remoteMgr.callActiveRpc("bots.syncWrite",
                        new org.json.JSONObject().put("snapshot", snapshotJson), 8000);
                return res.optBoolean("ok", false);
            } catch (Throwable t) {
                return false;
            }
        });
        shell = new AppShell(this, this);
        setContentView(shell.getView());
        handler.post(tick);
        handleDeepLinkIntent(getIntent());
        // Retired runtime archive index is not consulted; the core page uses the signed channel.
        askBatteryExemptionOnce();
        // 被杀之后自爬：排一次系统闹钟（进程死了闹钟仍在）。
        Watchdog.schedule(this);
        // Environment provisioning belongs to the signed core installer.
    }

    /**
     * 请求「忽略电池优化」。
     *
     * <p><b>为什么必须有</b>：2026-11-19 实测被系统杀过一次 ——
     * logcat 里是 {@code SmartPower: com.whaleonebot(13688): died->invisible(638149ms)}，
     * 即**退到后台约 10.6 分钟后被厂商省电策略干掉**（不是腾讯踢下线，也不是崩溃）。
     * 进程一死，容器里的 QQ 与协议端一起没了，表现就是「机器人突然不说话、私聊也不回」。
     * <p>前台服务需要有，但只有进了电池白名单，厂商的省电策略才会真的放过它。
     */
    private void askBatteryExemptionOnce() {
        try {
            String pkg = "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS";
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            if (getSharedPreferences("whale", MODE_PRIVATE).getBoolean("batteryAsked", false)) return;
            getSharedPreferences("whale", MODE_PRIVATE).edit().putBoolean("batteryAsked", true).apply();
            // [layer: shell-android] 改用统一主题底部面板 PromptSheet，清零全仓最后一处原生 AlertDialog。
            com.whaleonebot.ui.PromptSheet.showConfirm(
                    this,
                    "让机器人常驻后台",
                    "系统会在你离开 App 约十分钟后把它杀掉，容器里的 QQ 随之掉线，机器人就不说话了。\n\n"
                            + "点「去设置」把本应用加入「不限制/允许后台运行」，这是机器人能一直在线的必要条件。",
                    "去设置",
                    () -> {
                        try {
                            android.content.Intent i = new android.content.Intent(
                                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                            i.setData(android.net.Uri.parse("package:" + getPackageName()));
                            startActivity(i);
                        } catch (Exception e) {
                            // 厂商可能没有这个页面：退回系统电池优化列表
                            try {
                                startActivity(new android.content.Intent(
                                        android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                            } catch (Exception ignored) { }
                        }
                    },
                    "稍后");
            // 这个常量只在有该权限时才有意义；没有也不影响上面的判断与跳转。
            if (pkg.isEmpty()) android.util.Log.d("WhaleOneBot", "battery exemption requested");
        } catch (Exception e) {
            android.util.Log.e("WhaleOneBot", "battery exemption prompt failed", e);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (shell != null) shell.onResume();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLinkIntent(intent);
    }

    /** 点击系统 QQ 离线高优先级通知后，自动切到对应设备并直达 QQ 启动上线页。 */
    private void handleDeepLinkIntent(Intent intent) {
        if (intent == null || shell == null) return;
        if (!intent.getBooleanExtra("open_qq_login", false)) return;
        intent.removeExtra("open_qq_login");
        String peerId = intent.getStringExtra("open_remote_peer");
        shell.openQqLogin(peerId);
    }

    @Override public void onBackPressed() {
        if (shell == null || !shell.handleBack()) super.onBackPressed();
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (shell == null || !shell.onActivityResult(req, res, data)) super.onActivityResult(req, res, data);
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (shell != null) shell.onRequestPermissionsResult(code, perms, results);
        if (code == 1 && !ContainerService.isRunning()) ContainerService.start(this);
    }

    @Override protected void onDestroy() {
        polling = false;
        handler.removeCallbacks(tick);
        super.onDestroy();
    }

    // ------------------------------------------------------------------ Host

    private com.whaleonebot.remote.RemoteControlManager remoteOrNull() {
        com.whaleonebot.remote.RemoteControlManager m = com.whaleonebot.remote.RemoteControlManager.peek();
        return (m != null && m.isRemote()) ? m : null;
    }

    @Override public boolean containerRunning() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        return r != null ? r.activeSnapshot().containerRunning : ContainerService.isRunning();
    }

    /**
     * 启动容器 —— 之前若没有 rootfs 就静默起不来（新装的包、或只下过环境包没建过容器）。
     * ★ 2026-11-24：先把 APK 自带的环境铺成 rootfs（已就绪则不动），再起容器；
     *   铺不出来就把话说明白，而不是让用户对着「没反应」猜。
     */
    @Override public void startContainer() {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    r.callActiveRpc("container.start", null, 10000);
                    r.triggerSnapshotRefresh();
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("远端启动容器失败：" + t.getMessage()));
                }
            }, "remote-start-c").start();
            return;
        }
        android.util.Log.i("WhaleEnv", "startContainer: 用户点了启动容器");
        new Thread(() -> {
            boolean ok = com.whaleonebot.ui.BundledEnvironment.ensure(this);
            if (!ok) runOnUiThread(() -> toast("运行环境还没准备好：去「设置 → 环境配置」看环境包状态"));
            ContainerService.start(this);
        }, "prepare-environment").start();
    }

    @Override public void stopContainer() {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    r.callActiveRpc("container.stop", null, 10000);
                    r.triggerSnapshotRefresh();
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("远端停止容器失败：" + t.getMessage()));
                }
            }, "remote-stop-c").start();
            return;
        }
        ContainerService.stop(this);
    }

    @Override public com.whaleonebot.ui.QqAuthState qqAuthState() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            return com.whaleonebot.ui.QqAuthState.parseBotJson(r.activeSnapshot().botStateJson);
        }
        return com.whaleonebot.ui.QqAuthState.parseBotJson(ContainerService.readBotStateJson(getFilesDir()));
    }

    @Override public String qrUrl() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) return r.activeSnapshot().qrLive ? r.activeSnapshot().qrUrl : "";
        return qrLive() ? ContainerService.readQrUrl(getFilesDir()) : "";
    }

    @Override public QqCredentialVault.Summary savedCredSummary() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            com.whaleonebot.remote.RemoteControlManager.RemoteSnapshot snap = r.activeSnapshot();
            return new QqCredentialVault.Summary(snap.hasSavedCred, snap.savedCredUin, 0L);
        }
        return QqCredentialVault.summary(this);
    }

    @Override public String loginUin() {
        com.whaleonebot.ui.QqAuthState st = qqAuthState();
        if (st.isOnline()) return st.uin;
        // 兼容旧版未写全 bot.json 时兜底检查快照或 liveProbe，但一旦处于明确的离线/待扫码态绝不伪报已登录
        if (st.isOfflineAlert()) return null;
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) return r.activeSnapshot().loginUin;
        ContainerService.LiveRuntimeProbe probe = ContainerService.probeLiveRuntime(getFilesDir());
        if (probe.onebotAlive || probe.agentAlive) {
            return (probe.uin != null && !probe.uin.isEmpty()) ? probe.uin : identityUin();
        }
        return null;
    }

    @Override public boolean qrLive() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) return r.activeSnapshot().qrLive && r.activeSnapshot().qrBitmap != null;
        File f = qrFile();
        if (!f.isFile()) return false;
        long mtime = f.lastModified();
        if (requestAt > 0 && mtime < requestAt - 2000) return false;
        return System.currentTimeMillis() - mtime <= QR_TTL_MS;
    }

    @Override public Bitmap qrBitmap() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) return r.activeSnapshot().qrLive ? r.activeSnapshot().qrBitmap : null;
        if (!qrLive()) return null;
        File f = qrFile();
        long mtime = f.lastModified();
        if (qrCache == null || mtime != qrCacheMtime) {
            try {
                qrCache = BitmapFactory.decodeFile(f.getAbsolutePath());
                qrCacheMtime = mtime;
            } catch (Throwable t) {
                qrCache = null;
            }
        }
        return qrCache;
    }

    @Override public long qrLeftSeconds() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) return r.activeSnapshot().qrLive ? r.activeSnapshot().qrLeftSeconds : 0;
        File f = qrFile();
        if (!f.isFile() || !qrLive()) return 0;
        long age = System.currentTimeMillis() - f.lastModified();
        return Math.max(0, (QR_TTL_MS - age) / 1000);
    }

    /**
     * 「QQ 登录 / 换一张码」：已登录就只提示（不必再出码）；
     * 否则丢掉旧码、记下时刻，让容器里的登录进程去要一张新的。
     */
    @Override public void requestQr() {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    org.json.JSONObject res = r.callActiveRpc("login.requestQr", null, 10000);
                    final String msg = res.optString("msg", "已向远端请求 1 张新二维码");
                    runOnUiThread(() -> toast(msg));
                    r.triggerSnapshotRefresh();
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("请求远端二维码失败：" + t.getMessage()));
                }
            }, "remote-req-qr").start();
            return;
        }
        com.whaleonebot.ui.QqAuthState st = qqAuthState();
        if (st.isOnline()) {
            toast("当前已在线（" + st.uin + "），如需重登请先点「强制重登」或「安全下线」");
            return;
        }
        File f = qrFile();
        if (f.isFile()) f.delete();
        new File(qqStateDir(), "qr.url").delete();
        qrCache = null;
        qrCacheMtime = -1;
        requestAt = System.currentTimeMillis();
        boolean wasRunning = ContainerService.isRunning();
        if (!wasRunning) {
            ContainerService.start(this);
            toast("正在启动容器并按需请求 1 张新二维码…");
        } else {
            toast("正在向 QQ 按需请求 1 张新二维码…");
        }
        ContainerService.startLogin(this);
    }

    @Override public void passwordLogin(final String uin, final String password, final boolean remember) {
        final String cleanUin = uin == null ? "" : uin.trim();
        if (!cleanUin.matches("[1-9][0-9]{4,15}") || password == null || password.isEmpty()) {
            toast("请输入有效的机器人 QQ 号和密码");
            return;
        }
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    org.json.JSONObject params = new org.json.JSONObject()
                            .put("uin", cleanUin)
                            .put("password", password)
                            .put("remember", remember);
                    org.json.JSONObject res = r.callActiveRpc("login.password", params, 12000);
                    final String msg = res.optString("msg", "已提交账密登录");
                    runOnUiThread(() -> toast(msg));
                    r.triggerSnapshotRefresh();
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("远端账密登录提交失败：" + t.getMessage()));
                }
            }, "remote-pwd-login").start();
            return;
        }
        if (remember) QqCredentialVault.save(this, cleanUin, password);
        if (!ContainerService.isRunning()) ContainerService.start(this);
        if (!ContainerService.botRunning(this)) ContainerService.startBot(this);
        try {
            ContainerService.sendBotCommand(this, new org.json.JSONObject()
                    .put("action", "password_login")
                    .put("uin", cleanUin)
                    .put("password", password)
                    .put("at", System.currentTimeMillis()));
            toast("正在提交账密登录（密码绝不打日志）…");
        } catch (Throwable ex) {
            toast("提交账密登录失败：" + ex.getMessage());
        }
    }

    @Override public void quickSavedPasswordLogin() {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    org.json.JSONObject res = r.callActiveRpc("login.savedPassword", null, 12000);
                    final String msg = res.optString("msg", "正在触发远端一键账密重登");
                    runOnUiThread(() -> toast(msg));
                    r.triggerSnapshotRefresh();
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("远端一键重登失败：" + t.getMessage()));
                }
            }, "remote-saved-login").start();
            return;
        }
        QqCredentialVault.SavedCredential cred = QqCredentialVault.load(this);
        if (cred == null) {
            toast("尚未记住密码，请先输入一次并勾选记住密码");
            return;
        }
        passwordLogin(cred.uin, cred.password, false);
    }

    @Override public void forgetSavedPassword() {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    r.callActiveRpc("login.forgetSavedPassword", null, 8000);
                    r.triggerSnapshotRefresh();
                    runOnUiThread(() -> toast("已清除远端记住的加密密码"));
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("清除远端密码失败：" + t.getMessage()));
                }
            }, "remote-forget-pwd").start();
            return;
        }
        QqCredentialVault.clear(this);
        toast("已清除本机记住的加密密码");
    }

    @Override public void submitCaptcha(final String ticket, final String randStr, final String sid) {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    org.json.JSONObject params = new org.json.JSONObject()
                            .put("ticket", ticket == null ? "" : ticket)
                            .put("randStr", randStr == null ? "" : randStr)
                            .put("sid", sid == null ? "" : sid);
                    org.json.JSONObject res = r.callActiveRpc("login.submitCaptcha", params, 12000);
                    final String msg = res.optString("msg", "验证票据已回传给远端");
                    runOnUiThread(() -> toast(msg));
                    r.triggerSnapshotRefresh();
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("回传验证票据失败：" + t.getMessage()));
                }
            }, "remote-captcha").start();
            return;
        }
        try {
            ContainerService.sendBotCommand(this, new org.json.JSONObject()
                    .put("action", "submit_captcha")
                    .put("ticket", ticket == null ? "" : ticket)
                    .put("randStr", randStr == null ? "" : randStr)
                    .put("sid", sid == null ? "" : sid)
                    .put("at", System.currentTimeMillis()));
            toast("已提交安全验证结果，请稍候…");
        } catch (Throwable ex) {
            toast("提交安全验证失败：" + ex.getMessage());
        }
    }

    @Override public void qqSessionAction(final String action, final boolean clearSavedCred, final String mode) {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            final String rpc = "switch_account".equals(action) ? "login.switchAccount"
                    : ("force_relogin".equals(action) ? "login.forceRelogin" : "login.safeLogout");
            new Thread(() -> {
                try {
                    org.json.JSONObject params = new org.json.JSONObject()
                            .put("clearSavedCred", clearSavedCred)
                            .put("mode", mode == null ? "" : mode);
                    r.callActiveRpc(rpc, params, 12000);
                    r.triggerSnapshotRefresh();
                    runOnUiThread(() -> toast("已向远端下发操作指令"));
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("远端操作失败：" + t.getMessage()));
                }
            }, "remote-sess-act").start();
            return;
        }
        if (clearSavedCred) QqCredentialVault.clear(this);
        if ("force_relogin".equals(action) && "qr".equals(mode)) {
            requestAt = System.currentTimeMillis();
        }
        try {
            ContainerService.sendBotCommand(this, new org.json.JSONObject()
                    .put("action", action)
                    .put("mode", mode == null ? "" : mode)
                    .put("at", System.currentTimeMillis()));
            toast("已发送指令，聊天与记忆数据已安全保留");
        } catch (Throwable ex) {
            toast("发送指令失败：" + ex.getMessage());
        }
    }

    @Override public void wakeQqSession() {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    org.json.JSONObject res = r.callActiveRpc("login.wakeSession", null, 8000);
                    final String msg = res.optString("msg", "已触发远端温和重连");
                    runOnUiThread(() -> toast(msg));
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("温和重连指令失败：" + t.getMessage()));
                }
            }, "remote-wake").start();
            return;
        }
        try {
            ContainerService.sendBotCommand(this, new org.json.JSONObject()
                    .put("action", "wake_session").put("reason", "manual").put("at", System.currentTimeMillis()));
            toast("已触发进程内温和重连唤醒（不杀进程）");
        } catch (Throwable ex) {
            toast("温和重连失败：" + ex.getMessage());
        }
    }

    @Override public void openMobileQqAuth(String url) {
        if (!com.whaleonebot.ui.QqAuthState.isSafeHttpsTencentUrl(url)) {
            toast("当前没有有效的 QQ 授权链接，请先点「获取授权 / 二维码」");
            return;
        }
        String deep = com.whaleonebot.ui.QqAuthState.buildMobileQqDeepLink(url);
        if (!deep.isEmpty()) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(deep));
                i.setPackage("com.tencent.mobileqq");
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                toast("正在拉起手机 QQ 确认登录…");
                return;
            } catch (Throwable ignored) {
                // 本机未装手机 QQ 或系统拒接 mqqapi：平滑退回直接打开 https://txz.qq.com/p?k=...
            }
        }
        try {
            Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(web);
            toast("已打开腾讯官方登录授权页");
        } catch (Throwable ex) {
            toast("无法拉起手机 QQ 或浏览器，请复制链接或使用相机扫码");
        }
    }

    @Override public String loginLog(int lines) {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            String s = r.activeSnapshot().loginLog;
            return (s == null || s.isEmpty()) ? "（远端暂无运行日志）" : s;
        }
        File botLog = new File(qqStateDir(), "bot.log");
        return botLog.isFile() ? tail(botLog, lines) : tail(new File(qqStateDir(), "login.log"), lines);
    }

    @Override public String containerLog(int lines) {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            String s = r.activeSnapshot().containerLog;
            return (s == null || s.isEmpty()) ? "（远端暂无容器日志）" : s;
        }
        return tail(new File(getFilesDir(), "logs/container.log"), lines);
    }

    @Override public void restartQqOnly() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    r.callActiveRpc("container.restartQq", null, 15000);
                    r.triggerSnapshotRefresh();
                    runOnUiThread(() -> toast("已触发远端仅重启 QQ 通道"));
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("远端重启 QQ 失败：" + t.getMessage()));
                }
            }, "remote-restart-qq").start();
            return;
        }
        ContainerService.restartQqOnly(this);
        toast("正在重启 QQ 通道（不影响 B 站与容器主进程）…");
    }

    @Override public void restartFullContainer() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        if (r != null) {
            new Thread(() -> {
                try {
                    r.callActiveRpc("container.restartFull", null, 20000);
                    r.triggerSnapshotRefresh();
                    runOnUiThread(() -> toast("已触发远端整容器全链路重启"));
                } catch (Throwable t) {
                    runOnUiThread(() -> toast("远端整容器重启失败：" + t.getMessage()));
                }
            }, "remote-restart-all").start();
            return;
        }
        ContainerService.restartFullContainer(this);
        toast("正在执行整容器全链路重启（关闭 QQ → 重启容器 → 启动 QQ）…");
    }

    @Override public String networkDiagnosticSummary() {
        if (remoteOrNull() != null) return "远程控制中";
        return ContainerService.networkDiagnosticSummary(this);
    }

    @Override public String blackboxLog(int lines) {
        File f = new File(qqStateDir(), "blackbox.log");
        if (!f.isFile()) return "（暂无防掉线黑匣子记录，发生 -10004 / 140022015 / 被踢下线时会自动落盘最近 120 条诊断上下文）";
        return tail(f, lines);
    }

    @Override public void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    /** 把当前这张有效二维码存进相册（本机与远程模式均支持保存当前展示的二维码到手里这台手机相册）。 */
    @Override public void saveQrToAlbum() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        byte[] remotePng = (r != null && r.activeSnapshot().qrLive) ? r.activeSnapshot().qrPngBytes : null;
        File src = qrFile();
        if (remotePng == null && (!qrLive() || !src.isFile())) { toast("当前没有有效二维码"); return; }
        String name = "qq-login-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".png";
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/WhaleOneBot");
                v.put(MediaStore.Images.Media.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri != null) {
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (remotePng != null) {
                            out.write(remotePng);
                        } else {
                            try (InputStream in = new FileInputStream(src)) {
                                byte[] buf = new byte[65536];
                                int n;
                                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                            }
                        }
                    }
                    v.clear();
                    v.put(MediaStore.Images.Media.IS_PENDING, 0);
                    getContentResolver().update(uri, v, null, null);
                    toast("已保存到相册 Pictures/WhaleOneBot/" + name + "，去 QQ 扫一扫里选「相册」");
                    return;
                }
            }
            File dir = new File(Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_PICTURES), "WhaleOneBot");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("无法创建相册目录");
            File dst = new File(dir, name);
            try (OutputStream out = new FileOutputStream(dst)) {
                if (remotePng != null) {
                    out.write(remotePng);
                } else {
                    try (InputStream in = new FileInputStream(src)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    }
                }
            }
            sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(dst)));
            toast("已保存到相册 " + dst.getAbsolutePath());
        } catch (Throwable t) {
            toast("保存失败：" + t.getMessage());
        }
    }

    /**
     * 启动后拉一次运行端索引（后台线程，失败静默）。
     *
     * <p>为什么要自己拉：索引决定「内置运行端」下载哪一版，它一变就不该再让用户重装 APK。
     * 这里只更新磁盘缓存，页面下次打开自然读到；没配索引地址时整段是空操作。
     */
    private void refreshRuntimeIndexOnce() {
        if (runtimeIndexTried) return;
        runtimeIndexTried = true;
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    com.whaleonebot.ui.RuntimeIndex.refresh(MainActivity.this, 8000);
                } catch (Throwable ignored) {
                    // 索引拿不到不影响任何已有功能
                }
            }
        }, "runtime-index").start();
    }

    // ------------------------------------------------------------------ BotConfigHost
    /**
     * 运行端实际读取的那一份配置（容器里 {@code /agent/data/config.json} 对应的宿主文件）。
     * 只有「当前运行的机器人」用它 —— 其余机器人各有一份自己的。
     */
    private File liveConfigFile() {
        return new File(getFilesDir(), "rootfs/agent/data/config.json");
    }

    /**
     * 某个机器人自己的运行端配置：{@code rootfs/agent/data/bots/<botId>/config.json}。
     *
     * <p>用户 2026-11-19 要求的「所有机器人共用一份 runtime config 修一下」：容器里同时只跑
     * 一个运行端，所以**活配置**必须还是一份；分家的做法是「每个机器人各存一份，运行时的那份
     * 就是它自己的」。当前运行的机器人（{@link BotRegistry#primary()}）直接读写活配置，
     * 零迁移风险；其它机器人读写自己的文件，第一次打开时从活配置**播种**一份副本。
     */
    private File botConfigFile(String botId) {
        String core=InstalledRuntimeHost.core(getFilesDir(),botId);if(core!=null)return new File(InstalledRuntimeHost.data(getFilesDir(),core),"config.json");
        return new File(new File(getFilesDir(), "rootfs/agent/data/bots/" + safeBotId(botId)),
                "config.json");
    }

    /** botId 直接当目录名要防穿越：只留字母数字与 {@code -_}。 */
    private static String safeBotId(String id) {
        String s = id == null ? "" : id.trim();
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length() && b.length() < 64; i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '-' || c == '_';
            b.append(ok ? c : '_');
        }
        return b.length() == 0 ? "default" : b.toString();
    }

    /** 当前面板正在给哪个机器人改配置（页面栈顶的 arg，取不到就退回主机器人）。 */
    private String configScope() {
        if (shell == null) return "";
        try {
            String id = shell.currentBotId();
            return id == null ? "" : id;
        } catch (Throwable t) {
            return "";
        }
    }

    /** 这个机器人是不是「正在跑的那个」（只有它能碰活配置）。 */
    private boolean isLiveBot(String botId) {
        BotRegistry.Bot p = BotRegistry.primary();
        if (p == null || p.id == null || p.id.length() == 0) return true;
        String use = (botId == null || botId.length() == 0) ? p.id : botId;
        return use.equals("whale-1") && BindingControl.legacy(getFilesDir(),false);
    }

    private final java.util.concurrent.ConcurrentHashMap<String, String> remoteConfigCache =
            new java.util.concurrent.ConcurrentHashMap<String, String>();
    private final java.util.concurrent.ConcurrentHashMap<String, Long> remoteConfigAt =
            new java.util.concurrent.ConcurrentHashMap<String, Long>();

    @Override public String loadConfigJson() {
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        final String bot = configScope();
        if (r != null) {
            final String peerId = r.activePeerId();
            final String cacheKey = (peerId == null ? "" : peerId) + "|" + bot;
            final String cached = remoteConfigCache.get(cacheKey);
            final long prevAt = remoteConfigAt.containsKey(cacheKey) ? remoteConfigAt.get(cacheKey) : 0L;
            final long ttl = r.isCurrentChannelFast() ? 4000L : 15_000L;
            // 方案 A：命中远端配置缓存时 0ms 秒开配置页，同时在后台静默拉取最新版覆盖缓存
            if (cached != null) {
                if (System.currentTimeMillis() - prevAt >= ttl) {
                    new Thread(() -> {
                        try {
                            org.json.JSONObject res = r.callActiveRpc("config.load",
                                    new org.json.JSONObject().put("botId", bot), 8000);
                            String fresh = res.optString("json", null);
                            if (fresh != null && peerId != null && peerId.equals(r.activePeerId())) {
                                remoteConfigCache.put(cacheKey, fresh);
                                remoteConfigAt.put(cacheKey, System.currentTimeMillis());
                            }
                        } catch (Throwable ignored) {}
                    }, "remote-cfg-swr").start();
                }
                return cached;
            }
            final String[] holder = new String[1];
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            new Thread(() -> {
                try {
                    org.json.JSONObject res = r.callActiveRpc("config.load",
                            new org.json.JSONObject().put("botId", bot), 8000);
                    holder[0] = res.optString("json", "{}");
                } catch (Throwable ignored) {
                    holder[0] = null;
                } finally {
                    latch.countDown();
                }
            }, "remote-cfg-load").start();
            try { latch.await(8500, java.util.concurrent.TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}
            if (holder[0] != null) {
                remoteConfigCache.put(cacheKey, holder[0]);
                remoteConfigAt.put(cacheKey, System.currentTimeMillis());
            }
            return holder[0];
        }
        if (isLiveBot(bot)) return readUtf8(liveConfigFile());
        File f = botConfigFile(bot);
        if (!f.isFile()) {
            // Never clone legacy provider secrets or OneBot tokens into another runtime.
            return "{}";
        }
        return readUtf8(f);
    }

    @Override public boolean saveConfigJson(final String json) {
        if (json == null || json.isEmpty()) return false;
        final com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        final String bot = configScope();
        if (r != null) {
            final String peerId = r.activePeerId();
            final String cacheKey = (peerId == null ? "" : peerId) + "|" + bot;
            final boolean[] ok = new boolean[1];
            final boolean[] reloaded = new boolean[1];
            final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
            new Thread(() -> {
                try {
                    org.json.JSONObject res = r.callActiveRpc("config.save",
                            new org.json.JSONObject().put("botId", bot).put("json", json), 15000);
                    ok[0] = res.optBoolean("ok", false);
                    reloaded[0] = res.optBoolean("reloaded", false);
                } catch (Throwable ignored) {
                } finally {
                    latch.countDown();
                }
            }, "remote-cfg-save").start();
            try { latch.await(15500, java.util.concurrent.TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}
            if (ok[0]) {
                remoteConfigCache.put(cacheKey, json);
                remoteConfigAt.put(cacheKey, System.currentTimeMillis());
                toast(reloaded[0] ? "已保存到远端并热重载生效" : "已保存到远端设备");
            } else {
                toast("保存到远端失败，请检查远程连接");
            }
            return ok[0];
        }
        if (!isLiveBot(bot)) {
            // 不是当前运行的机器人：只写它自己那份，不重载（活配置里没有它）
            File own = botConfigFile(bot);
            if (!writeUtf8Quietly(own, json)) return false;
            BotRegistry.Bot b = BotRegistry.get(bot);
            String name = b == null ? bot : b.name;
            toast("已存入「" + name + "」；它不是当前运行的机器人，启动它才生效");
            return true;
        }

        File f = liveConfigFile();
        File tmp = new File(f.getParentFile(), "config.json.next");
        try {
            // 先写临时文件再原子替换：中途失败不会把运行端配置写坏。
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(json.getBytes("UTF-8"));
                out.getFD().sync();
            }
            if (!tmp.renameTo(f)) {
                // rename 失败（极少见）就退回直接覆盖
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(json.getBytes("UTF-8"));
                }
                tmp.delete();
            }
            // 活配置的那份也同步存进「这个机器人自己的目录」，将来它不再是主机器人时不会丢
            writeUtf8Quietly(botConfigFile(bot), json);
            requestAgentConfigReload(json);
            return true;
        } catch (Throwable t) {
            tmp.delete();
            return false;
        }
    }

    /** 读一个 UTF-8 文本文件；不存在 / 读失败返回 null。 */
    private static String readUtf8(File f) {
        if (f == null || !f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 8 * 1024 * 1024) break;
            }
            return new String(out.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return null;
        }
    }

    /** 原子写一个 UTF-8 文本文件（临时文件 + rename）；失败返回 false。 */
    private static boolean writeUtf8Quietly(File f, String text) {
        try {
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return false;
            File tmp = new File(dir, f.getName() + ".next");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(text.getBytes("UTF-8"));
                out.getFD().sync();
            }
            if (tmp.renameTo(f)) return true;
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(text.getBytes("UTF-8"));
            }
            tmp.delete();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 让运行端把刚写进磁盘的配置**重新读进内存**。
     *
     * 运行端没有任何 config.json 的文件监听（已核对：其源码里 0 处 fs.watch / watchFile），
     * 而我们这条链路是「App 直接改文件」，所以不主动喊一声的话，用户在面板上改的东西
     * 要等到下次重启运行端才生效 —— 那正是「我改了每群回复概率，它还是不理我」的由来。
     * 控制台路由 <code>POST /api/config/reload</code> 就是干这个的（重读磁盘 + 重排各子系统）。
     * 无令牌时它的 authorize() 只放行「远端是回环 + Host 头是 127.0.0.1/localhost」，所以这里手写 Host 头。
     * 重载失败不改返回值（保存本身是成功的），只用 toast 如实说明「已保存但没热生效」。
     */
    private void requestAgentConfigReload(final String savedJson) {
        if (!ContainerService.botRunning(this)) return; // 没在跑就没有内存态可重载，下次启动自然读到新配置
        final int port = agentConsolePort(savedJson);
        new Thread(new Runnable() {
            @Override public void run() {
                String detail = "";
                boolean ok = false;
                HttpURLConnection c = null;
                try {
                    URL url = new URL("http://127.0.0.1:" + port + "/api/config/reload");
                    c = (HttpURLConnection) url.openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(20000);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(0);
                    c.setRequestProperty("Host", "127.0.0.1:" + port);
                    c.setRequestProperty("Content-Type", "application/json");
                    c.getOutputStream().close();
                    int code = c.getResponseCode();
                    ok = code == 200;
                    detail = "HTTP " + code;
                    if (!ok) {
                        InputStream err = c.getErrorStream();
                        if (err != null) {
                            try {
                                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                                byte[] b = new byte[4096];
                                int n;
                                while ((n = err.read(b)) > 0 && buf.size() < 65536) buf.write(b, 0, n);
                                String body = new String(buf.toByteArray(), "UTF-8").trim();
                                if (body.length() > 0) detail += " " + body;
                            } finally {
                                err.close();
                            }
                        }
                    }
                } catch (Throwable t) {
                    detail = String.valueOf(t.getMessage());
                } finally {
                    if (c != null) c.disconnect();
                }
                final String msg = ok
                        ? "已保存，运行端已重载（立即生效）"
                        : "已保存，但运行端重载失败（" + detail + "），改动要重启运行端才生效";
                runOnUiThread(new Runnable() {
                    @Override public void run() { toast(msg); }
                });
            }
        }, "cfg-reload").start();
    }

    /**
     * 控制台端口：从刚写下的这份 JSON 里取 {@code server.port}，取不到就退回手机端的既定端口。
     *
     * <p>这里故意只用正则而<b>不用 {@code BotConfigJson}</b>：那是 {@code com.whaleonebot.ui} 包里的
     * 包私有类，跨包引用编不过；为了读一个端口号去把它改成 public 会把「解析器」的口子开给所有包，不值得。
     */
    private int agentConsolePort(String json) {
        try {
            if (json != null) {
                int at = json.indexOf("\"server\"");
                if (at >= 0) {
                    java.util.regex.Matcher m = java.util.regex.Pattern
                            .compile("\"port\"\\s*:\\s*(\\d{1,5})")
                            .matcher(json);
                    m.region(at, json.length());
                    if (m.find()) {
                        int port = Integer.parseInt(m.group(1));
                        if (port > 0 && port < 65536) return port;
                    }
                }
            }
        } catch (Throwable ignored) {
            // 落到默认端口
        }
        return 41907;
    }

    @Override public boolean botRunning() {
        com.whaleonebot.remote.RemoteControlManager r = remoteOrNull();
        return r != null ? r.activeSnapshot().botRunning : ContainerService.botRunning(this);
    }

    // ------------------------------------------------------------------ 工具

    private File qqStateDir() { return new File(getFilesDir(), "rootfs/opt/whale/qq-state"); }

    private File qrFile() { return new File(qqStateDir(), "qr.png"); }

    /** 已登录的 uin；identity.json 不存在/读不出就返回 null。 */
    private String identityUin() {
        String s = readText(new File(qqStateDir(), "identity.json"));
        int i = s.indexOf("\"uin\":\"");
        if (i < 0) return null;
        int j = s.indexOf('"', i + 7);
        return j > i ? s.substring(i + 7, j) : null;
    }

    static String readText(File f) {
        if (f == null || !f.isFile()) return "";
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 65536) break;
            }
            return new String(out.toByteArray(), "UTF-8").trim();
        } catch (Throwable t) {
            return "";
        }
    }

    static String tail(File f, int n) {
        if (f == null || !f.isFile()) return "（暂无日志）";
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long len = raf.length();
            int take = (int) Math.min(len, 32 * 1024);
            raf.seek(len - take);
            byte[] buf = new byte[take];
            raf.readFully(buf);
            String s = new String(buf, "UTF-8");
            String[] lines = s.split("\n");
            int from = Math.max(0, lines.length - n);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < lines.length; i++) sb.append(lines[i]).append('\n');
            return sb.toString();
        } catch (Exception e) {
            return "（读日志失败：" + e.getMessage() + "）";
        }
    }

}
