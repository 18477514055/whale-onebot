package com.whaleonebot.douyin.mobile;

import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

/** Non-exported. Host starts it only after owner taps a bot-specific foreground control. */
public final class OwnerActivity extends Sheet {
    public static final String BOT="com.whaleonebot.douyin.mobile.BOT";
    private static final String DOUYIN="com.ss.android.ugc.aweme";
    private final Handler timer=new Handler(Looper.getMainLooper());
    private Desk.Request displayed;
    @Override void render() {
        Desk.Slot s=desk.get(getIntent().getStringExtra(BOT)); if(s==null){finish();return;}
        text("机器人："+s.botId+"\n本地账号标识："+s.accountId);
        displayed=desk.pending(s);
        if(displayed==null) {
            text("本次只打开抖音。请在官方客户端核对并手动登录账号；返回不会绑定账号或开启机器人权限。");
            button("打开抖音，手动登录",()->{
                if(!desk.current(s)){finish();return;}
                try {Intent i=getPackageManager().getLaunchIntentForPackage(DOUYIN);
                    if(i==null || i.getComponent()==null || !DOUYIN.equals(i.getComponent().getPackageName())) {text("未找到可打开的官方客户端。未更改绑定。");return;}
                    startActivity(i);finish();
                } catch(ActivityNotFoundException|SecurityException ex){text("系统未允许打开抖音。未更改绑定。");}
            });
        } else {
            Desk.Request r=displayed;
            text("待确认："+r.action);text("对象："+r.target);text("本次完整内容或变更：\n"+r.details);text("请求编号："+r.requestId);
            button("仅同意这一次",()->{desk.decide(s,r,true);finish();});
            button("跳过这一次",()->{desk.decide(s,r,false);finish();});
            timer.postDelayed(this::finish,Math.max(0,r.deadline-SystemClock.elapsedRealtime()));
        }
    }
    @Override protected void onPause() { if(displayed!=null) desk.decide(displayed.slot,displayed,false); timer.removeCallbacksAndMessages(null); super.onPause(); }
}
