package com.whaleonebot.backup;
import java.nio.file.Path;
/** Android SQLite in production; real SQLite/JDBC adapter in offline table-projection tests. */
interface PortableDatabase extends AutoCloseable {
    interface Backend {void regular(Path p,long max)throws Exception;PortableDatabase open(Path file,boolean create)throws Exception;}
    interface Rows extends AutoCloseable {boolean next()throws Exception;String text(int i)throws Exception;void close()throws Exception;}
    Rows query(String sql)throws Exception;
    void exec(String sql,Object...args)throws Exception;
    void close()throws Exception;
}
