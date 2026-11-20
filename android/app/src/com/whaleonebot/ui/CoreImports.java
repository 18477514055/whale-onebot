package com.whaleonebot.ui;

import android.app.AlertDialog;
import android.net.Uri;
import android.view.WindowManager;
import android.widget.EditText;
import java.io.*;
import java.net.*;
import javax.net.ssl.HttpsURLConnection;

final class CoreImports {
    static String read(InputStream stream)throws IOException{if(stream==null)throw new IOException();try(InputStream in=stream){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[]buf=new byte[2048];int n;while((n=in.read(buf))!=-1){if(out.size()+n>16384)throw new IOException();out.write(buf,0,n);}return out.toString("UTF-8");}}
    static void preview(CoreManagerScreen s,String text){CoreInventory.Instance i=CoreInventory.parseDescriptor(text);s.activity.runOnUiThread(()->s.confirm("登记自定义核心？",CoreManagerScreen.title(i)+"\n支持平台："+i.platforms,()->s.work(()->{BotRegistry.importDescriptor(text);return "自定义核心已登记";})));}
    static void document(CoreManagerScreen s,Uri file){s.work(()->{preview(s,read(s.activity.getContentResolver().openInputStream(file)));return "已读取描述";});}
    static void link(CoreManagerScreen s){EditText e=new EditText(s.activity);e.setSingleLine(true);e.setHint("https://example.org/core.json");new AlertDialog.Builder(s.activity).setTitle("描述文件 HTTPS 地址").setView(e).setNegativeButton("取消",null).setPositiveButton("读取",(d,k)->{String value=e.getText().toString().trim();s.work(()->{URI u=new URI(value);if(!"https".equals(u.getScheme())||u.getHost()==null||!u.getHost().equalsIgnoreCase(u.getRawAuthority())||!u.getHost().matches("(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,63}")||u.getRawFragment()!=null||u.getRawQuery()!=null)throw new IOException();for(InetAddress ip:InetAddress.getAllByName(u.getHost()))if(ip.isAnyLocalAddress()||ip.isLinkLocalAddress()||ip.isLoopbackAddress()||ip.isSiteLocalAddress()||ip.isMulticastAddress())throw new IOException();HttpsURLConnection c=(HttpsURLConnection)u.toURL().openConnection();try{c.setInstanceFollowRedirects(false);c.setUseCaches(false);c.setConnectTimeout(7000);c.setReadTimeout(7000);if(c.getResponseCode()!=200)throw new IOException();preview(s,read(c.getInputStream()));}finally{c.disconnect();}return "已读取描述";});}).show();}
    static void register(CoreManagerScreen s){s.work(()->{CoreRegistration reg=CoreRegistration.open();s.activity.runOnUiThread(()->{if(s.activity.isFinishing()||s.activity.isDestroyed()){reg.close();return;}AlertDialog d=new AlertDialog.Builder(s.activity).setTitle("本机登记 · 2 分钟").setMessage("POST http://127.0.0.1:"+reg.port()+"/v1/core-instances\n\n一次性授权码：\n"+reg.token()).setPositiveButton("关闭登记",null).create();d.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);d.setOnDismissListener(x->{try{reg.close();}catch(Exception ignored){}s.status.setText("登记窗口已关闭");});d.show();});return "等待本机登记";});}
}
