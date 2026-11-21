package com.whaleonebot.backup;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import static java.nio.file.LinkOption.NOFOLLOW_LINKS;

/** Discovers only the fixed durable directory under each binding worker. Never scans worker/session contents. */
final class BindingCompartments {
    interface Store {void visit(Path dir,String binding,String suffix)throws Exception;}
    static boolean directory(Path p)throws IOException{if(Files.notExists(p,NOFOLLOW_LINKS))return false;CoreArchive.check(Files.isDirectory(p,NOFOLLOW_LINKS));return true;}
    static void capture(Path live,String owner,CoreArchive a,Store projection)throws Exception{
        projection.visit(live.resolve("durable"),"","");Path channels=live.resolve("channels");if(!directory(channels))return;
        try(DirectoryStream<Path> bindings=Files.newDirectoryStream(channels)){for(Path b:bindings){String id=b.getFileName().toString();if(!a.slots.containsKey(id))throw new IOException("实例包含未登记的账号目录，无法确认记忆归属；未释放");String platform=a.slots.get(id)[1];CoreArchive.check(directory(b));
            Path p=b;boolean present=true;for(String name:new String[]{owner,"workers",id}){p=p.resolve(name);if(!directory(p)){present=false;break;}}if(!present)continue;
            try(DirectoryStream<Path> accounts=Files.newDirectoryStream(p)){for(Path account:accounts){String label=account.getFileName().toString();CoreArchive.check(directory(account));Path durable=account.resolve("durable");if(!directory(durable))continue;CoreArchive.check(label.matches(platform+"-[1-9][0-9]{0,19}"));String ordinal=""+a.scopes.size();a.add("scope",ordinal,id,label.substring(platform.length()+1));projection.visit(durable,id,"@"+ordinal);}}
        }}
    }
    static void restore(Path stage,String owner,CoreArchive a,Store store)throws Exception{
        CoreArchive.check(owner.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}"));store.visit(Files.createDirectory(stage.resolve("durable")),"","");
        for(Map.Entry<String,String[]> e:a.scopes.entrySet()){String id=e.getValue()[0],account=e.getValue()[1],platform=a.slots.get(id)[1];Path p=stage;for(String name:new String[]{"channels",id,owner,"workers",id,platform+"-"+account,"durable"}){p=p.resolve(name);if(!directory(p))Files.createDirectory(p);}store.visit(p,id,"@"+e.getKey());}
    }
}
