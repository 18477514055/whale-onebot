package com.whaleonebot;

import android.content.Context;
import com.whaleonebot.install.CoreInstaller;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Uses the selected core's verified environment without putting account data or updated APK assets in that shared root. */
final class ManagedBiliHost {
    private ManagedBiliHost(){}
    private static File asset(Context ctx,String name,File dir,boolean executable)throws Exception{
        Files.createDirectories(dir.toPath()); File file=new File(dir,new File(name).getName());byte[] bytes;
        try(InputStream in=ctx.getAssets().open(name);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);bytes=out.toByteArray();}
        if(!file.isFile()||!Arrays.equals(bytes,Files.readAllBytes(file.toPath()))){Path tmp=Files.createTempFile(dir.toPath(),".asset-",".tmp");try{Files.write(tmp,bytes);Files.move(tmp,file.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}finally{Files.deleteIfExists(tmp);}}
        if(executable&&!file.setExecutable(true,true))throw new IOException();return file;
    }
    // Enrollment is short-lived. Resolve the two fixed origins using Android's current
    // network policy, not a public DNS fallback. Never put a snapshot in the shared root.
    static File enrollmentHosts(Context c)throws IOException {
        StringBuilder rows=new StringBuilder("127.0.0.1 localhost\n::1 localhost\n");
        for(String name:new String[]{"passport.bilibili.com","api.bilibili.com"})
            for(java.net.InetAddress ip:java.net.InetAddress.getAllByName(name))
                rows.append(ip.getHostAddress()).append(' ').append(name).append('\n');
        File hosts=File.createTempFile("bili-enroll-",".hosts",c.getCacheDir());
        try {Files.write(hosts.toPath(),rows.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII));return hosts;}
        catch(IOException ex){hosts.delete();throw ex;}
    }
    static synchronized ProcessBuilder builder(Context ctx,String bot,String slot,String core)throws Exception{
        File files=ctx.getFilesDir();if(!InstalledRuntimeHost.valid(core)||!InstalledRuntimeHost.valid(slot)||!InstalledRuntimeHost.owner(files,bot,core))throw new IOException();
        File app=CoreInstaller.active(files,core);if(app==null||!new File(app,"src/platform-modules/bilibili/.bot-module.json").isFile())throw new IOException();
        File root=CoreInstaller.environmentForApp(files,app);if(!new File(root,"opt/whale/bili-protocol/src/platforms/bilibili/service.mjs").isFile())throw new IOException();
        File bin=new File(files,"bin"),ld=new File(files,"libexec/proot"),adapter=new File(files,"managed-adapters/bili");
        for(String n:new String[]{"proot","libtalloc.so.2","libandroid-shmem.so"})asset(ctx,n,bin,n.equals("proot"));for(String n:new String[]{"loader","loader32"})asset(ctx,"libexec/proot/"+n,ld,true);
        File host=asset(ctx,"bili-protocol-host.mjs",adapter,false),client=asset(ctx,"authorized-client.mjs",adapter,false),transport=asset(ctx,"bili-client.mjs",adapter,false);
        File state=new File(InstalledRuntimeHost.data(files,core),"protocol-state/bilibili/"+slot);File ids=new File(state,"device-ids"),tmp=new File(state,"tmp");Files.createDirectories(ids.toPath());Files.createDirectories(tmp.toPath());Files.createDirectories(new File(files,"tmp").toPath());
        ProcessBuilder pb=ContainerService.containerBuilder(files,"exec env -i PATH=/usr/bin:/bin HOME=/tmp TZ=Asia/Shanghai /usr/bin/node /opt/whale/bili-protocol-host.mjs");List<String> args=pb.command();int at=args.indexOf("-r");args.set(at+1,root.getCanonicalPath());args.addAll(at,Arrays.asList("-b",host.getCanonicalPath()+":/opt/whale/bili-protocol-host.mjs","-b",client.getCanonicalPath()+":/opt/whale/bili-protocol/src/platforms/bilibili/authorized-client.mjs","-b",transport.getCanonicalPath()+":/opt/whale/bili-protocol/src/platforms/bilibili/client.mjs","-b",ids.getCanonicalPath()+":/opt/whale/bili-protocol/device-ids","-b",tmp.getCanonicalPath()+":/tmp"));return pb;
    }
}
