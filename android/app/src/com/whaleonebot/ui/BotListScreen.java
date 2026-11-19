package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 机器人列表页：<b>设置 → 机器人</b>。
 *
 * <p>为什么单独一页：V1 的机器人与平台是多对多（见 {@link BotRegistry}），
 * 所以「管理机器人」必须有一层<b>与具体平台无关</b>的位置 —— 就是这里。
 * 平台页（QQ）只负责「启动 + 配置」，不再兼任机器人列表。
 *
 * <p>数据一律来自 {@link BotRegistry#list()}：本页不缓存、不自己造数据，
 * 每次 {@code build()} 重新读一遍，所以「新建后返回」看到的必然是最新列表。
 * 每行 = 名字 + 平台徽标（{@link BotRegistry#PLATFORM_LABEL}）+ 运行端类型；点击 → {@code shell.pushBot(id)}。
 *
 * <p>动效：本页不写任何入场动画（整页过渡只由 {@link Motion} 在 AppShell 里执行），
 * 只有 {@link Ui#press} 的按下反馈。
 */
final class BotListScreen extends Screen {

    BotListScreen(AppShell shell) {
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

        col.addView(header("机器人"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView crumb = Ui.text(activity, "设置 / 机器人", Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S1);
        col.addView(crumb, clp);

        // 每次进页都重新读注册表：新建/删除之后回来看到的就是最新状态。
        List<BotRegistry.Bot> bots = BotRegistry.list();
        if (bots == null) bots = new ArrayList<BotRegistry.Bot>();

        if (bots.isEmpty()) {
            // 空态：一句话 + 同一个主按钮（按钮统一放在列表末尾，两态位置一致，不跳动）
            LinearLayout.LayoutParams elp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            elp.topMargin = dp(Theme.S4);
            col.addView(emptyCard(), elp);
        } else {
            col.addView(sectionLabel("全部机器人 · " + bots.size()), labelLp(Theme.S3));
            for (int i = 0; i < bots.size(); i++) {
                LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
                if (i > 0) rlp.topMargin = dp(Theme.S2);
                col.addView(botCard(bots.get(i)), rlp);
            }
        }

        TextView newBtn = Ui.button(activity, t, "+ 新建机器人", true);
        newBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushNewBot();
            }
        });
        LinearLayout.LayoutParams nlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        nlp.topMargin = dp(Theme.S4);
        col.addView(newBtn, nlp);

        TextView note = Ui.text(activity,
                "一个机器人可以接多个平台。平台专属的设置（白名单、登录…）回首页点那个平台再配。",
                Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams tlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        tlp.topMargin = dp(Theme.S3);
        col.addView(note, tlp);
    }

    // ------------------------------------------------------------------ 一行机器人

    /**
     * 一张机器人卡：图标块 + 名字 + 运行端类型（右上角）+ 平台徽标行 + 箭头。
     * 整张卡可点，进该机器人的详情页。
     */
    private View botCard(final BotRegistry.Bot b) {
        if (b == null) return new View(activity);

        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.CHAT, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(nameLine(b), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        box.addView(platformLine(b), marginTop(Theme.S1 + 2));
        row.addView(box, blp);

        IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
        row.addView(chev, Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushBot(b.id);
            }
        });
        return card;
    }

    /** 第一行：名字（占满剩余宽度）+ 运行端类型胶囊。 */
    private View nameLine(BotRegistry.Bot b) {
        LinearLayout line = Ui.row(activity);

        TextView name = Ui.strong(activity, b.name == null ? "未命名机器人" : b.name,
                Theme.T_CARD, t.textPrimary);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        nlp.weight = 1f;
        nlp.rightMargin = dp(Theme.S1);
        line.addView(name, nlp);

        line.addView(runtimePill(b), new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        return line;
    }

    /**
     * 运行端类型（内置 / 自定义）。只读注册表里的 {@code runtimeKind}，不猜。
     * 认不出的取值照样显示原文，免得以后加新类型时界面变成空白。
     */
    private TextView runtimePill(BotRegistry.Bot b) {
        String kind = b == null ? null : b.runtimeKind;
        String label;
        if ("builtin".equals(kind)) {
            label = "内置运行端";
        } else if ("custom".equals(kind)) {
            label = "自定义运行端";
        } else if (kind != null && kind.length() > 0) {
            label = kind;
        } else {
            label = "运行端未设置";
        }

        TextView pill = Ui.text(activity, label, Theme.T_CAP, t.textSecondary);
        pill.setTypeface(Typeface.DEFAULT_BOLD);
        pill.setLetterSpacing(0.02f);
        pill.setPadding(dp(10), dp(4), dp(10), dp(4));
        pill.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_PILL)));
        return pill;
    }

    /** 第二行：平台徽标（名字取自注册表的 PLATFORM_LABEL；多平台时横向可滚）。 */
    private View platformLine(BotRegistry.Bot b) {
        List<String> platforms = b == null ? null : b.platforms;
        if (platforms == null || platforms.isEmpty()) {
            return Ui.text(activity, "未绑定平台", Theme.T_CAP, t.textTertiary);
        }

        HorizontalScrollView hs = new HorizontalScrollView(activity);
        hs.setHorizontalScrollBarEnabled(false);
        hs.setClipToPadding(false);

        LinearLayout chips = Ui.row(activity);
        for (int i = 0; i < platforms.size(); i++) {
            String id = platforms.get(i);
            if (id == null || id.length() == 0) continue;
            TextView chip = Ui.text(activity, BotRegistry.PLATFORM_LABEL(id), Theme.T_CAP, t.onAccent);
            chip.setTypeface(Typeface.DEFAULT_BOLD);
            chip.setPadding(dp(10), dp(4), dp(10), dp(4));
            chip.setGravity(Gravity.CENTER);
            chip.setBackground(Drawables.round(t.accent, 0, 0, dp(Theme.R_PILL)));
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
            if (chips.getChildCount() > 0) clp.leftMargin = dp(6);
            chips.addView(chip, clp);
        }
        hs.addView(chips, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        return hs;
    }

    // ------------------------------------------------------------------ 空态

    private View emptyCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(Theme.S3 + 2), dp(Theme.S4), dp(Theme.S3 + 2), dp(Theme.S4));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.CHAT, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        box.addView(tile, Ui.llp(dp(52), dp(52)));

        TextView title = Ui.strong(activity, "还没有机器人", Theme.T_CARD, t.textPrimary);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        tlp.topMargin = dp(Theme.S3);
        box.addView(title, tlp);

        TextView sub = Ui.text(activity,
                "新建一个：填名字与人设、选运行端、勾要接入的平台，它就会出现在这里。",
                Theme.T_CAP, t.textSecondary);
        sub.setGravity(Gravity.CENTER);
        sub.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S2);
        box.addView(sub, slp);

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    // ------------------------------------------------------------------ 小工具

    private TextView sectionLabel(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setLetterSpacing(0.08f);
        return v;
    }

    private LinearLayout.LayoutParams labelLp(int topMargin) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(topMargin);
        lp.bottomMargin = dp(Theme.S2);
        return lp;
    }

    private LinearLayout.LayoutParams marginTop(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(top);
        return lp;
    }
}
