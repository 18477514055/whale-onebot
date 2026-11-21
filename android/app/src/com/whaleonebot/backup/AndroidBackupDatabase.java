package com.whaleonebot.backup;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.system.*;
import java.nio.file.Path;

final class AndroidBackupDatabase implements PortableDatabase.Backend {
    public void regular(Path p,long max)throws Exception{StructStat s=Os.lstat(p.toString());CoreArchive.check(OsConstants.S_ISREG(s.st_mode)&&s.st_nlink==1&&s.st_size<=max);}
    public PortableDatabase open(Path file,boolean create){final SQLiteDatabase db=create?SQLiteDatabase.openOrCreateDatabase(file.toFile(),null):SQLiteDatabase.openDatabase(file.toString(),null,SQLiteDatabase.OPEN_READONLY|SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        return new PortableDatabase(){public Rows query(String sql){Cursor c=db.rawQuery(sql,null);return new Rows(){public boolean next(){return c.moveToNext();}public String text(int n){return c.getString(n);}public void close(){c.close();}};}public void exec(String sql,Object...args){if("BEGIN".equals(sql))db.beginTransaction();else if("COMMIT".equals(sql)){db.setTransactionSuccessful();db.endTransaction();}else if(args.length==0)db.execSQL(sql);else db.execSQL(sql,args);}public void close(){try{if(db.inTransaction())db.endTransaction();}finally{db.close();}}};
    }
}
