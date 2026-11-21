package com.whaleonebot;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import java.io.*;
import java.net.*;
import java.util.UUID;
import java.nio.charset.StandardCharsets;

/** Managed protocol process asks Android's resolver on demand. No cookie, URL, port or HTTP payload. */
final class BiliSystemResolver implements Closeable {
    final String name="whale-bili-"+UUID.randomUUID();
    private final LocalServerSocket listener;
    private volatile boolean closed;
    BiliSystemResolver() throws IOException {
        listener=new LocalServerSocket(name);
        Thread thread=new Thread(this::serve,"bili-dns");thread.setDaemon(true);thread.start();
    }
    private void serve(){
        while(!closed){
            LocalSocket client; try{client=listener.accept();}catch(IOException e){break;}
            try(LocalSocket c=client){
                if(c.getPeerCredentials().getUid()!=android.os.Process.myUid())continue;
                c.setSoTimeout(3000);InputStream in=c.getInputStream();StringBuilder q=new StringBuilder();int b;
                while(q.length()<254 && (b=in.read())!='\n'){if(b<0||b>127)throw new IOException();q.append((char)b);}
                String host=q.toString();if(!host.matches("(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:bilibili\\.com|bilivideo\\.com)"))continue;
                StringBuilder answer=new StringBuilder();for(InetAddress ip:InetAddress.getAllByName(host)){
                    if(answer.length()>2000)break;answer.append(ip.getHostAddress()).append('\n');
                }c.getOutputStream().write(answer.toString().getBytes(StandardCharsets.US_ASCII));
            }catch(IOException ignored){/* empty reply = lookup failed; never log queries */}
        }
    }
    public void close(){closed=true;try{listener.close();}catch(IOException ignored){}}
}
