package com.whaleonebot.ui;

import android.widget.*;
import android.view.View;
import com.whaleonebot.ContainerService;
import org.json.JSONArray;
import org.json.JSONObject;
import static android.view.ViewGroup.LayoutParams.*;

/**
 * 机器人启动页 —— <b>新号与老号共用同一页</b>。
 *
 * <p>★ 2026-11-24 用户口径：「让新登录的账号和已登录的账号是同一个启动页 —— 只要填了 QQ 账号就能发起扫码」。
 * 以前这一页只管「绑定 / 连接」（{@link BoundStartScreen}），二维码只在 legacy 的 {@link QqScreen} 里，
 * 于是新核心机器人**根本没有扫码入口**。现在两页合一：
 * <pre>
 *   标题（机器人名）
 *   运行端与各账号的绑定状态
 *   【本机 QQ 登录】容器启停 → 扫码登录 / 换一张码 → 二维码
 *   【这个机器人】连接 QQ（内置核心）/ 启动·停止本机器人（legacy 容器）
 *   管理账号绑定
 * </pre>
 * 扫码走的是**本机 QQ 客户端**（容器里的 {@code /opt/whale/qq-state}），与机器人是不是新号无关：
 * 登录成功后 identity.json 里有 uin，绑定状态自然会从「待登录」变成「已验证连接」。
 *
 * <p>Worker lifecycle is never evidence that an account is connected.
 */
final class BoundStartScreen extends Screen {

    private final BotRegistry.Bot bot;
    private final boolean dashboard;

    private TextView status;
    private String previous;

    private QrPanel qr;
    private TextView startBtn;
    private TextView stopBtn;
    private TextView saveBtn;
    private TextView loginBtn;
    private String lastLoginLine;

    // 运行日志（原 QqScreen 的那一块，统一启动页时被我漏掉了 —— 用户直接点名）
    private TextView logText;
    private ScrollView logScroll;
    private String lastLog;

    BoundStartScreen(AppShell shell,BotRegistry.Bot bot,boolean dashboard) {super(shell);this.bot=bot;this.dashboard=dashboard;}

    void build() {
        ScrollView scroll=new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll);
        LinearLayout col=Ui.column(activity);
        col.setPadding(dp(Theme.S4),dp(Theme.S3),dp(Theme.S4),dp(Theme.S4));
        scroll.addView(col);
        col.addView(header(bot==null?"找不到机器人":bot.name+(dashboard?" · QQ 看板":"")));
        if(bot==null)return;

        status=Ui.text(activity,"读取绑定状态…",Theme.T_BODY,t.textPrimary);
        status.setPadding(0,dp(Theme.S3),0,dp(Theme.S3));
        col.addView(status);
        if(dashboard){refresh();return;}

        buildLoginBlock(col);
        buildBotBlock(col);
        add(col,"管理账号绑定",false,v -> shell.pushBot(bot.id));
        buildLogArea(col);
        TextView note=Ui.text(activity,"已验证连接并不授权回复。允许联系的人或群由该账号的运行端白名单单独控制。",Theme.T_BODY,t.textSecondary);
        note.setPadding(0,dp(Theme.S3),0,0);
        col.addView(note);
        refresh();
    }

    // ---------------------------------------------------------------- 本机 QQ 登录

    /**
     * 本机 QQ 登录区：容器启停 → 扫码 / 换码 → 二维码。
     *
     * <p>这一段与 {@link QqScreen} 用的是同一套宿主能力（{@code host().containerRunning()} /
     * {@code requestQr()} / {@link QrPanel}），所以新老账号看到的是同一件事：**这台手机上的 QQ 登录**。
     */
    private void buildLoginBlock(LinearLayout col) {
        col.addView(sectionLabel("本机 QQ 登录"), sectionLp());

        LinearLayout row1=Ui.row(activity);
        startBtn=Ui.button(activity,t,"启动容器",false);
        startBtn.setOnClickListener(new View.OnClickListener(){public void onClick(View v){host().startContainer();host().toast("正在启动容器");}});
        stopBtn=Ui.button(activity,t,"停止容器",false);
        stopBtn.setOnClickListener(new View.OnClickListener(){public void onClick(View v){host().stopContainer();host().toast("正在停止容器");}});
        LinearLayout.LayoutParams b1=Ui.llp(0,dp(Theme.TOUCH));b1.weight=1f;
        LinearLayout.LayoutParams b2=Ui.llp(0,dp(Theme.TOUCH));b2.weight=1f;b2.leftMargin=dp(Theme.S2);
        row1.addView(startBtn,b1);
        row1.addView(stopBtn,b2);
        col.addView(row1,Ui.llp(MATCH_PARENT,WRAP_CONTENT));

        LinearLayout row2=Ui.row(activity);
        loginBtn=Ui.button(activity,t,"扫码登录 QQ",true);
        loginBtn.setOnClickListener(new View.OnClickListener(){public void onClick(View v){
            // ★ 先确认容器里真有 QQ：环境包本身**不含** QQ 客户端，没装就点扫码只会干等 40 秒然后什么都没有
            //   （用户就是这么被卡住的）。这里直接把话说明白并把人送到装的入口。
            if(QqClientInstaller.clientVersion(activity.getFilesDir())==null){
                host().toast("容器里还没有 QQ：先去「环境配置」装 QQ 安装包，回来再扫码");
                shell.pushEnv();
                return;
            }
            shell.requestQr();
        }});
        TextView again=Ui.button(activity,t,"换一张码",false);
        again.setOnClickListener(new View.OnClickListener(){public void onClick(View v){shell.requestQr();}});
        LinearLayout.LayoutParams c1=Ui.llp(0,dp(Theme.TOUCH));c1.weight=1f;
        LinearLayout.LayoutParams c2=Ui.llp(0,dp(Theme.TOUCH));c2.weight=1f;c2.leftMargin=dp(Theme.S2);
        row2.addView(loginBtn,c1);
        row2.addView(again,c2);
        LinearLayout.LayoutParams r2=Ui.llp(MATCH_PARENT,WRAP_CONTENT);r2.topMargin=dp(Theme.S2);
        col.addView(row2,r2);

        saveBtn=Ui.button(activity,t,"保存二维码到相册",false);
        saveBtn.setOnClickListener(new View.OnClickListener(){public void onClick(View v){host().saveQrToAlbum();}});
        Ui.enabled(saveBtn,false);
        LinearLayout.LayoutParams sv=Ui.llp(MATCH_PARENT,dp(Theme.TOUCH));sv.topMargin=dp(Theme.S2);
        col.addView(saveBtn,sv);

        qr=new QrPanel(shell);
        LinearLayout.LayoutParams qlp=Ui.llp(MATCH_PARENT,WRAP_CONTENT);qlp.topMargin=dp(Theme.S4);
        col.addView(qr,qlp);
    }

    // ---------------------------------------------------------------- 这个机器人

    /** 机器人自己的动作：内置核心给「连接 QQ」，legacy 容器给启停。 */
    private void buildBotBlock(LinearLayout col) {
        CoreInventory.Instance core=BotRegistry.coreForBot(bot.id);
        boolean managed=core!=null && CoreManagerScreen.managed(core);
        if(managed){
            col.addView(sectionLabel("这个机器人"), sectionLp());
            add(col,"连接 QQ",true,v -> {
                if(!BotRegistry.platformEnabled(bot.id,BotRegistry.P_QQ)){
                    // ★ 用户口径是「少一步就少一个卡点」：开关在上一页，这里直接把开关打开再连，不让用户回去找。
                    BotRegistry.setPlatformEnabled(bot.id,BotRegistry.P_QQ,true);
                    host().toast("已为本机器人打开 QQ");
                }
                new Thread(() -> {
                    // 先确保容器内本机 QQ OneBot 协议端已拉起，再连接受管核心
                    ContainerService.startBot(activity);
                    try{ContainerService.startInstalledPlatform(activity,bot.id,BotRegistry.P_QQ);}
                    catch(Exception e){activity.runOnUiThread(() -> host().toast("QQ 启动未完成：" + (e.getMessage()==null?"未知原因":e.getMessage())));}
                },"connect-qq").start();
            });
        } else if (BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            col.addView(sectionLabel("这个机器人"), sectionLp());
            if (!host().containerRunning()) add(col,"准备本地容器",false,v -> {ContainerService.start(activity);host().toast("正在准备本地容器");});
            add(col,"启动本机器人",true,v -> {ContainerService.startBoundBot(activity,bot.id);refresh();});
            add(col,"停止本机器人",false,v -> {ContainerService.stopBoundBot(bot.id);refresh();});
        }
    }

    // ---------------------------------------------------------------- 状态

    private void add(LinearLayout col,String label,boolean primary,View.OnClickListener action){
        TextView btn=Ui.button(activity,t,label,primary);
        btn.setMinimumHeight(dp(Theme.TOUCH));
        btn.setOnClickListener(action);
        LinearLayout.LayoutParams lp=Ui.llp(MATCH_PARENT,WRAP_CONTENT);
        lp.topMargin=dp(Theme.S2);
        col.addView(btn,lp);
    }

    void refresh(){
        if(bot==null || status==null)return;

        // 本机 QQ 登录区的实时状态（与 QqScreen 同一套判据：容器 + 已登录 uin）
        boolean running=host().containerRunning();
        String uin=host().loginUin();
        boolean logged=uin!=null && uin.length()>0;
        String loginLine="本机 QQ：" + (!running ? "容器已停止（先点「启动容器」）"
                : (logged ? "已登录 " + uin : "容器在运行 · 还没登录（点「扫码登录 QQ」）"));
        if(!loginLine.equals(lastLoginLine)){
            lastLoginLine=loginLine;
            if(loginBtn!=null) loginBtn.setText(logged ? "重新扫码" : "扫码登录 QQ");
        }
        Ui.enabled(startBtn,!running);
        Ui.enabled(stopBtn,running);
        if(saveBtn!=null) Ui.enabled(saveBtn,host().qrLive());
        if(qr!=null) qr.refresh();

        JSONObject result=ContainerService.bindingStatus(activity,bot.id);
        String state=result==null?"":result.optString("state");
        StringBuilder sb=dashboard?new StringBuilder():new StringBuilder(loginLine).append("\n\n运行端：").append(summary(state));
        JSONArray rows=result==null?null:result.optJSONArray("bindings");
        for(BotRegistry.Binding v:bot.bindings){
            // ★ 这里是「QQ 的启动页」——bilibili 的绑定状态属于 B 站页面，不该混进来（用户点名问过）。
            if(!BotRegistry.P_QQ.equals(v.platform))continue;
            boolean verified=false;
            if(rows!=null) for(int i=0;i<rows.length();i++){
                JSONObject row=rows.optJSONObject(i);
                if(row!=null && BindingPresentation.connected(v,state,row.optString("id"),row.optString("platform"),row.optString("accountId"),row.optString("state"))) verified=true;
            }
            if(sb.length()>0)sb.append("\n\n");
            sb.append(v.label());
            if(!dashboard)sb.append("\n").append(v.detail());
            sb.append("\n").append(verified?"已验证连接":v.accountId.isEmpty()?"待登录":("unknown".equals(state)?"状态未知（运行端在跑，尚未核验账号）":"未验证连接"));
        }
        if(dashboard&&sb.length()==0)sb.append("尚未添加 QQ 账号");
        String s=sb.toString();
        if(!s.equals(previous)){status.setText(s);previous=s;}

        // 运行日志：登录 30 行 + 容器 15 行（与原来 QqScreen 完全一致的口径）
        if(logText!=null){
            String logs=buildLogs();
            if(!logs.equals(lastLog)){
                lastLog=logs;
                logText.setText(logs);
                if(logScroll!=null) logScroll.post(new Runnable(){public void run(){
                    if(logScroll.getChildCount()>0) logScroll.fullScroll(View.FOCUS_DOWN);}});
            }
        }
    }

    private String buildLogs(){
        StringBuilder sb=new StringBuilder();
        sb.append("— 登录 —\n").append(tail(host().loginLog(30)));
        sb.append("\n— 容器 —\n").append(tail(host().containerLog(15)));
        return sb.toString();
    }

    private static String tail(String s){
        if(s==null) return "（暂无日志）";
        String v=s.trim();
        return v.length()==0?"（暂无日志）":v;
    }

    /** 运行日志区（原来是 QqScreen 的一等公民，统一启动页时必须保留）。 */
    private void buildLogArea(LinearLayout col){
        FrameLayout logCard=new FrameLayout(activity);
        logCard.setBackground(Drawables.round(t.logFill,t.logStroke,dp(1),dp(Theme.R_PANEL)));
        Ui.elevate(logCard,2f,t);
        logCard.setClipToOutline(true);
        LinearLayout lbox=Ui.column(activity);
        lbox.setPadding(dp(Theme.S2+2),dp(Theme.S2),dp(Theme.S2+2),dp(Theme.S2));
        LinearLayout lhead=Ui.row(activity);
        lhead.addView(sectionLabel("运行日志"),new LinearLayout.LayoutParams(0,WRAP_CONTENT,1f));
        lbox.addView(lhead,Ui.llp(MATCH_PARENT,WRAP_CONTENT));
        logScroll=new ScrollView(activity);
        logScroll.setVerticalScrollBarEnabled(false);
        logText=Ui.mono(activity,Theme.T_MONO,t.logText);
        logText.setText("（等待日志）");
        logScroll.addView(logText,new FrameLayout.LayoutParams(MATCH_PARENT,WRAP_CONTENT));
        LinearLayout.LayoutParams lslp=Ui.llp(MATCH_PARENT,dp(150));
        lslp.topMargin=dp(Theme.S2);
        lbox.addView(logScroll,lslp);
        logCard.addView(lbox,new LinearLayout.LayoutParams(MATCH_PARENT,WRAP_CONTENT));
        LinearLayout.LayoutParams lclp=Ui.llp(MATCH_PARENT,WRAP_CONTENT);
        lclp.topMargin=dp(Theme.S4);
        col.addView(logCard,lclp);
    }

    private TextView sectionLabel(String text){
        TextView v=Ui.text(activity,text,Theme.T_CAP,t.textSecondary);
        v.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        v.setLetterSpacing(0.08f);
        return v;
    }

    private LinearLayout.LayoutParams sectionLp(){
        LinearLayout.LayoutParams lp=Ui.llp(MATCH_PARENT,WRAP_CONTENT);
        lp.topMargin=dp(Theme.S4);
        lp.bottomMargin=dp(Theme.S2);
        return lp;
    }

    static String summary(String state){
        switch(state){
            case "waiting":return "等待账号配置、插件或授权"; case "partial":return "部分绑定已启动（账号连接见下方）";
            case "running":return "运行中（账号连接见下方）"; case "starting":return "启动中"; case "stopped":return "已停止";
            case "external":return "由自定义运行端管理"; case "failed":return "启动失败，请检查配置"; case "stale":return "状态已过期（运行端未在跑）";
            case "credentials_required":return "缺少本次令牌，请编辑绑定"; case "config_required":return "请先完善账号绑定与运行端配置";
            case "runtime_missing":return "缺少支持多绑定的内置运行端"; case "container_required":return "本地容器尚未就绪"; default:return "暂无可核验状态";
        }
    }
}
