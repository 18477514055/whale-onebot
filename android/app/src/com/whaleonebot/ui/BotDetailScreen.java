package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 机器人详情页：平台面板（QQ）→ <b>机器人</b> → 运行端配置。
 *
 * <p>为什么要有这一层：运行端配置是「某个机器人」的配置，不是「QQ」的配置，更不是「App」的配置。
 * 一个机器人可能同时管几个平台，一个平台也可能挂几个机器人 —— 所以平台与配置之间必须有机器人这一层。
 * 标题、平台徽标、状态摘要全部来自 {@link BotRegistry.Bot}，平台名与显示名来自
 * {@link BotRegistry#PLATFORMS} / {@link BotRegistry#PLATFORM_LABEL(String)}，本页不写死任何一项。
 * 机器人 id 由 {@link AppShell} 从栈元素的 arg 里取（见 {@link AppShell#pushBot(String)}），
 * 因此两个不同机器人的详情页可以同时压在栈上而互不顶掉。
 *
 * <p>返回链路：主页 → QQ → 配置 → 本页 → 运行端配置。系统返回键在 AppShell 里逐级出栈，
 * 运行端配置的组页先由该页自己消费（退回列表页），不会一次跳回主页。
 */
final class BotDetailScreen extends Screen {

    private final BotRegistry.Bot bot;

    private TextView statusLine;
    private IconView statusDot;
    private TextView platformLine;
    private TextView summaryLine;

    private String lastStatus;
    private String lastPlatforms;

    BotDetailScreen(AppShell shell, BotRegistry.Bot bot) {
        super(shell);
        this.bot = bot == null ? BotRegistry.primary() : bot;
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

        String title = bot == null ? "机器人" : bot.name;
        col.addView(header(title), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 面包屑：这一页在哪儿，一眼能看出来。
        // 入口有两条（主页 → QQ → 配置 → 详情；设置 → 机器人 → 详情），所以只写
        // 「主页 / 机器人 / <名字>」这条恒成立的路径，不写死具体平台。
        TextView crumb = Ui.text(activity,
                "主页 / 机器人 / " + (bot == null ? "…" : bot.name),
                Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S1);
        col.addView(crumb, clp);

        // ---------- 状态卡 ----------
        FrameLayout statusCard = Ui.card(activity, t);
        LinearLayout sbox = Ui.column(activity);
        sbox.setPadding(dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2));

        LinearLayout line1 = Ui.row(activity);
        statusDot = new IconView(activity, IconView.DOT, t.textTertiary);
        line1.addView(statusDot, Ui.llp(dp(10), dp(10)));
        statusLine = Ui.strong(activity, "读取中…", Theme.T_CARD, t.textPrimary);
        LinearLayout.LayoutParams stlp = Ui.llp(0, WRAP_CONTENT);
        stlp.weight = 1f;
        stlp.leftMargin = dp(Theme.S1);
        line1.addView(statusLine, stlp);
        sbox.addView(line1, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        platformLine = Ui.text(activity, "平台", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams plp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        plp.topMargin = dp(Theme.S2);
        sbox.addView(platformLine, plp);

        // 平台胶囊：这个机器人接入的实心、没接通的「未接入」描边。多平台时一行放不下就横向滚动。
        // 平台清单与显示名一律来自 BotRegistry（合同 §1），本页不自己写死平台名。
        HorizontalScrollView hs = new HorizontalScrollView(activity);
        hs.setHorizontalScrollBarEnabled(false);
        hs.setClipToPadding(false);
        LinearLayout chips = Ui.row(activity);
        hs.addView(chips, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        for (int i = 0; i < BotRegistry.PLATFORMS.size(); i++) {
            String p = BotRegistry.PLATFORMS.get(i);
            boolean supported = BotRegistry.PLATFORM_SUPPORTED(p);
            boolean bound = bot != null && bot.serves(p);
            TextView chip = chip(BotRegistry.PLATFORM_LABEL(p) + (supported ? "" : " · 未接入"),
                    bound && supported);
            LinearLayout.LayoutParams chlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            if (i > 0) chlp.leftMargin = dp(Theme.S1);
            chips.addView(chip, chlp);
        }
        LinearLayout.LayoutParams hlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        hlp.topMargin = dp(Theme.S2);
        sbox.addView(hs, hlp);

        summaryLine = Ui.text(activity, "", Theme.T_CAP, t.textTertiary);
        summaryLine.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams sumlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        sumlp.topMargin = dp(Theme.S2);
        sbox.addView(summaryLine, sumlp);

        statusCard.addView(sbox, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams sclp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        sclp.topMargin = dp(Theme.S3);
        col.addView(statusCard, sclp);

        // ---------- 运行端配置入口 ----------
        TextView cfgLabel = Ui.text(activity, "配置", Theme.T_CAP, t.textSecondary);
        cfgLabel.setTypeface(Typeface.DEFAULT_BOLD);
        cfgLabel.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams cfgllp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        cfgllp.topMargin = dp(Theme.S4);
        cfgllp.bottomMargin = dp(Theme.S2);
        col.addView(cfgLabel, cfgllp);

        col.addView(botConfigCard(), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- 扩展预留 ----------
        TextView moreLabel = Ui.text(activity, "扩展", Theme.T_CAP, t.textSecondary);
        moreLabel.setTypeface(Typeface.DEFAULT_BOLD);
        moreLabel.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams mllp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        mllp.topMargin = dp(Theme.S4);
        mllp.bottomMargin = dp(Theme.S2);
        col.addView(moreLabel, mllp);

        FrameLayout moreCard = Ui.card(activity, t);
        LinearLayout mbox = Ui.column(activity);
        mbox.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));

        TextView note = Ui.text(activity,
                "一个机器人可以管多个平台，一个平台也可以挂多个机器人 —— 这两条由下面的入口承载，"
                        + "新建与平台绑定的入口仍在建设中。",
                Theme.T_CAP, t.textSecondary);
        note.setLineSpacing(dp(3), 1f);
        mbox.addView(note, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        mbox.addView(extensionRow("新增机器人", "多机器人：每个机器人有自己的配置"),
                marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        mbox.addView(extensionRow("绑定到其它平台", "多平台：抖音 / bilibili / 小黑盒"),
                marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        moreCard.addView(mbox, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams mclp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        mclp.topMargin = dp(Theme.S2);
        col.addView(moreCard, mclp);

        refresh();
    }

    /** 「运行端配置」入口：视觉与设置页里的入口卡一致（图标块 + 标题/副标题 + 箭头）。 */
    private View botConfigCard() {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.TUNE, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, "运行端配置", Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity, "白名单 / 人格 / 回复 / 主动发言…", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        slp.topMargin = dp(4);
        box.addView(sub, slp);
        row.addView(box, blp);

        IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
        row.addView(chev, Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // 配置挂在机器人上，所以这里带 id 进（栈元素是 (kind, arg)，
                // 两个不同机器人的配置页同时压栈也不会互相顶掉）。
                if (bot == null) {
                    shell.pushBotList();
                } else {
                    shell.pushBotConfig(bot.id);
                }
            }
        });
        return card;
    }

    private TextView chip(String label, boolean active) {
        TextView c = Ui.text(activity, label, Theme.T_CAP, active ? t.onAccent : t.ghostText);
        c.setTypeface(Typeface.DEFAULT_BOLD);
        c.setPadding(dp(Theme.S2), dp(8), dp(Theme.S2), dp(8));
        c.setGravity(Gravity.CENTER);
        c.setBackground(active
                ? Drawables.round(t.accent, 0, 0, dp(Theme.R_PILL))
                : Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_PILL)));
        return c;
    }

    /** 预留入口：不可点，带「敬请期待」角标 —— 明确告知能力边界，不做假按钮。 */
    private View extensionRow(String title, String sub) {
        LinearLayout row = Ui.row(activity);

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        box.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView s = Ui.text(activity, sub, Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams slp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        slp.topMargin = dp(3);
        box.addView(s, slp);
        row.addView(box, blp);

        TextView badge = Ui.text(activity, "敬请期待", Theme.T_CAP, t.toneStrong);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        badge.setLetterSpacing(0.02f);
        badge.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f),
                Ui.alpha(t.accent, 0.30f), dp(1), dp(Theme.R_PILL)));
        badge.setPadding(dp(10), dp(5), dp(10), dp(5));
        row.addView(badge, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        return row;
    }

    private LinearLayout.LayoutParams marginTop(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }

    @Override
    void refresh() {
        if (bot == null) return;

        // 把真实状态喂给注册表：机器人层（QQ 面板与本页）都只读它，不各自去问宿主。
        boolean running = host().containerRunning();
        String uin = host().loginUin();
        boolean logged = uin != null && uin.length() > 0;
        BotRegistry.report(BotRegistry.P_QQ, running, logged ? uin : null);

        String status = bot.statusSummary();
        if (statusLine != null && !status.equals(lastStatus)) {
            statusLine.setText(status);
            lastStatus = status;
        }
        if (statusDot != null) {
            statusDot.setColor(!running ? t.textTertiary : (logged ? t.accent : t.textSecondary));
        }

        String platforms = "平台：" + bot.platformSummary();
        if (platformLine != null && !platforms.equals(lastPlatforms)) {
            platformLine.setText(platforms);
            lastPlatforms = platforms;
        }

        if (summaryLine != null) {
            int n = bot.platforms == null ? 0 : bot.platforms.size();
            String text = "机器人 id：" + bot.id + " · 运行端：" + bot.runtimeLabel()
                    + " · 名下平台 " + n + " 个"
                    + " · 运行端配置读的是这个机器人自己的 config.json";
            if (!text.equals(summaryLine.getText().toString())) summaryLine.setText(text);
        }
    }
}
