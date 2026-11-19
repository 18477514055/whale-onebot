package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 首页：四张平台卡纵排，只有 QQ 能进。左上角圆形钮进设置。
 *
 * <p>构图不是简单的顶部堆叠 —— 卡片组在页头与页脚之间垂直居中，
 * 配合错峰入场（60ms 间隔），读起来像一块「启动台」而不是一列列表。
 */
final class HomeScreen extends Screen {

    private final ArrayList<View> cards = new ArrayList<View>();

    private LinearLayout col;
    private TextView qqSub;
    private IconView qqDot;
    private String lastSub;
    private int lastDot = Integer.MIN_VALUE;
    private View fab;

    HomeScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S4));
        root.addView(col, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        // ---------- 页头（左边 80dp 让给 FAB） ----------
        LinearLayout head = Ui.row(activity);
        head.setPadding(dp(80), 0, 0, 0);
        head.setMinimumHeight(dp(64));

        LinearLayout titleBox = Ui.column(activity);
        // 单行 + 自动缩放：系统字体放大 / 厂家字体偏宽时自动缩到放得下，
        // 绝不能出现 "WhaleOneBot" 被截成 "WhaleOneB"。
        TextView title = Ui.strong(activity, "WhaleOneBot", Theme.T_TITLE, t.textPrimary);
        title.setSingleLine(true);
        title.setAutoSizeTextTypeUniformWithConfiguration(
                15, Theme.T_TITLE, 1, TypedValue.COMPLEX_UNIT_SP);
        titleBox.addView(title);
        TextView sub = Ui.text(activity, "本地容器 · 机器人控制台", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        slp.topMargin = dp(4);
        titleBox.addView(sub, slp);
        // 权重 1：标题块拿到「剩余的全部宽度」，宽度确定后 autosize 才能生效
        LinearLayout.LayoutParams boxLp = Ui.llp(0, WRAP_CONTENT);
        boxLp.weight = 1f;
        head.addView(titleBox, boxLp);
        col.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- 固定间距（不再用顶部弹性留白，卡片组贴着页头往下排） ----------
        col.addView(new View(activity), Ui.llp(MATCH_PARENT, dp(Theme.S4)));

        // ---------- 分区标签 ----------
        TextView label = Ui.text(activity, "平台", Theme.T_CAP, t.textSecondary);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams labelLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        labelLp.bottomMargin = dp(Theme.S2);
        col.addView(label, labelLp);

        // ---------- 四张卡 ----------
        addCard(IconView.CHAT, "QQ", null,
                Ui.alpha(t.accent, 0.16f), t.accent, false);
        addCard(IconView.MUSIC, "抖音", "短视频与直播",
                Ui.alpha(t.textPrimary, 0.10f), Ui.alpha(t.textPrimary, 0.85f), true);
        addCard(IconView.TV, "bilibili", "视频、直播与动态",
                Ui.alpha(t.textPrimary, 0.10f), Ui.alpha(t.textPrimary, 0.85f), true);
        addCard(IconView.BOX, "小黑盒", "游戏社区与战绩",
                Ui.alpha(t.textPrimary, 0.10f), Ui.alpha(t.textPrimary, 0.85f), true);

        // ---------- 余量全部放到卡片组下方，页脚仍然贴在底部 ----------
        col.addView(new View(activity), new LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f));

        TextView foot = Ui.text(activity, "所有数据都留在本机", Theme.T_CAP, t.textTertiary);
        foot.setGravity(Gravity.CENTER);
        col.addView(foot, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- FAB ----------
        fab = new Fab(activity, t);
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(dp(56), dp(56),
                Gravity.TOP | Gravity.START);
        flp.leftMargin = dp(Theme.S4);
        flp.topMargin = dp(Theme.S3);
        fab.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.push(AppShell.P_SETTINGS);
            }
        });
        root.addView(fab, flp);
    }

    /** 一张平台卡：图标块 + 标题/副标题 + 尾部（箭头或「敬请期待」角标）。 */
    private void addCard(int icon, String name, String staticSub,
                         int tileFill, int iconTint, boolean soon) {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        // 纵向 24、横向 24/16：卡片高 112dp，四张在首屏更有分量
        row.setPadding(dp(Theme.S4), dp(Theme.S4), dp(Theme.S3), dp(Theme.S4));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        // 图标块
        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(tileFill, 0, 0, dp(Theme.R_TILE)));
        IconView iv = new IconView(activity, icon, iconTint);
        tile.addView(iv, new FrameLayout.LayoutParams(dp(32), dp(32), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(64), dp(64)));

        // 文字块
        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);

        TextView title = Ui.strong(activity, name, Theme.T_CARD, t.textPrimary);
        box.addView(title, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        LinearLayout subRow = Ui.row(activity);
        IconView dot = new IconView(activity, IconView.DOT,
                soon ? Ui.alpha(t.textTertiary, 0.55f) : t.textTertiary);
        subRow.addView(dot, Ui.llp(dp(8), dp(8)));
        TextView sub = Ui.text(activity, staticSub == null ? "读取中…" : staticSub,
                Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams sublp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        sublp.leftMargin = dp(6);
        subRow.addView(sub, sublp);
        LinearLayout.LayoutParams srlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        srlp.topMargin = dp(4);
        box.addView(subRow, srlp);

        row.addView(box, blp);

        if (soon) {
            TextView badge = Ui.text(activity, "敬请期待", Theme.T_CAP, t.toneStrong);
            badge.setTypeface(Typeface.DEFAULT_BOLD);
            badge.setLetterSpacing(0.02f);
            badge.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f),
                    Ui.alpha(t.accent, 0.30f), dp(1), dp(Theme.R_PILL)));
            badge.setPadding(dp(10), dp(5), dp(10), dp(5));
            row.addView(badge, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        } else {
            IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
            row.addView(chev, Ui.llp(dp(20), dp(20)));
        }

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        if (soon) {
            card.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    host().toast("还在路上，先用 QQ 吧");
                }
            });
            card.setAlpha(0.62f); // 明确的「不可用」，但文字仍可读
        } else {
            card.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    // 用户 2026-11-18 定：点平台先进「这个平台的机器人选择」，
                    // 再点机器人进「启动 / 配置」。V1 只有 QQ 可点，所以平台 id 先写死 QQ；
                    // 等别的平台开放时给 addCard 加一个 platformId 参数即可（就这一处）。
                    shell.pushPlatformBots(BotRegistry.P_QQ);
                }
            });
        }

        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        if (!cards.isEmpty()) clp.topMargin = dp(Theme.S2);
        col.addView(card, clp);
        cards.add(card);

        if (staticSub == null) {
            qqSub = sub;
            qqDot = dot;
        }
    }

    @Override
    void onAttach() {
        // 错峰入场：60ms 间隔，320ms 进程，translateY 16dp。
        // 参数集中在 Motion 里 —— 页面的入场动效不再各写一套（见 Motion 的说明）。
        Motion.stagger(cards, 60L, 320L, dp(16));
        Motion.popIn(fab, 40L, 260L, 0.86f);
    }

    @Override
    void refresh() {
        boolean running = host().containerRunning();
        String uin = host().loginUin();
        boolean logged = uin != null && uin.length() > 0;

        String sub;
        if (!running) {
            sub = "容器未启动";
        } else if (logged) {
            sub = "已登录 " + uin;
        } else {
            sub = "未登录";
        }
        if (qqSub != null && !sub.equals(lastSub)) {
            qqSub.setText(sub);
            lastSub = sub;
        }

        int dotColor = !running ? Ui.alpha(t.textTertiary, 0.55f)
                : (logged ? t.accent : t.textSecondary);
        if (qqDot != null && dotColor != lastDot) {
            qqDot.setColor(dotColor);
            lastDot = dotColor;
        }
    }
}
