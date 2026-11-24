import com.whaleonebot.ui.SetupState;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * SetupState 的主机侧断言：临时目录里造出「旧布局 / 受管布局 / 只有 deb / 什么都没有」四种现场，
 * 验证首页三步的判据不会把没装的当成装好了。
 */
public final class SetupStateTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Path work = Files.createTempDirectory("setup-state");

        // 1) 什么都没有
        File files = work.toFile();
        eq("空目录：环境未就绪", false, SetupState.environmentReady(new File(files, "rootfs")));
        eq("空目录：QQ 未就绪", false, SetupState.qqReady(files));

        // 2) 旧独立布局：usr/bin/bash + usr/local/bin/node（软链指向 usr/local/node/bin/node）
        File legacy = new File(files, "rootfs-legacy");
        touch(legacy, "usr/bin/bash");
        touch(legacy, "etc/debian_version");
        touch(legacy, "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1");
        touch(legacy, "usr/local/node/bin/node");
        symlink(new File(legacy, "usr/local/bin/node"), "../node/bin/node");
        eq("旧布局四样齐全 = 环境就绪", true, SetupState.environmentReady(legacy));

        // 3) 受管布局：bin/bash + usr/bin/node（没有 usr/bin/bash，也没有 usr/local/bin/node）
        File managed = new File(files, "rootfs-managed");
        touch(managed, "bin/bash");
        touch(managed, "usr/bin/node");
        eq("受管布局 = 环境就绪", true, SetupState.environmentReady(managed));

        // 4) 只有 bash、没有 node ⇒ 未就绪（不能因为「目录看起来像 rootfs」就放行）
        File half = new File(files, "rootfs-half");
        touch(half, "bin/bash");
        eq("只有 bash = 未就绪", false, SetupState.environmentReady(half));

        // 5) QQ：解出来的客户端（rootfs/opt/QQ 的 qq + wrapper.node）
        File withClient = new File(work.toFile(), "files-client");
        touch(withClient, "rootfs/opt/QQ/qq");
        eq("只有 qq 没有 wrapper = 未就绪", false, SetupState.qqReady(withClient));
        touch(withClient, "rootfs/opt/QQ/resources/app/wrapper.node");
        eq("客户端齐了 = QQ 就绪", true, SetupState.qqReady(withClient));

        // 6) QQ：只有校验过的 deb（还没解出来）
        File withDeb = new File(work.toFile(), "files-deb");
        touch(withDeb, "qq-packages/qq-3.2.35-arm64.deb");
        eq("已放好 deb = QQ 就绪", true, SetupState.qqReady(withDeb));

        // 7) 受管布局的客户端目录也算
        File withManaged = new File(work.toFile(), "files-managed");
        touch(withManaged, "platform-clients/qq/active/opt/QQ/qq");
        touch(withManaged, "platform-clients/qq/active/opt/QQ/resources/app/wrapper.node");
        eq("受管客户端目录 = QQ 就绪", true, SetupState.qqReady(withManaged));

        // 8) 空 deb 文件不算（长度 0 说明写坏了）
        File emptyDeb = new File(work.toFile(), "files-emptydeb");
        touchEmpty(emptyDeb, "qq-packages/qq-0.deb");
        eq("空 deb 不算就绪", false, SetupState.qqReady(emptyDeb));

        // 9) 环境包套数：只认回执，不认「目录存在」（解压一半的目录也在那儿）
        File packs = new File(work.toFile(), "files-packs");
        eq("没有 core-environments = 0 套", 0, SetupState.environmentPackCount(packs));
        touch(packs, "core-environments/abcdef01/bin/bash");
        eq("只有目录没有回执 = 0 套", 0, SetupState.environmentPackCount(packs));
        // 真机形态：回执在 <home>/rootfs/ 下（ManagedEnvironment 内部 resolve("rootfs")）
        touch(packs, "core-environments/abcdef01/rootfs/.whale-public-environment");
        eq("rootfs 下有回执 = 1 套", 1, SetupState.environmentPackCount(packs));
        touch(packs, "core-environments/22aa33bb/.whale-public-environment");
        eq("旧形态（回执在 home 下）也算 = 2 套", 2, SetupState.environmentPackCount(packs));

        System.out.println("\nSetupState: " + pass + " pass / " + fail + " fail");
        if (fail > 0) System.exit(1);
    }

    private static void touch(File base, String rel) throws Exception {
        File f = new File(base, rel);
        f.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(new byte[] {1, 2, 3});
        }
    }

    private static void touchEmpty(File base, String rel) throws Exception {
        File f = new File(base, rel);
        f.getParentFile().mkdirs();
        // 零字节 = 写盘/校验失败留下的空壳，不能算「装好了」
        try (FileOutputStream out = new FileOutputStream(f)) {
        }
    }

    private static void symlink(File link, String target) throws Exception {
        link.getParentFile().mkdirs();
        Files.deleteIfExists(link.toPath());
        Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(target));
    }

    private static void eq(String name, Object want, Object got) {
        boolean ok = want == null ? got == null : want.equals(got);
        if (ok) {
            pass++;
            System.out.println("  ✓ " + name);
        } else {
            fail++;
            System.out.println("  ✗ " + name + "（期望 " + want + "，实际 " + got + "）");
        }
    }
}
