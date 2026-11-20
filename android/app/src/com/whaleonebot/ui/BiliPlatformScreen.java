package com.whaleonebot.ui;

import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.widget.*;
import com.whaleonebot.ContainerService;
import org.json.JSONObject;
import java.util.*;
import static android.view.ViewGroup.LayoutParams.*;

/** Three Bilibili surfaces for the selected robot; no global QQ status/config API. */
final class BiliPlatformScreen extends Screen {
    final BotRegistry.Bot bot;
    private String tab;
    private AlertDialog challengeDialog;
    private String challengeBinding;
    private final Map<BotRegistry.Binding,TextView> statuses=new LinkedHashMap<>();
    private final Map<BotRegistry.Binding,TextView> links=new LinkedHashMap<>();
    private final Map<BotRegistry.Binding,TextView> starts=new LinkedHashMap<>();
    BiliPlatformScreen(AppShell shell,BotRegistry.Bot bot,String tab){super(shell);this.bot=bot;this.tab=tab==null?"start":tab;}
    void build(){
        root.removeAllViews(); statuses.clear(); links.clear(); starts.clear();
        ScrollView scroll=new ScrollView(activity); root.addView(scroll); LinearLayout col=Ui.column(activity);
        col.setPadding(dp(Theme.S4),dp(Theme.S3),dp(Theme.S4),dp(Theme.S4)); scroll.addView(col);
        col.addView(header(bot==null?"找不到机器人":bot.name)); if(bot==null)return;
        note(col,"B 站  /  "+bot.id);
        LinearLayout tabs=Ui.row(activity); col.addView(tabs);
        String[] keys={"start","config","dashboard"},titles={"启动","配置","看板"};
        for(int i=0;i<keys.length;i++){
            final String key=keys[i]; TextView v=Ui.button(activity,t,titles[i],key.equals(tab));v.setSelected(key.equals(tab));v.setMinimumHeight(dp(Theme.TOUCH));
            v.setOnClickListener(w->{tab=key;build();}); LinearLayout.LayoutParams lp=Ui.llp(0,WRAP_CONTENT);lp.weight=1;if(i>0)lp.leftMargin=dp(Theme.S1); tabs.addView(v,lp);
        }
        boolean config="config".equals(tab),dashboard="dashboard".equals(tab);

        int count=0;
        for(BotRegistry.Binding row:bot.bindings){
            if(!BotRegistry.P_BILIBILI.equals(row.platform))continue; count++;
            FrameLayout card=Ui.card(activity,t); LinearLayout box=Ui.column(activity);int p=dp(Theme.S3);box.setPadding(p,p,p,p);card.addView(box);col.addView(card,pad());
            box.addView(Ui.strong(activity,row.accountId.isEmpty()?"待填写 UID":"UID  "+row.accountId,Theme.T_CARD,t.textPrimary));
            if(config){note(box,"私信对端："+(row.peerId.isEmpty()?"未设置":row.peerId));note(box,"记忆与知识库："+("isolated".equals(row.memoryMode)?"独立":"共享"));}
            if(config){
                if(row.hostedBili()){
                    boolean saved=ContainerService.hasBiliSession(activity,bot.id,row.id);
                    note(box,"已保存登录："+(saved?"是":"否"));
                    button(box,"账号操作",false,()->new AlertDialog.Builder(activity).setTitle("账号操作").setItems(new String[]{"退出账号 / 清除登录态"},(d,i)->forget(row)).setNegativeButton("取消",null).show());
                }
                if(row.hostedBili() || row.accountId.isEmpty())button(box,"编辑账号配置",false,()->edit(row));
                else button(box,"编辑外部协议地址",false,()->shell.pushBot(bot.id));
            }else{
                TextView line=note(box,""); statuses.put(row,line);
                if(!dashboard && row.hostedBili()){
                    starts.put(row,button(box,ContainerService.hasBiliSession(activity,bot.id,row.id)?"快速登录":"授权登录",true,()->start(row)));
                    TextView link=button(box,"查看本次授权二维码",false,()->open(row));link.setVisibility(View.GONE);links.put(row,link);
                    button(box,"更多操作",false,()->new AlertDialog.Builder(activity).setTitle("账号操作").setItems(new String[]{"停止此账号","断开机器人"},(d,i)->{if(i==0)ContainerService.stopBiliProtocol(bot.id,row.id);else ContainerService.stopBoundBot(bot.id);refresh();}).setNegativeButton("取消",null).show());
                }else if(!dashboard && row.accountId.isEmpty())button(box,"填写账号",true,()->{tab="config";build();});
            }
        }
        if("start".equals(tab) && count>0 && BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            button(col,"连接机器人",false,()->{ContainerService.startBoundBot(activity,bot.id);refresh();});

        }
        if(count==0)note(col,"这台机器人还没有 B 站账号。");
        if(config && BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind))button(col,"添加本机 B 站账号",true,()->edit(null));
        else if(config)button(col,"管理账号绑定",false,()->shell.pushBot(bot.id));
        if(config && RuntimeSurfaces.builtin(bot)){CoreInventory.Instance c=BotRegistry.coreForBot(bot.id);if(c!=null && CoreManagerScreen.managed(c))button(col,"平台插件",false,()->shell.corePage("plugins",c.id));}
        refresh();
    }
    private LinearLayout.LayoutParams pad(){LinearLayout.LayoutParams lp=Ui.llp(MATCH_PARENT,WRAP_CONTENT);lp.topMargin=dp(Theme.S2);return lp;}
    private TextView note(LinearLayout box,String val){TextView v=Ui.text(activity,val,Theme.T_BODY,t.textSecondary);box.addView(v,pad());return v;}
    private TextView button(LinearLayout box,String label,boolean primary,Runnable task){TextView v=Ui.button(activity,t,label,primary);v.setMinimumHeight(dp(Theme.TOUCH));v.setOnClickListener(w->task.run());box.addView(v,pad());return v;}
    private void forget(BotRegistry.Binding row){
        new AlertDialog.Builder(activity).setTitle("退出 UID "+row.accountId+"？").setMessage("停止此账号并清除本机保存的登录。下次启动需重新授权。").setNegativeButton("取消",null).setPositiveButton("退出并清除",(d,k)->{
            boolean ok=ContainerService.forgetBiliSession(activity,bot.id,row.id);host().toast(ok?"已退出此账号":"未能清除登录，请重试");build();
        }).show();
    }
    private void start(BotRegistry.Binding row){
        JSONObject record=ContainerService.biliProtocolStatus(bot.id,row.id);
        String state=record==null?"":record.optString("state");
        if(BiliPlatformState.useSaved(ContainerService.hasBiliSession(activity,bot.id,row.id),state)){
            ContainerService.startBiliProtocol(activity,bot.id,row.id,row.peerId);refresh();return;
        }
        LinearLayout form=Ui.column(activity);int p=dp(Theme.S3);form.setPadding(p,p,p,p);
        TextView peer=new TextView(activity);peer.setText(row.peerId.isEmpty()?"未授权任何私信对端。":"仅允许配置的私信对端 UID："+row.peerId);form.addView(peer);

        note(form,"登录成功后保存到本机，下次可快速登录。");
        AlertDialog d=new AlertDialog.Builder(activity).setTitle("授权 UID "+row.accountId).setView(form).setNegativeButton("取消",null).setPositiveButton("开始授权",null).create();d.show();d.getButton(-1).setOnClickListener(v->{
            ContainerService.reauthorizeBiliProtocol(activity,bot.id,row.id,row.peerId);d.dismiss();refresh();
        });
    }
    private void open(BotRegistry.Binding row){String url=ContainerService.biliAuthorizationLink(bot.id,row.id);
        challengeBinding=row.id; challengeDialog=url==null?null:BiliAuthorizationDialog.show(activity,url,row.accountId,()->ContainerService.stopBiliProtocol(bot.id,row.id));
        if(challengeDialog==null)host().toast("本次授权码不可用或已过期"); }
    private EditText input(LinearLayout form,String label,String value){TextView l=new TextView(activity);l.setText(label);form.addView(l);EditText e=new EditText(activity);e.setId(View.generateViewId());l.setLabelFor(e.getId());e.setSingleLine(true);e.setInputType(InputType.TYPE_CLASS_NUMBER);e.setText(value);form.addView(e);return e;}
    private static boolean validUid(String s){return s!=null && s.matches("[1-9][0-9]{0,15}") && Long.parseLong(s)<=9007199254740991L;}
    private void edit(BotRegistry.Binding selected){
        LinearLayout form=Ui.column(activity);int p=dp(Theme.S3);form.setPadding(p,p,p,p);
        EditText uid=input(form,"本人 B 站 UID",selected==null?"":selected.accountId);uid.setEnabled(selected==null || selected.accountId.isEmpty());
        EditText peer=input(form,"已获同意的私信对端 UID（留空不启用私信）",selected==null?"":selected.peerId);
        CheckBox isolate=new CheckBox(activity);isolate.setText("此账号单独使用记忆和知识库");isolate.setMinimumHeight(dp(Theme.TOUCH));isolate.setChecked(selected!=null && "isolated".equals(selected.memoryMode));form.addView(isolate);
        TextView help=new TextView(activity); help.setText("默认共享；更改后需重新连接。");form.addView(help);
        AlertDialog.Builder builder=new AlertDialog.Builder(activity).setTitle("本机 B 站绑定").setView(form).setNegativeButton("取消",null).setPositiveButton("保存",null);
        if(selected!=null && bot.bindings.size()>1)builder.setNeutralButton("移除…",null);
        AlertDialog d=builder.create();d.show();d.getButton(-1).setOnClickListener(v->{
            BotRegistry.Binding before=selected;if(before==null) for(BotRegistry.Binding r:bot.bindings)if("bilibili".equals(r.platform)&&r.accountId.isEmpty()){before=r;break;}
            BotRegistry.Binding next=new BotRegistry.Binding(before==null?"b-"+UUID.randomUUID():before.id,"bilibili",uid.getText().toString().trim(),isolate.isChecked()?"isolated":"shared","","",peer.getText().toString().trim());
            String problem=BotRegistry.changeBinding(bot,before,next);if(problem!=null){uid.setError(problem);return;}
            if(before!=null) ContainerService.stopBiliProtocol(bot.id,before.id);host().toast("B 站绑定已保存");d.dismiss();build();
        });
        if(selected!=null && bot.bindings.size()>1)d.getButton(-3).setOnClickListener(v->CoreBindingOps.remove(this,bot,selected,()->{d.dismiss();build();}));
    }
    void refresh(){
        if(bot==null)return;
        JSONObject workers=statuses.isEmpty()?null:ContainerService.bindingStatus(activity,bot.id);
        for(Map.Entry<BotRegistry.Binding,TextView> entry:statuses.entrySet()){ 
            BotRegistry.Binding row=entry.getKey();TextView label=entry.getValue();String out;
            if(row.accountId.isEmpty())out="待配置：尚未指定本人账号。";
            else if(!row.hostedBili())out="外部协议端：此页不代其登录。";
            else{
                JSONObject s=ContainerService.biliProtocolStatus(bot.id,row.id);String state=s==null?"":s.optString("state");
                out=BiliPlatformState.label(state,row.accountId,s==null?"":s.optString("selfId"));
                if("dashboard".equals(tab) && s!=null && s.has("received")){
                    long at=s.optLong("lastReceived");out+="\n收信数："+s.optInt("received")+"\n上次收信："+(at>0?java.text.DateFormat.getDateTimeInstance().format(new java.util.Date(at)):"暂无记录");
                }
                boolean pending="waiting".equals(state)||"scanned".equals(state)||"awaiting_confirmation".equals(state);
                if(!pending && row.id.equals(challengeBinding) && challengeDialog!=null){challengeDialog.dismiss();challengeDialog=null;challengeBinding=null;}
                TextView link=links.get(row);if(link!=null)link.setVisibility(pending?View.VISIBLE:View.GONE);
            }
            boolean verified=false;
            if(workers!=null){org.json.JSONArray rows=workers.optJSONArray("bindings");
                if(rows!=null)for(int i=0;i<rows.length();i++){
                    JSONObject r=rows.optJSONObject(i);if(r!=null && BindingPresentation.connected(row,workers.optString("state"),r.optString("id"),r.optString("platform"),r.optString("accountId"),r.optString("state")))verified=true;
                }
            }
            out+="\n机器人连接："+(verified?"已验证":"未验证");
            if("dashboard".equals(tab))out+="\n私信对端："+(row.peerId.isEmpty()?"未授权":row.peerId);
            if(!out.contentEquals(label.getText()))label.setText(out);
        }
    }
}
