package com.whaleonebot.ui;

import android.view.View;
import android.widget.*;
import static android.view.ViewGroup.LayoutParams.*;

/** 编辑机器人名下的账号，不跨机器人读取运行状态或配置。 */
final class BotDetailScreen extends Screen {
    private final BotRegistry.Bot bot;
    private final String editorId;
    BotDetailScreen(AppShell shell,BotRegistry.Bot bot){this(shell,bot,null);}
    BotDetailScreen(AppShell shell,BotRegistry.Bot bot,String editorId){super(shell);this.bot=bot;this.editorId=editorId;}

    void build() {
        root.removeAllViews();
        if(editorId!=null && bot!=null){BotRegistry.Binding match=null;for(BotRegistry.Binding b:bot.bindings)if(b.id.equals(editorId))match=b;if(editorId.isEmpty()||match!=null){new BindingEditor(this,bot,match).show();return;}root.addView(header("账号已移除"));return;}
        ScrollView scroll = new ScrollView(activity);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col);
        col.addView(header(bot == null ? "找不到机器人" : bot.name));
        if (bot == null) return;
        EditText name=new EditText(activity);name.setSingleLine(true);name.setTextColor(t.textPrimary);name.setContentDescription("机器人名称");name.setVisibility(View.GONE);col.addView(name);
        button(col,"修改名称",false,v->{if(name.getVisibility()!=View.VISIBLE){name.setText(bot.name);name.setVisibility(View.VISIBLE);name.requestFocus();name.selectAll();((TextView)v).setText("保存名称");return;}String problem=BotRegistry.rename(bot.id,name.getText().toString());if(problem!=null){name.setError(problem);return;}build();});
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
        button(col,"高级接入 · 外部 OneBot 服务",false,v -> edit(null));
        if (!BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) button(col,"管理外部入口",false,v -> new RuntimeUiEditor(this,bot).show());
        if (BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            button(col,"机器人行为与模型配置",false,v->shell.pushBotConfig(bot.id));
            CoreInventory.Instance core=BotRegistry.coreForBot(bot.id);
            if(core!=null && CoreManagerScreen.managed(core)){
                for(String platform:core.platforms)if(!bot.platforms.contains(platform)&&BotRegistry.PLATFORM_SUPPORTED(platform))offerPlatform(col,core,platform);
                button(col,"平台插件与维护",false,v->shell.corePage("instance",core.id));
            }
        }
    }
    private void offerPlatform(LinearLayout col,CoreInventory.Instance core,String platform){
        final String label=BotRegistry.PLATFORM_LABEL(platform);
        button(col,"添加 "+label,false,v->{TextView action=(TextView)v;action.setEnabled(false);action.setText("正在计算下载量…");
            new Thread(()->{try{
                com.whaleonebot.install.CoreInstaller ci=com.whaleonebot.install.CoreInstaller.open(activity);
                String version=com.whaleonebot.install.CoreInstaller.release(activity.getFilesDir(),core.id);
                long bytes=ci.addPlatformBytes(core.id,version,platform);
                activity.runOnUiThread(()->{action.setText("保存并安装 "+label+" · "+android.text.format.Formatter.formatFileSize(activity,bytes));action.setEnabled(true);
                    action.setOnClickListener(w->{if(!BotRegistry.addPlatform(bot.id,core.id,platform)){host().toast("平台配置已变化，请返回重试");return;}
                        action.setEnabled(false);action.setText("正在安装 "+label);new Thread(()->{boolean ok=false;try{ok=ci.installAttachedPlatform(core.id,bot.id,version,platform,null);}catch(Exception ignored){}final boolean installed=ok;
                            activity.runOnUiThread(()->{host().toast(installed?"已安装 "+label:"平台已保存，请在平台插件中重试安装");build();});},"install-attached-platform").start();});});
            }catch(Exception e){activity.runOnUiThread(()->{action.setText("添加 "+label);action.setEnabled(true);host().toast(CoreManagerScreen.safe(e));});}},"quote-platform").start();});
    }
    private void edit(BotRegistry.Binding v) { shell.externalAccount(bot.id,v==null?null:v.id); }
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
