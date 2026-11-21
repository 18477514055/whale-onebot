package com.whaleonebot.ui;

import android.view.View;
import android.widget.*;
import java.util.*;

/** Assignment is a single registry operation; install failures never free the assigned core. */
final class NewBotScreen extends Screen {
    NewBotScreen(AppShell shell){super(shell);}
    void build(){
        ScrollView scroll=new ScrollView(activity);root.addView(scroll);LinearLayout col=Ui.column(activity);int p=dp(Theme.S4);col.setPadding(p,p,p,p);scroll.addView(col);col.addView(header("新建机器人"));
        List<CoreInventory.Instance> free=new ArrayList<>();for(CoreInventory.Instance c:BotRegistry.cores())if(c.ownerId.isEmpty())free.add(c);
        if(free.isEmpty()){col.addView(Ui.text(activity,"没有空闲核心。请先下载内置核心或接入自定义核心。",Theme.T_BODY,t.textSecondary));TextView go=Ui.button(activity,t,"管理本机核心",true);go.setOnClickListener(v->shell.popTo(AppShell.P_BOTLIST));col.addView(go);return;}
        EditText name=field(col,"名字",true),persona=field(col,"提示词",false);label(col,"空闲核心");
        Spinner cores=new Spinner(activity);String[] names=new String[free.size()];for(int i=0;i<names.length;i++)names[i]=coreLabel(free.get(i));cores.setAdapter(new TintedAdapter(activity,names,t.textPrimary));cores.setContentDescription("空闲核心");col.addView(cores);
        label(col,"接入平台");LinearLayout checks=Ui.column(activity);col.addView(checks);List<String> selected=new ArrayList<>();
        cores.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> a){}public void onItemSelected(AdapterView<?> a,View v,int pos,long id){checks.removeAllViews();selected.clear();for(String platform:free.get(pos).platforms){CheckBox cb=new CheckBox(activity);cb.setText(BotRegistry.PLATFORM_LABEL(platform));cb.setTextColor(t.textPrimary);cb.setMinHeight(dp(Theme.TOUCH));cb.setOnCheckedChangeListener((view,on)->{if(on)selected.add(platform);else selected.remove(platform);});checks.addView(cb);}}});
        TextView save=Ui.button(activity,t,"创建机器人",true);save.setMinimumHeight(dp(Theme.TOUCH));col.addView(save);save.setOnClickListener(v->{String n=name.getText().toString().trim();String problem=BotRegistry.nameProblem(n,null);if(problem!=null){name.setError(problem);return;}if(selected.isEmpty()){host().toast("至少选择一个平台");return;}CoreInventory.Instance c=free.get(cores.getSelectedItemPosition());BotRegistry.Bot bot=BotRegistry.createOnCore(c.id,n,persona.getText().toString(),new ArrayList<>(selected));if(bot==null){host().toast("无法分配此核心，请刷新后重试");return;}save.setEnabled(false);shell.popTo(AppShell.P_BOTLIST);if(BotRegistry.KIND_BUILTIN.equals(c.kind))shell.corePage("plugins",c.id);else shell.pushBot(bot.id);});
    }
    private void label(LinearLayout v,String s){TextView l=Ui.strong(activity,s,Theme.T_BODY,t.textPrimary);l.setPadding(0,dp(Theme.S3),0,0);v.addView(l);}
    private EditText field(LinearLayout v,String s,boolean single){label(v,s);EditText e=new EditText(activity);e.setTextColor(t.textPrimary);e.setContentDescription(s);e.setSingleLine(single);if(!single)e.setMinLines(2);v.addView(e);return e;}

    /**
     * 下拉里的核心名。不再用 {@code core-<完整 uuid> / 内置 1.1.0-rc.1}：
     * 原始 id 有 41 个字符，窄屏被截成「core-9585f717-96e6-459c-b…」，既认不出也读不完。
     * 这里给「内置/自定义 + 版本 + id 前 8 位」，三份同版核心仍能分辨。
     */
    private static String coreLabel(CoreInventory.Instance c){
        String id=c.id==null?"":c.id;
        if(id.startsWith("core-"))id=id.substring(5);
        int cut=id.indexOf('-');
        String shortId=cut>0?id.substring(0,cut):id;
        return ("builtin".equals(c.kind)?"内置":"自定义")+" "+c.version+" · "+shortId;
    }

    /**
     * 原生 Spinner 的 item 布局吃 Activity 主题的默认字色（深色 = 白字），
     * 浅色主题下就是白字压浅底 —— 真机 2026-11-21 实测「空闲核心」几乎读不出来。
     * 这里显式按令牌上色，深色主题下效果与原来一致。
     */
    private static final class TintedAdapter extends ArrayAdapter<String> {
        private final int color;
        TintedAdapter(android.content.Context c,String[] items,int color){
            super(c,android.R.layout.simple_spinner_dropdown_item,items);
            this.color=color;
        }
        @Override public View getView(int pos,View convert,android.view.ViewGroup parent){
            TextView v=(TextView)super.getView(pos,convert,parent);v.setTextColor(color);return v;
        }
        @Override public View getDropDownView(int pos,View convert,android.view.ViewGroup parent){
            TextView v=(TextView)super.getDropDownView(pos,convert,parent);v.setTextColor(color);return v;
        }
    }
}
