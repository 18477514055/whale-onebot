package com.whaleonebot.ui;

import com.whaleonebot.ContainerService;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 真正把 QQ 客户端装进容器（用户 2026-11-24 反馈：「装好之后退出又显示没装好」）。
 *
 * <p>★ 之前的缺陷：install() 只把 deb 暂存到 app 私有目录（qq-packages/），从没解包到 rootfs/opt/QQ。
 * 于是首页三步卡第 2 步永远打不了勾（SetupState 认的是 rootfs/opt/QQ/resources/app/wrapper.node），
 * 用户在文件管理器里也看不到包（它在 app 私有目录）—— 看起来就像「装了又被卸掉」。
 *
 * <p>现在：从 deb 里流式抽出 data.tar.xz 到 rootfs/tmp/，在**容器内**用系统 tar 解包
 * （容器是 Debian，实测 tar 1.34 + xz 都在），校验 wrapper.node 存在才算装好；
 * 已经装过就不覆盖（保护正在用的客户端与登录态），只报出已装版本。
 */
final class QqClientInstaller {

    interface Progress { void onProgress(String stage); }

    static final class Result {
        boolean ok;
        boolean already;
        String version = "";
        String detail = "";
    }

    private QqClientInstaller() { }

    /**
     * 把 deb 里的 <code>opt/QQ</code> 装进 rootfs。
     *
     * <p>★ 2026-11-24 真机事故（必须记住）：以前这段是**在容器里**跑 {@code tar -xJf / rm -rf / cp -a}，
     * 而内置环境包（whale-environment，892 条目）里 <b>只有 bash / sh / env / sleep / node</b> ——
     * 没有 coreutils、没有 tar、没有 xz。于是真机报 <code>/bin/bash: line 1: rm: command not found</code>。
     * 老 rootfs 是完整 Debian 骨架，所以历史上一直没暴露。
     *
     * <p>现在改成<b>纯宿主侧</b>：用 APK 自带的 {@code files/bin/busybox}（Android 二进制，自带
     * xz/tar/cp/rm/mkdir/chmod/ln）解包并拷进 rootfs。好处有两条：不依赖容器在跑、不依赖 rootfs 里有什么命令。
     * busybox 是动态链接的，必须给 LD_LIBRARY_PATH（同目录的 libbusybox.so.1.38.0）。
     */
    /** 宿主侧按需释放 busybox 及依赖库，避免新用户未起容器直接装 QQ 时报缺 busybox。 */
    static void ensureBusybox(android.content.Context ctx) {
        if (ctx == null) return;
        File bin = new File(ctx.getFilesDir(), "bin");
        if (!bin.isDirectory() && !bin.mkdirs()) return;
        String[] assets = { "busybox", "libbusybox.so.1.38.0", "libandroid-selinux.so", "libpcre2-8.so" };
        for (String name : assets) {
            File dest = new File(bin, name);
            if (dest.isFile() && dest.length() > 0) continue;
            try (InputStream in = ctx.getAssets().open(name);
                 FileOutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                if ("busybox".equals(name)) dest.setExecutable(true, false);
            } catch (Throwable e) {
                android.util.Log.w("WhaleEnv", "释放 " + name + " 失败", e);
            }
        }
    }

    static Result install(File files, File deb, Progress p) throws IOException {
        Result r = new Result();
        File rootfs = resolveRootfs(files);
        if (rootfs == null) {
            throw new IOException("找不到可用的运行环境（rootfs）：先在环境配置页把内置核心/环境包装好");
        }
        File bb = new File(files, "bin/busybox");
        if (!bb.isFile()) {
            throw new IOException("缺少 busybox（先启动一次容器，它会在内核里释放运行时）");
        }
        String bbPath = bb.getAbsolutePath();
        String libPath = new File(files, "bin").getAbsolutePath();

        File tmp = new File(files, "tmp");
        if (!tmp.isDirectory() && !tmp.mkdirs()) throw new IOException("无法创建临时目录");
        File dataXz = new File(tmp, "qq-data.tar.xz");
        File dataTar = new File(tmp, "qq-data.tar");
        File stage = new File(tmp, "qq-x");

        try {
            if (p != null) p.onProgress("正在解开安装包…");
            String member = extractDataMember(deb, dataXz);

            File target = new File(rootfs, "opt/QQ");
            if (new File(target, "resources/app/wrapper.node").isFile()) {
                r.ok = true;
                r.already = true;
                r.version = readVersion(new File(target, "resources/app/package.json"));
                r.detail = "容器里已经有客户端" + (r.version.isEmpty() ? "" : " " + r.version) + "，没有覆盖";
                return r;
            }

            if (p != null) p.onProgress("正在装进容器（约 1.2 GB，要一会儿）…");
            // 根据实际成员后缀分别走 gzip 或 xz，避免直接跑 xz -dc 导致 gzip deb 崩溃
            if ("data.tar.gz".equals(member) || (member != null && member.endsWith(".gz"))) {
                runShell(bbPath, libPath, bbPath + " gzip -dc '" + dataXz.getAbsolutePath() + "' > '" + dataTar.getAbsolutePath() + "'");
            } else {
                runShell(bbPath, libPath, bbPath + " xz -dc '" + dataXz.getAbsolutePath() + "' > '" + dataTar.getAbsolutePath() + "'");
            }

            run(bbPath, libPath, null, "rm", "-rf", stage.getAbsolutePath());
            run(bbPath, libPath, null, "mkdir", "-p", stage.getAbsolutePath());
            run(bbPath, libPath, null, "tar", "-xf", dataTar.getAbsolutePath(), "-C", stage.getAbsolutePath());

            File staged = new File(stage, "opt/QQ");
            if (!new File(staged, "resources/app/wrapper.node").isFile()) {
                r.detail = "解包没成功：包里没有 opt/QQ/resources/app/wrapper.node";
                return r;
            }

            File optDir = new File(rootfs, "opt");
            if (!optDir.isDirectory() && !optDir.mkdirs()) throw new IOException("无法创建容器内的 /opt");
            run(bbPath, libPath, null, "rm", "-rf", target.getAbsolutePath());
            run(bbPath, libPath, null, "cp", "-a", staged.getAbsolutePath(), optDir.getAbsolutePath() + "/");

            if (!new File(target, "resources/app/wrapper.node").isFile()) {
                r.detail = "解包没成功：拷进 rootfs 后仍找不到 wrapper.node";
                return r;
            }
            r.ok = true;
            r.version = readVersion(new File(target, "resources/app/package.json"));
            r.detail = "已装好客户端" + (r.version.isEmpty() ? "" : " " + r.version);
            return r;
        } finally {
            cleanup(dataXz, dataTar, stage);
        }
    }

    private static void cleanup(File... paths) {
        for (File f : paths) {
            if (f == null || !f.exists()) continue;
            try {
                if (f.isDirectory()) {
                    File[] kids = f.listFiles();
                    if (kids != null) for (File k : kids) cleanup(k);
                }
                f.delete();
            } catch (RuntimeException ignored) { }
        }
    }

    /** busybox 走 applet 名字调用（argv[0] = busybox，argv[1] = applet）。 */
    private static void run(String bbPath, String libPath, File unused, String... args) throws IOException {
        String[] cmd = new String[args.length + 1];
        cmd[0] = bbPath;
        System.arraycopy(args, 0, cmd, 1, args.length);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().put("LD_LIBRARY_PATH", libPath);
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        StringBuilder out = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (out.length() < 2000) out.append(line).append('\n');
            }
        }
        try {
            int code = proc.waitFor();
            if (code != 0) throw new IOException("busybox " + args[0] + " 失败（exit " + code + "）: " + out.toString().trim());
        } catch (InterruptedException e) {
            proc.destroy();
            Thread.currentThread().interrupt();
            throw new IOException("被中断");
        }
    }

    /** 需要重定向的那几条（xz -dc > file）只能借宿主 sh，但只用内置的 '>'，不依赖任何 coreutils。 */
    private static void runShell(String bbPath, String libPath, String command) throws IOException {
        ProcessBuilder pb = new ProcessBuilder("/system/bin/sh", "-c", command);
        pb.environment().put("LD_LIBRARY_PATH", libPath);
        pb.redirectErrorStream(true);
        Process proc = pb.start();
        StringBuilder out = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (out.length() < 2000) out.append(line).append('\n');
            }
        }
        try {
            int code = proc.waitFor();
            if (code != 0) throw new IOException("解压执行失败（exit " + code + "）: " + out.toString().trim());
        } catch (InterruptedException e) {
            proc.destroy();
            Thread.currentThread().interrupt();
            throw new IOException("被中断");
        }
    }

    /**
     * 找"真正能用的 rootfs"：优先 files/rootfs，其次受管布局 files/core-environments/<sha>/rootfs。
     * ★ 2026-11-24：以前只认 files/rootfs/bin/bash —— 而受管布局里环境包解在 core-environments 下，
     *   于是「明明装了核心和环境包」的用户会被判成"容器还没准备好"（用户实测反馈）。
     */
    /** 已解出来的 QQ 客户端版本；没装（或只有 rootfs 没客户端）返回 null。 */
    static String clientVersion(File files) {
        File root = resolveRootfs(files);
        if (root == null) return null;
        if (!new File(root, "opt/QQ/resources/app/wrapper.node").isFile()) return null;
        return readVersion(new File(root, "opt/QQ/resources/app/package.json"));
    }

    /**
     * 这个目录能不能当容器骨架用。
     *
     * <p>★ 2026-11-24 真机事故：只用 {@link RootfsLayout#isReady} 会把**环境包铺出来的** rootfs 判成不可用 ——
     * 两代布局不是同一套文件：
     * <pre>
     *   RootfsLayout.isReady（换骨架那套）：usr/bin/bash · etc/debian_version · usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1 · usr/local/bin/node
     *   ManagedEnvironment.prepare 校验的那套：bin/bash · usr/bin/env · usr/bin/node
     * </pre>
     * 于是「内置环境包已铺成 rootfs」日志打了、环境配置页也写「容器：已就绪」，但装 QQ 仍然报
     * 「找不到可用的运行环境（rootfs）」—— 判据互相不认。这里两种布局都认。
     */
    static boolean usable(File root) {
        if (root == null || !root.isDirectory()) return false;
        if (RootfsLayout.isReady(root)) return true;
        // ★ 实测（2026-11-24，环境包 892 条目）：whale-environment **没有** etc/debian_version，
        //   loader 也在 lib/aarch64-linux-gnu/ 而不是 usr/lib/... ⇒ 早期两套判据都不认它，
        //   于是"环境已铺好、容器也能起"却一直报"找不到 rootfs"。只认真正必需的三样。
        boolean shell = new File(root, "bin/bash").isFile() || new File(root, "usr/bin/bash").isFile();
        boolean env = new File(root, "usr/bin/env").isFile();
        boolean node = new File(root, "usr/bin/node").isFile() || new File(root, "usr/local/bin/node").exists();
        return shell && env && node;
    }

    static File resolveRootfs(File files) {
        File direct = new File(files, "rootfs");
        if (usable(direct)) return direct;
        File envs = new File(files, "core-environments");
        File[] dirs = envs.listFiles();
        if (dirs == null) return null;
        File best = null;
        long bestAt = -1;
        for (File dir : dirs) {
            File candidate = new File(dir, "rootfs");
            if (!usable(candidate)) continue;
            long at = new File(candidate, "opt/QQ/resources/app/wrapper.node").isFile() ? Long.MAX_VALUE : candidate.lastModified();
            if (at > bestAt) { bestAt = at; best = candidate; }
        }
        return best;
    }

    /** 从客户端的 package.json 里读版本（形如 3.2.32-52194）；读不到返回空串。 */
    private static String readVersion(File pkg) {
        if (!pkg.isFile()) return "";
        try (InputStream in = new FileInputStream(pkg)) {
            byte[] buf = new byte[4096];
            int n = in.read(buf);
            if (n <= 0) return "";
            String text = new String(buf, 0, n, StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("\"version\"\\s*:\\s*\"([^\"]+)\"").matcher(text);
            return m.find() ? m.group(1) : "";
        } catch (Throwable e) {
            return "";
        }
    }

    /** 从 Debian 包里把 data.tar.* 流式抽出来（不执行维护脚本、不解析成员语义）。返回成员名。 */
    private static String extractDataMember(File deb, File out) throws IOException {
        try (InputStream in = new BufferedInputStream(new FileInputStream(deb))) {
            byte[] magic = new byte[8];
            if (in.read(magic) != 8 || !"!<arch>\n".equals(new String(magic, StandardCharsets.US_ASCII))) {
                throw new IOException("不是 Debian 包");
            }
            byte[] hdr = new byte[60];
            for (int i = 0; i < 3; i++) {
                int got = 0;
                while (got < 60) {
                    int n = in.read(hdr, got, 60 - got);
                    if (n < 0) throw new IOException("安装包不完整");
                    got += n;
                }
                String h = new String(hdr, StandardCharsets.US_ASCII);
                String name = h.substring(0, 16).trim().replaceFirst("/$", "");
                String sizeText = h.substring(48, 58).trim();
                if (!h.endsWith("`\n") || !sizeText.matches("[0-9]{1,10}")) throw new IOException("安装包头损坏");
                long size = Long.parseLong(sizeText);
                if (name.startsWith("data.tar")) {
                    copy(in, out, size);
                    return name;
                }
                skip(in, size + (size & 1));
            }
            throw new IOException("包里没有 data.tar");
        }
    }

    private static void copy(InputStream in, File out, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        long left = size;
        try (FileOutputStream os = new FileOutputStream(out)) {
            while (left > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (n <= 0) throw new IOException("安装包被截断");
                os.write(buf, 0, n);
                left -= n;
            }
        }
    }

    private static void skip(InputStream in, long n) throws IOException {
        byte[] buf = new byte[8192];
        long left = n;
        while (left > 0) {
            int got = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (got <= 0) throw new IOException("安装包被截断");
            left -= got;
        }
    }
}
