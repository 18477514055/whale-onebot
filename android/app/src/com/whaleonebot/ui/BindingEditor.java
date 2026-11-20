package com.whaleonebot.ui;

import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import com.whaleonebot.ContainerService;
import java.util.UUID;

/** A focused native form. Tokens never enter the registry or view state. */
final class BindingEditor {
    private final BotDetailScreen page;
    private final BotRegistry.Bot bot;
    private final BotRegistry.Binding old;
    private final LinearLayout form;
    BindingEditor(BotDetailScreen page,BotRegistry.Bot bot,BotRegistry.Binding old) {
        this.page=page; this.bot=bot; this.old=old; form=Ui.column(page.activity);
        int p=page.dp(Theme.S3); form.setPadding(p,p,p,p);
    }
    private TextView label(String s) {
        TextView v=new TextView(page.activity); v.setText(s); v.setPadding(0,page.dp(Theme.S1),0,0); form.addView(v); return v;
    }
    private EditText field(String title,String value,String hint,int type) {
        TextView l=label(title); EditText e=new EditText(page.activity); e.setSingleLine(true); e.setInputType(type);
        e.setId(View.generateViewId()); l.setLabelFor(e.getId()); e.setText(value); e.setHint(hint); form.addView(e); return e;
    }
    private Spinner choices(String title,String[] values,int selected) {
        TextView l=label(title); Spinner s=new Spinner(page.activity); s.setId(View.generateViewId()); l.setLabelFor(s.getId());
        ArrayAdapter<String> a=new ArrayAdapter<>(page.activity,android.R.layout.simple_spinner_dropdown_item,values);
        s.setAdapter(a); s.setSelection(selected); s.setMinimumHeight(page.dp(Theme.TOUCH)); form.addView(s); return s;
    }
    void show() {
        final Spinner platform=choices("平台",new String[]{"QQ","bilibili"},old!=null && BotRegistry.P_BILIBILI.equals(old.platform)?1:0);
        EditText account=field("账号 ID",old==null?"":old.accountId,"QQ 号或 bilibili UID",InputType.TYPE_CLASS_NUMBER);
        final boolean fixed=old!=null && !old.accountId.isEmpty(); platform.setEnabled(old==null); account.setEnabled(!fixed);
        if (fixed) label("更换账号请添加新绑定，以免沿用原账号的独立记忆。");
        final Spinner mode=choices("记忆与知识库",new String[]{"与这台机器人的其他共享账号共用","仅此绑定使用"},old!=null && "isolated".equals(old.memoryMode)?1:0);
        int uri=InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI;
        EditText http=field("OneBot HTTP 地址",old==null?"":old.httpUrl,"http://127.0.0.1:端口",uri);
        EditText ws=field("OneBot WebSocket 地址",old==null?"":old.wsUrl,"ws://127.0.0.1:端口",uri);
        EditText token=field("协议令牌（仅本次进程有效）","","不显示已输入的令牌",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setSaveEnabled(false); token.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        token.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        label("保存绑定会停止这台机器人的旧连接；不会登录或自动启动。地址改变后需重新输入令牌。");
        TextView error=label(""); error.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        ScrollView scroll=new ScrollView(page.activity); scroll.addView(form);
        AlertDialog.Builder builder=new AlertDialog.Builder(page.activity).setTitle(old==null?"添加账号绑定":"编辑账号绑定").setView(scroll)
            .setNegativeButton("取消",null).setPositiveButton("保存绑定",null);
        if (old!=null && bot.bindings.size()>1) builder.setNeutralButton("移除…",null);
        AlertDialog d=builder.create(); d.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        d.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE); d.show();
        d.setOnDismissListener(ignore -> token.getText().clear());
        d.getButton(-1).setOnClickListener(view -> {
            String selected=platform.getSelectedItemPosition()==0?"qq":"bilibili";
            BotRegistry.Binding replacing=old;
            if(replacing==null) for(BotRegistry.Binding pending:bot.bindings)
                if(pending.platform.equals(selected) && pending.accountId.isEmpty()){replacing=pending;break;}
            BotRegistry.Binding next=new BotRegistry.Binding(replacing==null?"b-"+UUID.randomUUID().toString():replacing.id,
                selected,account.getText().toString().trim(),
                mode.getSelectedItemPosition()==0?"shared":"isolated",http.getText().toString().trim(),ws.getText().toString().trim());
            boolean legacy=BotRegistry.legacyQQ(bot);
            String problem=BotRegistry.changeBinding(bot,replacing,next);
            if (problem!=null) { error.setText(problem); scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN)); return; }
            stop(legacy && !BotRegistry.legacyQQ(bot));
            boolean accepted=true;
            try { if (token.length()>0) ContainerService.setBindingToken(page.activity,bot.id,next.id,token.getText().toString()); }
            catch (IllegalArgumentException invalid) { accepted=false; }
            page.host().toast(accepted ? "绑定已保存" : "绑定已保存，令牌未接受。请重新编辑并输入 OneBot 令牌，不要填写平台 Cookie。"); d.dismiss(); page.build();
        });
        if(old!=null && bot.bindings.size()>1) d.getButton(-3).setOnClickListener(v->CoreBindingOps.remove(page,bot,old,()->{d.dismiss();page.build();}));
    }
    private void stop(boolean wasLegacy) {
        ContainerService.stopBoundBot(bot.id);
        if (wasLegacy) ContainerService.stopBot();
    }
}
