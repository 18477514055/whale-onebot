package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.net.Uri;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * [layer: shell-android] 抖音（测试版）实验性内置 WebView 手动登录窗。
 *
 * <p>说明（诚实边界）：
 * <ul>
 *   <li>本窗口仅加载抖音官方网页端（{@code www.douyin.com} / {@code douyin.com} / {@code login.douyin.com}），由用户在手机上亲自完成扫码或手机号登录；</li>
 *   <li>用户点击「我已登录，保存本地凭证」时，从 {@link CookieManager} 提取当前域 Cookie 写入本机私有目录（权限 0600），绝不打印到日志；</li>
 *   <li>网页凭证通道属于实验性测试功能，不承诺个人号实时私信或绕过平台风控。</li>
 * </ul>
 */
public final class DouyinWebLogin {

    public static final String START_URL = "https://www.douyin.com/";
    private static boolean busy;

    public interface Callback {
        void onCaptured(boolean saved, String summary);
    }

    private DouyinWebLogin() {
    }

    private static boolean allowedHost(String url) {
        if (url == null || url.length() > 4096) return false;
        try {
            Uri u = Uri.parse(url);
            if (!"https".equalsIgnoreCase(u.getScheme())) return false;
            String host = u.getHost();
            if (host == null) return false;
            String low = host.toLowerCase(java.util.Locale.ROOT);
            return low.equals("douyin.com")
                    || low.endsWith(".douyin.com")
                    || low.endsWith(".bytedance.com")
                    || low.endsWith(".snssdk.com")
                    || low.endsWith(".iesdouyin.com")
                    || low.endsWith(".zijieapi.com");
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean open(final Activity activity, final String botId, final Callback callback) {
        if (Looper.myLooper() != Looper.getMainLooper() || activity == null
                || activity.isFinishing() || activity.isDestroyed()) {
            return false;
        }
        if (busy) {
            Toast.makeText(activity, "登录窗口已在打开状态", Toast.LENGTH_SHORT).show();
            return false;
        }
        busy = true;
        final WebView web;
        try {
            web = new WebView(activity);
        } catch (Throwable ex) {
            busy = false;
            Toast.makeText(activity, "系统 WebView 不可用，请更新 Android System WebView", Toast.LENGTH_LONG).show();
            return false;
        }

        web.setSaveEnabled(false);
        web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");

        final CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        final boolean[] closed = {false};
        final Dialog[] dialogRef = new Dialog[1];

        final Runnable cleanup = () -> {
            if (closed[0]) return;
            closed[0] = true;
            try {
                if (dialogRef[0] != null && dialogRef[0].isShowing()) dialogRef[0].dismiss();
            } catch (Throwable ignored) {
            }
            try {
                if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
                web.stopLoading();
                web.clearHistory();
                web.destroy();
            } catch (Throwable ignored) {
            }
            busy = false;
        };

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request == null || request.getUrl() == null ? "" : request.getUrl().toString();
                if (request != null && request.isForMainFrame()) {
                    return !allowedHost(u);
                }
                return false;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                cleanup.run();
                return true;
            }
        });

        Theme t = PromptSheet.currentTheme(activity);
        dialogRef[0] = PromptSheet.custom(
                activity, t,
                "抖音网页登录（测试版 · 实验通道）",
                web,
                "我已登录，保存凭证", (d, btn) -> {
                    cm.flush();
                    String c1 = cm.getCookie("https://www.douyin.com/");
                    String c2 = cm.getCookie("https://douyin.com/");
                    String merged = mergeCookies(c1, c2);
                    if (merged.isEmpty()) {
                        Toast.makeText(activity, "尚未检测到抖音网页 Cookie，请先完成登录后再点保存", Toast.LENGTH_LONG).show();
                        return;
                    }
                    boolean ok = DouyinSettings.saveWebSession(activity.getFilesDir(), botId, merged);
                    DouyinSettings.SessionSummary sum = DouyinSettings.sessionSummary(activity.getFilesDir(), botId);
                    cleanup.run();
                    if (callback != null) {
                        callback.onCaptured(ok, ok
                                ? ("已保存 " + sum.cookieFieldCount + " 项实验凭证" + (sum.hasSessionId ? "（含登录态）" : "（建议确认已完成账号登录）"))
                                : "本地写入失败");
                    }
                },
                "刷新页面", (d, btn) -> web.reload(),
                "关闭", (d, btn) -> cleanup.run(),
                true, true, d -> cleanup.run(), null
        );
        web.loadUrl(START_URL);
        return true;
    }

    private static String mergeCookies(String a, String b) {
        java.util.LinkedHashMap<String, String> map = new java.util.LinkedHashMap<>();
        for (String src : new String[]{a, b}) {
            if (src == null) continue;
            for (String part : src.split(";")) {
                String p = part.trim();
                int eq = p.indexOf('=');
                if (eq > 0) {
                    map.put(p.substring(0, eq).trim(), p.substring(eq + 1).trim());
                }
            }
        }
        StringBuilder sb = new StringBuilder();
        for (java.util.Map.Entry<String, String> e : map.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }
}
