package com.whaleonebot.ui;

import java.io.File;

/**
 * APK 里自带的那一份运行环境（{@code assets/bundled/environment.bin}）→ {@code files/rootfs}。
 *
 * <p>★ 2026-11-24 为什么要有它：「新装的包上面没有 rootfs」是用户反复卡住的那一步
 * （装 QQ 报「找不到可用的运行环境」、启容器没反应）。环境包已经打进 APK 了，
 * 就不该再要求用户先去下载一次。凡是要用到容器的入口（启动容器 / 安装 QQ）先调这里，
 * 已就绪则一个字节都不动。
 *
 * <p>资产用中性名 {@code environment.bin}：aapt 会「理解」{@code .tar.gz} 后缀并把内容解压，
 * 那样交给 {@code ManagedEnvironment.prepare} 的就不是原始 gzip 字节（实测报 Not in GZIP format）。
 * 而 prepare 内部自己套 GZIPInputStream ⇒ 这里必须原样拷字节，算的 sha256 就是它要校验的那份。
 */
public final class BundledEnvironment {

    private BundledEnvironment() {}

    /** 主线程调用会被 IO 卡住 —— 调用方自己放到后台线程。 */
    public static boolean ensure(android.content.Context ctx) {
        File files = ctx.getFilesDir();
        // ★ 进门先留一条日志：这一段以前"静默什么都不做"，导致真机上完全看不出它有没有被调用。
        // 同时把内置的 core.zip 预埋进 core-release-cache，避免新建核心时重复联网下载
        seedAssetToCache(ctx, files, "bundled/core.zip");

        // ★ 2026-11-25 主力机事故：这里原先用 QqClientInstaller.resolveRootfs(files) 判断「已就绪」，
        //   而那个方法会扫 files/core-environments/*/rootfs。于是「装过核心」的机器会出现
        //   「ensure 说环境就绪（返回 true）、ContainerService 却按 files/rootfs 起容器」⇒
        //   proot 报 `/bin/bash not found (root = files/rootfs)`、LOGIN exit rc=1，
        //   用户看到的就是「点启动容器什么都不发生」。判据必须与容器实际使用的路径一致：只认 files/rootfs。
        File legacy = new File(files, "rootfs");
        boolean legacyReady = QqClientInstaller.usable(legacy);
        android.util.Log.i("WhaleEnv", "ensure: 容器用的 rootfs=" + legacy.getAbsolutePath() + " 可用=" + legacyReady);
        if (legacyReady) return true;

        // 目录存在但不可用（空骨架 / 上次铺到一半被打断）：ManagedEnvironment.prepare 见到已存在的
        // files/rootfs 会直接抛 "Existing environment preserved" 而拒绝覆盖 ⇒ 先挪到旁边留证再铺。
        File qqKeep = new File(files, "tmp/qq-client-keep");
        if (legacy.exists()) {
            // ★ 2026-11-25 用户问「为什么每次更新都要重新下载 QQ」：
            //   QQ 客户端是装在**环境目录里面**的（<rootfs>/opt/QQ），环境一旦整棵换掉它就跟没。
            //   同一分区内的 rename 是瞬时的、不复制那 1.2 GB，所以在挪走旧 rootfs 之前
            //   先把 opt/QQ 提到 tmp/qq-client-keep，铺完新环境再放回去 —— 环境换、客户端留。
            File oldQQ = new File(legacy, "opt/QQ");
            if (new File(oldQQ, "resources/app/wrapper.node").isFile()) {
                if (qqKeep.exists()) qqKeep.delete();
                if (oldQQ.renameTo(qqKeep)) {
                    android.util.Log.i("WhaleEnv", "ensure: 旧环境里的 QQ 客户端已暂存（铺完再放回，不用重装）");
                } else {
                    android.util.Log.w("WhaleEnv", "ensure: 旧 QQ 客户端暂存失败，铺完需要重新装 QQ");
                }
            }
            File aside = new File(files, "rootfs.broken-" + System.currentTimeMillis());
            if (legacy.renameTo(aside)) {
                android.util.Log.w("WhaleEnv", "ensure: 现有 rootfs 不可用，已挪到 " + aside.getName() + " 再重新铺");
            } else {
                android.util.Log.w("WhaleEnv", "ensure: 现有 rootfs 不可用且挪不动，放弃自动铺设");
                return false;
            }
        }

        File tmp = new File(files, "tmp");
        if (!tmp.isDirectory() && !tmp.mkdirs()) return false;
        File out = new File(tmp, "environment.tar.gz");

        android.util.Log.i("WhaleEnv", "ensure: 开始拷贝内置环境包 → " + out.getAbsolutePath());
        String sha;
        try (java.io.InputStream in = ctx.getAssets().open("bundled/environment.bin");
             java.io.FileOutputStream os = new java.io.FileOutputStream(out)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                md.update(buf, 0, n);
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            sha = hex.toString();
        } catch (Throwable e) {
            android.util.Log.w("WhaleEnv", "读内置环境包失败（不影响后续手动下载）", e);
            out.delete();
            return false;
        }

        try {
            com.whaleonebot.ManagedEnvironment.prepare(files, out, sha);
            android.util.Log.i("WhaleEnv", "内置环境包已铺成 rootfs，sha256=" + sha);
            seedFileToCache(files, out, sha);
            // 新环境就位：把暂存的 QQ 客户端放回容器根（同分区 rename，瞬时，不复制 1.2 GB）
            if (qqKeep.isDirectory()) {
                File opt = new File(legacy, "opt");
                if (!opt.isDirectory() && !opt.mkdirs()) {
                    android.util.Log.w("WhaleEnv", "ensure: 建不出新环境的 /opt，QQ 客户端需要重新装");
                } else if (qqKeep.renameTo(new File(opt, "QQ"))) {
                    android.util.Log.i("WhaleEnv", "ensure: QQ 客户端已放回新环境（这次不用重新下载/重装）");
                } else {
                    android.util.Log.w("WhaleEnv", "ensure: QQ 客户端放回失败，需要重新装 QQ");
                }
            }
            return QqClientInstaller.usable(legacy);
        } catch (Throwable e) {
            android.util.Log.w("WhaleEnv", "内置环境包铺开失败（可改用手动下载环境包）", e);
            return false;
        } finally {
            out.delete();
        }
    }

    /** 将 APK 内置资产按内容哈希（SHA-256）预埋进 core-release-cache，命中时免下载。 */
    private static void seedAssetToCache(android.content.Context ctx, File files, String assetPath) {
        File tmp = new File(files, "tmp");
        if (!tmp.isDirectory() && !tmp.mkdirs()) return;
        File stage = new File(tmp, "seed-" + Math.abs(assetPath.hashCode()) + ".tmp");
        try (java.io.InputStream in = ctx.getAssets().open(assetPath);
             java.io.FileOutputStream os = new java.io.FileOutputStream(stage)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                md.update(buf, 0, n);
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            seedFileToCache(files, stage, hex.toString());
        } catch (Throwable e) {
            android.util.Log.w("WhaleEnv", "预埋内置资产到缓存跳过: " + assetPath, e);
        } finally {
            stage.delete();
        }
    }

    private static void seedFileToCache(File files, File src, String sha) {
        if (src == null || !src.isFile() || sha == null || sha.length() != 64) return;
        File cacheDir = new File(files, "core-release-cache");
        if (!cacheDir.isDirectory() && !cacheDir.mkdirs()) return;
        File slot = new File(cacheDir, sha);
        if (slot.isFile() && slot.length() == src.length()) return;
        File tmpSlot = new File(cacheDir, sha + ".part");
        try (java.io.FileInputStream in = new java.io.FileInputStream(src);
             java.io.FileOutputStream out = new java.io.FileOutputStream(tmpSlot)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            if (!tmpSlot.renameTo(slot)) tmpSlot.delete();
            else android.util.Log.i("WhaleEnv", "已预埋内置资产至离线缓存: " + sha.substring(0, 12));
        } catch (Throwable e) {
            tmpSlot.delete();
        }
    }
}
