package com.whaleonebot.backup;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import static java.nio.file.LinkOption.NOFOLLOW_LINKS;

/** Filesystem side of the inventory transaction. Caller holds registry and stopped-instance leases.
 * No tree copying. Live data moves by same-filesystem rename; never fall back to recursive copy/delete. */
public final class CoreDataTransaction {
    private final Path live,txn,old,stage,marker;
    interface Action {void run() throws Exception;}
    interface Prepare {void run(Path dir)throws Exception;}
    interface ResetRecovery {void reconcile(boolean committed)throws IOException;}
    private final ResetRecovery resetRecovery;
    CoreDataTransaction(Path trustedFiles,String core)throws IOException {this(trustedFiles,core,committed->{});}
    CoreDataTransaction(Path trustedFiles,String core,ResetRecovery recovery)throws IOException {
        this(trustedFiles,core,false,recovery);
    }
    CoreDataTransaction(Path trustedFiles,String core,boolean readOnlyLayout,ResetRecovery recovery)throws IOException {
        resetRecovery=recovery;
        CoreArchive.check(core!=null&&core.matches("[a-z][a-z0-9-]{0,63}")&&!core.startsWith("legacy-")&&!core.startsWith("custom-")&&!core.equals("whale-1"));
        Path p=trustedFiles.toRealPath(); // Context.getFilesDir(), never an archive/user path
        for(String name:new String[]{"rootfs","opt","whale","instance-data"}){p=p.resolve(name);if(Files.notExists(p,NOFOLLOW_LINKS)){if(!readOnlyLayout)Files.createDirectory(p);}else CoreArchive.check(Files.isDirectory(p,NOFOLLOW_LINKS));}
        live=p.resolve(core);txn=p.resolve(".maintenance-"+core);old=txn.resolve("old");stage=txn.resolve("new");marker=txn.resolve("intent");
    }
    Path live()throws IOException{CoreArchive.check(!exists(live)||Files.isDirectory(live,NOFOLLOW_LINKS));return live;}
    static boolean exists(Path p){return Files.exists(p,NOFOLLOW_LINKS);}
    static void move(Path a,Path b)throws IOException{CoreArchive.check(!exists(b));Files.move(a,b,StandardCopyOption.ATOMIC_MOVE);}
    static void erase(Path dir)throws IOException {
        // walkFileTree does not follow symlinks; all entry points are fixed, private quarantine children.
        Files.walkFileTree(dir,new SimpleFileVisitor<Path>(){
            @Override public FileVisitResult visitFile(Path p,BasicFileAttributes a)throws IOException{Files.delete(p);return FileVisitResult.CONTINUE;}
            @Override public FileVisitResult postVisitDirectory(Path p,IOException error)throws IOException{if(error!=null)throw error;Files.delete(p);return FileVisitResult.CONTINUE;}
        });
    }
    private void marker(String kind,String owner)throws IOException{CoreArchive.check(owner.matches("[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}"));try(FileOutputStream f=new FileOutputStream(marker.toFile())){f.write((kind+":"+owner).getBytes(StandardCharsets.US_ASCII));f.getFD().sync();}}
    void recover(String owner)throws IOException{
        if(!exists(txn))return;
        CoreArchive.check(Files.isDirectory(txn,NOFOLLOW_LINKS));
        if(!exists(marker)){CoreArchive.check(!exists(old)&&!exists(stage));Files.delete(txn);return;}
        CoreArchive.check(Files.isRegularFile(marker,NOFOLLOW_LINKS)&&Files.size(marker)<=112);
        String intent=new String(Files.readAllBytes(marker),StandardCharsets.US_ASCII);CoreArchive.check(intent.matches("(?:release|restore):[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}"));String expected=intent.substring(intent.indexOf(':')+1);
        CoreArchive.check(owner.isEmpty()||expected.equals(owner));
        if(intent.startsWith("release:")){
            resetRecovery.reconcile(owner.isEmpty());
            if(exists(old)){if(expected.equals(owner))move(old,live);else erase(old);}
        }else if(owner.isEmpty()&&exists(live))erase(live);
        if(exists(stage))erase(stage);Files.delete(marker);Files.delete(txn);
    }
    void release(String owner,Action resetAndCommit)throws Exception{
        recover(owner);live();Files.createDirectory(txn);marker("release",owner);
        try{if(exists(live))move(live,old);resetAndCommit.run();}catch(Exception ex){recover(owner);throw ex;}
        recover("");
    }
    void stageRestore(String newOwner,Prepare prepare)throws Exception{
        live();CoreArchive.check(!exists(live)&&!exists(txn));Files.createDirectory(txn);marker("restore",newOwner);
        try{Files.createDirectory(stage);prepare.run(stage);move(stage,live);}catch(Exception ex){recover("");throw ex;}
    }
}
