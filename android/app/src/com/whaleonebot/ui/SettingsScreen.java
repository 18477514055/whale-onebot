package com.whaleonebot.ui;

import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.CompoundButton;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import com.whaleonebot.net.MirrorFetch;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 设置主页（2026-11-26 全面重做，对齐问答报告 Q7 / Q8）：
 * <ol>
 *   <li>顶部状态横幅：远程控制时高亮展示远端设备名并区分远端/本机作用范围，本机展示环境与机器人摘要；</li>
 *   <li>顶置主推卡：「一键部署向导」（选平台 → 环境核心 → 建档 → 大模型 Key → 登录启动，自动回到本页）；</li>
 *   <li>三大分组白底卡片（每项配专属矢量图标 + 实时状态摘要，彻底消灭全页重复齿轮/推子图标与平铺杂乱感）：
 *       ① 机器人与部署（机器人与核心 / 环境配置）
 *       ② 更新与数据（版本与国内镜像 / 备份中心 / 远程设备与配对）
 *       ③ 外观与保活（外观主题 / 自动重启保活）。</li>
 * </ol>
 */
final class SettingsScreen extends Screen {

    private TextView themeValue;
    private TextView watchdogValue;
    private Switch watchdogSwitch;

    SettingsScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("设置"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        final com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        final boolean remote = rm != null && rm.isRemote();

        // ---------------- 顶部作用域横幅（远程时醒目高亮防误操作） ----------------
        if (remote) {
            com.whaleonebot.remote.RemoteStore.PairedPeer peer = rm.activePeer();
            String peerName = peer == null ? "远端设备" : peer.displayName();
            LinearLayout banner = Ui.column(activity);
            banner.setBackground(Drawables.round(
                    Ui.alpha(t.accent, t.dark ? 0.20f : 0.10f),
                    t.accent, dp(1.2f), dp(Theme.R_CARD)));
            banner.setPadding(dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3), dp(Theme.S2 + 2));
            LinearLayout top = Ui.row(activity);
            top.addView(Ui.strong(activity, "正在远程设置：" + peerName, Theme.T_BODY, t.toneStrong),
                    new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            top.addView(Ui.pill(activity, t, "远端生效", Ui.TONE_OK));
            banner.addView(top, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            banner.addView(Ui.text(activity, "标有「远端」的设置将直接作用在远端手机；主题与设备配对始终仅作用于本机。",
                    Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
            col.addView(banner, topMargin(dp(Theme.S3)));
        }

        // ---------------- 顶置主推卡：一键部署向导 ----------------
        col.addView(buildWizardHeroCard(remote), topMargin(dp(Theme.S3)));

        // ---------------- 分组 1：机器人与部署 ----------------
        col.addView(groupLabel("机器人与部署"));
        LinearLayout g1 = Ui.addCard(col, activity, t, 0);

        int botCount = BotRegistry.list().size();
        int freeCores = 0;
        for (CoreInventory.Instance c : BotRegistry.cores()) if (c.ownerId.isEmpty()) freeCores++;
        g1.addView(groupRow(
                IconView.CHAT,
                "机器人与核心",
                "管理 " + botCount + " 台机器人 · 空闲核心 " + freeCores + " 份",
                remote ? "远端" : (botCount + " 台"),
                remote ? Ui.TONE_OK : Ui.TONE_NEUTRAL,
                v -> shell.pushBotList()));

        g1.addView(Ui.divider(activity, t));

        boolean envReady = remote
                ? rm.activeSnapshot().setupEnv
                : QqClientInstaller.usable(new java.io.File(activity.getFilesDir(), "rootfs"));
        g1.addView(groupRow(
                IconView.CPU,
                "环境配置",
                remote ? "远端运行环境与 QQ 客户端（支持本机推 .deb）" : "底层运行环境与 Linux QQ 安装包",
                envReady ? "已就绪" : "待配置",
                envReady ? Ui.TONE_OK : Ui.TONE_WARN,
                v -> shell.pushEnv()));

        // ---------------- 分组 2：更新与数据 ----------------
        col.addView(groupLabel("更新与数据"));
        LinearLayout g2 = Ui.addCard(col, activity, t, 0);

        String prefMirror = MirrorFetch.preferredPrefix();
        String mirrorHint = prefMirror.isEmpty()
                ? "自动无 VPN 国内镜像路由 · App / 核心 / 部件"
                : ("当前优选镜像：" + shortHost(prefMirror) + " · 支持一键测速");
        g2.addView(groupRow(
                IconView.GLOBE,
                "版本与国内镜像",
                mirrorHint,
                remote ? "远端" : "镜像池",
                Ui.TONE_OK,
                v -> shell.pushVersion()));

        g2.addView(Ui.divider(activity, t));

        g2.addView(groupRow(
                IconView.SHIELD,
                "备份中心",
                remote ? "P2P 流式导出、恢复或维护远端机器人备份" : "导出、恢复或清理本机机器人数据备份",
                remote ? "远端" : null,
                Ui.TONE_OK,
                v -> shell.corePage("backups", null)));

        g2.addView(Ui.divider(activity, t));

        int peerCount = com.whaleonebot.remote.RemoteControlManager.get(activity).store().listPeers().size();
        g2.addView(groupRow(
                IconView.QR,
                "远程设备与配对",
                "已配对 " + peerCount + " 台设备 · 扫码直连与本机配对码",
                peerCount > 0 ? (peerCount + " 台") : "本机",
                Ui.TONE_NEUTRAL,
                v -> shell.pushRemoteDevices(false)));

        // ---------------- 分组 3：外观与保活 ----------------
        col.addView(groupLabel("外观与保活"));
        LinearLayout g3 = Ui.addCard(col, activity, t, 0);

        themeValue = Ui.text(activity, "当前主题：" + t.name + "（仅作用于本机 App）", Theme.T_CAP, t.textSecondary);
        g3.addView(groupRowWithSub(
                IconView.PALETTE,
                "外观主题",
                themeValue,
                "本机",
                Ui.TONE_NEUTRAL,
                v -> shell.push(AppShell.P_THEME)));

        g3.addView(Ui.divider(activity, t));

        boolean enabled = remote ? rm.activeSnapshot().watchdogEnabled : com.whaleonebot.Watchdog.isEnabled(activity);
        watchdogValue = Ui.text(activity, watchdogText(enabled), Theme.T_CAP, t.textSecondary);
        watchdogSwitch = new Switch(activity);
        watchdogSwitch.setChecked(enabled);
        watchdogSwitch.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                if (remote) {
                    watchdogValue.setText(watchdogText(isChecked));
                    new Thread(() -> {
                        try {
                            rm.callActiveRpc("watchdog.set", new org.json.JSONObject().put("enabled", isChecked), 8000);
                            rm.triggerSnapshotRefresh();
                        } catch (Throwable ex) {
                            activity.runOnUiThread(() -> host().toast("远端自动重启设置失败：" + ex.getMessage()));
                        }
                    }, "remote-wd").start();
                    return;
                }
                com.whaleonebot.Watchdog.setEnabled(activity, isChecked);
                watchdogValue.setText(watchdogText(isChecked));
                if (isChecked) {
                    if (!com.whaleonebot.ContainerService.isRunning()
                            && com.whaleonebot.ui.SetupState.read(activity.getFilesDir()).env) {
                        com.whaleonebot.ContainerService.start(activity);
                    }
                    showAutostartDialog();
                }
            }
        });
        g3.addView(groupSwitchRow(IconView.POWER, "自动重启保活", watchdogValue, watchdogSwitch, remote));

        g3.addView(Ui.divider(activity, t));
        int kaScore = remote ? rm.activeSnapshot().keepAliveScore : KeepAliveInspector.inspect(activity).score;
        String kaBadge = remote ? (rm.activeSnapshot().netProxyHijack ? "代理风险" : (kaScore + " 分"))
                : (kaScore + " 分");
        g3.addView(groupRow(
                IconView.SHIELD,
                "登录健康与系统保活自检仪",
                "逐项检查电池白名单、自启动、精确闹钟与 VPN 代理劫持",
                kaBadge,
                kaScore < 70 || (remote && rm.activeSnapshot().netProxyHijack) ? Ui.TONE_WARN : Ui.TONE_OK,
                v -> shell.pushLoginHealth()));

        // ---------------- 分组 4：高级与开发者维护（折叠收纳，避免新手困惑） ----------------
        col.addView(groupLabel("高级与开发者维护"));
        LinearLayout g4 = Ui.addCard(col, activity, t, 0);
        final LinearLayout devBody = Ui.column(activity);
        devBody.setVisibility(View.GONE);
        final TextView devToggleSub = Ui.text(activity, "点击展开：自定义运行端 · 批量创建核心 · 高级维护", Theme.T_CAP, t.textSecondary);
        g4.addView(groupRowWithSub(
                IconView.TUNE,
                "开发者与底层维护",
                devToggleSub,
                "高级",
                Ui.TONE_NEUTRAL,
                v -> {
                    boolean show = devBody.getVisibility() != View.VISIBLE;
                    devBody.setVisibility(show ? View.VISIBLE : View.GONE);
                    devToggleSub.setText(show ? "点击收起底层维护入口" : "点击展开：自定义运行端 · 批量创建核心 · 高级维护");
                }));
        devBody.addView(Ui.divider(activity, t));
        devBody.addView(groupRow(
                IconView.BOX,
                "接入自定义运行端",
                "通过描述文件、HTTPS 或本机回环接入自建第三方运行端",
                "高级",
                Ui.TONE_NEUTRAL,
                v -> shell.corePage("custom", null)));
        devBody.addView(Ui.divider(activity, t));
        devBody.addView(groupRow(
                IconView.GLOBE,
                "批量下载空闲核心",
                "按指定版本准备 1~5 份独立核心实例供多机器人分配",
                "高级",
                Ui.TONE_NEUTRAL,
                v -> shell.corePage("download", null)));
        g4.addView(devBody, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    private FrameLayout buildWizardHeroCard(boolean remote) {
        FrameLayout card = new FrameLayout(activity);
        card.setBackground(Drawables.round(
                Ui.alpha(t.accent, t.dark ? 0.24f : 0.12f),
                t.accent, dp(1.2f), dp(Theme.R_CARD)));

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3), dp(Theme.S3 + 2));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(t.accent, 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.WIZARD, t.onAccent),
                new FrameLayout.LayoutParams(dp(26), dp(26), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(48), dp(48)));

        LinearLayout txt = Ui.column(activity);
        LinearLayout.LayoutParams tlp = Ui.llp(0, WRAP_CONTENT);
        tlp.weight = 1f;
        tlp.leftMargin = dp(Theme.S3);
        tlp.rightMargin = dp(Theme.S2);

        LinearLayout head = Ui.row(activity);
        head.addView(Ui.strong(activity, "一键部署向导", Theme.T_CARD, t.textPrimary));
        LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        plp.leftMargin = dp(8);
        head.addView(Ui.pill(activity, t, remote ? "远端可用" : "推荐", Ui.TONE_OK), plp);
        txt.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        txt.addView(Ui.text(activity,
                "选平台（QQ / B站 / 抖音测试版）→ 自动检测环境与核心 → 配模型 Key → 扫码上线",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        row.addView(txt, tlp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.accent), Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(v -> shell.pushDeployWizard());
        return card;
    }

    private LinearLayout groupRow(int icon, String title, String sub,
                                  String pillText, int pillTone, View.OnClickListener click) {
        return groupRowWithSub(icon, title, Ui.text(activity, sub, Theme.T_CAP, t.textSecondary),
                pillText, pillTone, click);
    }

    private LinearLayout groupRowWithSub(int icon, String title, TextView subView,
                                         String pillText, int pillTone, View.OnClickListener click) {
        LinearLayout row = Ui.row(activity);
        row.setPadding(0, dp(Theme.S1 + 2), 0, dp(Theme.S1 + 2));
        row.setMinimumHeight(dp(Theme.TOUCH + 8));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.14f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, icon, t.accent),
                new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(40), dp(40)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);

        LinearLayout titleRow = Ui.row(activity);
        titleRow.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary));
        if (pillText != null && pillText.length() > 0) {
            LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            plp.leftMargin = dp(8);
            titleRow.addView(Ui.pill(activity, t, pillText, pillTone), plp);
        }
        box.addView(titleRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        box.addView(subView, topMargin(dp(3)));
        row.addView(box, blp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
        row.setClickable(true);
        row.setFocusable(true);
        Ui.press(row, 0.985f);
        row.setOnClickListener(click);
        return row;
    }

    private LinearLayout groupSwitchRow(int icon, String title, TextView subView, Switch sw, boolean remoteBadge) {
        LinearLayout row = Ui.row(activity);
        row.setPadding(0, dp(Theme.S1 + 2), 0, dp(Theme.S1 + 2));
        row.setMinimumHeight(dp(Theme.TOUCH + 8));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.14f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, icon, t.accent),
                new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(40), dp(40)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);

        LinearLayout titleRow = Ui.row(activity);
        titleRow.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary));
        if (remoteBadge) {
            LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            plp.leftMargin = dp(8);
            titleRow.addView(Ui.pill(activity, t, "远端", Ui.TONE_OK), plp);
        }
        box.addView(titleRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        box.addView(subView, topMargin(dp(3)));
        row.addView(box, blp);

        row.addView(sw, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        return row;
    }

    private TextView groupLabel(String text) {
        TextView tv = Ui.text(activity, text, Theme.T_CAP, t.textTertiary);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setLetterSpacing(0.06f);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S4);
        lp.bottomMargin = dp(Theme.S1);
        tv.setLayoutParams(lp);
        return tv;
    }

    private LinearLayout.LayoutParams topMargin(int px) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = px;
        return lp;
    }

    private static String shortHost(String url) {
        try {
            String h = new java.net.URL(url).getHost();
            return h == null || h.isEmpty() ? url : h;
        } catch (Throwable ignored) {
            return url;
        }
    }

    private static String watchdogText(boolean enabled) {
        return enabled
                ? "被系统杀掉后约 3 分钟内自动拉起"
                : "关闭后被杀不会自动拉起";
    }

    private void showAutostartDialog() {
        PromptSheet.confirm(
                activity, t,
                "建议同时允许自启动",
                "否则被系统清理后不会再拉起。请在应用详情里允许自启动。",
                "去设置",
                () -> {
                    try {
                        Intent intent = new Intent(
                                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:" + activity.getPackageName()));
                        activity.startActivity(intent);
                    } catch (Throwable e) {
                        android.util.Log.w("WhaleUI", "打开应用详情失败", e);
                        host().toast("无法打开应用详情");
                    }
                },
                null, null,
                "知道了");
    }

    @Override
    void refresh() {
        super.refresh();
        if (themeValue == null) return;
        String want = "当前主题：" + shell.theme.name + "（仅作用于本机 App）";
        if (!want.equals(themeValue.getText().toString())) themeValue.setText(want);
    }
}
