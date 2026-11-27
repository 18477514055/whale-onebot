package com.whaleonebot.ui;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import com.whaleonebot.ContainerService;
import com.whaleonebot.Watchdog;
import com.whaleonebot.backup.CoreBackupSaf;
import com.whaleonebot.install.CoreInstaller;
import com.whaleonebot.remote.RemoteCrypto;
import com.whaleonebot.remote.RemoteTransport;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * [layer: shell-android] 被控端全量 RPC 路由器与双向文件流处理器（覆盖全部 36 个界面的远程完全控制）。
 *
 * <p>严格遵守安全与 P13 纪律：
 * <ul>
 *   <li>仅在端到端加密且通过双向公钥认证的会话内分发请求；</li>
 *   <li>绝不将任何配置 Key、Cookie、Token 打印到日志；</li>
 *   <li>核心更新/插件切换静默完成；远端 App APK 下载校验后在远端拉起安装确认通知（守 Android 非 Root 限制）。</li>
 * </ul>
 */
public final class RemoteHostDispatcher implements RemoteTransport.RpcHandler, RemoteTransport.StreamReceiver {

    private static final long QR_TTL_MS = 115_000L;
    private static final String CHANNEL_UPDATE = "whale-remote-update";

    private final Context ctx;
    private volatile long qrRequestedAt = 0L;
    private final Map<String, Runnable> biliEnrollCancels = new ConcurrentHashMap<String, Runnable>();

    public RemoteHostDispatcher(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    @Override
    public String handleRpc(String method, String paramsJson, RemoteTransport.Session session) throws Exception {
        JSONObject p = (paramsJson == null || paramsJson.trim().isEmpty())
                ? new JSONObject() : new JSONObject(paramsJson);
        switch (method) {
            case "system.snapshot":
                return handleSystemSnapshot(p);
            case "container.start":
                return handleContainerStart();
            case "container.stop":
                ContainerService.stop(ctx);
                return "{\"ok\":true}";
            case "container.restartQq":
                ContainerService.restartQqOnly(ctx);
                return "{\"ok\":true}";
            case "container.hotReconnectQq":
                ContainerService.hotReconnectQq(ctx);
                return "{\"ok\":true}";
            case "container.restartAgent":
                try {
                    int port = DashApi.localPort(ctx);
                    DashApi.postLocal(port, "/api/config/reload", "{}", 10000);
                } catch (Throwable ignored) {}
                return "{\"ok\":true}";
            case "container.restartFull":
                ContainerService.restartFullContainer(ctx);
                return "{\"ok\":true}";
            case "login.requestQr":
                return handleRequestQr();
            case "login.password":
                return handlePasswordLogin(p);
            case "login.savedPassword":
                return handleSavedPasswordLogin();
            case "login.forgetSavedPassword":
                return new JSONObject().put("ok", com.whaleonebot.QqCredentialVault.clear(ctx)).toString();
            case "login.submitCaptcha":
                return handleSubmitCaptcha(p);
            case "login.safeLogout":
                return handleSessionAction("safe_logout", p);
            case "login.switchAccount":
                return handleSessionAction("switch_account", p);
            case "login.forceRelogin":
                return handleSessionAction("force_relogin", p);
            case "login.wakeSession":
                return handleWakeSession();
            case "watchdog.set":
                Watchdog.setEnabled(ctx, p.optBoolean("enabled", true));
                if (p.optBoolean("enabled", true) && !ContainerService.isRunning()) ContainerService.start(ctx);
                return new JSONObject().put("enabled", Watchdog.isEnabled(ctx)).toString();

            // ---- 机器人与绑定管理 ----
            case "bots.syncWrite": {
                boolean ok = BotRegistry.applyIncomingRemoteSnapshot(p.optString("snapshot", ""));
                return new JSONObject().put("ok", ok).toString();
            }
            case "bots.setBindingToken":
                ContainerService.setBindingToken(ctx, p.optString("botId"), p.optString("bindingId"), p.optString("token"));
                return "{\"ok\":true}";
            case "bots.start":
                ContainerService.startBoundBot(ctx, p.optString("botId"));
                return "{\"ok\":true}";
            case "bots.startBot":
                ContainerService.startBot(ctx);
                return "{\"ok\":true}";
            case "bots.stop":
                ContainerService.stopBoundBot(p.optString("botId"));
                return "{\"ok\":true}";
            case "bots.startPlatform":
                ContainerService.startInstalledPlatform(ctx, p.optString("botId"), p.optString("platform"));
                return "{\"ok\":true}";
            case "bots.stopPlatform":
                ContainerService.stopInstalledPlatform(ctx, p.optString("botId"), p.optString("platform"));
                return "{\"ok\":true}";
            case "bots.stopBinding":
                ContainerService.stopInstalledBinding(p.optString("botId"), p.optString("bindingId"));
                return "{\"ok\":true}";
            case "bots.bindingStatus":
                return ContainerService.bindingStatus(ctx, p.optString("botId")).toString();

            // ---- B 站远程登录与运维 ----
            case "bili.status":
                return handleBiliStatus(p);
            case "bili.enroll":
                return handleBiliEnroll(p);
            case "bili.enrollCancel":
                return handleBiliEnrollCancel(p);
            case "bili.start":
                ContainerService.startBiliProtocol(ctx, p.optString("botId"), p.optString("bindingId"), p.optString("peer"));
                return "{\"ok\":true}";
            case "bili.restart":
                ContainerService.restartBiliProtocol(ctx, p.optString("botId"), p.optString("bindingId"), p.optString("peer"));
                return "{\"ok\":true}";
            case "bili.blackbox":
                return new JSONObject().put("log", ContainerService.biliBlackboxLog(p.optInt("lines", 80))).toString();
            case "bili.importCookie":
                return ContainerService.importBiliCookie(
                        ctx,
                        p.optString("botId"),
                        p.optString("bindingId"),
                        p.optString("expectedUid", ""),
                        p.optBoolean("newSlot", false),
                        p.optString("rawCookie", ""),
                        p.optString("acTimeValue", "")
                ).toString();
            case "bili.stop":
                ContainerService.stopBiliProtocol(p.optString("botId"), p.optString("bindingId"));
                return "{\"ok\":true}";
            case "bili.reauthorize":
                ContainerService.reauthorizeBiliProtocol(ctx, p.optString("botId"), p.optString("bindingId"), p.optString("peer"));
                return "{\"ok\":true}";
            case "bili.forget":
                return new JSONObject().put("ok", ContainerService.forgetBiliSession(ctx, p.optString("botId"), p.optString("bindingId"))).toString();
            case "bili.settingsGet":
                return BiliSettings.get(ctx, p.optString("botId"), p.optString("bindingId")).toString();
            case "bili.settingsSet":
                BiliSettings.put(ctx, p.optString("botId"), p.optString("bindingId"),
                        new JSONObject(p.optString("json", "{}")));
                return "{\"ok\":true}";
            case "bili.actionLog":
                return handleBiliActionLog(p);

            // ---- 抖音全量远程登录、保活校验与策略 ----
            case "douyin.summary":
                return DouyinSettings.sessionSummary(ctx, p.optString("botId", "default")).toJson().toString();
            case "douyin.importCookie": {
                com.whaleonebot.DouyinSessionStore.Summary s =
                        com.whaleonebot.DouyinSessionVerifier.saveAndVerify(
                                ctx, p.optString("botId", "default"), p.optString("rawCookie", ""));
                return new DouyinSettings.SessionSummary(s.saved, s.verified, s.savedAt, s.lastCheckAt,
                        s.cookieFieldCount, s.hasSessionId, s.uid, s.nickname, s.state, s.lastError).toJson().toString();
            }
            case "douyin.probe": {
                com.whaleonebot.DouyinSessionStore.Summary s =
                        com.whaleonebot.DouyinSessionVerifier.probeOnce(ctx, p.optString("botId", "default"));
                return new DouyinSettings.SessionSummary(s.saved, s.verified, s.savedAt, s.lastCheckAt,
                        s.cookieFieldCount, s.hasSessionId, s.uid, s.nickname, s.state, s.lastError).toJson().toString();
            }
            case "douyin.forget":
                return new JSONObject().put("ok", DouyinSettings.forgetWebSession(ctx, p.optString("botId", "default"))).toString();
            case "douyin.blackbox":
                return new JSONObject().put("log", com.whaleonebot.DouyinSessionVerifier.blackboxLog(p.optInt("lines", 60))).toString();
            case "douyin.configGet":
                return DouyinSettings.loadConfig(ctx.getFilesDir(), p.optString("botId", "default")).toJson().toString();
            case "douyin.configSet":
                return new JSONObject().put("ok", DouyinSettings.saveConfig(
                        ctx.getFilesDir(), p.optString("botId", "default"),
                        DouyinSettings.Config.fromJson(p.optJSONObject("config")))).toString();
            case "douyin.queueGet": {
                JSONArray arr = new JSONArray();
                for (String item : DouyinSettings.listCandidates(ctx.getFilesDir(), p.optString("botId", "default"))) {
                    arr.put(item);
                }
                return new JSONObject().put("items", arr).toString();
            }
            case "douyin.queueAdd":
                return new JSONObject().put("ok", DouyinSettings.enqueueCandidate(
                        ctx.getFilesDir(), p.optString("botId", "default"), p.optString("url", ""))).toString();
            case "douyin.queueClear":
                return new JSONObject().put("ok", DouyinSettings.clearCandidates(
                        ctx.getFilesDir(), p.optString("botId", "default"))).toString();

            // ---- 运行端配置（端到端加密完整读写含 API Key，严禁打日志） ----
            case "config.load":
                return handleConfigLoad(p);
            case "config.save":
                return handleConfigSave(p);

            // ---- 看板 10 子页与待对账（DashApi 回环代理） ----
            case "dash.get":
                return handleDashGet(p);
            case "dash.post":
                return handleDashPost(p);

            // ---- 知识库 ----
            case "kb.load":
                return handleKbLoad();
            case "kb.saveLibs":
                return handleKbSaveLibs(p);
            case "kb.saveEnv":
                return handleKbSaveEnv(p);

            // ---- 环境配置与 QQ 客户端 ----
            case "env.status":
                return handleEnvStatus();
            case "env.ensureBundled":
                return new JSONObject().put("ok", BundledEnvironment.ensure(ctx)).toString();
            case "env.scanQqDebs":
                return handleScanQqDebs();
            case "env.installQqDeb":
                return handleInstallQqDeb(p);
            case "env.downloadQqOfficial":
                return handleDownloadQqOfficial();

            // ---- 核心、插件与版本管理 ----
            case "cores.download":
                return handleCoresDownload(p);
            case "cores.downloadStatus":
                return handleCoresDownloadStatus();
            case "cores.pluginStage":
                return handleCoresPluginStage(p);
            case "cores.storage":
                return handleCoresStorage(p);
            case "version.status":
                return handleVersionStatus();
            case "version.setAuto":
                CoreInstaller.setAuto(ctx.getFilesDir(), p.optBoolean("enabled", false));
                return "{\"ok\":true}";
            case "version.downloadAppApk":
                return handleVersionDownloadAppApk(p);

            // ---- 备份维护 ----
            case "backup.releaseCore":
                CoreBackupSaf.release(ctx, p.optString("coreId"), p.optString("botId"));
                return "{\"ok\":true}";
            case "backup.recoverPending":
                CoreBackupSaf.recoverPending(ctx, p.optString("coreId"));
                return "{\"ok\":true}";

            default:
                throw new UnsupportedOperationException("未知远程方法：" + method);
        }
    }

    // ------------------------------------------------------------------ 双向加密流（备份 & QQ .deb 互传）

    @Override
    public void onUploadStream(String streamId, String metaJson, InputStream data, RemoteTransport.Session session) throws Exception {
        JSONObject meta = new JSONObject(metaJson == null || metaJson.isEmpty() ? "{}" : metaJson);
        String kind = meta.optString("kind", "");
        File tmpDir = new File(ctx.getFilesDir(), "tmp/remote-uploads");
        tmpDir.mkdirs();
        File temp = new File(tmpDir, "up-" + System.currentTimeMillis() + "-" + streamId + ".bin");
        try {
            try (FileOutputStream out = new FileOutputStream(temp)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = data.read(buf)) > 0) out.write(buf, 0, n);
                out.getFD().sync();
            }
            if ("qq_deb".equals(kind)) {
                QqClientInstaller.ensureBusybox(ctx);
                QqClientInstaller.Result r = QqClientInstaller.install(ctx.getFilesDir(), temp, null);
                if (!r.ok) throw new IOException(r.detail == null ? "QQ 安装包安装失败" : r.detail);
            } else if ("backup_restore".equals(kind)) {
                String coreId = meta.optString("coreId", "");
                CoreBackupSaf.restoreFromFile(ctx, coreId, temp);
            } else {
                throw new IOException("不支持的上传流类型：" + kind);
            }
        } finally {
            temp.delete();
        }
    }

    @Override
    public void onDownloadStream(String streamId, String metaJson, OutputStream out, RemoteTransport.Session session) throws Exception {
        JSONObject meta = new JSONObject(metaJson == null || metaJson.isEmpty() ? "{}" : metaJson);
        String kind = meta.optString("kind", "");
        if ("backup_export".equals(kind)) {
            String coreId = meta.optString("coreId", "");
            String botId = meta.optString("botId", "");
            boolean release = meta.optBoolean("release", false);
            File tmpDir = new File(ctx.getFilesDir(), "tmp/remote-exports");
            tmpDir.mkdirs();
            File temp = new File(tmpDir, "exp-" + System.currentTimeMillis() + ".zip");
            try {
                CoreBackupSaf.exportToFile(ctx, coreId, botId, temp, release);
                try (FileInputStream in = new FileInputStream(temp)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
            } finally {
                temp.delete();
            }
            return;
        }
        throw new IOException("不支持的下载流类型：" + kind);
    }

    // ------------------------------------------------------------------ 本地执行实现

    /**
     * 方案 A 哈希增量快照（向下兼容旧版无参调用）：
     * 若控制端已持有相同 botsHash / loginLogHash / containerLogHash / qrMtime，
     * 跳过重复传输大块 JSON、日志与二维码 PNG，常规轮询包体从 ~40KB 压到 ~350B。
     */
    private String handleSystemSnapshot(JSONObject req) throws Exception {
        File files = ctx.getFilesDir();
        SetupState.Steps st = SetupState.read(files);
        File qqDir = new File(files, "rootfs/opt/whale/qq-state");
        File qrFile = new File(qqDir, "qr.png");
        long mtime = qrFile.isFile() ? qrFile.lastModified() : 0L;
        boolean qrLive = qrFile.isFile() && mtime >= qrRequestedAt - 2000
                && (System.currentTimeMillis() - mtime <= QR_TTL_MS);
        long qrLeft = qrLive ? Math.max(0L, (QR_TTL_MS - (System.currentTimeMillis() - mtime)) / 1000L) : 0L;

        String prevBotsHash = req == null ? "" : req.optString("botsHash", "");
        String prevLoginHash = req == null ? "" : req.optString("loginLogHash", "");
        String prevContHash = req == null ? "" : req.optString("containerLogHash", "");
        long prevQrMtime = req == null ? -1L : req.optLong("qrMtime", -1L);

        JSONObject o = new JSONObject();
        o.put("containerRunning", ContainerService.isRunning());
        o.put("botRunning", ContainerService.botRunning(ctx));
        String botStateJson = ContainerService.readBotStateJson(files);
        QqAuthState auth = QqAuthState.parseBotJson(botStateJson);
        String uin = auth.isOnline() ? auth.uin : "";
        o.put("loginUin", uin);
        o.put("botStateJson", botStateJson);
        com.whaleonebot.QqCredentialVault.Summary cred = com.whaleonebot.QqCredentialVault.summary(ctx);
        o.put("hasSavedCred", cred.hasSaved);
        o.put("savedCredUin", cred.uin);
        o.put("qrLive", qrLive);
        o.put("qrLeftSeconds", qrLeft);
        o.put("qrMtime", mtime);
        if (qrLive) {
            o.put("qrUrl", ContainerService.readQrUrl(files));
        }
        if (qrLive && mtime != prevQrMtime && qrFile.length() > 0 && qrFile.length() < 512 * 1024) {
            o.put("qrPngB64", RemoteCrypto.b64Encode(readBytes(qrFile)));
        }
        o.put("setupEnv", st.env);
        o.put("setupQq", st.qq);
        o.put("setupBot", st.bot);
        o.put("watchdogEnabled", Watchdog.isEnabled(ctx));
        String qv = QqClientInstaller.clientVersion(files);
        o.put("qqClientVersion", qv == null ? "" : qv);
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            o.put("appVersionName", pi.versionName == null ? "" : pi.versionName);
            o.put("appVersionCode", pi.versionCode);
        } catch (Throwable ignored) {
        }
        // 改读真实 bot.log（单进程合流后登录/断连/看门狗全在这里），若无再退回 login.log
        File botLogFile = new File(qqDir, "bot.log");
        String loginLog = botLogFile.isFile() ? tailFile(botLogFile, 50) : tailFile(new File(qqDir, "login.log"), 40);
        String loginHash = shortHash(loginLog);
        o.put("loginLogHash", loginHash);
        if (!loginHash.equals(prevLoginHash)) o.put("loginLog", loginLog);

        String contLog = tailFile(new File(files, "logs/container.log"), 40);
        String contHash = shortHash(contLog);
        o.put("containerLogHash", contHash);
        if (!contHash.equals(prevContHash)) o.put("containerLog", contLog);

        String botsJson = BotRegistry.exportLocalSnapshotJson();
        String botsHash = shortHash(botsJson);
        o.put("botsHash", botsHash);
        if (!botsHash.equals(prevBotsHash)) {
            o.put("botsJson", botsJson);
            o.put("coresJson", "");
        }
        try {
            NetworkRiskLogic.Report nr = NetworkRiskDetector.inspect(ctx);
            o.put("netRisk", new JSONObject()
                    .put("level", nr.level)
                    .put("badge", nr.badge)
                    .put("summary", nr.summary)
                    .put("proxyHijack", nr.proxyHijack));
            KeepAliveInspector.Summary ka = KeepAliveInspector.inspect(ctx);
            o.put("keepAlive", new JSONObject()
                    .put("score", ka.score)
                    .put("badge", ka.badge));
            // 扫描三平台异常告警摘要推往主力机
            for (BotRegistry.Bot bot : BotRegistry.list()) {
                for (BotRegistry.Binding row : bot.bindings) {
                    if (row.hostedBili() && !row.accountId.isEmpty()) {
                        JSONObject bs = ContainerService.biliProtocolStatus(bot.id, row.id);
                        String bState = bs.optString("state", "");
                        if ("reauth_required".equals(bState) || "expired".equals(bState)) {
                            o.put("biliAlert", new JSONObject()
                                    .put("title", "B 站账号需要重新授权（UID " + row.accountId + "）")
                                    .put("message", "登录态已过期，原有配置已保留，点击前往重新上线"));
                            break;
                        }
                    }
                }
                DouyinSettings.SessionSummary dy = DouyinSettings.sessionSummary(ctx, bot.id);
                if (dy.saved && "expired".equals(dy.state)) {
                    o.put("douyinAlert", new JSONObject()
                            .put("title", "抖音账号登录已失效")
                            .put("message", dy.lastError.isEmpty() ? "请重新扫码或短信登录" : dy.lastError));
                }
            }
        } catch (Throwable ignored) {}
        return o.toString();
    }

    private static String shortHash(String s) {
        byte[] h = RemoteCrypto.sha256((s == null ? "" : s).getBytes(StandardCharsets.UTF_8));
        return RemoteCrypto.hex(h).substring(0, 16);
    }

    private String handleContainerStart() {
        new Thread(() -> {
            BundledEnvironment.ensure(ctx);
            ContainerService.start(ctx);
        }, "remote-start-container").start();
        return "{\"ok\":true}";
    }

    private String handleRequestQr() throws Exception {
        File files = ctx.getFilesDir();
        QqAuthState auth = QqAuthState.parseBotJson(ContainerService.readBotStateJson(files));
        if (auth.isOnline()) {
            return new JSONObject().put("ok", false).put("msg", "远端当前已在线（" + auth.uin + "），如需重登请先点「强制重登」或「安全下线」").toString();
        }
        File qqDir = new File(files, "rootfs/opt/whale/qq-state");
        new File(qqDir, "qr.png").delete();
        new File(qqDir, "qr.url").delete();
        qrRequestedAt = System.currentTimeMillis();
        if (!ContainerService.isRunning()) ContainerService.start(ctx);
        ContainerService.startLogin(ctx);
        return new JSONObject().put("ok", true).put("msg", "已向远端请求 1 张新二维码（按需出码）").toString();
    }

    private String handlePasswordLogin(JSONObject p) throws Exception {
        String uin = p.optString("uin", "").trim();
        String password = p.optString("password", "");
        boolean remember = p.optBoolean("remember", false);
        if (!uin.matches("[1-9][0-9]{4,15}") || password.isEmpty()) {
            return new JSONObject().put("ok", false).put("msg", "请输入有效的机器人 QQ 号与密码").toString();
        }
        if (remember) {
            com.whaleonebot.QqCredentialVault.save(ctx, uin, password);
        }
        if (!ContainerService.isRunning()) ContainerService.start(ctx);
        if (!ContainerService.botRunning(ctx)) ContainerService.startBot(ctx);
        JSONObject cmd = new JSONObject()
                .put("action", "password_login")
                .put("uin", uin)
                .put("password", password)
                .put("at", System.currentTimeMillis());
        boolean sent = ContainerService.sendBotCommand(ctx, cmd);
        return new JSONObject().put("ok", sent)
                .put("msg", sent ? "已通过加密通道提交账密登录（密码绝不打日志）" : "发送登录指令失败").toString();
    }

    private String handleSavedPasswordLogin() throws Exception {
        com.whaleonebot.QqCredentialVault.SavedCredential cred = com.whaleonebot.QqCredentialVault.load(ctx);
        if (cred == null) {
            return new JSONObject().put("ok", false).put("msg", "被控机尚未记住密码，请先输入一次账密并勾选记住密码").toString();
        }
        if (!ContainerService.isRunning()) ContainerService.start(ctx);
        if (!ContainerService.botRunning(ctx)) ContainerService.startBot(ctx);
        JSONObject cmd = new JSONObject()
                .put("action", "password_login")
                .put("uin", cred.uin)
                .put("password", cred.password)
                .put("at", System.currentTimeMillis());
        boolean sent = ContainerService.sendBotCommand(ctx, cmd);
        return new JSONObject().put("ok", sent)
                .put("msg", sent ? ("正在使用被控机已存加密凭据登录 " + cred.uin + "…") : "触发一键重登失败").toString();
    }

    private String handleSubmitCaptcha(JSONObject p) throws Exception {
        JSONObject cmd = new JSONObject()
                .put("action", "submit_captcha")
                .put("ticket", p.optString("ticket", ""))
                .put("randStr", p.optString("randStr", ""))
                .put("sid", p.optString("sid", ""))
                .put("newDeviceLoginSig", p.optString("newDeviceLoginSig", ""))
                .put("unusualDeviceCheckSig", p.optString("unusualDeviceCheckSig", ""))
                .put("at", System.currentTimeMillis());
        boolean sent = ContainerService.sendBotCommand(ctx, cmd);
        return new JSONObject().put("ok", sent)
                .put("msg", sent ? "安全验证票据已回传给远端容器" : "回传验证票据失败").toString();
    }

    private String handleSessionAction(String action, JSONObject p) throws Exception {
        if (p.optBoolean("clearSavedCred", false)) {
            com.whaleonebot.QqCredentialVault.clear(ctx);
        }
        if ("force_relogin".equals(action) && "qr".equals(p.optString("mode", ""))) {
            qrRequestedAt = System.currentTimeMillis();
        }
        JSONObject cmd = new JSONObject()
                .put("action", action)
                .put("mode", p.optString("mode", ""))
                .put("at", System.currentTimeMillis());
        boolean sent = ContainerService.sendBotCommand(ctx, cmd);
        return new JSONObject().put("ok", sent).toString();
    }

    private String handleWakeSession() throws Exception {
        JSONObject cmd = new JSONObject()
                .put("action", "wake_session")
                .put("reason", "manual")
                .put("at", System.currentTimeMillis());
        boolean sent = ContainerService.sendBotCommand(ctx, cmd);
        return new JSONObject().put("ok", sent)
                .put("msg", sent ? "已下发温和重连唤醒指令（不杀进程）" : "唤醒指令发送失败").toString();
    }

    private String handleBiliStatus(JSONObject p) throws Exception {
        String botId = p.optString("botId");
        String bindingId = p.optString("bindingId");
        JSONObject st = ContainerService.biliProtocolStatus(botId, bindingId);
        st.put("authLink", nz(ContainerService.biliAuthorizationLink(botId, bindingId)));
        st.put("hasSaved", ContainerService.hasBiliSession(ctx, botId, bindingId));
        BotRegistry.Bot bot = BotRegistry.get(botId);
        if (bot != null) {
            for (BotRegistry.Binding row : bot.bindings) {
                if (bindingId.equals(row.id) && !row.accountId.isEmpty()) {
                    st.put("refreshSummary", com.whaleonebot.BiliRefreshStore.shortStatus(ctx, botId, bindingId, row.accountId));
                    break;
                }
            }
        }
        return st.toString();
    }

    private String handleBiliEnroll(JSONObject p) throws Exception {
        String botId = p.optString("botId");
        String slot = p.optString("slot");
        boolean fresh = p.optBoolean("fresh", false);
        Runnable cancel = ContainerService.enrollBiliAccount(ctx, botId, slot, fresh);
        if (cancel == null) return new JSONObject().put("ok", false).toString();
        biliEnrollCancels.put(botId + ":" + slot, cancel);
        return new JSONObject().put("ok", true).toString();
    }

    private String handleBiliEnrollCancel(JSONObject p) throws Exception {
        Runnable r = biliEnrollCancels.remove(p.optString("botId") + ":" + p.optString("slot"));
        if (r != null) r.run();
        return "{\"ok\":true}";
    }

    private String handleBiliActionLog(JSONObject p) throws Exception {
        String botId = p.optString("botId");
        int page = p.optInt("page", 0);
        int size = p.optInt("size", BiliActionLog.DEFAULT_PAGE_SIZE);
        List<JSONObject> rows = BiliActionLog.page(ctx, botId, page, size);
        JSONArray arr = new JSONArray();
        for (JSONObject r : rows) arr.put(r);
        return new JSONObject().put("rows", arr).put("total", BiliActionLog.count(ctx, botId)).toString();
    }

    private String handleConfigLoad(JSONObject p) throws Exception {
        String botId = p.optString("botId", "");
        File f = resolveConfigFile(botId);
        String text = readUtf8File(f);
        return new JSONObject().put("json", text == null ? "{}" : text).toString();
    }

    private String handleConfigSave(JSONObject p) throws Exception {
        String botId = p.optString("botId", "");
        String json = p.optString("json", "");
        if (json.isEmpty()) return "{\"ok\":false}";
        File f = resolveConfigFile(botId);
        boolean ok = writeUtf8Atomic(f, json);
        boolean reloaded = false;
        if (ok && ContainerService.botRunning(ctx)) {
            int port = ModelsScreen.U.consolePortOf(json);
            if (port <= 0) port = 41907;
            DashApi.Resp r = DashApi.postLocal(port, "/api/config/reload", "{}", 15000);
            reloaded = r.ok();
        }
        return new JSONObject().put("ok", ok).put("reloaded", reloaded).toString();
    }

    private File resolveConfigFile(String botId) {
        File files = ctx.getFilesDir();
        File managed = ContainerService.managedConfigFile(files, botId);
        if (managed != null) return managed;
        BotRegistry.Bot primary = BotRegistry.primary();
        String use = (botId == null || botId.isEmpty()) ? (primary == null ? "whale-1" : primary.id) : botId;
        if ("whale-1".equals(use)) return new File(files, "rootfs/agent/data/config.json");
        return new File(files, "rootfs/agent/data/bots/" + use.replaceAll("[^A-Za-z0-9_-]", "_") + "/config.json");
    }

    private String handleDashGet(JSONObject p) throws Exception {
        String path = p.optString("path", "/api/status");
        int timeout = Math.max(2000, Math.min(95000, p.optInt("timeoutMs", 8000)));
        int port = DashApi.localPort(ctx);
        String body = DashApi.getLocal(port, path, timeout);
        return new JSONObject().put("ok", body != null).put("body", body == null ? "" : body).toString();
    }

    private String handleDashPost(JSONObject p) throws Exception {
        String path = p.optString("path", "/");
        String body = p.optString("body", "{}");
        int timeout = Math.max(2000, Math.min(30000, p.optInt("timeoutMs", 10000)));
        int port = DashApi.localPort(ctx);
        DashApi.Resp r = DashApi.postLocal(port, path, body, timeout);
        return new JSONObject().put("code", r.code).put("body", r.body).toString();
    }

    private String handleKbLoad() throws Exception {
        File files = ctx.getFilesDir();
        File libs = new File(files, "rootfs/agent/data/knowledge-lib/libraries.json");
        File stats = new File(files, "rootfs/agent/data/knowledge-lib/stats.json");
        File env = new File(files, "rootfs/agent/home/.hindsight/profiles/ecnu.env");
        return new JSONObject()
                .put("libs", nz(readUtf8File(libs)))
                .put("stats", nz(readUtf8File(stats)))
                .put("env", nz(readUtf8File(env)))
                .toString();
    }

    private String handleKbSaveLibs(JSONObject p) throws Exception {
        File libs = new File(ctx.getFilesDir(), "rootfs/agent/data/knowledge-lib/libraries.json");
        return new JSONObject().put("ok", writeUtf8Atomic(libs, p.optString("json", "{}"))).toString();
    }

    private String handleKbSaveEnv(JSONObject p) throws Exception {
        File env = new File(ctx.getFilesDir(), "rootfs/agent/home/.hindsight/profiles/ecnu.env");
        return new JSONObject().put("ok", writeUtf8Atomic(env, p.optString("text", ""))).toString();
    }

    private String handleEnvStatus() throws Exception {
        File files = ctx.getFilesDir();
        boolean envReady = QqClientInstaller.usable(new File(files, "rootfs"));
        String qv = QqClientInstaller.clientVersion(files);
        int packs = SetupState.environmentPackCount(files);
        return new JSONObject()
                .put("envReady", envReady)
                .put("qqReady", qv != null)
                .put("qqVersion", qv == null ? "" : qv)
                .put("packs", packs)
                .put("containerRunning", ContainerService.isRunning())
                .toString();
    }

    private String handleScanQqDebs() throws Exception {
        JSONArray arr = new JSONArray();
        File dl = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dl != null && dl.isDirectory()) {
            File[] fs = dl.listFiles();
            if (fs != null) {
                for (File f : fs) {
                    if (f.isFile() && f.getName().toLowerCase().endsWith(".deb")
                            && f.getName().toLowerCase().contains("qq")) {
                        arr.put(new JSONObject()
                                .put("name", f.getName())
                                .put("path", f.getAbsolutePath())
                                .put("size", f.length()));
                    }
                }
            }
        }
        return new JSONObject().put("files", arr).toString();
    }

    private String handleInstallQqDeb(JSONObject p) throws Exception {
        File deb = new File(p.optString("path", ""));
        if (!deb.isFile()) throw new IOException("远端找不到指定的 .deb 文件");
        QqClientInstaller.ensureBusybox(ctx);
        QqClientInstaller.Result r = QqClientInstaller.install(ctx.getFilesDir(), deb, null);
        return new JSONObject().put("ok", r.ok).put("version", nz(r.version)).put("detail", nz(r.detail)).toString();
    }

    private String handleDownloadQqOfficial() throws Exception {
        File dir = new File(ctx.getFilesDir(), "qq-packages");
        dir.mkdirs();
        QqDebFetch.Result r = QqDebFetch.download(dir, null);
        if (r == null || r.file == null) {
            return new JSONObject().put("ok", false).put("detail", r == null ? "下载失败" : nz(r.error)).toString();
        }
        QqClientInstaller.ensureBusybox(ctx);
        QqClientInstaller.Result ir = QqClientInstaller.install(ctx.getFilesDir(), r.file, null);
        return new JSONObject().put("ok", ir.ok).put("version", nz(ir.version)).put("detail", nz(ir.detail)).toString();
    }

    private String handleCoresDownload(JSONObject p) throws Exception {
        int count = Math.max(1, Math.min(8, p.optInt("count", 1)));
        String version = p.optString("version", "");
        CoreInstaller ci = CoreInstaller.open(ctx);
        String ver = (version == null || version.isEmpty()) ? ci.current() : version;
        CoreManagerScreen.createCores(ci, ver, count);
        return "{\"ok\":true}";
    }

    private String handleCoresDownloadStatus() throws Exception {
        CoreManagerScreen.Download ds = CoreManagerScreen.currentDownload();
        JSONObject o = new JSONObject();
        if (ds == null) {
            o.put("active", false);
        } else {
            o.put("active", ds.running);
            o.put("done", !ds.running);
            o.put("stage", nz(ds.label));
            o.put("read", ds.bytes);
            o.put("total", ds.total);
        }
        return o.toString();
    }

    private String handleCoresPluginStage(JSONObject p) throws Exception {
        String coreId = p.optString("coreId", "");
        String platform = p.optString("platform", "");
        String pluginRelease = p.optString("version", "");
        CoreInstaller.open(ctx).stagePlugin(coreId, platform, pluginRelease, null);
        return "{\"ok\":true}";
    }

    private String handleCoresStorage(JSONObject p) throws Exception {
        String coreId = p.optString("coreId", "");
        File dir = new File(ctx.getFilesDir(), "core-instances/" + coreId);
        return new JSONObject().put("bytes", dirSize(dir)).toString();
    }

    private String handleVersionStatus() throws Exception {
        JSONObject o = new JSONObject();
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            o.put("versionName", nz(pi.versionName));
            o.put("versionCode", pi.versionCode);
        } catch (Throwable ignored) {
        }
        o.put("autoCore", CoreInstaller.auto(ctx.getFilesDir()));
        return o.toString();
    }

    /** Q18：远端后台下载 APK 并在远端拉起系统安装确认界面/通知（受 Android 非 Root 系统限制）。 */
    private String handleVersionDownloadAppApk(JSONObject p) throws Exception {
        String urlStr = p.optString("url", "");
        String name = p.optString("name", "whale-update.apk");
        if (!urlStr.startsWith("https://")) throw new IOException("仅允许 HTTPS 下载地址");
        File dlDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dlDir == null || (!dlDir.isDirectory() && !dlDir.mkdirs())) {
            dlDir = new File(ctx.getFilesDir(), "tmp/updates");
            dlDir.mkdirs();
        }
        File outFile = new File(dlDir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
        HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(true);
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("下载失败 HTTP " + code);
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(outFile)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        } finally {
            c.disconnect();
        }
        raiseHostApkInstallPrompt(outFile);
        return new JSONObject()
                .put("ok", true)
                .put("path", outFile.getAbsolutePath())
                .put("status", "downloaded_pending_host_confirm")
                .put("msg", "APK 已下载到远端 " + outFile.getName() + "，请在远端设备屏幕上点击确认安装")
                .toString();
    }

    private void raiseHostApkInstallPrompt(File apk) {
        try {
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(Uri.fromFile(apk), "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                if (Build.VERSION.SDK_INT >= 26) {
                    nm.createNotificationChannel(new NotificationChannel(CHANNEL_UPDATE, "远程应用更新", NotificationManager.IMPORTANCE_HIGH));
                }
                PendingIntent pi = PendingIntent.getActivity(ctx, 0x77, install,
                        Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT);
                Notification.Builder b = Build.VERSION.SDK_INT >= 26
                        ? new Notification.Builder(ctx, CHANNEL_UPDATE) : new Notification.Builder(ctx);
                nm.notify(77, b.setContentTitle("WhaleOneBot 更新已就绪")
                        .setContentText("点击安装 " + apk.getName())
                        .setSmallIcon(android.R.drawable.stat_sys_download_done)
                        .setContentIntent(pi).setAutoCancel(true).build());
            }
            try {
                ctx.startActivity(install);
            } catch (Throwable ignored) {
            }
        } catch (Throwable ignored) {
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static String readIdentityUin(File qqDir) {
        String s = readUtf8File(new File(qqDir, "identity.json"));
        if (s == null) return null;
        int i = s.indexOf("\"uin\":\"");
        if (i < 0) return null;
        int j = s.indexOf('"', i + 7);
        return j > i ? s.substring(i + 7, j) : null;
    }

    private static byte[] readBytes(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) bos.write(b, 0, n);
            return bos.toByteArray();
        }
    }

    private static String readUtf8File(File f) {
        if (f == null || !f.isFile()) return null;
        try {
            return new String(readBytes(f), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    private static boolean writeUtf8Atomic(File f, String text) {
        try {
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory()) dir.mkdirs();
            File tmp = new File(dir, f.getName() + ".next");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (tmp.renameTo(f)) return true;
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
            }
            tmp.delete();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private static String tailFile(File f, int maxLines) {
        if (f == null || !f.isFile()) return "";
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long len = raf.length();
            int take = (int) Math.min(len, 16 * 1024);
            raf.seek(len - take);
            byte[] buf = new byte[take];
            raf.readFully(buf);
            String[] lines = new String(buf, StandardCharsets.UTF_8).split("\n");
            int from = Math.max(0, lines.length - maxLines);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < lines.length; i++) sb.append(lines[i]).append('\n');
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    private static long dirSize(File f) {
        if (f == null || !f.exists()) return 0L;
        if (f.isFile()) return f.length();
        long sum = 0L;
        File[] list = f.listFiles();
        if (list != null) {
            for (File ch : list) sum += dirSize(ch);
        }
        return sum;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
