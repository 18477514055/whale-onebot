package com.whaleonebot.backup;

import java.io.*;

/** One newly-created SAF document, no replacement or append. A provider's close is not proof of persistence. */
final class BackupDocument {
    interface Target {InputStream read() throws IOException; OutputStream write() throws IOException; void discard() throws IOException;}
    static final String EXTERNAL="com.android.externalstorage.documents", DOWNLOADS="com.android.providers.downloads.documents";
    static void require(boolean ok,String code)throws IOException{if(!ok)throw new IOException(code);}
    // Only single documents from the two local system providers. Never open the document ID as a path.
    static void provider(String authority,boolean single)throws IOException{
        require(EXTERNAL.equals(authority)||DOWNLOADS.equals(authority),"BACKUP_LOCAL_PROVIDER_REQUIRED");
        require(single,"BACKUP_SINGLE_DOCUMENT_REQUIRED");
    }
    static void identity(String authority,String id,String name,String mime,String downloadsRoot)throws IOException{
        require(name!=null&&!name.contains("/")&&!name.contains("\\")&&name.toLowerCase(java.util.Locale.ROOT).endsWith(".whalebackup"),"BACKUP_DOCUMENT_NAME");
        require(mime!=null&&!mime.equals("vnd.android.document/directory"),"BACKUP_DOCUMENT_TYPE");
        require(id!=null&&!id.isEmpty()&&!id.contains("\\")&&!id.contains(".."),"BACKUP_DOCUMENT_SCOPE");
        if(EXTERNAL.equals(authority)){
            int split=id.indexOf(':');require(split>0,"BACKUP_DOCUMENT_SCOPE");String sub=id.substring(split+1).toLowerCase(java.util.Locale.ROOT);
            require(!sub.startsWith("/")&&!sub.startsWith("android/")&&sub.endsWith(".whalebackup"),"BACKUP_DOCUMENT_SCOPE");
        }else{
            require(DOWNLOADS.equals(authority),"BACKUP_LOCAL_PROVIDER_REQUIRED");
            if(id.startsWith("raw:"))require(downloadsRoot!=null&&id.startsWith("raw:"+downloadsRoot+"/")&&id.endsWith("/"+name),"BACKUP_DOCUMENT_SCOPE");
            else require(id.matches("(?:msf:)?[0-9]+"),"BACKUP_DOCUMENT_SCOPE");
        }
    }
    static void publish(CoreArchive data,Target target)throws IOException{
        boolean empty;
        try(InputStream previous=target.read()){empty=previous.read()==-1;}
        catch(IOException|RuntimeException fail){throw new IOException("BACKUP_TARGET_READ");}
        require(empty,"BACKUP_TARGET_NOT_EMPTY");
        // Only discard an output we established was empty before our write.
        String stage="BACKUP_TARGET_WRITE";
        try{
            byte[] expected;
            try(OutputStream out=target.write()){CoreArchive.check(out!=null);expected=data.write(out);}
            stage="BACKUP_TARGET_VERIFY";
            try(InputStream stored=target.read()){CoreArchive.read(stored,expected);}
        }catch(IOException|RuntimeException fail){try{target.discard();}catch(Exception cleanup){stage+="_DISCARD_FAILED";}throw new IOException(stage);}
    }
}
