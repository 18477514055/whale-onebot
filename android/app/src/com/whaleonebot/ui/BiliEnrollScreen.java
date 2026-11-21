package com.whaleonebot.ui;

import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import com.whaleonebot.ContainerService;

/** First login belongs to a robot slot, not a pre-entered account ID. */
final class BiliEnrollScreen extends Screen {
    private final String botId,slot; private final boolean fresh;
    private LinearLayout col,code; private TextView status,begin,web; private String shown=""; private boolean requested; private Runnable cancelOwnEnrollment;
    BiliEnrollScreen(AppShell shell,String botId,String route){super(shell);this.botId=botId;fresh=route.startsWith("new:");slot=route.substring(route.indexOf(':')+1);}
    void build(){
        ScrollView scroll=new ScrollView(activity);root.addView(scroll);col=Ui.column(activity);int p=dp(Theme.S4);col.setPadding(p,p,p,p);scroll.addView(col);col.addView(header("登录 B 站"));
        BotRegistry.Bot bot=BotRegistry.get(botId);if(bot==null||!BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind))return;
        col.addView(Ui.strong(activity,"登录到「"+bot.name+"」",Theme.T_CARD,t.textPrimary));
        status=Ui.text(activity,"",Theme.T_BODY,t.textSecondary);col.addView(status);
        code=Ui.column(activity);col.addView(code);begin=Ui.button(activity,t,"获取登录二维码",true);col.addView(begin);begin.setOnClickListener(v->{Runnable cancel=ContainerService.enrollBiliAccount(activity,botId,slot,fresh);if(cancel!=null){cancelOwnEnrollment=cancel;requested=true;}else if(!requested){host().toast("此账号已有操作进行中");}refresh();});
        web=Ui.button(activity,t,"用本机哔哩哔哩确认",false);col.addView(web);web.setOnClickListener(v->{String url=ContainerService.biliAuthorizationLink(botId,slot);if(!BiliLocalConfirmation.open(activity,url))host().toast("请截取二维码，在哔哩哔哩扫一扫中选择相册");});web.setVisibility(View.GONE);
        // The QR is intentionally screenshotable for album scanning. No cookie or token is rendered.
    }
    boolean handleBack(){if(cancelOwnEnrollment!=null){cancelOwnEnrollment.run();cancelOwnEnrollment=null;}return false;}
    void refresh(){if(!requested||status==null)return;String s=ContainerService.biliProtocolStatus(botId,slot).optString("state"),url=ContainerService.biliAuthorizationLink(botId,slot);boolean pending="awaiting_confirmation".equals(s)&&BiliWebLogin.accepts(url)&&!BiliWebLogin.START.equals(url);
        if(!pending){shown="";code.removeAllViews();}else if(!url.equals(shown)){code.removeAllViews();code.addView(BiliAuthorizationDialog.image(activity,url),new LinearLayout.LayoutParams(-1,dp(260)));shown=url;}
        web.setVisibility(pending?View.VISIBLE:View.GONE);begin.setVisibility("starting".equals(s)||pending||"enrolled".equals(s)?View.GONE:View.VISIBLE);
        status.setText(pending?"请用哔哩哔哩官方 App 扫码并确认。":"starting".equals(s)?"正在准备登录…":"enrolled".equals(s)?"登录成功，账号已添加。返回启动页即可连接机器人。":"already_bound".equals(s)?"这个账号已绑定，未更改原来的连接。":"runtime_missing".equals(s)||"container_required".equals(s)?"本机登录环境尚未就绪，请先检查核心和运行环境。":"本次登录未完成。可返回或重新获取二维码。");
    }
}
