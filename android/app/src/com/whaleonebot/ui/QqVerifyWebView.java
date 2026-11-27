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
        default void onExtendedVerified(String ticket, String randStr, String sid,
                                        String newDeviceLoginSig, String unusualDeviceCheckSig) {
            onVerified(ticket, randStr, sid);
        }
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
                if (callback != null) callback.onExtendedVerified(
                        ticket == null ? "" : ticket,
                        randStr == null ? "" : randStr,
                        finalSid, "", "");
            });
        };

        final java.util.function.Consumer<String[]> finishExtended = (parts) -> {
            if (done[0] || parts == null) return;
            done[0] = true;
            String tkt = parts.length > 0 && parts[0] != null ? parts[0] : "";
            String rnd = parts.length > 1 && parts[1] != null ? parts[1] : "";
            String sid = parts.length > 2 && parts[2] != null ? parts[2] : "";
            if (sid.isEmpty()) {
                try {
                    String qSid = Uri.parse(verifyUrl).getQueryParameter("sid");
                    if (qSid != null) sid = qSid;
                } catch (Throwable ignored) {}
            }
            final String fSid = sid;
            final String fNewDev = parts.length > 3 && parts[3] != null ? parts[3] : "";
            final String fUnusual = parts.length > 4 && parts[4] != null ? parts[4] : "";
            activity.runOnUiThread(() -> {
                cleanup.run();
                if (callback != null) callback.onExtendedVerified(tkt, rnd, fSid, fNewDev, fUnusual);
            });
        };

        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void onCapResult(String ticket, String randStr) {
                if (ticket != null && !ticket.trim().isEmpty()) {
                    finishWithTicket.accept(ticket.trim(), randStr == null ? "" : randStr.trim());
                }
            }

            @JavascriptInterface
            public void onDeviceResult(String ticket, String randStr, String sid, String newDeviceSig, String unusualSig) {
                if ((ticket != null && !ticket.trim().isEmpty())
                        || (newDeviceSig != null && !newDeviceSig.trim().isEmpty())
                        || (unusualSig != null && !unusualSig.trim().isEmpty())) {
                    finishExtended.accept(new String[]{
                            ticket == null ? "" : ticket.trim(),
                            randStr == null ? "" : randStr.trim(),
                            sid == null ? "" : sid.trim(),
                            newDeviceSig == null ? "" : newDeviceSig.trim(),
                            unusualSig == null ? "" : unusualSig.trim()
                    });
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
                if (checkUrlForTicket(u, finishExtended)) return true;
                if (request != null && request.isForMainFrame()) {
                    return !QqAuthState.isSafeHttpsTencentUrl(u);
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (checkUrlForTicket(url, finishExtended)) return;
                // 监听腾讯防水墙与安全中心多种回调（postMessage / capDestroy / mqq.ui.popBack / webkit handler）
                view.evaluateJavascript(
                        "(function(){try{"
                                + "if(!window.__whaleHooked){window.__whaleHooked=1;"
                                + "var emit=function(d){try{if(!d)return;"
                                + "if(typeof d==='string'){try{d=JSON.parse(d);}catch(_){return;}}"
                                + "var b=window.WhaleCaptchaBridge;if(!b)return;"
                                + "var t=d.ticket||d.sig||d.proofWaterSig||'';"
                                + "var r=d.randstr||d.randStr||d.proofWaterRand||'';"
                                + "var s=d.sid||d.proofWaterSid||'';"
                                + "var nd=d.newDeviceLoginSig||d.new_device_login_sig||'';"
                                + "var ud=d.unusualDeviceCheckSig||d.unusual_device_check_sig||'';"
                                + "if(t||nd||ud){b.onDeviceResult(String(t),String(r),String(s),String(nd),String(ud));}"
                                + "}catch(_){}};"
                                + "window.addEventListener('message',function(e){emit(e.data);});"
                                + "var origPop=window.mqq&&window.mqq.ui&&window.mqq.ui.popBack;"
                                + "if(window.mqq&&window.mqq.ui){window.mqq.ui.popBack=function(arg){emit(arg);if(origPop)return origPop.apply(this,arguments);};}"
                                + "var origCap=window.capDestroy;"
                                + "window.capDestroy=function(arg){emit(arg);if(origCap)return origCap.apply(this,arguments);};"
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

    private static boolean checkUrlForTicket(String url, java.util.function.Consumer<String[]> sink) {
        if (url == null || url.isEmpty()) return false;
        try {
            Uri u = Uri.parse(url);
            String ticket = firstParam(u, "ticket", "sig", "proofWaterSig");
            String rand = firstParam(u, "randstr", "randStr", "proofWaterRand");
            String sid = firstParam(u, "sid", "proofWaterSid");
            String newDev = firstParam(u, "newDeviceLoginSig", "new_device_login_sig");
            String unusual = firstParam(u, "unusualDeviceCheckSig", "unusual_device_check_sig");
            if (!ticket.isEmpty() || !newDev.isEmpty() || !unusual.isEmpty()) {
                sink.accept(new String[]{ticket, rand, sid, newDev, unusual});
                return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    private static String firstParam(Uri u, String... keys) {
        for (String k : keys) {
            String v = u.getQueryParameter(k);
            if (v != null && !v.trim().isEmpty()) return v.trim();
        }
        return "";
    }
}
