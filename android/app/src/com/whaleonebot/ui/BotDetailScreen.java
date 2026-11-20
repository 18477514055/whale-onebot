package com.whaleonebot.ui;

import android.view.View;
import android.widget.*;
import static android.view.ViewGroup.LayoutParams.*;

/** 编辑机器人名下的账号，不跨机器人读取运行状态或配置。 */
final class BotDetailScreen extends Screen {
    private final BotRegistry.Bot bot;
    BotDetailScreen(AppShell shell, BotRegistry.Bot bot) { super(shell); this.bot = bot; }

    void build() {
        root.removeAllViews();
        ScrollView scroll = new ScrollView(activity);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col);
        col.addView(header(bot == null ? "找不到机器人" : bot.name));
        if (bot == null) return;
        text(col, bot.runtimeLabel() + "  /  " + bot.id);
        text(col, "账号绑定");
        FrameLayout card = Ui.card(activity,t);
        LinearLayout rows = Ui.column(activity);
        rows.setPadding(dp(Theme.S3),dp(Theme.S1),dp(Theme.S3),dp(Theme.S1));
        card.addView(rows); col.addView(card);
        for (BotRegistry.Binding binding : bot.bindings) {
            LinearLayout row = Ui.column(activity);
            row.setMinimumHeight(dp(Theme.TOUCH));
            row.setPadding(0,dp(Theme.S2),0,dp(Theme.S2));
            row.addView(Ui.strong(activity,binding.label(),Theme.T_CARD,t.textPrimary));
            row.addView(Ui.text(activity,binding.detail() + (binding.localQQ()?"  /  查看状态":"  /  编辑"),Theme.T_BODY,t.textSecondary));
            row.setFocusable(true); Ui.press(row,0.985f);
            row.setOnClickListener(v -> { if(binding.localQQ()) shell.pushBotStart(bot.id); else if(binding.hostedBili()) shell.pushBiliAccounts(bot.id,"config"); else edit(binding); }); rows.addView(row);
        }
        button(col,"添加账号绑定",true,v -> edit(null));
        if (!BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) button(col,"管理外部入口",false,v -> new RuntimeUiEditor(this,bot).show());
        if (BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            button(col,"机器人行为与模型配置",false,v->shell.pushBotConfig(bot.id));
            CoreInventory.Instance core=BotRegistry.coreForBot(bot.id);
            if(core!=null && CoreManagerScreen.managed(core))button(col,"平台插件与维护",false,v->shell.corePage("instance",core.id));
        }
    }
    private void edit(BotRegistry.Binding v) { new BindingEditor(this,bot,v).show(); }
    private void text(LinearLayout col,String value) {
        TextView label = Ui.text(activity,value,Theme.T_BODY,t.textSecondary);
        label.setPadding(0,dp(Theme.S3),0,dp(Theme.S2)); col.addView(label);
    }
    private void button(LinearLayout col,String label,boolean primary,View.OnClickListener click) {
        TextView button = Ui.button(activity,t,label,primary);
        button.setMinimumHeight(dp(Theme.TOUCH)); button.setOnClickListener(click);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT,WRAP_CONTENT); lp.topMargin=dp(Theme.S3); col.addView(button,lp);
    }
}
