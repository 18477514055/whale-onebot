package com.whaleonebot.ui;

import java.io.*;
import java.nio.charset.StandardCharsets;

/** Stream the two Debian package archives without executing maintainer scripts or extracting paths.
 * The caller must verify package/ABI/version and actual runtime compatibility before activation. */
final class QqDebArchive {
    interface Reader { void read(String name, InputStream bytes) throws IOException; }
    private static IOException invalid(){return new IOException("Unsupported or incomplete Debian package");}
    private static byte[] take(InputStream in,int size)throws IOException{
        byte[] buf=new byte[size]; new DataInputStream(in).readFully(buf); return buf;
    }
    private static String ascii(byte[] bytes){return new String(bytes,StandardCharsets.US_ASCII);}
    private static final class Member extends InputStream {
        final InputStream source; long left;
        Member(InputStream source,long left){this.source=source;this.left=left;}
        public int read()throws IOException{if(left==0)return -1;int v=source.read();if(v<0)throw invalid();left--;return v;}
        public int read(byte[] b,int off,int len)throws IOException{if(len==0)return 0;if(left==0)return -1;int n=source.read(b,off,(int)Math.min(left,len));if(n<=0)throw invalid();left-=n;return n;}
    }
    /** Stage a download in app-private storage. Pin and size come from the maintained release record,
     * not the download response. Never modify the selected client; caller owns a successful file. */
    static File stage(File privateDir,InputStream in,long size,String sha256)throws IOException{
        if(privateDir==null||!privateDir.isDirectory()||size<=0||size>(521L<<20)||sha256==null||!sha256.matches("[0-9a-f]{64}"))throw invalid();
        final java.security.MessageDigest digest;
        try{digest=java.security.MessageDigest.getInstance("SHA-256");}catch(java.security.NoSuchAlgorithmException impossible){throw new AssertionError(impossible);}
        File temp=File.createTempFile("qq-client-",".part",privateDir);boolean accepted=false;
        try{
            long count=0;byte[] buffer=new byte[65536];
            try(FileOutputStream out=new FileOutputStream(temp)){
                int n;while((n=in.read(buffer))!=-1){if(n==0||n>size-count)throw invalid();out.write(buffer,0,n);digest.update(buffer,0,n);count+=n;}
            }
            if(count!=size)throw invalid();byte[] actual=digest.digest();
            for(int i=0;i<actual.length;i++)if((actual[i]&255)!=Integer.parseInt(sha256.substring(2*i,2*i+2),16))throw invalid();
            try(InputStream verified=new BufferedInputStream(new FileInputStream(temp))){inspect(verified,(name,body)->{});}
            accepted=true;return temp;
        }finally{if(!accepted)java.nio.file.Files.deleteIfExists(temp.toPath());}
    }
    static void inspect(InputStream in,Reader reader)throws IOException{
        if(!ascii(take(in,8)).equals("!<arch>\n"))throw invalid();
        byte[] drain=new byte[16384];
        for(int i=0;i<3;i++){
            String h=ascii(take(in,60)), name=h.substring(0,16).trim().replaceFirst("/$",""),size=h.substring(48,58).trim();
            if(!h.endsWith("`\n")||!size.matches("[0-9]{1,10}"))throw invalid();
            long n=Long.parseLong(size);
            if(i==0){if(!name.equals("debian-binary")||n!=4||!ascii(take(in,4)).equals("2.0\n"))throw invalid();continue;}
            if(!name.matches((i==1?"control":"data")+"\\.tar\\.(?:xz|gz|zst)")||n==0||n>(i==1?8L<<20:512L<<20))throw invalid();
            Member body=new Member(in,n);reader.read(name,body);while(body.read(drain,0,drain.length)!=-1){};
            if((n&1)!=0&&in.read()!='\n')throw invalid();
        }
        if(in.read()!=-1)throw invalid();
    }
}
