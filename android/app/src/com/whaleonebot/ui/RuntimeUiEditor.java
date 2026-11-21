package com.whaleonebot.ui;

import android.app.AlertDialog;
import android.widget.*;

final class RuntimeUiEditor {
    final Screen page;final BotRegistry.Bot bot;
    RuntimeUiEditor(Screen page,BotRegistry.Bot bot){this.page=page;this.bot=bot;}
    void show(){
        String[] items=new String[bot.runtimeUi.size()+1];items[0]="添加网页入口";
        for(int i=1;i<items.length;i++){RuntimeUiLink l=bot.runtimeUi.get(i-1);items[i]=BotRegistry.PLATFORM_LABEL(l.platform)+" / "+l.label;}
        new AlertDialog.Builder(page.activity).setTitle("外部入口").setItems(items,(d,i)->edit(i==0?null:bot.runtimeUi.get(i-1))).setNegativeButton("关闭",null).show();
    }
    private EditText field(LinearLayout col,String label,String value){TextView l=new TextView(page.activity);l.setText(label);col.addView(l);EditText e=new EditText(page.activity);e.setId(android.view.View.generateViewId());l.setLabelFor(e.getId());e.setSingleLine(true);e.setText(value);col.addView(e);return e;}
    private void edit(RuntimeUiLink old){LinearLayout col=Ui.column(page.activity);int p=page.dp(Theme.S3);col.setPadding(p,p,p,p);
        Spinner platform=new Spinner(page.activity);platform.setContentDescription("平台");platform.setAdapter(new ArrayAdapter<>(page.activity,android.R.layout.simple_spinner_dropdown_item,new String[]{"QQ","B 站"}));platform.setSelection(old!=null&&"bilibili".equals(old.platform)?1:0);col.addView(platform);
        EditText name=field(col,"入口名称",old==null?"":old.label),url=field(col,"HTTPS 网页地址",old==null?"":old.url);
        AlertDialog.Builder b=new AlertDialog.Builder(page.activity).setTitle("外部网页").setView(col).setNegativeButton("取消",null).setPositiveButton("保存",null);
        if(old!=null)b.setNeutralButton("移除…",(d,k)->new AlertDialog.Builder(page.activity).setTitle("移除此入口？").setPositiveButton("移除",(d2,k2)->page.host().toast(BotRegistry.changeLink(bot,old,null)?"已移除":"保存失败")).setNegativeButton("取消",null).show());
        AlertDialog d=b.create();d.show();d.getButton(-1).setOnClickListener(v->{RuntimeUiLink l=RuntimeUiLink.parse(platform.getSelectedItemPosition()==0?"qq":"bilibili",name.getText().toString().trim(),url.getText().toString().trim());
            if(l==null){url.setError("请输入名称和公开 HTTPS 地址，不含查询参数、端口或凭据");return;}
            if(!BotRegistry.changeLink(bot,old,l)){page.host().toast("保存失败或入口已满");return;}d.dismiss();page.host().toast("入口已保存");});
    }
}
