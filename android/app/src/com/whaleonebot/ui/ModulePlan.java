package com.whaleonebot.ui;

import java.io.File;
import java.util.*;

/** Read-only local projection; neither the catalog nor a receipt is a trusted installer. */
final class ModulePlan {
    static List<String> needs(BotRegistry.Bot b){List<String> ids=new ArrayList<>();if(b==null||!BotRegistry.KIND_BUILTIN.equals(b.runtimeKind))return ids;
        ids.add("core");for(String p:Arrays.asList("qq","bilibili")) if(b.serves(p))ids.add(p);return ids;}
    static boolean schema(Map<?,?> obj){return obj!=null && Long.valueOf(1).equals(obj.get("schemaVersion")) && Long.valueOf(1).equals(obj.get("abi"));}
    static boolean record(Map<?,?> r,String id){return schema(r)&&id.equals(r.get("id"))&&("core".equals(id)?"core":"platform-plugin").equals(r.get("kind"))&&r.get("version") instanceof String&&((String)r.get("version")).matches("[A-Za-z0-9._-]{1,64}")&&r.get("sha256") instanceof String&&((String)r.get("sha256")).matches("[0-9a-f]{64}");}
    static String describe(File files,BotRegistry.Bot bot){
        if(bot==null || !bot.id.matches("[a-zA-Z0-9_-]{1,64}")) return "无法读取模块清单";
        Map<?,?> catalog=BotStore.readMetadata(new File(files,"module-downloads/catalog.json"));
        File root=new File(files,"bot-runtimes/"+bot.id+"/agent-app");StringBuilder s=new StringBuilder();
        for(String id:needs(bot)){
            if(s.length()>0)s.append("\n");s.append(id.equals("core")?"核心":BotRegistry.PLATFORM_LABEL(id)+" 插件").append("：");
            Map<?,?> receipt=BotStore.readMetadata(new File(root,id.equals("core")?".bot-module.json":"src/platform-modules/"+id+"/.bot-module.json"));
            Map<?,?> entry=null;if(schema(catalog)&&catalog.get("artifacts") instanceof List)for(Object o:(List<?>)catalog.get("artifacts"))if(o instanceof Map&&record((Map<?,?>)o,id)){if(entry!=null){entry=null;break;}entry=(Map<?,?>)o;}
            if(record(receipt,id)){s.append("安装记录 ").append(receipt.get("version"));if(entry!=null&&!receipt.get("sha256").equals(entry.get("sha256")))s.append("，清单版本 ").append(entry.get("version"));}
            else if(entry!=null)s.append("待安装 ").append(entry.get("version"));else s.append("待提供安装包");
        }
        return s.toString();
    }
}
