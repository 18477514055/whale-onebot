import com.whaleonebot.ui.ArchiveImporter;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * v1.2.16 纯 Java 逻辑回归断言：
 * 1) ArchiveImporter 支持 .zip 与 .tar.gz 流式解包；
 * 2) 严防 Zip Slip（../evil.txt、/etc/passwd、C:\evil.txt）；
 * 3) 过滤非文本文件（.png/.exe）与单批上限控制。
 */
public final class V1216RefactorTest {

    private static int passed = 0;

    private static void eq(Object actual, Object expected, String msg) {
        if (actual == null ? expected != null : !actual.equals(expected)) {
            throw new AssertionError(msg + " (expected=" + expected + ", actual=" + actual + ")");
        }
        passed++;
    }

    private static void ok(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
        passed++;
    }

    private static byte[] buildZip() throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(bos, StandardCharsets.UTF_8)) {
            addZipEntry(zos, "notes/intro.md", "# 群规\n请文明发言");
            addZipEntry(zos, "data/members.csv", "name,role\n小鲸鱼,bot");
            addZipEntry(zos, "../evil.txt", "should be rejected");
            addZipEntry(zos, "/abs/path.txt", "should be rejected");
            addZipEntry(zos, "assets/pic.png", "binary-ignored");
            addZipEntry(zos, "__MACOSX/._intro.md", "apple-double-ignored");
        }
        return bos.toByteArray();
    }

    private static void addZipEntry(ZipOutputStream zos, String name, String content) throws Exception {
        zos.putNextEntry(new ZipEntry(name));
        zos.write(content.getBytes(StandardCharsets.UTF_8));
        zos.closeEntry();
    }

    private static byte[] buildTarGz(String entryName, String content) throws Exception {
        byte[] data = content.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream tar = new ByteArrayOutputStream();
        byte[] header = new byte[512];
        byte[] nameBytes = entryName.getBytes(StandardCharsets.UTF_8);
        System.arraycopy(nameBytes, 0, header, 0, Math.min(nameBytes.length, 100));
        // mode + uid + gid
        writeAscii(header, 100, "0000644\0");
        writeAscii(header, 108, "0000000\0");
        writeAscii(header, 116, "0000000\0");
        // size in octal (11 digits + NUL)
        String oct = String.format("%011o\0", data.length);
        writeAscii(header, 124, oct);
        writeAscii(header, 136, "00000000000\0");
        for (int i = 148; i < 156; i++) header[i] = ' ';
        header[156] = '0';
        long sum = 0;
        for (byte b : header) sum += (b & 0xFF);
        writeAscii(header, 148, String.format("%06o\0 ", sum));
        tar.write(header);
        tar.write(data);
        int rem = data.length % 512;
        if (rem != 0) tar.write(new byte[512 - rem]);
        tar.write(new byte[1024]); // EOF 2 zero blocks

        ByteArrayOutputStream gzOut = new ByteArrayOutputStream();
        try (GZIPOutputStream gz = new GZIPOutputStream(gzOut)) {
            gz.write(tar.toByteArray());
        }
        return gzOut.toByteArray();
    }

    private static void writeAscii(byte[] dst, int off, String s) {
        byte[] b = s.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(b, 0, dst, off, b.length);
    }

    public static void main(String[] args) throws Exception {
        // 1. 路径安全校验
        eq(ArchiveImporter.sanitizeEntryName("../evil.txt"), null, "拒绝 .. 穿越");
        eq(ArchiveImporter.sanitizeEntryName("/etc/passwd"), null, "拒绝绝对路径");
        eq(ArchiveImporter.sanitizeEntryName("C:\\evil.txt"), null, "拒绝盘符和反斜杠");
        eq(ArchiveImporter.sanitizeEntryName("docs/群规.md"), "docs_群规.md", "合法中文相对路径正常展平");

        // 2. ZIP 解包与安全过滤
        ArchiveImporter.Result zipRes = new ArchiveImporter.Result();
        ArchiveImporter.extractInto("pack.zip", new ByteArrayInputStream(buildZip()), zipRes);
        eq(zipRes.files.size(), 2, "ZIP 仅提取 2 份合法文本文档");
        ok(zipRes.skippedUnsafe >= 3, "ZIP 拒绝了穿越路径与 __MACOSX 元文件");
        eq(zipRes.skippedNonText, 1, "ZIP 跳过了 .png 二进制文件");
        ok(zipRes.files.get(0).content.contains("请文明发言"), "保留中文内容");
        ok(zipRes.files.get(1).name.endsWith(".csv"), "支持 .csv 表格");

        // 3. TAR.GZ 解包
        ArchiveImporter.Result tgzRes = new ArchiveImporter.Result();
        ArchiveImporter.extractInto("memory.tar.gz", new ByteArrayInputStream(buildTarGz("folder/note.txt", "记忆测试内容")), tgzRes);
        eq(tgzRes.files.size(), 1, "tar.gz 正确提取 1 份文档");
        eq(tgzRes.files.get(0).content, "记忆测试内容", "tar.gz UTF-8 内容完整");

        System.out.println("PASS: V1216RefactorTest (" + passed + " assertions)");
    }
}
