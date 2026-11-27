package com.whaleonebot.ui;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 纯 Java 零依赖压缩包与文本文档安全流式解包器（支持 .zip / .tar.gz / .tgz / .tar 及常见纯文本）：
 * <ul>
 *   <li>严防 Zip Slip 路径穿越（拒绝 ..、前导 /、\、盘符 :）；</li>
 *   <li>严防解压炸弹（单批最多 20 份有效文本、单文件 <= 2MB、总计 <= 8MB，与后端 file-import.js 对齐）；</li>
 *   <li>不引用任何 Android 类，可在标准 JVM 上直接单测验证。</li>
 * </ul>
 */
public final class ArchiveImporter {

    public static final int MAX_FILES = 20;
    public static final int MAX_FILE_BYTES = 2 * 1024 * 1024;
    public static final int MAX_TOTAL_BYTES = 8 * 1024 * 1024;

    private static final String[] TEXT_EXTS = {
            ".md", ".txt", ".json", ".csv", ".log", ".yaml", ".yml", ".ini", ".xml", ".html", ".htm"
    };

    public static final class ExtractedFile {
        public final String name;
        public final String content;
        public final int bytes;

        public ExtractedFile(String name, String content, int bytes) {
            this.name = name;
            this.content = content;
            this.bytes = bytes;
        }
    }

    public static final class Result {
        public final List<ExtractedFile> files = new ArrayList<ExtractedFile>();
        public int skippedNonText = 0;
        public int skippedOversize = 0;
        public int skippedUnsafe = 0;
        public int totalBytes = 0;
    }

    private ArchiveImporter() {}

    public static boolean isArchiveName(String fileName) {
        if (fileName == null) return false;
        String lower = fileName.trim().toLowerCase(Locale.US);
        return lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar");
    }

    public static boolean isSupportedTextName(String fileName) {
        if (fileName == null) return false;
        String lower = fileName.trim().toLowerCase(Locale.US);
        for (int i = 0; i < TEXT_EXTS.length; i++) {
            if (lower.endsWith(TEXT_EXTS[i])) return true;
        }
        return false;
    }

    /** 校验压缩包内路径合法性并规范化为安全文件名（拒绝任何路径穿越）。 */
    public static String sanitizeEntryName(String rawName) {
        if (rawName == null) return null;
        String s = rawName.trim();
        if (s.length() == 0 || s.startsWith("/") || s.startsWith("\\") || s.indexOf('\\') >= 0 || s.indexOf(':') >= 0) {
            return null;
        }
        String[] parts = s.split("/");
        StringBuilder flat = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            String p = parts[i].trim();
            if (p.length() == 0 || ".".equals(p)) continue;
            if ("..".equals(p)) return null;
            if (p.startsWith("__MACOSX") || p.startsWith("._")) return null;
            if (flat.length() > 0) flat.append('_');
            flat.append(p);
        }
        String out = flat.toString().replaceAll("[^A-Za-z0-9._\\-\\u4e00-\\u9fa5]", "_");
        if (out.length() == 0 || out.startsWith(".")) return null;
        if (out.length() > 110) out = out.substring(out.length() - 110);
        return out;
    }

    /** 根据文件名后缀自动流式解包或读取纯文本，并累加至 result。 */
    public static void extractInto(String fileName, InputStream in, Result out) throws IOException {
        if (in == null || out == null) return;
        String lower = fileName == null ? "" : fileName.trim().toLowerCase(Locale.US);
        if (lower.endsWith(".zip")) {
            extractZip(in, out);
        } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
            GZIPInputStream gz = new GZIPInputStream(in);
            extractTar(gz, out);
        } else if (lower.endsWith(".tar")) {
            extractTar(in, out);
        } else {
            String safe = sanitizeEntryName(fileName == null || fileName.trim().isEmpty() ? "import.txt" : fileName);
            if (safe == null) { out.skippedUnsafe++; return; }
            addSingleStream(safe, in, out);
        }
    }

    private static void extractZip(InputStream in, Result out) throws IOException {
        ZipInputStream zin = new ZipInputStream(in);
        ZipEntry entry;
        while ((entry = zin.getNextEntry()) != null) {
            if (out.files.size() >= MAX_FILES || out.totalBytes >= MAX_TOTAL_BYTES) break;
            if (entry.isDirectory()) { zin.closeEntry(); continue; }
            String safe = sanitizeEntryName(entry.getName());
            if (safe == null) { out.skippedUnsafe++; zin.closeEntry(); continue; }
            if (!isSupportedTextName(safe)) { out.skippedNonText++; zin.closeEntry(); continue; }
            addSingleStream(safe, zin, out);
            zin.closeEntry();
        }
    }

    /** 纯 Java POSIX/USTAR tar 流式解析（512 字节块头，无外部进程依赖）。 */
    private static void extractTar(InputStream in, Result out) throws IOException {
        byte[] header = new byte[512];
        while (out.files.size() < MAX_FILES && out.totalBytes < MAX_TOTAL_BYTES) {
            if (!readFully(in, header, 0, 512)) break;
            boolean allZero = true;
            for (int i = 0; i < 512; i++) {
                if (header[i] != 0) { allZero = false; break; }
            }
            if (allZero) break;
            String name = readTarString(header, 0, 100);
            String prefix = readTarString(header, 345, 155);
            if (prefix.length() > 0) name = prefix + "/" + name;
            long size = parseOctal(header, 124, 12);
            byte typeFlag = header[156];
            long padded = ((size + 511L) / 512L) * 512L;
            boolean isRegular = (typeFlag == 0 || typeFlag == '0');

            String safe = isRegular ? sanitizeEntryName(name) : null;
            if (!isRegular || size <= 0) {
                skipExact(in, padded);
                continue;
            }
            if (safe == null) {
                out.skippedUnsafe++;
                skipExact(in, padded);
                continue;
            }
            if (!isSupportedTextName(safe)) {
                out.skippedNonText++;
                skipExact(in, padded);
                continue;
            }
            if (size > MAX_FILE_BYTES || out.totalBytes + size > MAX_TOTAL_BYTES) {
                out.skippedOversize++;
                skipExact(in, padded);
                continue;
            }
            byte[] buf = new byte[(int) size];
            if (!readFully(in, buf, 0, (int) size)) break;
            skipExact(in, padded - size);
            String text = new String(buf, "UTF-8").replace("\u0000", "");
            if (text.trim().length() > 0) {
                out.files.add(new ExtractedFile(safe, text, buf.length));
                out.totalBytes += buf.length;
            }
        }
    }

    private static void addSingleStream(String safeName, InputStream in, Result out) throws IOException {
        if (out.files.size() >= MAX_FILES) { out.skippedOversize++; return; }
        int limit = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - out.totalBytes);
        if (limit <= 0) { out.skippedOversize++; return; }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        boolean overflow = false;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > limit) { overflow = true; break; }
            bos.write(buf, 0, n);
        }
        if (overflow) { out.skippedOversize++; return; }
        byte[] raw = bos.toByteArray();
        if (raw.length == 0) return;
        // 简单二进制启发过滤：若含过多 NUL 字节则跳过
        int nuls = 0;
        for (int i = 0; i < Math.min(raw.length, 512); i++) if (raw[i] == 0) nuls++;
        if (nuls > 4) { out.skippedNonText++; return; }
        String text = new String(raw, "UTF-8");
        if (text.trim().length() > 0) {
            out.files.add(new ExtractedFile(safeName, text, raw.length));
            out.totalBytes += raw.length;
        }
    }

    private static boolean readFully(InputStream in, byte[] dst, int off, int len) throws IOException {
        int got = 0;
        while (got < len) {
            int n = in.read(dst, off + got, len - got);
            if (n < 0) return false;
            got += n;
        }
        return true;
    }

    private static void skipExact(InputStream in, long bytes) throws IOException {
        long rem = bytes;
        byte[] sink = new byte[4096];
        while (rem > 0) {
            int toRead = (int) Math.min(sink.length, rem);
            int n = in.read(sink, 0, toRead);
            if (n < 0) break;
            rem -= n;
        }
    }

    private static String readTarString(byte[] buf, int off, int len) throws IOException {
        int end = off;
        while (end < off + len && buf[end] != 0) end++;
        return new String(buf, off, end - off, "UTF-8").trim();
    }

    private static long parseOctal(byte[] buf, int off, int len) {
        long val = 0;
        int end = off + len;
        int i = off;
        while (i < end && (buf[i] == 0 || buf[i] == ' ')) i++;
        while (i < end && buf[i] >= '0' && buf[i] <= '7') {
            val = (val << 3) + (buf[i] - '0');
            i++;
        }
        return val;
    }
}
