package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 平台页的<b>第二层：某个机器人在本平台的「启动 / 配置」两项</b>。
 *
 * <p>用户 2026-11-18 的要求：这一层只该有两个并列入口 ——
 * <b>启动</b>（点进去才是启动页：状态、启停、二维码、日志）与
 * <b>配置</b>（点进去是这个平台的全部设置）。
 * 以前启动面板和配置混在同一页上，看上去像「配置是启动的子项」，层级是错的。
 *
 * <pre>
 *   主页 → QQ 平台 → 机器人名字 → 【本页：启动 / 配置】 → 启动页 / 配置页
 * </pre>
 *
 * <p>本页不写任何数据、不缓存状态：两个卡片只做导航，运行状态一律在启动页里看。
 */
final class PlatformBotScreen extends Screen {

    private final BotRegistry.Bot bot;
    private final String platformId;

    PlatformBotScreen(AppShell shell, BotRegistry.Bot bot, String platformId) {
        super(shell);
        this.bot = bot;
        this.platformId = (platformId == null || platformId.length() == 0)
                ? BotRegistry.P_QQ : platformId;
    }

    @Override
    void build() {
        final String label = BotRegistry.PLATFORM_LABEL(platformId);
        final String name = bot == null || bot.name == null || bot.name.length() == 0
                ? "未命名机器人" : bot.name;

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header(name), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView crumb = Ui.text(activity, "主页 / " + label + " / " + name,
                Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S1);
        col.addView(crumb, clp);

        if (bot == null) {
            // 兜底：注册表里没有这台机器人（被删掉了 / 刚被清空）时不要空白页。
            LinearLayout.LayoutParams elp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            elp.topMargin = dp(Theme.S4);
            col.addView(missingCard(), elp);
            return;
        }

        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S3);
        CoreInventory.Instance core=BotRegistry.coreForBot(bot.id);
        if(core!=null && CoreManagerScreen.managed(core)){
            android.widget.Switch toggle=new android.widget.Switch(activity);toggle.setText(label);toggle.setTextColor(t.textPrimary);toggle.setMinHeight(dp(Theme.TOUCH));
            toggle.setChecked(BotRegistry.platformEnabled(bot.id,platformId));col.addView(toggle,slp);
            toggle.setOnClickListener(v->{boolean on=toggle.isChecked();
                if(on){boolean account=false;String vacant=null;for(BotRegistry.Binding binding:bot.bindings)if(platformId.equals(binding.platform)){if(!binding.accountId.isEmpty())account=true;else vacant=binding.id;}
                    if(!account){toggle.setChecked(false);if(BotRegistry.P_BILIBILI.equals(platformId)&&vacant!=null)shell.pushBiliAccounts(bot.id,"slot:"+vacant);else host().toast("请先完成该平台账号登录");return;}}
                if(!BotRegistry.setPlatformEnabled(bot.id,platformId,on)){toggle.setChecked(!on);host().toast("无法保存平台开关");return;}
                toggle.setEnabled(false);new Thread(()->{try{if(on)com.whaleonebot.ContainerService.startInstalledPlatform(activity,bot.id,platformId);else com.whaleonebot.ContainerService.stopInstalledPlatform(activity,bot.id,platformId);}catch(Exception e){activity.runOnUiThread(()->host().toast(on?"已允许此平台，启动未完成":"已关闭此平台，停止状态待核验"));}finally{activity.runOnUiThread(()->{toggle.setChecked(BotRegistry.platformEnabled(bot.id,platformId));toggle.setEnabled(true);});}},"platform-switch").start();
            });
        }

        LinearLayout.LayoutParams l1 = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        l1.topMargin = dp(Theme.S1 + 2);
        // ★ 文案必须跟着「当前进入的平台」走，而不是 legacyQQ(bot)：
        //   一个老 QQ 机器人后来加了 B 站账号，从 B 站进来仍然显示「旧版 QQ 容器」，
        //   用户会以为进错了页。路由本来就是对的（下面 pushBiliAccounts），错的是文案。
        final boolean biliEntry = BotRegistry.P_BILIBILI.equals(platformId);
        col.addView(entryCard(IconView.PLAY, "启动",
                biliEntry ? "B 站账号登录与连接" : BotRegistry.legacyQQ(bot) ? "查看旧版 QQ 容器状态与日志" : "查看本机器人的运行端和各账号连接", new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        if (BotRegistry.P_BILIBILI.equals(platformId)) shell.pushBiliAccounts(bot.id,"start");
                        else shell.pushBotStart(bot.id);
                    }
                }), l1);

        LinearLayout.LayoutParams l2 = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        l2.topMargin = dp(Theme.S2);
        col.addView(entryCard(IconView.TUNE, "配置",
                biliEntry ? "账号、私信对端、记忆范围与行为参数" : BotRegistry.legacyQQ(bot) ? name + " 在 QQ 上的运行端设置" : "管理账号、协议地址和记忆范围", new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        if (BotRegistry.P_BILIBILI.equals(platformId)) shell.pushBiliAccounts(bot.id,"config");
                        else if (BotRegistry.legacyQQ(bot)) shell.pushBotConfig(bot.id);
                        else shell.pushBot(bot.id);
                    }
                }), l2);

        // 用户 2026-11-18 追加：与「启动 / 配置」同层的第三项 —— 看板（只读观测，不写任何配置）。
        LinearLayout.LayoutParams l3 = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        l3.topMargin = dp(Theme.S2);
        if (BotRegistry.P_BILIBILI.equals(platformId) || BotRegistry.P_QQ.equals(platformId)) col.addView(entryCard(IconView.DOT, "看板",
                BotRegistry.P_BILIBILI.equals(platformId) ? "浏览、评论、配额与动作流水" : "实时状态、会话、调用、记忆", new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        if (BotRegistry.P_BILIBILI.equals(platformId)) shell.pushBiliAccounts(bot.id,"dashboard");
                        else if(BotRegistry.legacyQQ(bot)) shell.pushDashboardHub();
                        else shell.pushManagedQqDashboard(bot.id);
                    }
                }), l3);


    }

    // ------------------------------------------------------------------ 两个入口

    /** 一张入口卡：图标块 + 标题 + 一行说明 + 箭头。整张卡可点。 */
    private View entryCard(int icon, String title, String sub, View.OnClickListener click) {
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
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView subText = Ui.text(activity, sub, Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S1 + 2);
        box.addView(subText, slp);
        row.addView(box, blp);

        IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
        row.addView(chev, Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(click);
        return card;
    }

    private View missingCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S4), dp(Theme.S4), dp(Theme.S4), dp(Theme.S4));

        TextView guide = Ui.text(activity, "这台机器人已经不在列表里了（可能刚被删掉）",
                Theme.T_BODY, t.textPrimary);
        guide.setLineSpacing(dp(3), 1f);
        box.addView(guide, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView go = Ui.button(activity, t, "回到机器人列表", true);
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

    private TextView sectionLabel(String text) {
        TextView tv = Ui.text(activity, text, Theme.T_CAP, t.textTertiary);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setLetterSpacing(0.06f);
        return tv;
    }
}
