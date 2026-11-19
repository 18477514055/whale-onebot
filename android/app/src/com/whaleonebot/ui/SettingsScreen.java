package com.whaleonebot.ui;

import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 设置页：<b>平台无关的通用项</b>都在这里。
 *
 * <p>分界线：换成任何平台都还成立的东西放这里 —— 「机器人」（新建 / 管理，多对多）与「主题」。
 * 只对某个平台/某个机器人成立的配置（运行端配置：白名单、人格、回复、主动发言…）
 * 不进这里，而是走「主页 → 平台 → 机器人 → 运行端配置」。
 *
 * <p>本页不再有任何 QQ 专属入口，也不再在这里用文字解释「运行端配置去哪了」——
 * 机器人这一层本身就是那个答案（点进去就是列表与新建）。
 */
final class SettingsScreen extends Screen {

    /** 主题卡的副标题：换主题后由 {@link #refresh()} 就地更新。 */
    private TextView themeValue;

    /** 「被杀之后自动重启」那一条的副标题（显示当前开关状态）。 */
    private TextView watchdogValue;

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

        // ---------- 机器人：新建 / 管理（一个机器人可接多个平台） ----------
        col.addView(entryCard(IconView.CHAT, "机器人",
                        Ui.text(activity, "新建 / 管理机器人，一个机器人可接多个平台",
                                Theme.T_CAP, t.textSecondary),
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                shell.pushBotList();
                            }
                        }),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- 主题 ----------
        themeValue = Ui.text(activity, t.name, Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams cardLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        cardLp.topMargin = dp(Theme.S2);
        col.addView(entryCard(IconView.TUNE, "主题", themeValue,
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                shell.push(AppShell.P_THEME);
                            }
                        }),
                cardLp);

        // ---------- 被杀之后自动重启（用户可关掉） ----------
        // 补偿层的开关放在用户手上：默认开，因为实测"进了电池白名单也会被厂商杀"；
        // 关掉就一个闹钟都不排（见 Watchdog）。
        watchdogValue = Ui.text(activity, watchdogText(), Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams wLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        wLp.topMargin = dp(Theme.S2);
        col.addView(entryCard(IconView.TUNE, "被杀之后自动重启", watchdogValue,
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                boolean next = !com.whaleonebot.Watchdog.isEnabled(activity);
                                com.whaleonebot.Watchdog.setEnabled(activity, next);
                                if (next && !com.whaleonebot.ContainerService.isRunning()) {
                                    com.whaleonebot.ContainerService.start(activity);
                                }
                                watchdogValue.setText(watchdogText());
                                host().toast(next ? "已开启：被系统杀掉后会自动拉起" : "已关闭：杀掉后不会自动拉起");
                            }
                        }),
                wLp);
    }

    /** 开关副标题：直接写当前状态，用户不用点进去猜。 */
    private String watchdogText() {
        return com.whaleonebot.Watchdog.isEnabled(activity)
                ? "已开启 · 被系统杀掉后会自动拉起（约 3 分钟内）"
                : "已关闭 · 被杀后不会自动拉起";
    }

    /**
     * 一张入口卡：图标块 + 标题 + 副标题（{@code sub} 由调用方创建，便于之后就地更新文字）+ 箭头。
     *
     * @param sub 副标题 View；本方法只负责挂进卡片
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

    @Override
    void refresh() {
        if (themeValue == null) return;
        String want = shell.theme.name;
        if (!want.equals(themeValue.getText().toString())) themeValue.setText(want);
    }
}
