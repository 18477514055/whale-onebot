package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.whaleonebot.DouyinSessionStore;

/**
 * [layer: shell-android] 抖音内置安全 WebView 登录窗（支持桌面扫码/短信防拦截切换、自动监听登录态与远程代登回传）。
 */
public final class DouyinWebLogin {

    public static final String DESKTOP_HOME_URL = "https://www.douyin.com/?enter_from=web_homepage";
    public static final String CREATOR_LOGIN_URL = "https://creator.douyin.com/";
    private static final String DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    private static final String MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
    private static boolean busy;

    public interface Callback {
        void onCookieCaptured(String rawCookie);
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
            Toast.makeText(activity, "抖音登录窗口已在打开状态", Toast.LENGTH_SHORT).show();
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
        final WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        // 默认采用桌面端 Chrome UA，解决移动端网页强弹「打开抖音 App」拦截导致难登录的问题
        s.setUserAgentString(DESKTOP_UA);

        final CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        final boolean[] desktopMode = {true};
        final boolean[] closed = {false};
        final Dialog[] dialogRef = new Dialog[1];
        final Handler poller = new Handler(Looper.getMainLooper());

        final Runnable cleanup = () -> {
            if (closed[0]) return;
            closed[0] = true;
            poller.removeCallbacksAndMessages(null);
            try {
                if (dialogRef[0] != null && dialogRef[0].isShowing()) dialogRef[0].dismiss();
            } catch (Throwable ignored) {}
            try {
                if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
                web.stopLoading();
                web.clearHistory();
                web.clearCache(true);
                web.destroy();
            } catch (Throwable ignored) {}
            try {
                WebStorage.getInstance().deleteAllData();
                cm.removeAllCookies(r -> busy = false);
            } catch (Throwable ignored) {
                busy = false;
            }
        };

        final Runnable checkSession = new Runnable() {
            @Override
            public void run() {
                if (closed[0] || activity.isFinishing() || activity.isDestroyed()) return;
                cm.flush();
                String merged = mergeCookies(
                        cm.getCookie("https://www.douyin.com/"),
                        cm.getCookie("https://douyin.com/"),
                        cm.getCookie("https://creator.douyin.com/")
                );
                if (DouyinSessionStore.hasRealSessionCookie(merged)) {
                    cleanup.run();
                    if (callback != null) callback.onCookieCaptured(merged);
                    return;
                }
                poller.postDelayed(this, 1600L);
            }
        };

        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request == null || request.getUrl() == null ? "" : request.getUrl().toString();
                if (request != null && request.isForMainFrame()) {
                    // 拦截 snssdk/snssdk1128/bytedance 等唤醒 App 的自定义 scheme，停留在网页内登录
                    return !allowedHost(u);
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                poller.post(checkSession);
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
                "抖音登录（自动监听 · 支持桌面扫码与短信）",
                web,
                "我已登录，立即提取", (d, btn) -> {
                    cm.flush();
                    String merged = mergeCookies(
                            cm.getCookie("https://www.douyin.com/"),
                            cm.getCookie("https://douyin.com/"),
                            cm.getCookie("https://creator.douyin.com/")
                    );
                    if (!DouyinSessionStore.hasRealSessionCookie(merged)) {
                        Toast.makeText(activity, "尚未检测到有效登录态（仅游客 Cookie），请先扫码或短信登录", Toast.LENGTH_LONG).show();
                        return;
                    }
                    cleanup.run();
                    if (callback != null) callback.onCookieCaptured(merged);
                },
                "切创作者扫码/手机版", (d, btn) -> {
                    desktopMode[0] = !desktopMode[0];
                    s.setUserAgentString(desktopMode[0] ? DESKTOP_UA : MOBILE_UA);
                    web.loadUrl(desktopMode[0] ? CREATOR_LOGIN_URL : DESKTOP_HOME_URL);
                    btn.setText(desktopMode[0] ? "切手机版" : "切桌面扫码");
                },
                "关闭", (d, btn) -> cleanup.run(),
                true, true, d -> cleanup.run(), null
        );
        cm.removeAllCookies(removed -> {
            if (closed[0] || activity.isFinishing() || activity.isDestroyed()) return;
            web.loadUrl(CREATOR_LOGIN_URL);
            poller.postDelayed(checkSession, 1800L);
        });
        return true;
    }

    private static String mergeCookies(String... sources) {
        java.util.LinkedHashMap<String, String> map = new java.util.LinkedHashMap<>();
        for (String src : sources) {
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
