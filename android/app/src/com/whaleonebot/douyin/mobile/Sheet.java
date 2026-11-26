package com.whaleonebot.douyin.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.WindowManager;
import android.view.MotionEvent;
import android.widget.*;

/** A foreground-only review sheet. Never schedules, wakes, shows over lockscreen or notifies. */
abstract class Sheet extends Activity {
    MobileHost host;
    Desk desk;
    private LinearLayout content;
    private boolean resumed;
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if(saved!=null || !(getApplication() instanceof MobileHost)) {finish();return;}
        host=(MobileHost)getApplication(); desk=host.douyinDesk();
        if(desk==null || !authorized()) {finish();return;}
        ScrollView scroll=new ScrollView(this); scroll.setBackgroundColor(0xfff4f8fa);
        content=new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        int pad=Math.round(20*getResources().getDisplayMetrics().density);
        content.setPadding(pad,pad,pad,pad); scroll.addView(content); setContentView(scroll);
        render();
    }
    abstract void render();
    final boolean authorized() {
        KeyguardManager key=getSystemService(KeyguardManager.class); PowerManager power=getSystemService(PowerManager.class);
        return host!=null && host.ownerSessionUnlocked() && key!=null && !key.isKeyguardLocked() && power!=null && power.isInteractive();
    }
    final void text(String message) {
        TextView v=new TextView(this); v.setTextSize(18); v.setTextColor(0xff183746); v.setText(message); content.addView(v);
    }
    final void button(String label,Runnable command) {
        Button b=new Button(this); b.setAllCaps(false); b.setFilterTouchesWhenObscured(true); b.setText(label);
        b.setOnClickListener(v->{ if(!resumed || !hasWindowFocus() || !authorized() || isFinishing()) {finish();return;} command.run(); });
        content.addView(b);
    }
    @Override public boolean dispatchTouchEvent(MotionEvent e) {
        // FLAG_WINDOW_IS_PARTIALLY_OBSCURED was introduced in API 29; inlined integer is harmless below 29.
        if((e.getFlags()&(MotionEvent.FLAG_WINDOW_IS_OBSCURED|MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED))!=0) return false;
        return super.dispatchTouchEvent(e);
    }
    @Override protected void onResume(){super.onResume(); resumed=true; if(!authorized()) finish();}
    @Override protected void onPause(){resumed=false; super.onPause(); finish();}
}
