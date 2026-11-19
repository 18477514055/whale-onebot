package com.whaleonebot.ui;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/**
 * 容器骨架（rootfs）的目录判定与「先解包到临时目录、确认可用再换上去」的纯逻辑。
 *
 * <p>为什么要分两步：解包是破坏性操作 —— 直接往正在用的 rootfs 上解，一旦包坏了或中途失败，
 * 用户就既没有新容器也没有旧容器（登录态、配置、知识库都在里面）。所以：
 * <ol>
 *   <li>解到 {@code rootfs.new}；</li>
 *   <li>用 {@link #isReady} 检查关键文件是否齐全；</li>
 *   <li>齐全才把旧的改名成 {@code rootfs.old-<时间戳>}，再把新的改名成 {@code rootfs}。</li>
 * </ol>
 * 换的时候只做两次 rename，中间没有「两个都没有」的窗口。
 *
 * <p>本类只用 java.io / java.nio，不 import Android，所以在 PC 上可以直接断言（见 test/java）。
 */
public final class RootfsLayout {

    /** 目录名后缀：新解包好的骨架。 */
    public static final String STAGING_SUFFIX = ".new";
    /** 目录名前缀：被换下来的旧骨架（保留以便回滚）。 */
    public static final String RETIRED_PREFIX = ".old-";

    private RootfsLayout() {
    }

    /** 解包目标目录：{@code <rootfs>.new}。 */
    public static File stagingDir(File rootfs) {
        return new File(rootfs.getParentFile(), rootfs.getName() + STAGING_SUFFIX);
    }

    /** 换下来的旧目录：{@code <rootfs>.old-<时间戳>}。 */
    public static File retiredDir(File rootfs, long stamp) {
        return new File(rootfs.getParentFile(), rootfs.getName() + RETIRED_PREFIX + stamp);
    }

    /**
     * 骨架是否可用：bash、debian 版本文件、动态加载器、node 四样都在就算好。
     *
     * <p>这四样是「能跑起来」的最低要求：缺 bash 起不了容器，缺 loader/node 进不去业务程序。
     */
    public static boolean isReady(File rootfs) {
        if (rootfs == null || !rootfs.isDirectory()) return false;
        return new File(rootfs, "usr/bin/bash").isFile()
                && new File(rootfs, "etc/debian_version").isFile()
                && new File(rootfs, "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1").isFile()
                && new File(rootfs, "usr/local/bin/node").exists();
    }

    /**
     * 把已经解包好的 {@code staged} 换到 {@code rootfs} 位置。
     *
     * @return true = 替换成功；false = 前置条件不满足（staged 不可用 / 改名失败），此时**旧目录保持原样**
     */
    public static boolean promote(File staged, File rootfs, long stamp) {
        if (!isReady(staged)) return false;
        try {
            if (rootfs.exists()) {
                File retired = retiredDir(rootfs, stamp);
                Files.move(rootfs.toPath(), retired.toPath(), StandardCopyOption.ATOMIC_MOVE);
            }
            Files.move(staged.toPath(), rootfs.toPath(), StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** 换下来之后如果新骨架其实不可用，把旧的换回去（尽力而为，不抛）。 */
    public static boolean rollback(File rootfs, long stamp) {
        File retired = retiredDir(rootfs, stamp);
        if (!retired.isDirectory()) return false;
        try {
            File broken = new File(rootfs.getParentFile(), rootfs.getName() + ".broken-" + stamp);
            if (rootfs.exists()) Files.move(rootfs.toPath(), broken.toPath(), StandardCopyOption.ATOMIC_MOVE);
            Files.move(retired.toPath(), rootfs.toPath(), StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }
}
