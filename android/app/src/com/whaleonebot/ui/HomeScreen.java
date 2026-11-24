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
    private final java.util.Map<String,TextView> platformCounts = new java.util.LinkedHashMap<>();
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

        // ---------- 新手指引（第一次用才出现，点「知道了」永久收起） ----------
        if (!Onboarding.seen(activity)) addGuide(col);

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
        addCard(IconView.TV, "bilibili", "查看本平台机器人",
                Ui.alpha(t.accent, 0.16f), t.accent, false);
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
                    host().toast("此平台尚未开放；可先配置 QQ 或 bilibili");
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
                    shell.pushPlatformBots(icon == IconView.TV ? BotRegistry.P_BILIBILI : BotRegistry.P_QQ);
                }
            });
        }

        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        if (!cards.isEmpty()) clp.topMargin = dp(Theme.S2);
        col.addView(card, clp);
        cards.add(card);

        if (!soon) platformCounts.put(icon == IconView.TV ? BotRegistry.P_BILIBILI : BotRegistry.P_QQ, sub);
    }

        /**
     * 三步指引卡。
     *
     * <p>文案刻意只留三步动作、不解释原理 —— 第一个使用者的原话是「不知道该先做什么」。
     * 三步各自的状态来自 {@link SetupState}（只读本地事实）：做完的打勾并变淡，没做的用主色标出来，
     * 按钮直接指向「下一件要做的事」。三步全做完就不再出现 —— 不必让人点「知道了」才能清屏。
     */
    private void addGuide(LinearLayout parent) {
        SetupState.Steps st = SetupState.read(activity.getFilesDir());
        if (st.all()) return;

        LinearLayout card = Ui.column(activity);
        card.setBackground(Drawables.round(t.cardFill, t.accent, dp(1), dp(Theme.R_CARD)));
        int pad = dp(Theme.S3);
        card.setPadding(pad, pad, pad, pad);

        card.addView(Ui.strong(activity, "第一次用？三步就能跑起来", Theme.T_CARD, t.textPrimary));
        TextView progress = Ui.text(activity, "已完成 " + st.done() + " / 3",
                Theme.T_CAP, st.done() == 0 ? t.textSecondary : t.accent);
        LinearLayout.LayoutParams plp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        plp.topMargin = dp(Theme.S1);
        card.addView(progress, plp);

        LinearLayout steps = Ui.column(activity);
        LinearLayout.LayoutParams stepsLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        stepsLp.topMargin = dp(Theme.S2);
        card.addView(steps, stepsLp);
        steps.addView(stepLine("1", "环境配置：下载内置核心（公共运行环境会一起装好）", st.env));
        steps.addView(stepLine("2", "装好 Linux QQ 安装包（同一页有下载地址与扫描安装）", st.qq));
        steps.addView(stepLine("3", "新建 QQ 机器人 → 启动它 → 连接", st.bot));

        LinearLayout actions = Ui.row(activity);
        // 环境与 QQ 都在「环境配置」页里做；这两步都过了才轮到新建机器人。
        boolean envFirst = !st.env || !st.qq;
        TextView go = Ui.button(activity, t, envFirst ? "去环境配置" : "新建机器人", true);
        go.setOnClickListener(v -> {
            if (envFirst) shell.pushEnv();
            else shell.pushNewBot();
        });
        TextView ok = Ui.button(activity, t, "知道了", false);
        ok.setOnClickListener(v -> {
            Onboarding.markSeen(activity);
            // ★ 不能直接 build()：build() 会再往 root 里 addView 一列，旧列没被移除 ⇒
            //   两层界面叠着画，文字互相压印（2026-11-25 主力机截图就是这现象）。
            //   重建前先清空：root 的全部子 View、平台计数表、卡片引用。
            root.removeAllViews();
            cards.clear();
            platformCounts.clear();
            build();
        });
        LinearLayout.LayoutParams goLp = Ui.llp(0, dp(Theme.TOUCH));
        goLp.weight = 1f;
        actions.addView(go, goLp);
        LinearLayout.LayoutParams okLp = Ui.llp(0, dp(Theme.TOUCH));
        okLp.weight = 1f;
        okLp.leftMargin = dp(Theme.S2);
        actions.addView(ok, okLp);
        LinearLayout.LayoutParams alp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        alp.topMargin = dp(Theme.S2);
        card.addView(actions, alp);

        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.bottomMargin = dp(Theme.S3);
        parent.addView(card, lp);
    }

    /** 一行分步：做完的打勾并变淡，没做的用正文色 —— 一眼看得出「下一步在哪」。 */
    private TextView stepLine(String no, String text, boolean done) {
        TextView line = Ui.text(activity, (done ? "✓ " : "○ ") + no + ". " + text,
                Theme.T_BODY, done ? t.textTertiary : t.textPrimary);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S1);
        line.setLayoutParams(lp);
        return line;
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
        for (java.util.Map.Entry<String,TextView> entry : platformCounts.entrySet()) {
            String sub = BotRegistry.forPlatform(entry.getKey()).size() + " 台机器人";
            if (!sub.contentEquals(entry.getValue().getText())) entry.getValue().setText(sub);
        }
    }
}
