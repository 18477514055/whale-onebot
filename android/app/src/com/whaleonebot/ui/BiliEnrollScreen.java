package com.whaleonebot.ui;

import android.text.InputType;
import android.view.View;
import android.widget.*;
import com.whaleonebot.ContainerService;

/** First login belongs to a robot slot, not a pre-entered account ID. */
final class BiliEnrollScreen extends Screen {
    private final String botId,slot; private final boolean fresh;
    private LinearLayout col,code; private TextView status,begin,web,webLoginBtn,importBtn; private String shown=""; private boolean requested; private Runnable cancelOwnEnrollment;
    BiliEnrollScreen(AppShell shell,String botId,String route){super(shell);this.botId=botId;fresh=route.startsWith("new:");slot=route.substring(route.indexOf(':')+1);}
    void build(){
        root.removeAllViews();
        ScrollView scroll=new ScrollView(activity);root.addView(scroll);col=Ui.column(activity);int p=dp(Theme.S4);col.setPadding(p,p,p,p);scroll.addView(col);col.addView(header("登录 B 站"));
        BotRegistry.Bot bot=BotRegistry.get(botId);if(bot==null||!BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind))return;
        col.addView(Ui.strong(activity,"登录到「"+bot.name+"」",Theme.T_CARD,t.textPrimary));
        col.addView(Ui.text(activity,"支持三种安全登录方式：官方扫码、内置官网登录（账密/短信，自动提取续期凭证）与手动导入 Cookie。",Theme.T_CAP,t.textSecondary));
        status=Ui.text(activity,"",Theme.T_BODY,t.textSecondary);col.addView(status);
        code=Ui.column(activity);col.addView(code);
        begin=Ui.button(activity,t,"获取登录二维码",true);col.addView(begin);begin.setOnClickListener(v->{Runnable cancel=RemoteBridge.enrollBili(activity,botId,slot,fresh);if(cancel!=null){cancelOwnEnrollment=cancel;requested=true;}else if(!requested){host().toast("此账号已有操作进行中");}refresh();});
        web=Ui.button(activity,t,"用本机哔哩哔哩确认",false);col.addView(web);web.setOnClickListener(v->{String url=RemoteBridge.biliAuthLink(botId,slot);if(!BiliLocalConfirmation.open(activity,url)){host().toast("请授权 B 站默认链接或改用官网网页登录");BiliLocalConfirmation.openAppLinksSettings(activity);}});web.setVisibility(View.GONE);
        webLoginBtn=Ui.button(activity,t,"官网网页登录（账密 / 短信）",false);
        col.addView(webLoginBtn);
        webLoginBtn.setOnClickListener(v->startWebLogin());
        importBtn=Ui.button(activity,t,"手动粘贴导入 Cookie",false);
        col.addView(importBtn);
        importBtn.setOnClickListener(v->showImportDialog());
    }
    private void startWebLogin(){
        BiliWebLogin.openForSession(activity,"",new BiliWebLogin.SessionCallback(){
            @Override public void onSessionCaptured(String rawCookie,String acTimeValue){
                submitCookieImport(rawCookie,acTimeValue);
            }
            @Override public void onCancelled(){
                host().toast("已取消 B 站官网登录");
            }
        });
    }
    private void showImportDialog(){
        LinearLayout box=Ui.column(activity);
        box.addView(Ui.text(activity,"粘贴含 SESSDATA=...; bili_jct=... 的完整 Cookie（附带 ac_time_value 可开启永久自动续期；仅密文存本机 Keystore）。",Theme.T_CAP,t.textSecondary));
        final EditText etCookie=new EditText(activity);
        etCookie.setHint("SESSDATA=...; bili_jct=...; ac_time_value=...");
        etCookie.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        etCookie.setMinLines(3);
        Ui.styleInput(etCookie,activity,t);
        box.addView(etCookie,Ui.llp(-1,-2));
        PromptSheet.custom(activity,t,"安全导入 B 站 Cookie",box,"核验并绑定",(d,btn)->{
            String raw=etCookie.getText()==null?"":etCookie.getText().toString().trim();
            if(raw.isEmpty()){host().toast("请先粘贴 Cookie");return;}
            d.dismiss();
            submitCookieImport(raw,"");
        },null,null,"取消",(d,btn)->d.dismiss(),true,false,null,null);
    }
    private void submitCookieImport(String rawCookie,String acTimeValue){
        if(status!=null)status.setText("正在联网核验 B 站账号并补全指纹…");
        new Thread(()->{
            org.json.JSONObject r=RemoteBridge.importBiliCookie(activity,botId,slot,"",fresh,rawCookie,acTimeValue);
            activity.runOnUiThread(()->{
                if(r!=null && r.optBoolean("ok",false)){
                    if(status!=null)status.setText("登录成功（UID "+r.optString("uid")+" · "+r.optString("uname")+"），返回启动页即可连接！");
                    host().toast("B 站登录成功" + (r.optBoolean("hasRefresh",false) ? "（已启用自动续期）" : ""));
                    if(begin!=null)begin.setVisibility(View.GONE);
                }else{
                    String err=r==null?"校验失败":r.optString("error","校验失败");
                    if(status!=null)status.setText("导入失败："+err);
                    host().toast(err);
                }
            });
        },"bili-enroll-import").start();
    }
    boolean handleBack(){if(cancelOwnEnrollment!=null){cancelOwnEnrollment.run();cancelOwnEnrollment=null;}return false;}
    void refresh(){super.refresh();if(!requested||status==null)return;org.json.JSONObject stObj=RemoteBridge.biliStatus(botId,slot);String s=stObj.optString("state"),url=RemoteBridge.isRemote()?stObj.optString("authLink"):ContainerService.biliAuthorizationLink(botId,slot);boolean pending="awaiting_confirmation".equals(s)&&BiliWebLogin.accepts(url)&&!BiliWebLogin.START.equals(url);
        if(!pending){shown="";code.removeAllViews();}else if(!url.equals(shown)){code.removeAllViews();code.addView(BiliAuthorizationDialog.image(activity,url),new LinearLayout.LayoutParams(-1,dp(260)));shown=url;}
        web.setVisibility(pending?View.VISIBLE:View.GONE);begin.setVisibility("starting".equals(s)||pending||"enrolled".equals(s)?View.GONE:View.VISIBLE);
        status.setText(pending?"请用哔哩哔哩官方 App 扫码并确认。":"starting".equals(s)?"正在准备登录…":"enrolled".equals(s)?"登录成功，账号已添加。返回启动页即可连接机器人。":"already_bound".equals(s)?"这个账号已绑定，未更改原来的连接。":"runtime_missing".equals(s)||"container_required".equals(s)?"本机登录环境尚未就绪，请先检查核心和运行环境。":"本次登录未完成。可返回或重新获取二维码。");
    }
}
