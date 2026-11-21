package com.whaleonebot.backup;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;
import com.whaleonebot.ContainerService;
import com.whaleonebot.install.CoreInstaller;
import com.whaleonebot.ui.BotRegistry;
import com.whaleonebot.ui.CoreInventory;
import java.io.*;


/** Worker-thread facade. Never enumerates shared storage or accepts a provider-supplied filesystem path. */
public final class CoreBackupSaf {
    private CoreBackupSaf(){}
    private static CoreInventory.Instance core(String id,String owner)throws IOException{
        for(CoreInventory.Instance c:BotRegistry.cores())if(c.id.equals(id)&&c.ownerId.equals(owner)&&!c.legacy&&BotRegistry.KIND_BUILTIN.equals(c.kind))return c;
        throw new IOException("核心不是可维护的内置实例，或占用者已变化");
    }
    private static CoreDataTransaction transaction(Context ctx,String id)throws IOException{
        return transaction(ctx,id,false);
    }
    private static CoreDataTransaction transaction(Context ctx,String id,boolean readOnlyLayout)throws IOException{
        return new CoreDataTransaction(ctx.getFilesDir().toPath(),id,readOnlyLayout,committed->{try{String op=CoreInstaller.pendingMaintenance(ctx.getFilesDir(),id);if("reset".equals(op))CoreInstaller.recoverReset(ctx.getFilesDir(),id,committed);}catch(Exception e){throw new IOException("无法核实核心复位记录",e);}});
    }
    /** Optional user-initiated recovery after process death. Ownership in the atomic registry determines rollback vs finalize. */
    public static void recoverPending(Context ctx,String id)throws Exception{
        String owner=null;synchronized(BotRegistry.class){for(CoreInventory.Instance c:BotRegistry.cores())if(c.id.equals(id)&&!c.legacy&&BotRegistry.KIND_BUILTIN.equals(c.kind)){owner=c.ownerId;break;}CoreArchive.check(owner!=null);if(owner.isEmpty()){transaction(ctx,id).recover("");return;}}
        try(Closeable paused=ContainerService.pauseForMaintenance(ctx,owner)){CoreArchive.check(paused!=null);synchronized(BotRegistry.class){core(id,owner);transaction(ctx,id).recover(owner);}}
    }
    private static void document(Context ctx,Uri u)throws IOException{
        BackupDocument.require(u!=null&&"content".equals(u.getScheme()),"BACKUP_SINGLE_DOCUMENT_REQUIRED");
        String authority=u.getAuthority();BackupDocument.provider(authority,DocumentsContract.isDocumentUri(ctx,u)&&!DocumentsContract.isTreeUri(u)&&u.getPathSegments().size()==2&&"document".equals(u.getPathSegments().get(0))&&u.getQuery()==null&&u.getFragment()==null);
        String display=DocumentsContract.Document.COLUMN_DISPLAY_NAME,mime=DocumentsContract.Document.COLUMN_MIME_TYPE;
        try(android.database.Cursor row=ctx.getContentResolver().query(u,new String[]{display,mime},null,null,null)){
            BackupDocument.require(row!=null&&row.moveToFirst(),"BACKUP_DOCUMENT_METADATA");
            BackupDocument.identity(authority,DocumentsContract.getDocumentId(u),row.getString(0),row.getString(1),android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS).getAbsolutePath());
            BackupDocument.require(!row.moveToNext(),"BACKUP_DOCUMENT_METADATA");
        }catch(RuntimeException ex){throw new IOException("BACKUP_DOCUMENT_METADATA");}
    }
    public static void export(Context ctx,String coreId,String expectedBotId,Uri destination)throws Exception{document(ctx,destination);owned(ctx,coreId,expectedBotId,destination,false);}
    public static void exportAndRelease(Context ctx,String coreId,String expectedBotId,Uri destination)throws Exception{document(ctx,destination);owned(ctx,coreId,expectedBotId,destination,true);}
    public static void release(Context ctx,String coreId,String expectedBotId)throws Exception{owned(ctx,coreId,expectedBotId,null,true);}
    private static void owned(Context ctx,String id,String owner,Uri destination,boolean release)throws Exception{
        String stage="BACKUP_OWNER_CHANGED";
        try{CoreArchive.check(owner!=null&&!owner.isEmpty());core(id,owner);
        stage="BACKUP_PAUSE_FAILED";
        try(Closeable ignored=ContainerService.pauseForMaintenance(ctx,owner)){
            CoreArchive.check(ignored!=null);
            synchronized(BotRegistry.class){stage="BACKUP_OWNER_CHANGED";CoreInventory.Instance c=core(id,owner);BotRegistry.Bot bot=BotRegistry.get(owner);CoreArchive.check(bot!=null && id.equals(bot.coreInstanceId));
                stage="BACKUP_DATA_LAYOUT";CoreDataTransaction fs=transaction(ctx,id,!release);fs.recover(owner);
                if(destination!=null){stage="BACKUP_CORE_METADATA";boolean compatible=CoreInstaller.acceptsPortableV1(ctx.getFilesDir(),id);stage="BACKUP_CORE_SCHEMA";CoreArchive.check(compatible);
                    stage="BACKUP_REGISTRY_DATA";CoreArchive data=new CoreArchive(c.version,bot.name,bot.persona,bot.platforms);for(BotRegistry.Binding binding:bot.bindings)data.add("slot",binding.id,binding.platform,binding.memoryMode);
                    stage="BACKUP_DATA_CAPTURE";CoreBackupProjection.capture(fs.live(),owner,data,new AndroidBackupDatabase());
                    stage=null; // publish supplies only fixed stage codes
                    BackupDocument.publish(data,new BackupDocument.Target(){
                        public InputStream read()throws IOException{return ctx.getContentResolver().openInputStream(destination);}
                        public OutputStream write()throws IOException{return ctx.getContentResolver().openOutputStream(destination,"wt");}
                        public void discard()throws IOException{CoreArchive.check(DocumentsContract.deleteDocument(ctx.getContentResolver(),destination));}
                    });
                }
                stage="BACKUP_RELEASE_FAILED";
                if(release)fs.release(owner,()->CoreInstaller.reset(ctx.getFilesDir(),id,()->{if(!BotRegistry.releaseOwner(id,owner))throw new IllegalStateException("无法保存释放状态");}));
            }
        }}catch(Exception failure){if(stage==null)throw failure;if("BACKUP_DATA_CAPTURE".equals(stage)&&failure instanceof IOException&&java.util.Arrays.asList("BACKUP_EXTERNAL_CORPUS","BACKUP_SQLITE_SIDECAR_WAL","BACKUP_SQLITE_SIDECAR_SHM","BACKUP_SQLITE_SIDECAR_JOURNAL").contains(failure.getMessage()))throw failure;throw new IOException(stage);}
    }
    public static void restore(Context ctx,String id,Uri source)throws Exception{document(ctx,source);CoreArchive data;try(InputStream in=ctx.getContentResolver().openInputStream(source)){data=CoreArchive.read(in,null);}
        synchronized(BotRegistry.class){CoreInventory.Instance c=core(id,"");CoreArchive.check(CoreInstaller.acceptsPortableV1(ctx.getFilesDir(),id)&&c.platforms.containsAll(data.platforms));
            CoreDataTransaction fs=transaction(ctx,id);fs.recover("");
            BotRegistry.BeforeCreate prepare=newId->{try{fs.stageRestore(newId,stage->CoreBackupProjection.restore(stage,newId,data,new AndroidBackupDatabase()));}catch(Exception e){throw new IOException("无法准备实例资料",e);}};
            BotRegistry.Bot bot=data.slots.isEmpty()?BotRegistry.createOnCore(id,data.name,data.persona,data.platforms,prepare):BotRegistry.restoreOnCore(id,data.name,data.persona,data.platforms,new java.util.ArrayList<>(data.slots.values()),prepare);
            if(bot==null){fs.recover("");throw new IOException("无法恢复，目标核心未被分配");}fs.recover(bot.id);
        }
    }
    public static void deleteBackup(Context ctx,Uri uri)throws Exception{document(ctx,uri);try(InputStream in=ctx.getContentResolver().openInputStream(uri)){CoreArchive.read(in,null);}CoreArchive.check(DocumentsContract.deleteDocument(ctx.getContentResolver(),uri));}
}
