package com.whaleonebot.ui;

import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Temporary one-success loopback capability. No remote UI, scripts, other routes or persisted token. */
public final class CoreRegistration implements Closeable {
    private static CoreRegistration active;
    private final String secret;
    private final ServerSocket server;
    private final long expires=System.nanoTime()+TimeUnit.MINUTES.toNanos(2);
    private volatile Socket client;
    private volatile boolean closed;
    private CoreRegistration() throws IOException {
        byte[] random=new byte[32];new SecureRandom().nextBytes(random);
        StringBuilder hex=new StringBuilder(64);for(byte b:random)hex.append(String.format(Locale.ROOT,"%02x",b&255));secret=hex.toString();
        server=new ServerSocket(0,4,InetAddress.getByName("127.0.0.1"));server.setSoTimeout(1000);
    }
    public static synchronized CoreRegistration open() throws IOException {
        if(active!=null)active.close();active=new CoreRegistration();CoreRegistration r=active;
        Thread t=new Thread(r::serve,"core-registration");t.setDaemon(true);t.start();return r;
    }
    public int port(){return server.getLocalPort();}
    public String token(){return secret;}
    public synchronized void close(){closed=true;try{server.close();}catch(IOException ignored){} Socket s=client;if(s!=null)try{s.close();}catch(IOException ignored){} }
    private boolean expired(){return System.nanoTime()-expires>=0;}
    private void serve(){
        try{while(!closed && !expired()){
            try(Socket s=server.accept()){client=s;s.setSoTimeout(2000);
                int status;try{status=handle(s);}catch(Exception ex){status=400;}
                String reason=status==201?"Created":status==403?"Forbidden":"Bad Request";
                s.getOutputStream().write(("HTTP/1.1 "+status+" "+reason+"\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                if(status==201)break;
            }catch(IOException ignored){}finally{client=null;}
        }}finally{close();}
    }
    private int handle(Socket socket) throws IOException {
        InputStream in=new BufferedInputStream(socket.getInputStream());
        if(!"POST /v1/core-instances HTTP/1.1".equals(line(in)))return 400;
        Map<String,String> h=new HashMap<>();String l;int size=0;
        while(!(l=line(in)).isEmpty()){
            size+=l.length();if(size>8192 || h.size()>=24)return 400;
            int sep=l.indexOf(':');if(sep<=0)return 400;String key=l.substring(0,sep).toLowerCase(Locale.ROOT);
            if(!key.matches("[a-z0-9-]+") || h.put(key,l.substring(sep+1).trim())!=null)return 400;
        }
        if(!("127.0.0.1:"+port()).equals(h.get("host")) || h.containsKey("origin") || h.containsKey("transfer-encoding") || h.containsKey("content-encoding"))return 403;
        String auth=h.get("authorization");if(auth==null || !MessageDigest.isEqual(auth.getBytes(StandardCharsets.US_ASCII),("Bearer "+secret).getBytes(StandardCharsets.US_ASCII)))return 403;
        String len=h.get("content-length");if(!"application/json".equalsIgnoreCase(h.get("content-type")) || len==null || !len.matches("[1-9][0-9]{0,4}"))return 400;
        int n=Integer.parseInt(len);if(n>16384)return 400;byte[] body=new byte[n];int pos=0;
        while(pos<n){checkTime();int k=in.read(body,pos,n-pos);if(k<0)throw new EOFException();pos+=k;}
        String json=StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(body)).toString();
        synchronized(this){checkTime();BotRegistry.importDescriptor(json);closed=true;}return 201;
    }
    private void checkTime() throws IOException {if(closed || expired())throw new IOException("Window closed");}
    private String line(InputStream in)throws IOException{
        StringBuilder s=new StringBuilder();while(s.length()<2048){checkTime();int c=in.read();if(c=='\r' && in.read()=='\n')return s.toString();if(c<32||c>126)throw new IOException("Header");s.append((char)c);}throw new IOException("Header length");
    }
}
