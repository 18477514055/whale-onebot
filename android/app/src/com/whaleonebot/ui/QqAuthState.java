package com.whaleonebot.ui;

/**
 * [layer: shell-android] QQ 登录与在线健康状态统一模型与纯逻辑解析器（零 Android 依赖，可进主机纯 Java 单测）。
 *
 * <p>首页红标、启动页状态卡、系统高优先级离线通知、远程快照同步全部共用这一份语义判定，
 * 避免出现「实际已掉线到 qr-ready，但界面还凭旧 identity.json 显示已登录」的分裂状态。
 */
public final class QqAuthState {

    public static final int LEVEL_ONLINE = 0;
    public static final int LEVEL_CONNECTING = 1;
    public static final int LEVEL_DEGRADED = 2;
    public static final int LEVEL_OFFLINE_ACTION = 3;

    public final String phase;
    public final String uin;
    public final boolean canQuickLogin;
    public final boolean needsManualLogin;
    public final String offlineReason;
    public final String offlineMessage;
    public final String verifyUrl;
    public final long verifyAt;
    public final long qrAt;
    public final String msfStatus;
    public final long lastHealthyAt;
    public final String clientVer;
    public final String hostname;
    public final String kernelRelease;
    public final String error;

    public QqAuthState(
            String phase, String uin, boolean canQuickLogin, boolean needsManualLogin,
            String offlineReason, String offlineMessage, String verifyUrl, long verifyAt,
            long qrAt, String msfStatus, long lastHealthyAt,
            String clientVer, String hostname, String kernelRelease) {
        this(phase, uin, canQuickLogin, needsManualLogin, offlineReason, offlineMessage,
                verifyUrl, verifyAt, qrAt, msfStatus, lastHealthyAt,
                clientVer, hostname, kernelRelease, "");
    }

    public QqAuthState(
            String phase, String uin, boolean canQuickLogin, boolean needsManualLogin,
            String offlineReason, String offlineMessage, String verifyUrl, long verifyAt,
            long qrAt, String msfStatus, long lastHealthyAt,
            String clientVer, String hostname, String kernelRelease, String error) {
        this.phase = safe(phase);
        this.uin = safe(uin);
        this.canQuickLogin = canQuickLogin;
        this.needsManualLogin = needsManualLogin;
        this.offlineReason = safe(offlineReason);
        this.offlineMessage = safe(offlineMessage);
        this.verifyUrl = safe(verifyUrl);
        this.verifyAt = verifyAt;
        this.qrAt = qrAt;
        this.msfStatus = safe(msfStatus);
        this.lastHealthyAt = lastHealthyAt;
        this.clientVer = safe(clientVer);
        this.hostname = safe(hostname);
        this.kernelRelease = safe(kernelRelease);
        this.error = safe(error);
    }

    public static QqAuthState empty() {
        return new QqAuthState("", "", false, false, "", "", "", 0L, 0L, "", 0L, "", "", "", "");
    }

    /** 解析 bot.json 原文（使用仓内纯 Java BotConfigJson，不依赖 org.json / Android）。 */
    public static QqAuthState parseBotJson(String jsonText) {
        if (jsonText == null || jsonText.trim().isEmpty()) return empty();
        try {
            Object doc = BotConfigJson.parse(jsonText);
            return new QqAuthState(
                    str(doc, "phase"),
                    str(doc, "uin"),
                    bool(doc, "canQuickLogin", false),
                    bool(doc, "needsManualLogin", false),
                    str(doc, "offlineReason"),
                    str(doc, "offlineMessage"),
                    str(doc, "verifyUrl"),
                    num(doc, "verifyAt", 0L),
                    num(doc, "qrAt", 0L),
                    str(doc, "msfStatus"),
                    num(doc, "lastHealthyAt", 0L),
                    str(doc, "clientVer"),
                    str(doc, "hostname"),
                    str(doc, "kernelRelease"),
                    str(doc, "error")
            );
        } catch (Throwable ignored) {
            return empty();
        }
    }

    /** 容器/协议进程是否因启动或运行时致命错误退出（不再误显示为「启动中…」）。 */
    public boolean isFatalError() {
        return "bot-start-failed".equals(phase)
                || "uncaught".equals(phase)
                || "unhandled-rejection".equals(phase)
                || "connect-failed".equals(phase)
                || "session-init-threw".equals(phase)
                || "getMsgService-threw".equals(phase)
                || "invalid-session-id".equals(phase)
                || "machine-guid-unavailable".equals(phase)
                || "machine-guid-invalid".equals(phase)
                || "agent-failed".equals(phase);
    }

    /** 原生 MSF 长连接是否处于明确断开态（onMSFStatusChange 2 = kDisconnected / login-disconnected）。 */
    public boolean isMsfDisconnected() {
        if (msfStatus.isEmpty()) return false;
        String low = msfStatus.toLowerCase(java.util.Locale.ROOT);
        return "2".equals(low)
                || "disconnected".equals(low)
                || "kdisconnected".equals(low)
                || "login-disconnected".equals(low);
    }

    /** 当前是否真正处于已登录在线态（不再轻信磁盘陈旧 identity.json，且 MSF 明确断开时不报假在线）。 */
    public boolean isOnline() {
        if (isMsfDisconnected()) return false;
        return !uin.isEmpty() && ("authenticated".equals(phase)
                || "initializing-session".equals(phase)
                || "starting-session".equals(phase)
                || "waiting-session-ready".equals(phase)
                || "session-ready".equals(phase)
                || "onebot-ready".equals(phase)
                || "agent-started".equals(phase)
                || "agent-running".equals(phase));
    }

    /** 当前是否明确掉线且需要人工重新上线（应弹高优先级通知 + 首页红标）。 */
    public boolean isOfflineAlert() {
        if ("kicked-offline".equals(phase)
                || "token-expired".equals(phase)
                || "waiting-manual-login".equals(phase)
                || "verify-required".equals(phase)
                || "qr-ready".equals(phase)) {
            return true;
        }
        return needsManualLogin && !isOnline();
    }

    public boolean hasVerifyChallenge() {
        return "verify-required".equals(phase) && isSafeHttpsTencentUrl(verifyUrl);
    }

    public int healthLevel(boolean containerRunning) {
        if (!containerRunning) return LEVEL_OFFLINE_ACTION;
        if (isOnline()) return LEVEL_ONLINE;
        if (isFatalError() || isOfflineAlert()) return LEVEL_OFFLINE_ACTION;
        if ("degraded".equals(phase) || isMsfDisconnected()) return LEVEL_DEGRADED;
        return LEVEL_CONNECTING;
    }

    /** 首页 QQ 卡片与顶部横幅用的简短状态胶囊文案。 */
    public String shortBadge(boolean containerRunning) {
        if (!containerRunning) return "容器未启动";
        if (isOnline()) return "在线 · " + uin;
        if (isFatalError()) return "启动异常 · " + phase;
        if ("kicked-offline".equals(phase)) return "已掉线 · 被踢下线";
        if ("token-expired".equals(phase)) return "已掉线 · 票据过期";
        if ("verify-required".equals(phase)) return "待安全滑块验证";
        if ("qr-ready".equals(phase)) return "待扫码确认";
        if ("scanned".equals(phase)) return "已扫码 · 待确认";
        if ("pwd-logging-in".equals(phase)) return "账密登录中…";
        if ("quick-login".equals(phase)) return "免扫码快登中…";
        if ("waiting-manual-login".equals(phase)) return "已掉线 · 待重新上线";
        if (isMsfDisconnected()) return "长连接断开 · 重连中";
        if ("degraded".equals(phase)) return "连接波动 · 重连中";
        return "启动中…";
    }

    /** 给人看的一句话人话诊断说明。 */
    public String detailMessage(boolean containerRunning) {
        if (!containerRunning) return "容器尚未启动，请先点击「启动容器」或「一键部署向导」。";
        if (!offlineMessage.isEmpty()) return offlineMessage;
        if (isOnline()) {
            return "QQ 原生会话在线（" + uin + "），支持免扫码快登：" + (canQuickLogin ? "是" : "待刷新");
        }
        if (isFatalError()) {
            return "QQ 启动异常（" + phase + (error.isEmpty() ? "" : "：" + error) + "），请点击下方「复制诊断日志」查看末尾报错。";
        }
        if ("kicked-offline".equals(phase)) return "账号被 QQ 安全中心或异地终端踢下线，已停止自动重登，请核查网络后手动重新上线。";
        if ("token-expired".equals(phase)) return "QQ 快登令牌已过期（140022015），请选择按需扫码或账密重新上线。";
        if ("verify-required".equals(phase)) return "腾讯安全中心要求完成滑块或新设备校验，请点击下方按钮打开验证页。";
        if (isMsfDisconnected()) return "QQ 原生通道（MSF）已断开，正在尝试原生重连，也可点击「L1 · QQ 进程内热重连」立即恢复。";
        if ("degraded".equals(phase)) return "QQ 原生通道探活波动，已保留当前会话并进行温和重连（绝不盲杀重启）。";
        if ("waiting-manual-login".equals(phase)) return "当前未登录 QQ，按需选择下方任意上线方式（已关闭后台自动刷码）。";
        return "正在初始化 QQ 原生环境…";
    }

    /** 仅放行腾讯官方 HTTPS 域名（用于 verifyUrl / qrUrl 安全防线）。 */
    public static boolean isSafeHttpsTencentUrl(String url) {
        if (url == null) return false;
        String s = url.trim();
        if (!s.startsWith("https://") || s.length() > 2048) return false;
        try {
            String host = new java.net.URL(s).getHost();
            if (host == null) return false;
            String low = host.toLowerCase(java.util.Locale.ROOT);
            return low.equals("qq.com") || low.endsWith(".qq.com")
                    || low.equals("tencent.com") || low.endsWith(".tencent.com")
                    || low.equals("gtimg.com") || low.endsWith(".gtimg.com")
                    || low.equals("gtimg.cn") || low.endsWith(".gtimg.cn");
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 构造调起手机 QQ 打开授权链接的 mqqapi URL（若无效返回空串）。 */
    public static String buildMobileQqDeepLink(String qrUrl) {
        if (!isSafeHttpsTencentUrl(qrUrl)) return "";
        try {
            String b64 = java.util.Base64.getEncoder().encodeToString(
                    qrUrl.trim().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return "mqqapi://forward/url?url_prefix=" + java.net.URLEncoder.encode(b64, "UTF-8")
                    + "&version=1&src_type=web";
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String safe(String s) {
        return s == null ? "" : s.trim();
    }

    private static String str(Object doc, String path) {
        Object v = BotConfigJson.get(doc, path);
        return v instanceof String ? ((String) v).trim() : "";
    }

    private static boolean bool(Object doc, String path, boolean def) {
        Object v = BotConfigJson.get(doc, path);
        return v instanceof Boolean ? ((Boolean) v).booleanValue() : def;
    }

    private static long num(Object doc, String path, long def) {
        double d = BotConfigJson.numOf(BotConfigJson.get(doc, path));
        return Double.isNaN(d) ? def : Math.round(d);
    }
}
