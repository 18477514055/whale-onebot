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
        Spinner cores=new Spinner(activity);String[] names=new String[free.size()];for(int i=0;i<names.length;i++)names[i]=CoreManagerScreen.title(free.get(i));cores.setAdapter(new ArrayAdapter<>(activity,android.R.layout.simple_spinner_dropdown_item,names));cores.setContentDescription("空闲核心");col.addView(cores);
        label(col,"接入平台");LinearLayout checks=Ui.column(activity);col.addView(checks);List<String> selected=new ArrayList<>();
        cores.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> a){}public void onItemSelected(AdapterView<?> a,View v,int pos,long id){checks.removeAllViews();selected.clear();for(String platform:free.get(pos).platforms){CheckBox cb=new CheckBox(activity);cb.setText(BotRegistry.PLATFORM_LABEL(platform));cb.setTextColor(t.textPrimary);cb.setMinHeight(dp(Theme.TOUCH));cb.setOnCheckedChangeListener((view,on)->{if(on)selected.add(platform);else selected.remove(platform);});checks.addView(cb);}}});
        TextView save=Ui.button(activity,t,"创建机器人",true);save.setMinimumHeight(dp(Theme.TOUCH));col.addView(save);save.setOnClickListener(v->{String n=name.getText().toString().trim();if(n.isEmpty()){name.setError("请填写名字");return;}if(selected.isEmpty()){host().toast("至少选择一个平台");return;}CoreInventory.Instance c=free.get(cores.getSelectedItemPosition());BotRegistry.Bot bot=BotRegistry.createOnCore(c.id,n,persona.getText().toString(),new ArrayList<>(selected));if(bot==null){host().toast("无法分配此核心，请刷新后重试");return;}save.setEnabled(false);shell.popTo(AppShell.P_BOTLIST);if(BotRegistry.KIND_BUILTIN.equals(c.kind))shell.corePage("plugins",c.id);else shell.pushBot(bot.id);});
    }
    private void label(LinearLayout v,String s){TextView l=Ui.strong(activity,s,Theme.T_BODY,t.textPrimary);l.setPadding(0,dp(Theme.S3),0,0);v.addView(l);}
    private EditText field(LinearLayout v,String s,boolean single){label(v,s);EditText e=new EditText(activity);e.setTextColor(t.textPrimary);e.setContentDescription(s);e.setSingleLine(single);if(!single)e.setMinLines(2);v.addView(e);return e;}
}
