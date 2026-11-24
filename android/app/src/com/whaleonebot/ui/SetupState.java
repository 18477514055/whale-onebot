package com.whaleonebot.ui;

import java.io.File;
import java.util.List;
import java.util.Locale;

/**
 * 「第一次用」的三步各自现在到哪一步 —— 全部只读本地事实，不联网、不改任何东西。
 *
 * <p>为什么要有它：2026-11-23 第一个使用者的反馈是「不知道该先做什么」。只放一张静态三步卡，
 * 仍然得让人自己比对「我做到哪了」；这里把三步都做成可判定的状态，首页据此打勾、
 * 并把按钮换成「下一件要做的事」。
 *
 * <p>三步的判据：
 * <ul>
 *   <li><b>环境</b>：rootfs 里 bash / 加载器 / node 齐了。与 ContainerService 同一套判断，
 *       并且两种布局都认 —— 受管环境是 {@code bin/bash + usr/bin/node}，
 *       旧的独立环境是 {@code usr/bin/bash + usr/local/bin/node}（真机实测 node 落在
 *       {@code usr/local/node/bin/node}，{@code usr/local/bin/node} 是它的软链）。</li>
 *   <li><b>QQ</b>：本机已经有解出来的 Linux QQ 客户端（{@code rootfs/opt/QQ} 或受管的
 *       {@code platform-clients/qq/active/opt/QQ}），或者私有目录里已经放好校验过的 deb。</li>
 *   <li><b>机器人</b>：注册表里已经有机器人。</li>
 * </ul>
 *
 * <p>★ 判据只代表「装好了」，不代表协议兼容或账号已登录 —— 那是第三步点下去之后的事。
 * ★ 刻意不 import Android：入参就是 files 目录，这样同一套判定能在主机侧直接断言
 * （见 {@code test/java/SetupStateTest.java}）。
 */
public final class SetupState {

    /** 三步的当前状态。 */
    public static final class Steps {
        final boolean env;
        final boolean qq;
        final boolean bot;

        Steps(boolean env, boolean qq, boolean bot) {
            this.env = env;
            this.qq = qq;
            this.bot = bot;
        }

        public int done() {
            return (env ? 1 : 0) + (qq ? 1 : 0) + (bot ? 1 : 0);
        }

        public boolean all() {
            return env && qq && bot;
        }
    }

    private SetupState() {
    }

    /** @param filesDir App 的私有 files 目录 */
    public static Steps read(File filesDir) {
        boolean env = false;
        boolean qq = false;
        boolean bot = false;
        try {
            if (filesDir != null) {
                env = environmentReady(new File(filesDir, "rootfs"));
                qq = qqReady(filesDir);
            }
            bot = botReady();
        } catch (Throwable ignored) {
            // 读不到就当「还没做」：宁可多引导一次，也不要让人误以为已经装好了。
        }
        return new Steps(env, qq, bot);
    }

    public static boolean environmentReady(File rootfs) {
        if (rootfs == null) return false;
        if (RootfsLayout.isReady(rootfs)) return true;
        boolean bash = new File(rootfs, "bin/bash").isFile();
        boolean node = new File(rootfs, "usr/bin/node").isFile()
                || new File(rootfs, "usr/local/node/bin/node").isFile()
                || new File(rootfs, "usr/local/bin/node").exists();
        return bash && node;
    }

    public static boolean qqReady(File filesDir) {
        if (filesDir == null) return false;
        if (QqClientFiles.present(new File(filesDir, "rootfs/opt/QQ"))) return true;
        if (QqClientFiles.present(new File(filesDir, "platform-clients/qq/active/opt/QQ"))) return true;
        return hasDeb(new File(filesDir, "qq-packages"));
    }

    private static boolean hasDeb(File dir) {
        File[] list = dir == null ? null : dir.listFiles();
        if (list == null) return false;
        for (File f : list) {
            if (f == null) continue;
            if (f.getName().toLowerCase(Locale.ROOT).endsWith(".deb") && f.length() > 0) return true;
        }
        return false;
    }

    /**
     * 已经拿到的公共环境包套数。
     *
     * <p>判据是 {@code core-environments/<hash>/} 里有 ManagedEnvironment 写的回执
     * （{@code .whale-public-environment}，内容是包的 sha256）—— 只认回执，不认「目录存在」，
     * 因为解压到一半的目录也在那儿。
     */
    public static int environmentPackCount(File filesDir) {
        File dir = new File(filesDir, "core-environments");
        File[] list = dir.listFiles();
        if (list == null) return 0;
        int n = 0;
        for (File d : list) {
            if (d == null || !d.isDirectory()) continue;
            // ★ 真机实测：ManagedEnvironment.prepare 内部是 base.resolve("rootfs")，回执落在
            // <home>/rootfs/.whale-public-environment（不是 <home>/ 下）。两层都认，免得布局变了又读不到。
            if (new File(d, "rootfs/.whale-public-environment").isFile()
                    || new File(d, ".whale-public-environment").isFile()) {
                n++;
            }
        }
        return n;
    }

    private static boolean botReady() {
        List<BotRegistry.Bot> bots = BotRegistry.list();
        return bots != null && !bots.isEmpty();
    }
}
