import com.whaleonebot.ui.RootfsLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * RootfsLayout 的主机侧断言：临时目录里造两套「骨架」，验证就绪判定与安全替换/回滚。
 */
public final class RootfsLayoutTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Path work = Files.createTempDirectory("rootfs-layout");
        File rootfs = new File(work.toFile(), "rootfs");

        // 1) 空目录 / 不存在
        eq("不存在 = 未就绪", false, RootfsLayout.isReady(rootfs));
        Files.createDirectories(rootfs.toPath());
        eq("空目录 = 未就绪", false, RootfsLayout.isReady(rootfs));

        // 2) 只缺一样也不算就绪
        makeReadySkeleton(rootfs);
        eq("四样齐全 = 就绪", true, RootfsLayout.isReady(rootfs));
        eq("删除 node 后 = 未就绪", false, afterDelete(rootfs, "usr/local/bin/node"));
        makeReadySkeleton(rootfs);
        eq("删除 bash 后 = 未就绪", false, afterDelete(rootfs, "usr/bin/bash"));
        makeReadySkeleton(rootfs);

        // 3) 暂存目录名与旧目录名
        eq("暂存目录名", "rootfs.new", RootfsLayout.stagingDir(rootfs).getName());
        eq("旧目录名含时间戳", "rootfs.old-42", RootfsLayout.retiredDir(rootfs, 42L).getName());

        // 4) 暂存目录不可用时不能替换（旧的必须原样保留）
        File stagedBad = RootfsLayout.stagingDir(rootfs);
        Files.createDirectories(stagedBad.toPath());
        eq("暂存不可用 ⇒ promote 失败", false, RootfsLayout.promote(stagedBad, rootfs, 7L));
        eq("旧的仍在", true, RootfsLayout.isReady(rootfs));

        // 5) 暂存可用 ⇒ 替换成功，旧目录被改名保留
        rm(stagedBad);
        makeReadySkeleton(stagedBad);
        new File(stagedBad, "marker-new").createNewFile();
        eq("promote 成功", true, RootfsLayout.promote(stagedBad, rootfs, 99L));
        eq("新的已就位", true, new File(rootfs, "marker-new").isFile());
        eq("旧的被保留", true, RootfsLayout.isReady(RootfsLayout.retiredDir(rootfs, 99L)));

        // 6) 回滚：把旧的换回来
        eq("rollback 成功", true, RootfsLayout.rollback(rootfs, 99L));
        eq("回滚后旧的回来了（无 marker-new）", false, new File(rootfs, "marker-new").isFile());
        eq("回滚后仍就绪", true, RootfsLayout.isReady(rootfs));

        // 7) 没有可回滚的旧目录时安全返回 false
        eq("无可回滚 ⇒ false", false, RootfsLayout.rollback(rootfs, 12345L));

        System.out.println("RootfsLayoutTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) System.exit(1);
    }

    private static void makeReadySkeleton(File root) throws Exception {
        Files.createDirectories(new File(root, "usr/bin").toPath());
        Files.createDirectories(new File(root, "etc").toPath());
        Files.createDirectories(new File(root, "usr/lib/aarch64-linux-gnu").toPath());
        Files.createDirectories(new File(root, "usr/local/bin").toPath());
        touch(new File(root, "usr/bin/bash"));
        touch(new File(root, "etc/debian_version"));
        touch(new File(root, "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"));
        touch(new File(root, "usr/local/bin/node"));
    }

    private static void touch(File f) throws Exception {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write('x');
        }
    }

    private static boolean afterDelete(File root, String rel) {
        new File(root, rel).delete();
        return RootfsLayout.isReady(root);
    }

    private static void rm(File f) throws Exception {
        Files.walk(f.toPath())
            .sorted((a, b) -> b.getNameCount() - a.getNameCount())
            .forEach((p) -> p.toFile().delete());
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
