package com.whaleonebot.ui;

import java.nio.charset.StandardCharsets;
import java.util.*;

/** Pure metadata only. Instances are immutable snapshots; occupancy never depends on running state. */
public final class CoreInventory {
    private CoreInventory() {}
    public static final class Instance {
        public final String id, kind, version, ownerId;
        public final boolean legacy;
        public final List<String> platforms;
        final List<RuntimeUiLink> pages;
        private Instance(String id,String kind,String version,String owner,boolean legacy,List<String> ps,List<RuntimeUiLink> pages) {
            this.id=id;this.kind=kind;this.version=version;this.ownerId=owner;this.legacy=legacy;
            this.platforms=Collections.unmodifiableList(new ArrayList<>(ps));
            this.pages=Collections.unmodifiableList(new ArrayList<>(pages));
        }
        Instance withVersion(String v){return new Instance(id,kind,v,ownerId,legacy,platforms,pages);}
        Instance owned(String id){return new Instance(this.id,kind,version,id,legacy,platforms,pages);}
    }
    // A directory name is not proof of an install. Resolve only the committed slot; pending is not live.
    static String activeVersion(java.io.File files,String id){
        if(files==null || id==null || !id.matches("[a-z][a-z0-9-]{0,63}"))return null;
        try {
            java.io.File root=new java.io.File(files.getCanonicalFile(),"core-instances/"+id);
            java.io.File active=new java.io.File(root,"active.json");
            require(active.getCanonicalFile().equals(active));Map<?,?> slots=BotStore.readMetadata(active);
            String g=str(slots,"current");require(java.util.UUID.fromString(g).toString().equals(g));
            java.io.File gen=new java.io.File(root,"generations/"+g);
            java.io.File info=new java.io.File(gen,"generation.json"),module=new java.io.File(gen,"agent-app/.bot-module.json");
            require(info.getCanonicalFile().equals(info) && module.getCanonicalFile().equals(module));
            Map<?,?> r=BotStore.readMetadata(info),m=BotStore.readMetadata(module);
            String v=str(r,"version");require(validVersion(v) && "core".equals(m.get("id")) && Long.valueOf(1).equals(m.get("abi")));
            return v;
        }catch(Exception ex){return null;}
    }
    static boolean hasReceipt(java.io.File files,String id,String expected){String v=activeVersion(files,id);return v!=null && (expected==null || expected.equals(v));}
    static Instance builtin(String id,String version) {
        require(id!=null && id.matches("[a-z][a-z0-9-]{0,63}") && !id.startsWith("custom-") && !id.startsWith("legacy-"));
        require(validVersion(version));
        return new Instance(id,"builtin",version,"",false,Arrays.asList("qq","bilibili","douyin"),Collections.<RuntimeUiLink>emptyList());
    }
    static Instance migrated(BotRegistry.Bot b) {
        require(b.id.matches("[a-z][a-z0-9-]{0,63}"));
        return new Instance("legacy-"+b.id,b.runtimeKind,b.runtimeRef.isEmpty()?"legacy":b.runtimeRef,b.id,true,
            BotRegistry.KIND_CUSTOM.equals(b.runtimeKind)?b.platforms:Arrays.asList("qq","bilibili","douyin"),b.runtimeUi);
    }
    public static Instance parseDescriptor(String json) {
        require(json!=null && json.length()<=16384 && json.getBytes(StandardCharsets.UTF_8).length<=16384);
        Object parsed=new BotStore.Json(json).parse(); require(parsed instanceof Map);
        Map<?,?> m=(Map<?,?>)parsed;
        require(m.size()==5 && Long.valueOf(1).equals(m.get("schemaVersion")));
        return custom(m);
    }
    private static boolean validVersion(String v) {return v!=null && v.matches("[A-Za-z0-9][A-Za-z0-9._+-]{0,63}");}
    private static Instance custom(Map<?,?> m) {
        String id=str(m,"id"),v=str(m,"version"); require(id.matches("custom-[a-z0-9][a-z0-9-]{0,55}") && validVersion(v));
        Object ps=m.get("platforms"),raw=m.get("pages");require(ps instanceof List && raw instanceof List);
        List<String> platforms=new ArrayList<>();for(Object p:(List<?>)ps){require(p instanceof String && BotRegistry.PLATFORM_SUPPORTED((String)p) && !platforms.contains(p));platforms.add((String)p);}
        require(!platforms.isEmpty() && ((List<?>)raw).size()<=16);
        List<RuntimeUiLink> pages=new ArrayList<>();for(Object item:(List<?>)raw){require(item instanceof Map); Map<?,?> page=(Map<?,?>)item;
            require(page.size()==3); RuntimeUiLink l=RuntimeUiLink.parse(str(page,"platform"),str(page,"label"),str(page,"url"));require(l!=null && platforms.contains(l.platform));pages.add(l);}
        return new Instance(id,"custom",v,"",false,platforms,pages);
    }
    static Instance fromRecord(Map<?,?> m,List<BotRegistry.Bot> bots){
        String id=str(m,"id"),kind=str(m,"kind"),version=str(m,"version");require(m.get("legacy") instanceof Boolean);
        if(Boolean.TRUE.equals(m.get("legacy"))) {
            for(BotRegistry.Bot b:bots) if(id.equals("legacy-"+b.id) && id.equals(b.coreInstanceId) && kind.equals(b.runtimeKind))return migrated(b);
            throw new IllegalArgumentException("旧实例没有原机器人");
        }
        if("custom".equals(kind)) return custom(m);require("builtin".equals(kind));return builtin(id,version);
    }
    static String str(Map<?,?> m,String key){Object v=m.get(key);require(v instanceof String);return (String)v;}
    static void require(boolean ok){if(!ok)throw new IllegalArgumentException("核心描述或登记数据无效");}
    static void write(StringBuilder out,Instance c){
        out.append("{\"id\":").append(BotStore.quote(c.id)).append(",\"kind\":").append(BotStore.quote(c.kind)).append(",\"version\":").append(BotStore.quote(c.version)).append(",\"legacy\":").append(c.legacy).append(",\"platforms\":[");
        boolean first=true;for(String p:c.platforms){if(!first)out.append(',');first=false;out.append(BotStore.quote(p));}
        out.append("],\"pages\":[");first=true;for(RuntimeUiLink p:c.pages){if(!first)out.append(',');first=false;
            out.append("{\"platform\":").append(BotStore.quote(p.platform)).append(",\"label\":").append(BotStore.quote(p.label)).append(",\"url\":").append(BotStore.quote(p.url)).append('}');}
        out.append("]}");
    }
}
