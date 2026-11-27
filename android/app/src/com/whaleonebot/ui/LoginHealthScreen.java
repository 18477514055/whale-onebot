package com.whaleonebot.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.whaleonebot.remote.RemoteControlManager;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 多平台（QQ / B 站 / 抖音）登录健康、网络防劫持、保活自检与四级重启统一中心。
 */
final class LoginHealthScreen extends Screen {

    private LinearLayout col;
    private TextView netPill;
    private TextView netDetail;
    private TextView keepScoreText;
    private LinearLayout keepListBox;
    private LinearLayout platBox;
    private TextView recoverAllBtn;
    private String lastSig = "";

    LoginHealthScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        boolean remote = RemoteBridge.isRemote();
        col.addView(header("多平台登录健康中心" + (remote ? "（远程）" : "")), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 1. 网络出口与代理劫持排查卡
        LinearLayout netCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout netHead = Ui.row(activity);
        netHead.addView(Ui.strong(activity, "网络出口与代理防劫持", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        netPill = Ui.pill(activity, t, "检测中…", Ui.TONE_NEUTRAL);
        netHead.addView(netPill, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        netCard.addView(netHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        netDetail = Ui.text(activity, "正在检测 Wi-Fi / 移动网络 / Tailscale 与代理 TUN 状态…", Theme.T_CAP, t.textSecondary);
        netCard.addView(netDetail, topMargin(dp(Theme.S2)));

        LinearLayout netBtns = Ui.row(activity);
        TextView copyRuleBtn = Ui.button(activity, t, "复制 sing-box/Clash 绕行规则", false);
        copyRuleBtn.setOnClickListener(v -> copyBypassRule());
        netBtns.addView(copyRuleBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1.3f));
        TextView vpnSetBtn = Ui.button(activity, t, "VPN 设置", false);
        vpnSetBtn.setOnClickListener(v -> {
            try { activity.startActivity(new Intent(Settings.ACTION_VPN_SETTINGS)); }
            catch (Throwable ignored) { host().toast("请从系统设置打开 VPN 管理"); }
        });
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 0.7f);
        vlp.leftMargin = dp(Theme.S2);
        netBtns.addView(vpnSetBtn, vlp);
        netCard.addView(netBtns, topMargin(dp(Theme.S2)));

        // 2. 系统保活自检仪卡
        LinearLayout keepCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout keepHead = Ui.row(activity);
        keepHead.addView(Ui.strong(activity, "系统保活自检仪", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        keepScoreText = Ui.pill(activity, t, "-- 分", Ui.TONE_NEUTRAL);
        keepHead.addView(keepScoreText, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        keepCard.addView(keepHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        keepListBox = Ui.column(activity);
        keepCard.addView(keepListBox, topMargin(dp(Theme.S2)));

        // 3. 三平台在线健康与一键恢复卡
        LinearLayout platCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout platHead = Ui.row(activity);
        platHead.addView(Ui.strong(activity, "QQ · bilibili · 抖音 在线健康", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        platCard.addView(platHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        platBox = Ui.column(activity);
        platCard.addView(platBox, topMargin(dp(Theme.S2)));

        recoverAllBtn = Ui.button(activity, t, "一键恢复全部有效会话（不碰已过期/无凭据）", true);
        recoverAllBtn.setOnClickListener(v -> recoverAllValid());
        platCard.addView(recoverAllBtn, topMargin(dp(Theme.S3)));

        // 4. 四级精细快速重启控制台
        LinearLayout rstCard = Ui.addCard(col, activity, t, Theme.S3);
        rstCard.addView(Ui.strong(activity, "四级精细重启与热恢复", Theme.T_CARD, t.textPrimary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        rstCard.addView(Ui.text(activity, "优先使用级别 1/2，避免打断其他平台与长连接。", Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        LinearLayout r12 = Ui.row(activity);
        TextView lvl1Btn = Ui.button(activity, t, "L1 · QQ 进程内热重连", true);
        lvl1Btn.setOnClickListener(v -> confirmProxyBeforeAction(() -> {
            RemoteBridge.hotReconnectQq(activity);
            host().toast("已下发 QQ 进程内毫秒级热重连（不断容器与 B 站）");
        }));
        TextView lvl2Btn = Ui.button(activity, t, "L2 · 仅重启 QQ", false);
        lvl2Btn.setOnClickListener(v -> confirmProxyBeforeAction(() -> host().restartQqOnly()));
        r12.addView(lvl1Btn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams r2lp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        r2lp.leftMargin = dp(Theme.S2);
        r12.addView(lvl2Btn, r2lp);
        rstCard.addView(r12, topMargin(dp(Theme.S3)));

        LinearLayout r34 = Ui.row(activity);
        TextView lvl3Btn = Ui.button(activity, t, "L3 · 重载 Agent 本体", false);
        lvl3Btn.setOnClickListener(v -> {
            RemoteBridge.restartAgentOnly(activity);
            host().toast("已触发 Agent 重载，QQ 与 B 站连接不受影响");
        });
        TextView lvl4Btn = Ui.button(activity, t, "L4 · 整容器全链路重启", false);
        lvl4Btn.setOnClickListener(v -> PromptSheet.showConfirm(
                activity, "确认整容器全链路重启？",
                "将依次重启整个 proot 容器、QQ 与各平台服务（短暂中断约数秒）。",
                "确认重启", () -> host().restartFullContainer(), "取消"));
        r34.addView(lvl3Btn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams r4lp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        r4lp.leftMargin = dp(Theme.S2);
        r34.addView(lvl4Btn, r4lp);
        rstCard.addView(r34, topMargin(dp(Theme.S2)));

        lastSig = "";
        refresh();
    }

    @Override
    void refresh() {
        super.refresh();
        final boolean remote = RemoteBridge.isRemote();
        RemoteControlManager rm = RemoteBridge.mgr();
        RemoteControlManager.RemoteSnapshot snap = (remote && rm != null) ? rm.activeSnapshot() : null;

        // 1. 更新网络与保活
        if (remote && snap != null) {
            int nLevel = snap.netRiskLevel;
            String nBadge = snap.netRiskBadge.isEmpty() ? "远端检测中" : snap.netRiskBadge;
            if (netPill != null) {
                netPill.setText(nBadge);
                applyPillTone(netPill, nLevel == NetworkRiskLogic.RISK_PROXY_HIJACK || nLevel == NetworkRiskLogic.RISK_OFFLINE);
            }
            if (netDetail != null) {
                netDetail.setText(snap.netRiskSummary.isEmpty() ? "正在从远端读取网络健康状态…" : snap.netRiskSummary);
            }
            if (keepScoreText != null) {
                keepScoreText.setText(snap.keepAliveScore + " 分 · " + (snap.keepAliveBadge.isEmpty() ? "远端" : snap.keepAliveBadge));
                applyPillTone(keepScoreText, snap.keepAliveScore < 70);
            }
            if (keepListBox != null && keepListBox.getChildCount() == 0) {
                keepListBox.addView(Ui.text(activity, "当前处于远程控制模式；系统电池与权限项请在被控机本地点击自检修复。", Theme.T_CAP, t.textSecondary));
            }
        } else {
            NetworkRiskLogic.Report net = NetworkRiskDetector.inspect(activity);
            if (netPill != null) {
                netPill.setText(net.badge);
                applyPillTone(netPill, net.isWarn());
            }
            if (netDetail != null) {
                netDetail.setText(net.summary + "\n" + net.detail);
            }
            KeepAliveInspector.Summary ks = KeepAliveInspector.inspect(activity);
            if (keepScoreText != null) {
                keepScoreText.setText(ks.score + " 分 · " + ks.badge);
                applyPillTone(keepScoreText, ks.score < 70);
            }
            renderKeepAliveItems(ks);
        }

        // 2. 更新三平台状态列表（按内容签名防高频重绘闪烁）
        StringBuilder sig = new StringBuilder();
        QqAuthState qq = host().qqAuthState();
        boolean contRun = host().containerRunning();
        sig.append(contRun).append('|').append(qq.phase).append('|').append(qq.uin).append('|').append(qq.offlineReason);
        for (BotRegistry.Bot b : BotRegistry.list()) {
            for (BotRegistry.Binding row : b.bindings) {
                if (row.hostedBili()) {
                    JSONObject bs = RemoteBridge.biliStatus(b.id, row.id);
                    sig.append('|').append(b.id).append(':').append(row.id).append(':').append(bs.optString("state"));
                }
            }
            DouyinSettings.SessionSummary dy = RemoteBridge.douyinSummary(activity, b.id);
            sig.append("|dy:").append(b.id).append(':').append(dy.saved).append(':').append(dy.state).append(':').append(dy.lastCheckAt);
        }
        String s = sig.toString();
        if (!s.equals(lastSig)) {
            lastSig = s;
            renderPlatforms(contRun, qq);
        }
    }

    private void renderKeepAliveItems(KeepAliveInspector.Summary ks) {
        if (keepListBox == null) return;
        keepListBox.removeAllViews();
        for (int i = 0; i < ks.items.size(); i++) {
            final KeepAliveInspector.CheckItem item = ks.items.get(i);
            if (i > 0) keepListBox.addView(Ui.divider(activity, t));
            LinearLayout row = Ui.row(activity);
            row.setPadding(0, dp(6), 0, dp(6));
            LinearLayout txt = Ui.column(activity);
            txt.addView(Ui.strong(activity, (item.ok ? "✓ " : "⚠ ") + item.title, Theme.T_BODY,
                    item.ok ? t.textPrimary : (t.dark ? 0xFFFF8A80 : 0xFFC62828)));
            txt.addView(Ui.text(activity, item.detail, Theme.T_CAP, t.textSecondary), topMargin(dp(2)));
            row.addView(txt, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            if (item.action != KeepAliveInspector.ACTION_NONE) {
                TextView fixBtn = Ui.pill(activity, t, item.fixLabel, item.ok ? Ui.TONE_NEUTRAL : Ui.TONE_WARN);
                fixBtn.setClickable(true);
                fixBtn.setOnClickListener(v -> {
                    if (item.action == KeepAliveInspector.ACTION_BYPASS_PROXY) {
                        copyBypassRule();
                    } else {
                        KeepAliveInspector.executeFix(activity, item, this::refresh);
                    }
                });
                LinearLayout.LayoutParams flp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
                flp.leftMargin = dp(8);
                row.addView(fixBtn, flp);
            }
            keepListBox.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
    }

    private void renderPlatforms(boolean contRun, QqAuthState qq) {
        if (platBox == null) return;
        platBox.removeAllViews();

        // A. QQ 行
        BotRegistry.Bot primary = BotRegistry.primary();
        boolean qqWarn = !contRun || qq.isOfflineAlert() || "degraded".equals(qq.phase) || qq.isMsfDisconnected();
        addPlatformRow(
                "QQ 机器人",
                qq.shortBadge(contRun),
                qq.detailMessage(contRun) + (qq.lastHealthyAt > 0
                        ? ("\n上次探活：" + formatTime(qq.lastHealthyAt) + " · 快登票据：" + (qq.canQuickLogin ? "可用" : "无"))
                        : ""),
                qqWarn,
                "打开 QQ 页",
                () -> {
                    if (primary != null) shell.pushBotStart(primary.id);
                    else shell.pushPlatformBots(BotRegistry.P_QQ);
                }
        );

        // B. B 站各槽位行
        int biliCount = 0;
        for (final BotRegistry.Bot b : BotRegistry.list()) {
            for (final BotRegistry.Binding row : b.bindings) {
                if (!row.hostedBili()) continue;
                biliCount++;
                platBox.addView(Ui.divider(activity, t));
                JSONObject bs = RemoteBridge.biliStatus(b.id, row.id);
                String st = bs.optString("state", "stopped");
                String ref = bs.optString("refreshSummary", "");
                boolean ok = BiliPlatformState.verified(st, row.accountId, bs.optString("selfId"));
                String label = BiliPlatformState.label(st, row.accountId, bs.optString("selfId"));
                addPlatformRow(
                        "bilibili · " + b.name + " (UID " + row.accountId + ")",
                        ok ? "在线已核验" : label,
                        (ref.isEmpty() ? "支持独立热重启与退避自愈" : ref),
                        !ok && !"stopped".equals(st),
                        ok ? "热重启" : "去处理",
                        () -> {
                            if (ok) {
                                RemoteBridge.restartBili(activity, b.id, row.id, row.peerId);
                                host().toast("正在独立热重启 B 站 UID " + row.accountId);
                            } else {
                                shell.pushBiliAccounts(b.id, "start");
                            }
                        }
                );
            }
        }
        if (biliCount == 0) {
            platBox.addView(Ui.divider(activity, t));
            addPlatformRow("bilibili", "暂未添加账号", "点击进入 B 站页面可扫码、官网登录或导入 Cookie", false,
                    "去配置", () -> shell.pushPlatformBots(BotRegistry.P_BILIBILI));
        }

        // C. 抖音各机器人行
        int dyCount = 0;
        for (final BotRegistry.Bot b : BotRegistry.list()) {
            DouyinSettings.SessionSummary dy = RemoteBridge.douyinSummary(activity, b.id);
            if (!dy.saved && dyCount > 0) continue;
            dyCount++;
            platBox.addView(Ui.divider(activity, t));
            String badge = !dy.saved ? "未登录"
                    : ("verified".equals(dy.state) || dy.verified ? "已验真在线"
                    : ("expired".equals(dy.state) ? "已失效需重登" : "已保存待核验"));
            String sub = !dy.saved ? "支持桌面扫码/短信自动捕获，每 45 分钟低频保活"
                    : ((!dy.nickname.isEmpty() ? dy.nickname + " · " : "") + "上次探活 " + formatTime(dy.lastCheckAt)
                    + (dy.lastError.isEmpty() ? "" : "\n" + dy.lastError));
            addPlatformRow(
                    "抖音 · " + b.name,
                    badge,
                    sub,
                    dy.saved && "expired".equals(dy.state),
                    dy.saved && !"expired".equals(dy.state) ? "核验" : "去登录",
                    () -> {
                        if (dy.saved && !"expired".equals(dy.state)) {
                            host().toast("正在核验抖音登录态…");
                            new Thread(() -> {
                                RemoteBridge.probeDouyin(activity, b.id);
                                activity.runOnUiThread(this::refresh);
                            }, "lh-dy-probe").start();
                        } else {
                            shell.pushDouyinPlatform(b.id, "start");
                        }
                    }
            );
        }
    }

    private void addPlatformRow(String title, String badge, String detail, boolean warn, String btnText, Runnable onClick) {
        LinearLayout row = Ui.row(activity);
        row.setPadding(0, dp(8), 0, dp(8));
        LinearLayout left = Ui.column(activity);
        LinearLayout head = Ui.row(activity);
        head.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        TextView pill = Ui.pill(activity, t, badge, warn ? Ui.TONE_WARN : Ui.TONE_NEUTRAL);
        applyPillTone(pill, warn);
        head.addView(pill, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        left.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        left.addView(Ui.text(activity, detail, Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        row.addView(left, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));

        TextView act = Ui.button(activity, t, btnText, false);
        act.setOnClickListener(v -> onClick.run());
        LinearLayout.LayoutParams alp = Ui.llp(WRAP_CONTENT, dp(Theme.TOUCH));
        alp.leftMargin = dp(8);
        row.addView(act, alp);
        platBox.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    private void recoverAllValid() {
        confirmProxyBeforeAction(() -> {
            int triggered = 0;
            QqAuthState qq = host().qqAuthState();
            if (!qq.isOnline() && qq.canQuickLogin && !"kicked-offline".equals(qq.phase) && !"token-expired".equals(qq.phase)) {
                RemoteBridge.hotReconnectQq(activity);
                triggered++;
            }
            for (BotRegistry.Bot b : BotRegistry.list()) {
                for (BotRegistry.Binding row : b.bindings) {
                    if (row.hostedBili() && RemoteBridge.hasBiliSession(activity, b.id, row.id)) {
                        JSONObject bs = RemoteBridge.biliStatus(b.id, row.id);
                        String st = bs.optString("state", "");
                        if (!"verified".equals(st) && !"reauth_required".equals(st)) {
                            RemoteBridge.startBili(activity, b.id, row.id, row.peerId);
                            triggered++;
                        }
                    }
                }
                DouyinSettings.SessionSummary dy = RemoteBridge.douyinSummary(activity, b.id);
                if (dy.saved && !"expired".equals(dy.state)) {
                    new Thread(() -> RemoteBridge.probeDouyin(activity, b.id), "lh-rec-dy").start();
                    triggered++;
                }
            }
            host().toast(triggered > 0
                    ? ("已向 " + triggered + " 个有效会话发起恢复（已失效/无凭据项不尝试）")
                    : "当前所有有效会话均已在线，或仅剩需人工重新登录的账号");
        });
    }

    private void confirmProxyBeforeAction(final Runnable action) {
        boolean hijack;
        if (RemoteBridge.isRemote()) {
            RemoteControlManager rm = RemoteBridge.mgr();
            hijack = rm != null && rm.activeSnapshot().netProxyHijack;
        } else {
            hijack = NetworkRiskDetector.inspect(activity).proxyHijack;
        }
        if (!hijack) {
            action.run();
            return;
        }
        PromptSheet.showConfirm(
                activity,
                "检测到全局代理正在劫持流量",
                "当前设备启用了全局代理/TUN（如 sing-box/Clash），直接连接 QQ 极易触发 -10003 或安全中心踢下线。\n\n建议先在代理软件中将 WhaleOneBot 加入直连白名单。",
                "仍要继续", action,
                "先看绕行规则");
    }

    private void copyBypassRule() {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("WhaleOneBot 代理绕行规则",
                    NetworkRiskDetector.bypassRuleSnippet(activity.getPackageName())));
            host().toast("已复制 sing-box / Clash 绕行规则到剪贴板");
        } catch (Throwable ignored) {
            host().toast("复制失败");
        }
    }

    private void applyPillTone(TextView pill, boolean warn) {
        pill.setBackground(Drawables.round(
                warn ? 0x26D9534F : Ui.alpha(t.accent, 0.16f),
                warn ? 0x99D9534F : t.ghostStroke,
                dp(1), dp(Theme.R_PILL)));
        pill.setTextColor(warn ? (t.dark ? 0xFFFF8A80 : 0xFFC62828) : t.toneStrong);
    }

    private static String formatTime(long ts) {
        if (ts <= 0L) return "暂无";
        return new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(new Date(ts));
    }

    private LinearLayout.LayoutParams topMargin(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }
}
