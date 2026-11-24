package com.whaleonebot.ui;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
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

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 设置页：平台无关的通用项（机器人、备份、版本管理、环境配置、主题、自动重启）。
 */
final class SettingsScreen extends Screen {

    /** 主题卡的副标题：换主题后由 {@link #refresh()} 就地更新。 */
    private TextView themeValue;

    /** 「自动重启」副标题（显示当前开关状态）。 */
    private TextView watchdogValue;

    /** 「自动重启」右侧开关。 */
    private Switch watchdogSwitch;

    SettingsScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("设置"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        View gap = new View(activity);
        col.addView(gap, Ui.llp(MATCH_PARENT, dp(Theme.S4)));

        // ---------- 机器人 ----------
        col.addView(entryCard(IconView.CHAT, "机器人",
                        Ui.text(activity, "新建 / 管理机器人，多平台共用",
                                Theme.T_CAP, t.textSecondary),
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                shell.pushBotList();
                            }
                        }),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- 备份 ----------
        col.addView(entryCard(IconView.TUNE, "备份",
                        Ui.text(activity, "导出、恢复或删除本地备份",
                                Theme.T_CAP, t.textSecondary),
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                shell.corePage("backups", null);
                            }
                        }),
                cardMargin());

        // ---------- 版本管理（唯一版本入口） ----------
        col.addView(entryCard(IconView.TUNE, "版本管理",
                        Ui.text(activity, "App、内置核心与平台插件",
                                Theme.T_CAP, t.textSecondary),
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                shell.pushVersion();
                            }
                        }),
                cardMargin());

        // ---------- 环境配置 ----------
        col.addView(entryCard(IconView.TUNE, "环境配置",
                        Ui.text(activity, "容器下载与 QQ 安装包（新机先来这里）",
                                Theme.T_CAP, t.textSecondary),
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                shell.pushEnv();
                            }
                        }),
                cardMargin());

        // ---------- 主题 ----------
        themeValue = Ui.text(activity, t.name, Theme.T_CAP, t.textSecondary);
        col.addView(entryCard(IconView.TUNE, "主题", themeValue,
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                shell.push(AppShell.P_THEME);
                            }
                        }),
                cardMargin());

        // ---------- 自动重启（右侧开关，仅开关可点） ----------
        boolean enabled = com.whaleonebot.Watchdog.isEnabled(activity);
        watchdogValue = Ui.text(activity, watchdogText(enabled), Theme.T_CAP, t.textSecondary);
        watchdogSwitch = new Switch(activity);
        watchdogSwitch.setChecked(enabled);
        watchdogSwitch.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                com.whaleonebot.Watchdog.setEnabled(activity, isChecked);
                if (isChecked && !com.whaleonebot.ContainerService.isRunning()) {
                    com.whaleonebot.ContainerService.start(activity);
                }
                watchdogValue.setText(watchdogText(isChecked));
                if (isChecked) {
                    showAutostartDialog();
                }
            }
        });
        col.addView(switchCard(IconView.TUNE, "自动重启", watchdogValue, watchdogSwitch),
                cardMargin());
    }

    /** 开关副标题：开启/关闭分别提示行为。 */
    private static String watchdogText(boolean enabled) {
        return enabled
                ? "被杀后自动拉起（约 3 分钟内）"
                : "关掉后被杀不会自动拉起";
    }

    /** 开启自动重启时弹出自制主题底部引导面板（替代原生黑框 AlertDialog）。 */
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

    private LinearLayout.LayoutParams cardMargin() {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S2);
        return lp;
    }

    /**
     * 一张入口卡：图标块 + 标题 + 副标题（{@code sub} 由调用方创建，便于之后就地更新文字）+ 箭头。
     */
    private FrameLayout entryCard(int icon, String title, TextView sub, View.OnClickListener click) {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, icon, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, title, Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        LinearLayout.LayoutParams slp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        slp.topMargin = dp(4);
        box.addView(sub, slp);
        row.addView(box, blp);

        IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
        row.addView(chev, Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(click);
        return card;
    }

    /**
     * 一张开关卡：图标块 + 标题 + 副标题 + 右侧 Switch。仅开关可点，卡片本身不响应点击。
     */
    private FrameLayout switchCard(int icon, String title, TextView sub, Switch sw) {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, icon, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, title, Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        LinearLayout.LayoutParams slp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        slp.topMargin = dp(4);
        box.addView(sub, slp);
        row.addView(box, blp);

        row.addView(sw, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        card.setClickable(false);
        card.setFocusable(false);
        return card;
    }

    @Override
    void refresh() {
        if (themeValue == null) return;
        String want = shell.theme.name;
        if (!want.equals(themeValue.getText().toString())) themeValue.setText(want);
    }
}
