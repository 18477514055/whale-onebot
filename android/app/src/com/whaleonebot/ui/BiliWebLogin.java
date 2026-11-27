package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Application;
import android.app.Dialog;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.HashSet;

/** Operator-driven passport UI. Opening/closing it proves nothing about adapter identity. */
public final class BiliWebLogin {
    public static final String START = "https://passport.bilibili.com/login";
    private static final String ORIGIN = "passport.bilibili.com";
    // Reserved for this process's only WebView consumer. Never fall back to the default jar.
    private static boolean isolated, busy;
    private BiliWebLogin() {}

    /** Strict initial-link policy: no arbitrary return URL or other user-controlled parameters. */
    public static boolean accepts(String url) {
        if (START.equals(url)) return true;
        if (!passport(url) || url.length() > 512) return false;
        URI u = URI.create(url);
        boolean modern="account.bilibili.com".equals(u.getRawAuthority());
        if (!(modern?"/h5/account-h5/auth/scan-web":"/h5-app/passport/login/scan").equals(u.getRawPath()) || u.getRawQuery() == null || u.getRawFragment() != null) return false;
        HashSet<String> seen = new HashSet<>();
        for (String kv : u.getRawQuery().split("&", -1)) {
            int eq = kv.indexOf('=');
            if (eq <= 0 || !seen.add(kv.substring(0, eq))) return false;
            if (modern) {
                if (!(kv.equals("callback=close") || kv.equals("from=") || kv.equals("navhide=1") || kv.matches("qrcode_key=[A-Za-z0-9_-]{32}"))) return false;
                continue;
            }
            if (!(kv.matches("qrcode_key=[A-Za-z0-9_-]{16,128}") || kv.equals("navhide=1") || kv.equals("from=") || kv.equals("from=main-fe-header"))) return false;
        }
        return seen.contains("qrcode_key") && (!modern || seen.size()==4);
    }

    private static boolean passport(String url) {
        if (url == null || url.length() > 8192 || url.indexOf('\\') >= 0) return false;
        try {
            URI u = URI.create(url);
            return "https".equals(u.getScheme()) && (ORIGIN.equals(u.getRawAuthority()) || "account.bilibili.com".equals(u.getRawAuthority()));
        } catch (IllegalArgumentException invalid) { return false; }
    }

    /** UI thread; true means the official login window opened, never 'authenticated'. */
    public static boolean open(Activity a, String url) { return open(a, url, null); }

    /** Optional local dismissal notification, including Back/rotation/renderer loss; contains no URL or account data. */
    public static boolean open(Activity a, String url, Runnable onClosed) {
        if (Looper.myLooper() != Looper.getMainLooper() || a == null || a.isFinishing() || a.isDestroyed() || !accepts(url)) return false;
        if (busy) return false;
        busy = true;
        Window w = new Window(a);
        try {
            if (!isolated) {
                try {
                    WebView.setDataDirectorySuffix("bili-passport-only");
                } catch (IllegalStateException ignored) {
                    // 同进程内先前已由 QQ 滑块或抖音登录初始化过 WebView：安全复用进程容器，不再崩溃报错
                }
                isolated = true;
            }
            WebView.setWebContentsDebuggingEnabled(false);
            w.show(url);
            w.onClosed = onClosed;
            return true;
        } catch (RuntimeException unavailable) {
            w.close();
            Toast.makeText(a, "无法打开登录窗口，请确认系统 WebView 可用后重试。", Toast.LENGTH_LONG).show();
            return false;
        }
    }

    private static final class Window implements Application.ActivityLifecycleCallbacks {
        final Activity a;
        WebView web;
        Dialog dialog;
        android.widget.TextView switchBtn;
        boolean closed, rendererGone;
        Runnable onClosed;
        Window(Activity a) { this.a = a; }
        @SuppressWarnings("deprecation")
        void show(String url) {
            web = new WebView(a);
            web.setSaveEnabled(false);
            web.setSaveFromParentEnabled(false);
            web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);  // The official page itself needs JS. No app scripts or bridge.
            s.setAllowFileAccess(false); s.setAllowContentAccess(false);
            s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            s.setCacheMode(WebSettings.LOAD_NO_CACHE); s.setSaveFormData(false); s.setSavePassword(false);
            s.setDomStorageEnabled(false); s.setGeolocationEnabled(false); s.setSafeBrowsingEnabled(true);
            s.setSupportMultipleWindows(true); s.setJavaScriptCanOpenWindowsAutomatically(false);
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptThirdPartyCookies(web, false);
            web.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }
            });
            web.setDownloadListener((u, agent, disposition, mime, size) -> {});
            web.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                    return req.isForMainFrame() ? !passport(req.getUrl().toString()) : !"https".equals(req.getUrl().getScheme());
                }
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                    Uri u = req.getUrl();
                    if (!"https".equals(u.getScheme()) || (req.isForMainFrame() && !passport(u.toString())))
                        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                    return null;
                }
                @Override public void onPageStarted(WebView v, String u, android.graphics.Bitmap icon) {
                    if (!passport(u)) { v.stopLoading(); close(); }
                }
                @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                    rendererGone = true; close(); return true;
                }
            });
            // [layer: shell-android] 改用统一主题全屏面板并保留 FLAG_SECURE 防截屏，替代原生 AlertDialog。
            Theme t = PromptSheet.currentTheme(a);
            final android.widget.TextView[] neutralRef = new android.widget.TextView[1];
            final boolean[] loginMode = { false };
            dialog = PromptSheet.custom(
                    a, t, "哔哩哔哩 · passport.bilibili.com", web,
                    null, null,
                    START.equals(url) ? null : "官网登录",
                    START.equals(url) ? null : (d, btn) -> {
                        if (closed) return;
                        loginMode[0] = !loginMode[0];
                        web.loadUrl(loginMode[0] ? START : url);
                        btn.setText(loginMode[0] ? "返回本次授权" : "官网登录");
                    },
                    "关闭登录页", (d, btn) -> d.dismiss(),
                    true, true, d -> close(), neutralRef);
            switchBtn = neutralRef[0];
            if (switchBtn != null) Ui.enabled(switchBtn, false);
            a.getApplication().registerActivityLifecycleCallbacks(this);
            // Cold entry also discards cookies left behind by a killed login process.
            cm.removeAllCookies(removed -> {
                if (closed || a.isDestroyed() || a.isFinishing()) return;
                if (switchBtn != null) Ui.enabled(switchBtn, true);
                web.loadUrl(url);
            });
        }
        void close() {
            if (closed) return;
            closed = true;
            a.getApplication().unregisterActivityLifecycleCallbacks(this);
            if (dialog != null && dialog.isShowing()) dialog.dismiss();
            try {
                if (web != null) {
                    if (web.getParent() instanceof ViewGroup) ((ViewGroup)web.getParent()).removeView(web);
                    if (!rendererGone) { web.stopLoading(); web.clearHistory(); web.clearCache(true); }
                    web.destroy(); web = null;
                }
            } finally {
                if (isolated) {
                    try { WebStorage.getInstance().deleteAllData();
                        CookieManager.getInstance().removeAllCookies(removed -> busy = false);
                    } catch (RuntimeException unavailable) { busy = false; }
                } else busy = false;
                if (onClosed != null) { Runnable notification = onClosed; onClosed = null; notification.run(); }
            }
        }
        public void onActivityDestroyed(Activity other) { if (other == a) close(); }
        public void onActivityCreated(Activity other, Bundle b) {} public void onActivityStarted(Activity other) {}
        public void onActivityResumed(Activity other) {} public void onActivityPaused(Activity other) {}
        public void onActivityStopped(Activity other) {} public void onActivitySaveInstanceState(Activity other, Bundle b) {}
    }
}
