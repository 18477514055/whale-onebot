package com.whaleonebot.ui;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.widget.*;

/** A named HTTPS link is a browser handoff, not an in-app extension or a runtime command. */
final class CustomRuntimeScreen extends Screen {
    private final BotRegistry.Bot bot;private final String platform;
    CustomRuntimeScreen(AppShell shell,BotRegistry.Bot bot,String platform){super(shell);this.bot=bot;this.platform=platform;}
    void build(){
        ScrollView scroll=new ScrollView(activity);root.addView(scroll);LinearLayout col=Ui.column(activity);int p=dp(Theme.S4);col.setPadding(p,p,p,p);scroll.addView(col);
        col.addView(header(bot.name));col.addView(Ui.text(activity,BotRegistry.PLATFORM_LABEL(platform)+" / 自定义运行端",Theme.T_BODY,t.textSecondary));
        for(BotRegistry.Binding v:bot.bindings)if(v.platform.equals(platform))col.addView(Ui.strong(activity,v.label(),Theme.T_CARD,t.textPrimary));
        for(RuntimeUiLink l:bot.runtimeUi)if(l.platform.equals(platform)){
            TextView go=Ui.button(activity,t,l.label,false);go.setMinimumHeight(dp(Theme.TOUCH));col.addView(go);
            go.setOnClickListener(v->new AlertDialog.Builder(activity).setTitle("在浏览器中打开？").setMessage(l.url).setNegativeButton("取消",null).setPositiveButton("打开",(d,k)->{
                try{activity.startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(l.url)).addCategory(Intent.CATEGORY_BROWSABLE));}catch(android.content.ActivityNotFoundException ex){host().toast("没有可用的浏览器");}
            }).show());
        }
        TextView bindings=Ui.button(activity,t,"管理账号绑定",false);bindings.setMinimumHeight(dp(Theme.TOUCH));bindings.setOnClickListener(v->shell.pushBot(bot.id));col.addView(bindings);
    }
}
