package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 平台页的<b>第一层：机器人选择</b>（用户 2026-11-18 提的层级）。
 *
 * <p>为什么要有这一层：机器人与平台是多对多的（见 {@link BotRegistry}）——
 * 同一个平台可以挂好几个机器人，同一个机器人也可以接好几个平台。
 * 所以「点平台」进来的第一件事必须是<b>选机器人</b>，而不是直接落到某一个机器人的运行面板上
 * （以前是取 {@code forPlatform(...).get(0)}，只认第一个，多机器人就分不清了）。
 *
 * <p>层级（别再压平）：
 * <pre>
 *   主页 → QQ 平台 → 【本页：机器人名字】 → 启动 / 配置 → 启动页 / 配置页
 * </pre>
 *
 * <p>数据一律现读 {@link BotRegistry#forPlatform(String)}，本页不缓存：从设置里新建完回来，
 * 看到的必然是最新列表。动效只由 {@link Motion} 统一执行，本页自己不加入场动画。
 */
final class PlatformBotsScreen extends Screen {

    /** 平台 id（qq / douyin / …），来自 {@link BotRegistry} 的 P_* 常量。 */
    private final String platformId;

    PlatformBotsScreen(AppShell shell, String platformId) {
        super(shell);
        this.platformId = (platformId == null || platformId.length() == 0)
                ? BotRegistry.P_QQ : platformId;
    }

    @Override
    void build() {
        final String label = BotRegistry.PLATFORM_LABEL(platformId);

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header(label), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView crumb = Ui.text(activity, "主页 / " + label, Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S1);
        col.addView(crumb, clp);

        List<BotRegistry.Bot> bots = BotRegistry.forPlatform(platformId);
        if (bots == null) bots = new ArrayList<BotRegistry.Bot>();

        if (BotRegistry.P_QQ.equals(platformId)) {
            java.io.File files=activity.getFilesDir();
            boolean legacyOnly=!bots.isEmpty() && bots.stream().allMatch(BotRegistry::legacyQQ);
            java.io.File client=legacyOnly?new java.io.File(files,"rootfs/opt/QQ"):new java.io.File(files,"platform-clients/qq/active/opt/QQ");
            if (!QqClientFiles.present(client)) {
                col.addView(Ui.strong(activity,"本机 QQ 客户端",Theme.T_CARD,t.textPrimary),marginTop(Theme.S3));
                col.addView(Ui.text(activity,"本地协议服务需要 Linux QQ（ARM64），不是手机上的 QQ。下载地址与安装引导在「设置 → 环境配置」里；使用外部协议服务可跳过。",Theme.T_BODY,t.textSecondary),marginTop(Theme.S1));
                TextView download=Ui.button(activity,t,"去「环境配置」取 QQ 安装包",false);
                download.setOnClickListener(v->shell.pushEnv());
                col.addView(download,marginTop(Theme.S1));
            }
        }
        if (bots.isEmpty()) {
            LinearLayout.LayoutParams elp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            elp.topMargin = dp(Theme.S4);
            col.addView(emptyCard(label), elp);
        } else {
            LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            slp.topMargin = dp(Theme.S3);
            col.addView(sectionLabel(label + " 机器人 · " + bots.size()), slp);

            for (int i = 0; i < bots.size(); i++) {
                LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
                if (i > 0) rlp.topMargin = dp(Theme.S2);
                else rlp.topMargin = dp(Theme.S1 + 2);
                col.addView(botCard(bots.get(i)), rlp);
            }
        }


    }

    // ------------------------------------------------------------------ 一个机器人

    /** 一行机器人：图标块 + 名字 + 运行端类型 + 箭头；整张卡可点，进「启动 / 配置」。 */
    private View botCard(final BotRegistry.Bot b) {
        if (b == null) return new View(activity);

        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(platformIcon(), new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(nameLine(b), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        CoreInventory.Instance core=BotRegistry.coreForBot(b.id);
        if(core!=null && CoreManagerScreen.managed(core)){
            boolean ready=false;try{java.io.File app=com.whaleonebot.install.CoreInstaller.active(activity.getFilesDir(),core.id);ready=app!=null && new java.io.File(app,"src/platform-modules/"+platformId+"/.bot-module.json").isFile();}catch(Exception ignored){}
            box.addView(Ui.text(activity,ready?"平台插件已安装":"平台插件待安装 · 设置 → 机器人",Theme.T_BODY,t.textSecondary));
        }
        // 只显示本平台（多平台混排会让人以为进了错页）
        for (BotRegistry.Binding binding : b.bindings) {
            if (platformId.equals(binding.platform)) {
                String bindingTitle = BotRegistry.P_QQ.equals(platformId) && binding.localQQ()
                        ? binding.label()
                        : BotRegistry.PLATFORM_LABEL(platformId) + "  "
                        + (binding.accountId == null || binding.accountId.isEmpty() ? "待登录" : binding.accountId);
                box.addView(Ui.text(activity, bindingTitle + "\n" + binding.detail(), Theme.T_BODY, t.textSecondary), marginTop(Theme.S1));
            }
        }
        row.addView(box, blp);

        IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
        row.addView(chev, Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushPlatformBot(b.id);
            }
        });
        return card;
    }

    /** 名字（占满剩余宽度）+ 运行端类型胶囊。 */
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

    /** 运行端类型（内置 / 自定义）。认不出的取值照样显示原文，免得以后加新类型时界面空白。 */
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

    /** 平台图标（QQ 是气泡，其余平台按注册表里的 id 走）。 */
    private IconView platformIcon() {
        int icon = IconView.CHAT;
        if (BotRegistry.P_DOUYIN.equals(platformId)) icon = IconView.MUSIC;
        else if (BotRegistry.P_BILIBILI.equals(platformId)) icon = IconView.TV;
        else if (BotRegistry.P_XIAOHEIHE.equals(platformId)) icon = IconView.BOX;
        return new IconView(activity, icon, t.accent);
    }

    // ------------------------------------------------------------------ 空态

    /**
     * 空态引导（规格 §2 / §5）：一句话说清去哪儿，一个主按钮直接带过去。
     * 文案与产品规格逐字一致，别改字 —— 验收就是按这句看的。
     */
    private View emptyCard(String label) {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S4), dp(Theme.S4), dp(Theme.S4), dp(Theme.S4));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        // 只显示本平台（多平台混排会让人以为进了错页）
        tile.addView(platformIcon(),
                new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER));
        box.addView(tile, Ui.llp(dp(52), dp(52)));

        TextView guide = Ui.text(activity,
                "本平台还没有机器人，请前往「设置 → 机器人」。",
                Theme.T_BODY, t.textPrimary);
        guide.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams glp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        glp.topMargin = dp(Theme.S3);
        box.addView(guide, glp);

        TextView go = Ui.button(activity, t, "去设置 · 机器人", true);
        go.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushBotList();
            }
        });
        LinearLayout.LayoutParams blp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        blp.topMargin = dp(Theme.S3);
        box.addView(go, blp);

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    // ------------------------------------------------------------------ 小工具

    private TextView sectionLabel(String text) {
        TextView tv = Ui.text(activity, text, Theme.T_CAP, t.textTertiary);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setLetterSpacing(0.06f);
        return tv;
    }

    private LinearLayout.LayoutParams marginTop(int token) {
        LinearLayout.LayoutParams lp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        lp.topMargin = dp(token);
        return lp;
    }
}
