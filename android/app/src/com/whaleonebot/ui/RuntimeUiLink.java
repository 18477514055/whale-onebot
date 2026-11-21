package com.whaleonebot.ui;

import java.net.URI;
import java.util.Locale;

/** Declarative browser handoff. No HTML, commands, credentials, embedded WebView or template substitution. */
final class RuntimeUiLink {
    final String platform,label,url,host;
    private RuntimeUiLink(String p,String l,String u,String h){platform=p;label=l;url=u;host=h;}
    static RuntimeUiLink parse(String p,String l,String u){
        if(!BotRegistry.PLATFORM_SUPPORTED(p)||l==null||!l.matches("[\\p{L}\\p{N} _.-]{1,40}")||l.trim().isEmpty()||u==null||u.length()>512)return null;
        try{URI v=new URI(u); String h=v.getHost()==null?"":v.getHost().toLowerCase(Locale.ROOT);
            if(!"https".equals(v.getScheme()) || !h.equals(v.getRawAuthority()) || !h.matches("(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}") || h.endsWith(".local") || h.endsWith(".localhost") || h.endsWith(".internal") || v.getRawQuery()!=null || v.getRawFragment()!=null || !v.getRawPath().matches("[/a-zA-Z0-9._~-]*"))return null;
            return new RuntimeUiLink(p,l.trim(),u,h);
        }catch(Exception e){return null;}
    }
}
