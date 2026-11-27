package com.whaleonebot;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/**
 * [layer: shell-android] 抖音登录态真实只读校验、低频定期保活探活（45 分钟）与独立黑匣子诊断。
 *
 * <p>严格遵守防风控原则：
 * <ul>
 *   <li>严禁把仅有 {@code ttwid} 的游客态误判为已登录；</li>
 *   <li>校验通过只读个人资料接口核验真实 UID / 昵称；</li>
 *   <li>低频保活探活仅每 45 分钟执行 1 次轻量只读检测（绝不高频撞滑块）；确认过期立即发本地与远程告警。</li>
 * </ul>
 */
public final class DouyinSessionVerifier {

    private static final long PROBE_INTERVAL_MS = 45L * 60_000L;
    private static final ArrayDeque<String> blackbox = new ArrayDeque<>();
    private static volatile Thread keepAliveThread = null;
    private static volatile String lastAlertBot = "";

    public static final class VerifyResult {
        public final boolean validSession;
        public final boolean networkFlap;
        public final String uid;
        public final String nickname;
        public final String state;
        public final String message;

        VerifyResult(boolean validSession, boolean networkFlap, String uid, String nickname, String state, String message) {
            this.validSession = validSession;
            this.networkFlap = networkFlap;
            this.uid = uid == null ? "" : uid;
            this.nickname = nickname == null ? "" : nickname;
            this.state = state == null ? "unknown" : state;
            this.message = message == null ? "" : message;
        }
    }

    private DouyinSessionVerifier() {
    }

    private static synchronized void record(String botId, String msg) {
        String line = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date())
                + " [" + (botId == null ? "default" : botId) + "] " + msg;
        blackbox.addLast(line);
        while (blackbox.size() > 60) blackbox.removeFirst();
    }

    public static synchronized String blackboxLog(int maxLines) {
        if (blackbox.isEmpty()) return "（暂无抖音诊断记录，执行登录校验、保活探活或重连时会自动记入）";
        StringBuilder sb = new StringBuilder();
        int skip = Math.max(0, blackbox.size() - Math.max(1, maxLines));
        int i = 0;
        for (String line : blackbox) {
            if (i++ >= skip) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    /** 联网只读校验抖音 Cookie（拒绝游客态 ttwid，提取真实昵称与 UID/sec_uid）。 */
    public static VerifyResult verifyCookieOnline(String rawCookie) {
        if (!DouyinSessionStore.hasRealSessionCookie(rawCookie)) {
            return new VerifyResult(false, false, "", "", "guest_only",
                    "未检测到登录态 Cookie（仅含游客凭证 ttwid），请先完成扫码或短信登录后再保存");
        }
        // 1) 优先请求抖音网页端只读个人信息接口
        String[] endpoints = {
                "https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web",
                "https://creator.douyin.com/web/api/media/user/info/"
        };
        boolean sawHttpReject = false;
        boolean sawNetworkErr = false;
        for (String ep : endpoints) {
            HttpResult r = httpGet(ep, rawCookie);
            if (!r.connected) {
                sawNetworkErr = true;
                continue;
            }
            if (r.code == 401 || r.code == 403) {
                sawHttpReject = true;
                continue;
            }
            if (r.code == 200 && r.body != null && !r.body.isEmpty()) {
                try {
                    JSONObject obj = new JSONObject(r.body);
                    // 网页 profile/self 格式：{ status_code: 0, user: { uid, sec_uid, nickname } }
                    JSONObject u = obj.optJSONObject("user");
                    if (u == null) u = obj.optJSONObject("user_info");
                    if (u == null) {
                        JSONObject data = obj.optJSONObject("data");
                        if (data != null) u = data.optJSONObject("user");
                        if (u == null) u = data;
                    }
                    if (u != null) {
                        String uid = firstNonEmpty(u.optString("uid", ""), u.optString("unique_id", ""),
                                u.optString("short_id", ""), u.optString("sec_uid", ""));
                        String nick = u.optString("nickname", "").trim();
                        if (nick.isEmpty()) nick = u.optString("name", "").trim();
                        if (!nick.isEmpty() || !uid.isEmpty()) {
                            return new VerifyResult(true, false, uid, nick, "verified",
                                    "已核验抖音登录态" + (nick.isEmpty() ? "" : ("：" + nick)));
                        }
                    }
                    int sc = obj.optInt("status_code", -999);
                    if (sc == 8 || sc == 2096 || sc == 2154 || obj.optInt("error_code", 0) == 10008) {
                        return new VerifyResult(false, false, "", "", "expired",
                                "抖音登录态已失效或被退出（status=" + sc + "），请重新登录");
                    }
                } catch (Throwable ignored) {
                    // 某些风控网关在网页端返回滑块 HTML；若确含 sessionid_ss/sid_tt 则保留半可信待核验
                }
            }
        }
        if (sawHttpReject) {
            return new VerifyResult(false, false, "", "", "expired",
                    "抖音服务端拒绝当前登录凭证，请重新登录");
        }
        if (sawNetworkErr) {
            return new VerifyResult(false, true, "", "", "network_error",
                    "网络波动未能连接抖音校验接口，已保留本地加密凭证");
        }
        // 含真实 sessionid/sid_tt 但只读接口暂时被网页滑块门槛挡住，降级为已保存登录态（待人工或下次探活再确认）
        return new VerifyResult(true, true, "", "", "saved_unconfirmed",
                "已检测到真实会话凭证（sessionid/sid_tt），但只读接口触发网页验证门槛，暂保留加密凭据");
    }

    /** 保存并立即执行真实账号联网核验，更新硬件加密仓。 */
    public static DouyinSessionStore.Summary saveAndVerify(Context ctx, String botId, String rawCookie) {
        VerifyResult vr = verifyCookieOnline(rawCookie);
        if (!DouyinSessionStore.hasRealSessionCookie(rawCookie)) {
            record(botId, "reject_guest_cookie");
            return new DouyinSessionStore.Summary(false, false, false, "", "", "guest_only", vr.message, 0L, 0L, 0);
        }
        boolean verified = vr.validSession && "verified".equals(vr.state);
        DouyinSessionStore.save(ctx, botId, rawCookie, verified, vr.uid, vr.nickname, vr.state, verified ? "" : vr.message);
        record(botId, "save_and_verify state=" + vr.state + " uid=" + vr.uid + " nick=" + vr.nickname);
        if ("verified".equals(vr.state)) lastAlertBot = "";
        return DouyinSessionStore.summary(ctx, botId);
    }

    /** 对已有加密凭证执行一次独立只读探活与告警。 */
    public static DouyinSessionStore.Summary probeOnce(Context ctx, String botId) {
        if (ctx == null) return new DouyinSessionStore.Summary(false, false, false, "", "", "stopped", "", 0L, 0L, 0);
        String cookie = DouyinSessionStore.loadCookie(ctx, botId);
        if (cookie == null || cookie.trim().isEmpty()) {
            return DouyinSessionStore.summary(ctx, botId);
        }
        VerifyResult vr = verifyCookieOnline(cookie);
        if (vr.validSession) {
            boolean full = "verified".equals(vr.state);
            DouyinSessionStore.updateHealth(ctx, botId, full, vr.uid, vr.nickname, vr.state, full ? "" : vr.message);
            record(botId, "probe_ok state=" + vr.state + " nick=" + vr.nickname);
            if (full) lastAlertBot = "";
        } else if (!vr.networkFlap) {
            DouyinSessionStore.updateHealth(ctx, botId, false, "", "", "expired", vr.message);
            record(botId, "probe_expired msg=" + vr.message);
            if (!botId.equals(lastAlertBot)) {
                lastAlertBot = botId;
                ContainerService.postPlatformAlertNotification(ctx, "douyin",
                        "抖音账号登录已失效", vr.message + "，点击前往重新网页扫码或短信登录。", null);
            }
        } else {
            DouyinSessionStore.updateHealth(ctx, botId, false, "", "", "network_error", vr.message);
            record(botId, "probe_network_flap");
        }
        return DouyinSessionStore.summary(ctx, botId);
    }

    /** 启动低频后台保活巡检（每 45 分钟仅对已存凭证做 1 次轻量只读核验）。 */
    public static synchronized void ensureKeepAliveLoop(final Context ctx) {
        if (ctx == null) return;
        if (keepAliveThread != null && keepAliveThread.isAlive()) return;
        final Context app = ctx.getApplicationContext();
        Thread t = new Thread(() -> {
            try { Thread.sleep(20_000L); } catch (InterruptedException e) { return; }
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    java.util.List<com.whaleonebot.ui.BotRegistry.Bot> bots = com.whaleonebot.ui.BotRegistry.list();
                    for (com.whaleonebot.ui.BotRegistry.Bot b : bots) {
                        DouyinSessionStore.Summary s = DouyinSessionStore.summary(app, b.id);
                        if (s.saved && !"expired".equals(s.state)) {
                            probeOnce(app, b.id);
                        }
                    }
                } catch (Throwable ignored) {}
                try {
                    Thread.sleep(PROBE_INTERVAL_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }, "douyin-keepalive");
        t.setDaemon(true);
        keepAliveThread = t;
        t.start();
    }

    /** 独立热重启抖音探活服务并立刻校验一次。 */
    public static void restartService(final Context ctx, final String botId) {
        if (ctx == null) return;
        record(botId, "manual_restart_probe");
        new Thread(() -> probeOnce(ctx.getApplicationContext(), botId), "douyin-reprobe").start();
    }

    private static final class HttpResult {
        final boolean connected;
        final int code;
        final String body;
        HttpResult(boolean connected, int code, String body) {
            this.connected = connected;
            this.code = code;
            this.body = body;
        }
    }

    private static HttpResult httpGet(String urlStr, String cookie) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Referer", "https://www.douyin.com/");
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
            int code = conn.getResponseCode();
            if (code != 200) return new HttpResult(true, code, "");
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0 && bos.size() < 262144) bos.write(buf, 0, n);
                return new HttpResult(true, code, new String(bos.toByteArray(), StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
            return new HttpResult(false, 0, "");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String firstNonEmpty(String... vals) {
        for (String v : vals) {
            if (v != null && !v.trim().isEmpty()) return v.trim();
        }
        return "";
    }
}
