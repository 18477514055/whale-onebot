package com.whaleonebot.ui;

import android.widget.*;
import android.view.View;
import com.whaleonebot.ContainerService;
import org.json.JSONArray;
import org.json.JSONObject;
import static android.view.ViewGroup.LayoutParams.*;

/** Worker lifecycle is never evidence that an account is connected. */
final class BoundStartScreen extends Screen {
    private final BotRegistry.Bot bot;
    private TextView status;
    private String previous;
    BoundStartScreen(AppShell shell,BotRegistry.Bot bot) {super(shell);this.bot=bot;}
    void build() {
        ScrollView scroll=new ScrollView(activity);root.addView(scroll);
        LinearLayout col=Ui.column(activity);col.setPadding(dp(Theme.S4),dp(Theme.S3),dp(Theme.S4),dp(Theme.S4));scroll.addView(col);
        col.addView(header(bot==null?"找不到机器人":bot.name)); if(bot==null)return;
        status=Ui.text(activity,"读取绑定状态…",Theme.T_BODY,t.textPrimary); status.setPadding(0,dp(Theme.S3),0,dp(Theme.S3)); col.addView(status);
        if (BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            if (!host().containerRunning()) add(col,"准备本地容器",false,v -> {ContainerService.start(activity);host().toast("正在准备本地容器");});
            add(col,"启动本机器人",true,v -> {ContainerService.startBoundBot(activity,bot.id);refresh();});
            add(col,"停止本机器人",false,v -> {ContainerService.stopBoundBot(bot.id);refresh();});
        }
        add(col,"管理账号绑定",false,v -> shell.pushBot(bot.id));
        TextView note=Ui.text(activity,"已验证连接并不授权回复。允许联系的人或群由该账号的运行端白名单单独控制。",Theme.T_BODY,t.textSecondary);
        note.setPadding(0,dp(Theme.S3),0,0);col.addView(note);refresh();
    }
    private void add(LinearLayout col,String label,boolean primary,View.OnClickListener action){
        TextView btn=Ui.button(activity,t,label,primary);btn.setMinimumHeight(dp(Theme.TOUCH));btn.setOnClickListener(action);
        LinearLayout.LayoutParams lp=Ui.llp(MATCH_PARENT,WRAP_CONTENT);lp.topMargin=dp(Theme.S2);col.addView(btn,lp);
    }
    void refresh(){
        if(bot==null || status==null)return;
        JSONObject result=ContainerService.bindingStatus(activity,bot.id);
        String state=result==null?"":result.optString("state");
        StringBuilder sb=new StringBuilder("运行端：").append(summary(state));
        JSONArray rows=result==null?null:result.optJSONArray("bindings");
        for(BotRegistry.Binding v:bot.bindings){
            boolean verified=false;
            if("running".equals(state) && rows!=null) for(int i=0;i<rows.length();i++){
                JSONObject row=rows.optJSONObject(i);
                if(row!=null && BindingPresentation.connected(v,state,row.optString("id"),row.optString("platform"),row.optString("accountId"),row.optString("state"))) verified=true;
            }
            sb.append("\n\n").append(v.label()).append("\n").append(v.detail()).append("\n").append(verified?"已验证连接":"未验证连接");
        }
        String s=sb.toString();if(!s.equals(previous)){status.setText(s);previous=s;}
    }
    static String summary(String state){
        switch(state){
            case "running":return "运行中（账号连接见下方）"; case "starting":return "启动中"; case "stopped":return "已停止";
            case "external":return "由自定义运行端管理"; case "failed":return "启动失败，请检查配置"; case "stale":return "状态已过期";
            case "credentials_required":return "缺少本次令牌，请编辑绑定"; case "config_required":return "请先完善账号绑定与运行端配置";
            case "runtime_missing":return "缺少支持多绑定的内置运行端"; case "container_required":return "本地容器尚未就绪"; default:return "暂无可核验状态";
        }
    }
}
