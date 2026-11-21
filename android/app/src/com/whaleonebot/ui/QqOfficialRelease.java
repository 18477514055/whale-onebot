package com.whaleonebot.ui;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;

/** Metadata only: the version offered by Tencent, not a compatibility or login receipt. */
final class QqOfficialRelease {
    static final String CONFIG="https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js";
    final String version, deb;
    private QqOfficialRelease(String version,String deb){this.version=version;this.deb=deb;}
    static QqOfficialRelease latest() throws IOException {
        HttpsURLConnection c=(HttpsURLConnection)new URL(CONFIG).openConnection();
        c.setInstanceFollowRedirects(false);c.setConnectTimeout(8000);c.setReadTimeout(8000);
        try {
            if(c.getResponseCode()!=200)throw new IOException("QQ metadata unavailable");
            try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] buf=new byte[2048];int n;
                while((n=in.read(buf))!=-1){if(out.size()+n>32768)throw new IOException("QQ metadata too large");out.write(buf,0,n);}
                return parse(new String(out.toByteArray(),StandardCharsets.UTF_8));
            }
        } finally {c.disconnect();}
    }
    static QqOfficialRelease parse(String script) throws IOException {
        // Extract JSON only. Never evaluate the surrounding SeaJS callback.
        int key=script.indexOf("var params="), end=script.indexOf("};",key);
        if(key<0||end<0||script.length()>32768)throw new IOException("QQ metadata format changed");
        try {
            Map<?,?> data=(Map<?,?>)InstallerJson.parse(script.substring(key+11,end+1).trim());
            String v=(String)data.get("version"), url=(String)((Map<?,?>)data.get("armDownloadUrl")).get("deb");
            if(v==null||!v.matches("[0-9]+(?:\\.[0-9]+){2,3}")||url==null||!url.matches("https://qqdl\\.gtimg\\.cn/qqfile/QQNTV2/[0-9.]+/release/[a-fA-F0-9]+/QQ_"+Pattern.quote(v)+"_[0-9]+_arm64_[0-9]+\\.deb"))throw new IOException("Unexpected QQ package");
            return new QqOfficialRelease(v,url);
        }catch(RuntimeException e){throw new IOException("Invalid QQ metadata");}
    }
}
