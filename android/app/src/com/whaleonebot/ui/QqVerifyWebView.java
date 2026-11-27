package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.net.Uri;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * [layer: shell-android] QQ 账密登录滑块 / 新设备安全验证内置 WebView（支持本机与远程主力机闭环）。
 *
 * <p>严格对齐 2026-11-27 问答报告 Q6 / Q11：
 * <ul>
 *   <li>仅放行腾讯官方 HTTPS 验证页域名（{@link QqAuthState#isSafeHttpsTencentUrl}），启用 {@code FLAG_SECURE} 防截屏；</li>
 *   <li>通过 URL 参数与轻量 JS Bridge 捕获验证页产出的 {@code ticket} / {@code randstr}，自动回调并回传给被控机提交登录；</li>
 *   <li>同时提供「我已完成验证，继续登录」手动兜底按钮，不卡死流程。</li>
 * </ul>
 */
public final class QqVerifyWebView {

    public interface Callback {
        void onVerified(String ticket, String randStr, String sid);
        void onCancelled();
    }

    private static boolean busy;

    private QqVerifyWebView() {
    }

    public static boolean open(final Activity activity, final String verifyUrl, final Callback callback) {
        if (Looper.myLooper() != Looper.getMainLooper() || activity == null
                || activity.isFinishing() || activity.isDestroyed()) {
            return false;
        }
        if (!QqAuthState.isSafeHttpsTencentUrl(verifyUrl)) {
            Toast.makeText(activity, "安全拦截：验证地址不在腾讯官方 HTTPS 白名单内", Toast.LENGTH_LONG).show();
            return false;
        }
        if (busy) {
            Toast.makeText(activity, "安全验证窗口已打开", Toast.LENGTH_SHORT).show();
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

        final boolean[] done = {false};
        final Dialog[] dialogRef = new Dialog[1];

        final Runnable cleanup = () -> {
            try {
                if (dialogRef[0] != null && dialogRef[0].isShowing()) dialogRef[0].dismiss();
            } catch (Throwable ignored) {}
            try {
                if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
                web.stopLoading();
                web.clearHistory();
                web.destroy();
            } catch (Throwable ignored) {}
            busy = false;
        };

        final java.util.function.BiConsumer<String, String> finishWithTicket = (ticket, randStr) -> {
            if (done[0]) return;
            done[0] = true;
            String sid = "";
            try {
                String qSid = Uri.parse(verifyUrl).getQueryParameter("sid");
                if (qSid != null) sid = qSid;
            } catch (Throwable ignored) {}
            final String finalSid = sid;
            activity.runOnUiThread(() -> {
                cleanup.run();
                if (callback != null) callback.onVerified(ticket == null ? "" : ticket,
                        randStr == null ? "" : randStr, finalSid);
            });
        };

        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void onCapResult(String ticket, String randStr) {
                if (ticket != null && !ticket.trim().isEmpty()) {
                    finishWithTicket.accept(ticket.trim(), randStr == null ? "" : randStr.trim());
                }
            }
        }, "WhaleCaptchaBridge");

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
                if (checkUrlForTicket(u, finishWithTicket)) return true;
                if (request != null && request.isForMainFrame()) {
                    return !QqAuthState.isSafeHttpsTencentUrl(u);
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (checkUrlForTicket(url, finishWithTicket)) return;
                // 监听腾讯防水墙常见回调，若页面调用 mqq.ui.popBack / jsbridge 传回 ticket 则自动捕获
                view.evaluateJavascript(
                        "(function(){try{"
                                + "var orig=window.capDestroy||function(){};"
                                + "if(!window.__whaleHooked){window.__whaleHooked=1;"
                                + "window.addEventListener('message',function(e){try{var d=typeof e.data==='string'?JSON.parse(e.data):e.data;"
                                + "if(d&&d.ticket&&window.WhaleCaptchaBridge){window.WhaleCaptchaBridge.onCapResult(String(d.ticket),String(d.randstr||d.randStr||''));}}catch(_){}});"
                                + "}}catch(_){}})();", null);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (!done[0]) {
                    done[0] = true;
                    cleanup.run();
                    if (callback != null) callback.onCancelled();
                }
                return true;
            }
        });

        Theme t = PromptSheet.currentTheme(activity);
        dialogRef[0] = PromptSheet.custom(
                activity, t,
                "QQ 安全滑块 / 新设备验证",
                web,
                "我已完成验证，继续登录", (d, btn) -> finishWithTicket.accept("", ""),
                "刷新验证页", (d, btn) -> web.reload(),
                "取消", (d, btn) -> {
                    if (!done[0]) {
                        done[0] = true;
                        cleanup.run();
                        if (callback != null) callback.onCancelled();
                    }
                },
                true, true, d -> {
                    if (!done[0]) {
                        done[0] = true;
                        cleanup.run();
                        if (callback != null) callback.onCancelled();
                    }
                }, null
        );
        web.loadUrl(verifyUrl);
        return true;
    }

    private static boolean checkUrlForTicket(String url, java.util.function.BiConsumer<String, String> sink) {
        if (url == null || url.isEmpty()) return false;
        try {
            Uri u = Uri.parse(url);
            String ticket = u.getQueryParameter("ticket");
            if (ticket == null || ticket.isEmpty()) ticket = u.getQueryParameter("sig");
            if (ticket != null && !ticket.trim().isEmpty()) {
                String rand = u.getQueryParameter("randstr");
                if (rand == null) rand = u.getQueryParameter("randStr");
                sink.accept(ticket.trim(), rand == null ? "" : rand.trim());
                return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }
}
