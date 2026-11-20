package com.whaleonebot;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.zip.GZIPInputStream;

/** Installs an authenticated clean, normalized USTAR environment. Never overlays an existing rootfs. */
public final class ManagedEnvironment {
 private static final String RECEIPT=".whale-public-environment";
 private static final long MAX=8L*1024*1024*1024;
 private static final LinkOption NO=LinkOption.NOFOLLOW_LINKS;
 private static IOException bad(){return new IOException("Invalid environment archive or target");}
 public static boolean ready(File files,String sha){try{if(sha==null||!sha.matches("[0-9a-f]{64}"))return false;Path root=files.toPath().resolve("rootfs"),r=root.resolve(RECEIPT);return Files.isDirectory(root,NO)&&Files.isRegularFile(r,NO)&&Files.size(r)==64&&sha.equals(new String(Files.readAllBytes(r),StandardCharsets.US_ASCII));}catch(IOException e){return false;}}
 private static String field(byte[] h,int pos,int n){int end=pos;while(end<pos+n&&h[end]!=0)end++;return new String(h,pos,end-pos,StandardCharsets.UTF_8);}
 private static long number(byte[] h,int i,int n)throws IOException{String s=field(h,i,n).trim();if(s.isEmpty())return 0;if(!s.matches("[0-7]+"))throw bad();return Long.parseLong(s,8);}
 private static void exact(InputStream in,byte[] b,int n)throws IOException{int at=0;while(at<n){int k=in.read(b,at,n-at);if(k<1)throw bad();at+=k;}}
 private static Path entry(Path root,String s)throws IOException{while(s.startsWith("./"))s=s.substring(2);if(s.indexOf('\\')>=0||s.indexOf(':')>=0||s.indexOf('\uFFFD')>=0||s.startsWith("/"))throw bad();for(String c:s.split("/"))if(c.equals("..")||c.equals(RECEIPT))throw bad();Path p=root.resolve(s).normalize();if(!p.startsWith(root))throw bad();return p;}
 private static void clean(Path dir)throws IOException{Files.walkFileTree(dir,new SimpleFileVisitor<Path>(){public FileVisitResult visitFile(Path p,BasicFileAttributes a)throws IOException{Files.delete(p);return FileVisitResult.CONTINUE;}public FileVisitResult postVisitDirectory(Path p,IOException e)throws IOException{if(e!=null)throw e;Files.delete(p);return FileVisitResult.CONTINUE;}});}
 private static boolean zero(byte[] b){for(byte v:b)if(v!=0)return false;return true;}
 private static void unpack(InputStream in,Path root)throws IOException{
  byte[] h=new byte[512],buf=new byte[65536];long total=0;int count=0;Set<Path> names=new HashSet<>();
  for(;;){exact(in,h,512);if(zero(h)){exact(in,h,512);if(!zero(h))throw bad();int trail=0,k;while((k=in.read(buf))!=-1){trail+=k;if(trail>1048576)throw bad();for(int i=0;i<k;i++)if(buf[i]!=0)throw bad();}break;}
   long sum=0;for(int i=0;i<512;i++)sum+=i>=148&&i<156?32:(h[i]&255);if(sum!=number(h,148,8)||!field(h,257,6).equals("ustar")||++count>200000)throw bad();String prefix=field(h,345,155),s=field(h,0,100);Path p=entry(root,(prefix.isEmpty()?"":prefix+"/")+s);int type=h[156];long n=number(h,124,12);if(p.equals(root)&&type!=53||!names.add(p)||n>MAX-total)throw bad();total+=n;
   if(!p.equals(root))Files.createDirectories(p.getParent());if(type==0||type==48){try(OutputStream out=Files.newOutputStream(p,StandardOpenOption.CREATE_NEW)){for(long left=n;left>0;){int k=(int)Math.min(left,buf.length);exact(in,buf,k);out.write(buf,0,k);left-=k;}}if((number(h,100,8)&0111)!=0&&!p.toFile().setExecutable(true,true))throw bad();exact(in,buf,(int)((512-n%512)%512));}
   else if(n!=0)throw bad();else if(type==53)Files.createDirectories(p);else throw bad(); // Published environments are materialized: no links, devices or PAX overrides.
  }

 }
 public static synchronized void prepare(File files,File archive,String sha)throws IOException{
  if(ready(files,sha))return;if(sha==null||!sha.matches("[0-9a-f]{64}")||!Files.isRegularFile(archive.toPath(),NO))throw bad();Path base=files.toPath().toRealPath(),dst=base.resolve("rootfs");if(Files.exists(dst,NO))throw new IOException("Existing environment preserved");Path stage=Files.createTempDirectory(base,".environment-");boolean done=false;
  try{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream raw=new BufferedInputStream(Files.newInputStream(archive.toPath()));DigestInputStream checked=new DigestInputStream(raw,digest);InputStream tar=new GZIPInputStream(checked,65536)){unpack(tar,stage);while(checked.read()!=-1){} }
   StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format(Locale.ROOT,"%02x",b&255));if(!sha.contentEquals(hex))throw bad();
   for(String s:new String[]{"bin/bash","usr/bin/env","usr/bin/node"}){Path p=stage.resolve(s).toRealPath();if(!p.startsWith(stage)||!Files.isRegularFile(p)||!Files.isExecutable(p))throw new IOException("Incomplete public environment: "+s);}
   Files.write(stage.resolve(RECEIPT),sha.getBytes(StandardCharsets.US_ASCII),StandardOpenOption.CREATE_NEW);Files.move(stage,dst,StandardCopyOption.ATOMIC_MOVE);done=true;
  }catch(NoSuchAlgorithmException e){throw new IOException(e);}finally{if(!done&&Files.exists(stage,NO))clean(stage);}
 }
 private ManagedEnvironment(){}
}
