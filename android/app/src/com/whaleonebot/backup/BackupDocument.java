package com.whaleonebot.backup;

import java.io.*;

/** One newly-created SAF document, no replacement or append. A provider's close is not proof of persistence. */
final class BackupDocument {
    interface Target {InputStream read() throws IOException; OutputStream write() throws IOException; void discard() throws IOException;}
    static void publish(CoreArchive data,Target target)throws IOException{
        try(InputStream previous=target.read()){CoreArchive.check(previous!=null&&previous.read()==-1);}
        // The picker supplied a *new empty* target. If publication fails, discard only this incomplete output.
        try{
            byte[] expected;
            try(OutputStream out=target.write()){CoreArchive.check(out!=null);expected=data.write(out);}
            try(InputStream stored=target.read()){CoreArchive.read(stored,expected);}
        }catch(IOException|RuntimeException fail){try{target.discard();}catch(Exception cleanup){fail.addSuppressed(cleanup);}throw fail;}
    }
}
