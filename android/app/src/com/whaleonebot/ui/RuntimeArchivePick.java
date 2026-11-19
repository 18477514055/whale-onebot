package com.whaleonebot.ui;

import java.io.File;
import java.util.Arrays;
import java.util.Comparator;

/**
 * 挑「该用哪个已下载的运行端包」的纯逻辑（不碰 Android，可在 PC 上用 javac/java 断言）。
 *
 * <p>规则与 `ContainerService.downloadedRuntimeArchive()` 一致：
 * <ol>
 *   <li>只看 {@code runtimes/<版本>/} 下的目录，版本目录名倒序（新版本优先）；</li>
 *   <li>每个目录里按固定顺序找一个非空文件：{@code rootfs.tar.gz}、{@code runtime.tar.gz}、
 *       {@code rootfs.tar}、{@code runtime.zip}；</li>
 *   <li>找到就返回，找不到继续看下一个版本目录；都没有返回 {@code null}。</li>
 * </ol>
 * 之所以固定顺序而不是「随便挑一个文件」：目录里可能同时留着上次下载的残片与用户手动放的包，
 * 顺序固定才可预测。
 */
public final class RuntimeArchivePick {

    private static final String[] NAMES = {
        "rootfs.tar.gz", "runtime.tar.gz", "rootfs.tar", "runtime.zip"
    };

    private RuntimeArchivePick() {
    }

    /** 在 {@code runtimesRoot} 下挑一个可用的归档；没有返回 null。 */
    public static File pick(File runtimesRoot) {
        if (runtimesRoot == null || !runtimesRoot.isDirectory()) return null;
        File[] versions = runtimesRoot.listFiles();
        if (versions == null || versions.length == 0) return null;
        Arrays.sort(versions, new Comparator<File>() {
            @Override public int compare(File a, File b) {
                return String.valueOf(b.getName()).compareTo(String.valueOf(a.getName()));
            }
        });
        for (File v : versions) {
            if (v == null || !v.isDirectory()) continue;
            for (String name : NAMES) {
                File f = new File(v, name);
                if (f.isFile() && f.length() > 0) return f;
            }
        }
        return null;
    }

    /** 按文件头判断是不是 zip（`PK`); 其余一律当 tar 处理。 */
    public static boolean looksLikeZip(File f) {
        if (f == null || !f.isFile()) return false;
        java.io.InputStream in = null;
        try {
            in = new java.io.FileInputStream(f);
            int a = in.read();
            int b = in.read();
            return a == 'P' && b == 'K';
        } catch (Throwable t) {
            return false;
        } finally {
            if (in != null) {
                try { in.close(); } catch (Throwable ignored) { /* 读完就关 */ }
            }
        }
    }
}
