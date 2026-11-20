package com.whaleonebot.ui;

import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Exercises real persistence, committed slot receipts and actual loopback HTTP, not Android stubs. */
public final class CoreInventoryTest {
    static int count;
    static void check(boolean b,String why){if(!b)throw new AssertionError(why);count++;}
    static void denied(Runnable r){try{r.run();}catch(IllegalArgumentException|IllegalStateException expected){count++;return;}throw new AssertionError("Expected rejection");}
    static String descriptor(String id){return "{\"schemaVersion\":1,\"id\":\""+id+"\",\"version\":\"v1\",\"platforms\":[\"qq\",\"bilibili\"],\"pages\":[]}";}
    static void write(Path p,String s)throws IOException{Files.createDirectories(p.getParent());Files.write(p,s.getBytes(StandardCharsets.UTF_8));}
    static void provision(Path dir,String id,String v)throws Exception{
        String gen=UUID.randomUUID().toString();Path root=dir.resolve("core-instances").resolve(id),g=root.resolve("generations").resolve(gen);
        write(root.resolve("active.json"),"{\"current\":\""+gen+"\"}");write(g.resolve("generation.json"),"{\"version\":\""+v+"\"}");
        write(g.resolve("agent-app/.bot-module.json"),"{\"id\":\"core\",\"abi\":1}");BotRegistry.registerBuiltin(id,v);
    }
    static int post(CoreRegistration r,String auth,String body)throws Exception{
        URL url=new URL("http://127.0.0.1:"+r.port()+"/v1/core-instances");HttpURLConnection c=(HttpURLConnection)url.openConnection(Proxy.NO_PROXY);
        c.setConnectTimeout(1000);c.setReadTimeout(2000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Authorization","Bearer "+auth);c.setRequestProperty("Content-Type","application/json");byte[] bytes=body.getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(bytes.length);
        try{try(OutputStream out=c.getOutputStream()){out.write(bytes);}return c.getResponseCode();}finally{c.disconnect();}
    }
    static void clean(Path root)throws IOException{try(java.util.stream.Stream<Path> paths=Files.walk(root)){for(Path p:(Iterable<Path>)paths.sorted(Comparator.reverseOrder())::iterator)Files.delete(p);}}
    public static void main(String[] args)throws Exception{
        Path dir=Files.createTempDirectory("core-inventory-"),file=dir.resolve("bots.json");List<String> qq=Arrays.asList("qq");
        try{
            BotRegistry.init(dir.toFile());check(BotRegistry.cores().isEmpty() && BotRegistry.primary()==null && !Files.exists(file),"clean install never seeds a fake bot");
            denied(()->BotRegistry.registerBuiltin("core-a","v1"));provision(dir,"core-a","v1");provision(dir,"core-b","v1");
            Path activeB=dir.resolve("core-instances/core-b/active.json");byte[] pointer=Files.readAllBytes(activeB);
            write(activeB,"{\"current\":\"../core-a\"}");check(BotRegistry.createOnCore("core-b","bad","",qq)==null,"reject malformed active generation even after registration");Files.write(activeB,pointer);
            Path fence=dir.resolve("rootfs/opt/whale/instance-data/.maintenance-core-b");write(fence,"pending");check(BotRegistry.createOnCore("core-b","bad","",qq)==null,"pending recovery prevents reuse");Files.delete(fence);
            check(BotRegistry.createOnCore("core-b","bad","",qq,id->{throw new IOException();})==null,"failed restore preparation has no owner");
            String[] shared={"slot-a","qq","shared"},isolated={"slot-b","qq","isolated"};
            check(BotRegistry.restoreOnCore("core-b","Bad","",qq,Arrays.asList(shared,shared),id->{throw new AssertionError();})==null,"duplicate slots rejected before preparing data");
            BotRegistry.Bot restored=BotRegistry.restoreOnCore("core-b","Restored","",qq,Arrays.asList(shared,isolated),id->{});
            check(restored!=null,"mixed restore committed");BotRegistry.init(dir.toFile());List<BotRegistry.Binding> slots=BotRegistry.get(restored.id).bindings;
            check(slots.size()==2 && slots.get(0).memoryMode.equals("shared") && slots.get(1).id.equals("slot-b") && slots.get(1).memoryMode.equals("isolated"),"round-trip retains same-platform independent slots");
            for(BotRegistry.Binding s:slots)check(s.accountId.isEmpty() && s.peerId.isEmpty() && s.httpUrl.isEmpty() && s.wsUrl.isEmpty(),"restored slot requires fresh authorization");
            ExecutorService pool=Executors.newFixedThreadPool(2);BotRegistry.Bot winner;
            try{Callable<BotRegistry.Bot> claim=()->BotRegistry.createOnCore("core-a","Example","prompt",qq);List<Future<BotRegistry.Bot>> winners=pool.invokeAll(Arrays.asList(claim,claim));BotRegistry.Bot a=winners.get(0).get(),b=winners.get(1).get();check((a==null)!=(b==null),"exactly one concurrent owner");winner=a==null?b:a;}finally{pool.shutdownNow();}
            check(!winner.id.equals("whale-1") && !BotRegistry.legacyQQ(winner),"new identity never legacy");winner.enabled=false;check(BotRegistry.update(winner),"stop");BotRegistry.init(dir.toFile());
            check(BotRegistry.coreForBot(winner.id).ownerId.equals(winner.id) && BotRegistry.createOnCore("core-a","next","",qq)==null,"stop/restart keeps ownership");
            check(!BotRegistry.remove(winner.id) && !BotRegistry.releaseOwner("core-b",winner.id),"no implicit or cross-instance release");
            check(BotRegistry.releaseOwner("core-a",winner.id) && BotRegistry.get(winner.id)==null,"explicit release commits owner and robot together");
            BotRegistry.Bot next=BotRegistry.createOnCore("core-a","Again","",qq);check(next!=null && !next.id.equals(winner.id),"release cannot revive an old bot identity");
            String d=descriptor("custom-sample");denied(()->BotRegistry.importDescriptor(d.replace("\"pages\":[]","\"command\":\"ignored\"")));denied(()->BotRegistry.importDescriptor(d.replace("\"schemaVersion\":1","\"schemaVersion\":1,\"schemaVersion\":1")));
            denied(()->BotRegistry.importDescriptor(d.replace("[]","[{\"platform\":\"qq\",\"label\":\"Page\",\"url\":\"file:///tmp/a\"}]")));
            try(CoreRegistration r=CoreRegistration.open()){check(post(r,"invalid",d)==403,"registration requires secret");check(post(r,r.token(),d)==201,"opt-in loopback register");}
            denied(()->BotRegistry.importDescriptor(d));BotRegistry.init(dir.toFile());check(BotRegistry.createOnCore("custom-sample","Custom","",qq)!=null,"local registration durable/selectable");
            String legacy="{\"schemaVersion\":2,\"bots\":[{\"id\":\"whale-1\",\"name\":\"老用户\",\"platforms\":[\"qq\"]}]}";write(file,legacy);byte[] before=Files.readAllBytes(file);BotRegistry.init(dir.toFile());
            CoreInventory.Instance c=BotRegistry.coreForBot("whale-1");check(c.legacy && c.ownerId.equals("whale-1") && Arrays.equals(before,Files.readAllBytes(file)),"legacy in-place and byte-preserved");check(!BotRegistry.releaseOwner(c.id,c.ownerId),"managed cleanup excludes legacy");
            write(file,"{broken");BotRegistry.init(dir.toFile());denied(()->BotRegistry.importDescriptor(d));check(BotRegistry.cores().isEmpty() && new String(Files.readAllBytes(file),StandardCharsets.UTF_8).equals("{broken"),"bad registry preserved and locked");
            System.out.println("CoreInventoryTest: "+count+" checks passed");
        }finally{clean(dir);}
    }
}
