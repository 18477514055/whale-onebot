import com.whaleonebot.ui.RuntimeArchivePick;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * RuntimeArchivePick 的主机侧断言：临时目录里摆几种「下载目录长什么样」，看挑出来的对不对。
 * 跑法见 scripts/run-java-logic-tests.mjs。
 */
public final class RuntimeArchivePickTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        // 1) 不存在的目录
        eq("null 目录", null, RuntimeArchivePick.pick(null));
        Path tmp = Files.createTempDirectory("rtpick");
        eq("目录为空", null, RuntimeArchivePick.pick(tmp.toFile()));
        eq("路径不是目录", null, RuntimeArchivePick.pick(tmp.resolve("nope").toFile()));

        // 2) 只有一个版本，里面有 rootfs.tar.gz
        Path v1 = Files.createDirectories(tmp.resolve("1.0.0"));
        File gz = write(v1.resolve("rootfs.tar.gz"), 10);
        eq("单版本取 rootfs.tar.gz", gz.getCanonicalPath(),
                RuntimeArchivePick.pick(tmp.toFile()).getCanonicalPath());

        // 3) 两个版本：取版本号更大那个目录
        Path v2 = Files.createDirectories(tmp.resolve("1.0.1"));
        File v2gz = write(v2.resolve("rootfs.tar.gz"), 12);
        eq("多版本取 1.0.1", v2gz.getCanonicalPath(),
                RuntimeArchivePick.pick(tmp.toFile()).getCanonicalPath());

        // 4) 新版本目录里只有 runtime.zip，也要认
        File v3zip = write(Files.createDirectories(tmp.resolve("1.0.2")).resolve("runtime.zip"), 4);
        eq("新版本只有 runtime.zip", v3zip.getCanonicalPath(),
                RuntimeArchivePick.pick(tmp.toFile()).getCanonicalPath());

        // 5) 新版本目录里文件是 0 字节 ⇒ 视为没有，退回上一版本
        write(Files.createDirectories(tmp.resolve("1.0.3")).resolve("rootfs.tar.gz"), 0);
        eq("0 字节被跳过", v3zip.getCanonicalPath(),
                RuntimeArchivePick.pick(tmp.toFile()).getCanonicalPath());

        // 6) 目录里只有无关文件名 ⇒ 跳过
        write(Files.createDirectories(tmp.resolve("1.0.4")).resolve("notes.txt"), 3);
        eq("无关文件名被跳过", v3zip.getCanonicalPath(),
                RuntimeArchivePick.pick(tmp.toFile()).getCanonicalPath());

        // 7) runtimes 根下直接放文件（不是目录）⇒ 不看
        write(tmp.resolve("rootfs.tar.gz"), 9);
        eq("根下文件不算", v3zip.getCanonicalPath(),
                RuntimeArchivePick.pick(tmp.toFile()).getCanonicalPath());

        // 8) 文件头判定：PK 开头是 zip，其它都当 tar
        File zipLike = write(tmp.resolve("a.bin"), 0);
        try (FileOutputStream out = new FileOutputStream(zipLike)) {
            out.write(new byte[]{'P', 'K', 3, 4});
        }
        eq("PK 开头 = zip", true, RuntimeArchivePick.looksLikeZip(zipLike));
        File gzLike = write(tmp.resolve("b.bin"), 0);
        try (FileOutputStream out = new FileOutputStream(gzLike)) {
            out.write(new byte[]{0x1f, (byte) 0x8b, 8, 0});
        }
        eq("gzip 头 = 不是 zip", false, RuntimeArchivePick.looksLikeZip(gzLike));
        eq("不存在的文件 = 不是 zip", false,
                RuntimeArchivePick.looksLikeZip(new File(tmp.toFile(), "missing.bin")));

        System.out.println("RuntimeArchivePickTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) System.exit(1);
    }

    private static File write(Path p, int bytes) throws Exception {
        try (FileOutputStream out = new FileOutputStream(p.toFile())) {
            out.write(new byte[bytes]);
        }
        return p.toFile();
    }

    private static void eq(String label, Object want, Object got) {
        boolean ok = (want == null) ? (got == null) : want.equals(got);
        if (ok) {
            pass++;
            System.out.println("PASS  " + label);
        } else {
            fail++;
            System.out.println("FAIL  " + label + "  want=" + want + " got=" + got);
        }
    }
}
