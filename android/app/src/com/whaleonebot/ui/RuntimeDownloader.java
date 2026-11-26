package com.whaleonebot.ui;

import android.app.Activity;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.SSLException;

/**
 * 内置运行端的<b>真实</b>下载器（无第三方库，只用 {@link HttpURLConnection}）。
 *
 * <p><b>落盘</b>：{@code getFilesDir()/runtimes/<version>/runtime.zip}，先写 {@code runtime.zip.part}，
 * 字节数与哈希全部通过后才改名成正式文件名 —— 半截文件永远不会被当成「已就绪」。
 *
 * <p><b>三条硬保证</b>（对应产品规格 §3 ②「不能静默失败」与 UI 合同 §5-T3）：
 * <ol>
 *   <li><b>不静默失败</b>：任何异常都落到 {@link Listener#onError(String)} 并带原因；
 *       连接 15 秒 / 读 20 秒没有进展就放弃，所以进度条不会停在中间一动不动。</li>
 *   <li><b>不假装进度</b>：进度只来自实际写入磁盘的字节数。总量未知时 {@code total} 传 -1，
 *       页面据此隐藏百分比（宁可只显示已下载字节，也不编一个百分比）。</li>
 *   <li><b>校验</b>：收到的字节数必须与清单声明（或服务器 Content-Length）一致；
 *       清单给了 sha256 就边下边算，不一致 → 删掉文件 + onError。</li>
 * </ol>
 *
 * <p><b>重试</b>：本类<b>不做</b>自动重试 —— 静默重试会把「其实一直失败」藏起来。每次
 * {@link #start()} 记一次尝试，{@link #attempts()} 对外可见（页面显示「第 N 次尝试」），
 * 用户点「重试」就是再调一次 {@code start()}。
 *
 * <p><b>线程</b>：下载在工作线程；回调统一切回主线程（{@link Activity#runOnUiThread}），
 * 页面可以直接改 View。终态回调（done / error / cancelled）保证<b>只会有一个</b>。
 */
final class RuntimeDownloader {

    /** 下载回调。{@code total <= 0} 表示总量未知（页面不要显示百分比）。 */
    interface Listener {
        void onProgress(long bytes, long total, long bytesPerSec);

        void onDone(File file);

        void onError(String message);

        /** 取消成功。契约里列举的三个之外补这一个：取消不是失败，界面不该显示成红色错误。 */
        void onCancelled();
    }

    /** 正式文件名。 */
    static final String FILE_NAME = "runtime.zip";
    private static final String PART_NAME = FILE_NAME + ".part";

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 20000;
    private static final int BUF = 64 * 1024;
    /** 进度回调节流：最快 200ms 一次，避免每读一块就发一条消息把主线程淹掉。 */
    private static final long EMIT_INTERVAL_MS = 200;

    private final Activity activity;
    private final RuntimeCatalog.Entry entry;
    private final Listener listener;
    private final File dir;
    private final File target;
    private final File part;

    /** 终态只允许派发一次。 */
    private final AtomicBoolean terminal = new AtomicBoolean(false);
    private volatile boolean cancelled;
    private volatile HttpURLConnection conn;
    private volatile Thread worker;
    private volatile int attempts;
    private volatile long startedAt;

    RuntimeDownloader(Activity activity, RuntimeCatalog.Entry entry, Listener listener) {
        if (activity == null || entry == null) throw new IllegalArgumentException("activity/entry 不能为空");
        this.activity = activity;
        this.entry = entry;
        this.listener = listener;
        this.dir = RuntimeCatalog.dirFor(activity, entry);
        this.target = new File(dir, FILE_NAME);
        this.part = new File(dir, PART_NAME);
    }

    // ---------------------------------------------------------------- 状态查询

    /** 最终应该出现的文件（'runtimes/&lt;版本&gt;/runtime.zip'）。 */
    File targetFile() {
        return target;
    }

    RuntimeCatalog.Entry entry() {
        return entry;
    }

    /** 工作线程是否还活着。 */
    boolean running() {
        Thread w = worker;
        return w != null && w.isAlive();
    }

    /** 已经发起过几次下载（含正在跑的这一轮）。 */
    int attempts() {
        return attempts;
    }

    /** 已经落下一个可用文件了吗（只核对大小，不做哈希 —— 哈希在下载流程里校验）。 */
    boolean hasCompletedFile() {
        if (!target.isFile()) return false;
        return !entry.hasBytes() || target.length() == entry.bytes;
    }

    // ---------------------------------------------------------------- 开始 / 取消

    /**
     * 开始一次下载。同一时刻只跑一轮：上一轮还在收尾时直说，不悄悄并发写同一个文件。
     */
    void start() {
        if (running()) {
            dispatchError("上一次下载还在收尾，稍等一秒再试");
            return;
        }
        if (!entry.hasSource()) {
            // 没源就明说，不发请求、不编进度
            dispatchError("下载源未配置：RuntimeCatalog 里的地址是空的，也没有 runtime 偏好项");
            return;
        }
        terminal.set(false);
        cancelled = false;
        conn = null;
        attempts = attempts + 1;
        startedAt = System.currentTimeMillis();
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                runOnce();
            }
        }, "runtime-download");
        th.setDaemon(true);
        worker = th;
        th.start();
    }

    /**
     * 取消。只有一次：置标志 + 断开连接把阻塞中的 read 踹醒。
     *
     * <p>为什么这里不直接回调：取消之后还要关流、删掉半截文件，等工作线程收尾完再发
     * {@link Listener#onCancelled()}，页面收到时磁盘已经是干净的。
     */
    void cancel() {
        if (terminal.get()) return;
        cancelled = true;
        HttpURLConnection c = conn;
        if (c != null) {
            try {
                c.disconnect();
            } catch (Throwable ignored) {
                // 断开本身失败无所谓，工作线程还会被 read 超时兜住
            }
        }
        if (!running()) {
            // 没有在跑的线程（例如还没 start 就取消）：立刻给一个可见的终态，不留空转
            dispatchCancelled();
        }
    }

    // ---------------------------------------------------------------- 工作线程

    /**
     * 一轮下载。先做传输，再统一收尾，<b>最后</b>才派发终态 ——
     * 这样页面收到「失败 / 已取消」时，临时文件已经清掉了，重试不会踩到脏文件。
     */
    private void runOnce() {
        boolean ok = false;
        boolean wasCancelled = false;
        String error = null;
        try {
            transfer();
            ok = true;
        } catch (CancelledException ce) {
            wasCancelled = true;
        } catch (Throwable t) {
            error = describe(t);
        } finally {
            HttpURLConnection c = conn;
            conn = null;
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                    // 收尾动作，失败无影响
                }
            }
            if (worker == Thread.currentThread()) worker = null;
            if (!ok) deleteQuietly(part);
        }

        if (ok) {
            // 已经校验通过并落成正式文件：即使这之后才收到 cancel()，也按「成功」上报 ——
            // 文件是真实可用的，删掉它只是因为用户恰好离开了页面，那是浪费。
            dispatchDone(target);
        } else if (wasCancelled || cancelled) {
            dispatchCancelled();
        } else {
            dispatchError(error == null || error.length() == 0 ? "下载失败（原因未知）" : error);
        }
    }

    /** 真正的传输：按 MirrorFetch 候选源依次尝试 → 校验响应 → 边下边算哈希 → 校验 → 改名。 */
    private void transfer() throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("无法创建运行端目录：" + dir.getAbsolutePath());
        }
        java.util.List<String> candidates = com.whaleonebot.net.MirrorFetch.candidateUrls(entry.url);
        if (candidates.isEmpty()) candidates.add(entry.url);
        IOException last = null;
        for (int i = 0; i < candidates.size(); i++) {
            checkCancelled();
            String candidateUrl = candidates.get(i);
            boolean isOfficial = candidateUrl.equals(entry.url);
            if (part.isFile() && !part.delete()) {
                throw new IOException("删不掉旧的临时文件：" + part.getAbsolutePath());
            }
            try {
                transferSingle(candidateUrl, isOfficial);
                if (isOfficial) com.whaleonebot.net.MirrorFetch.recordSuccessPrefix("");
                else com.whaleonebot.net.MirrorFetch.recordSuccessPrefix(
                        com.whaleonebot.net.MirrorFetch.sourcePrefixOf(candidateUrl, entry.url));
                return;
            } catch (CancelledException ce) {
                throw ce;
            } catch (IOException ex) {
                if (isOfficial) com.whaleonebot.net.MirrorFetch.markOfficialFailed();
                last = ex;
                deleteQuietly(part);
            }
        }
        throw last != null ? last : new IOException("所有下载源均失败");
    }

    private void transferSingle(String targetUrl, boolean isOfficial) throws IOException {
        URL url = new URL(targetUrl);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        conn = c;
        c.setConnectTimeout(isOfficial
                ? com.whaleonebot.net.MirrorFetch.OFFICIAL_CONNECT_TIMEOUT_MS
                : CONNECT_TIMEOUT_MS);
        c.setReadTimeout(READ_TIMEOUT_MS);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        // 关键：不要 gzip。压缩后到手的字节数既不是文件大小、sha256 也对不上。
        c.setRequestProperty("Accept-Encoding", "identity");
        c.connect();
        checkCancelled();

        int code = c.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) {
            throw new IOException("服务器返回 HTTP " + code
                    + (code == 404 ? "（地址上找不到这个文件）" : "")
                    + "，地址 " + targetUrl);
        }

        long total = entry.hasBytes() ? entry.bytes : -1L;
        long remoteLen = c.getContentLengthLong();
        if (remoteLen > 0) {
            if (entry.hasBytes() && entry.bytes != remoteLen) {
                throw new IOException("远端体积与清单不一致：清单 " + entry.bytes
                        + " 字节，远端 " + remoteLen + " 字节");
            }
            total = remoteLen;
        }

        MessageDigest md = null;
        if (entry.hasSha256()) {
            try {
                md = MessageDigest.getInstance("SHA-256");
            } catch (Throwable t) {
                throw new IOException("本机没有可用的 SHA-256 实现，无法校验下载内容");
            }
        }

        InputStream in = new BufferedInputStream(c.getInputStream(), BUF);
        OutputStream out = new FileOutputStream(part);
        long bytes = 0;
        try {
            byte[] buf = new byte[BUF];
            long lastEmit = System.currentTimeMillis();
            long lastBytes = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                checkCancelled();
                out.write(buf, 0, n);
                if (md != null) md.update(buf, 0, n);
                bytes += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit >= EMIT_INTERVAL_MS) {
                    long dt = Math.max(1L, now - lastEmit);
                    emitProgress(bytes, total, (bytes - lastBytes) * 1000L / dt);
                    lastEmit = now;
                    lastBytes = bytes;
                }
            }
            out.flush();
        } finally {
            closeQuietly(out);
            closeQuietly(in);
        }

        checkCancelled();
        // 收尾必须再发一次进度：否则界面会停在 97% 这种位置（看起来就是卡住了）
        long cost = Math.max(1L, System.currentTimeMillis() - startedAt);
        emitProgress(bytes, total, bytes * 1000L / cost);

        if (total > 0 && bytes != total) {
            throw new IOException("下载不完整：收到 " + bytes + " 字节，应为 " + total + " 字节");
        }
        if (entry.hasBytes() && bytes != entry.bytes) {
            throw new IOException("字节数校验失败：收到 " + bytes + " 字节，清单声明 " + entry.bytes + " 字节");
        }
        if (md != null) {
            String got = hex(md.digest());
            String want = RuntimeCatalog.Entry.normalizeSha256(entry.sha256);
            if (!got.equals(want)) {
                throw new IOException("sha256 校验不通过：收到 " + shortHash(got)
                        + "，清单 " + shortHash(want) + "（文件已丢弃）");
            }
        }

        // 校验全过了才落成正式文件名
        if (target.isFile() && !target.delete()) {
            throw new IOException("同名旧文件删不掉：" + target.getAbsolutePath());
        }
        if (!part.renameTo(target)) {
            throw new IOException("落盘失败：临时文件改名不成功（" + target.getAbsolutePath() + "）");
        }
    }

    private void checkCancelled() throws CancelledException {
        if (cancelled) throw new CancelledException();
    }

    // ---------------------------------------------------------------- 回调派发

    private void emitProgress(final long bytes, final long total, final long speed) {
        if (cancelled || terminal.get()) return;
        post(new Runnable() {
            @Override
            public void run() {
                listener.onProgress(bytes, total, speed);
            }
        });
    }

    private void dispatchDone(final File file) {
        if (!terminal.compareAndSet(false, true)) return;
        post(new Runnable() {
            @Override
            public void run() {
                listener.onDone(file);
            }
        });
    }

    private void dispatchError(final String message) {
        if (!terminal.compareAndSet(false, true)) return;
        post(new Runnable() {
            @Override
            public void run() {
                listener.onError(message);
            }
        });
    }

    private void dispatchCancelled() {
        if (!terminal.compareAndSet(false, true)) return;
        post(new Runnable() {
            @Override
            public void run() {
                listener.onCancelled();
            }
        });
    }

    /** 一律切回主线程；Activity 已经在关闭就不再往上抛（页面也用不着那些回调了）。 */
    private void post(Runnable r) {
        try {
            if (activity.isFinishing() || activity.isDestroyed()) return;
            activity.runOnUiThread(r);
        } catch (Throwable ignored) {
            // 宿主正在销毁：回调丢掉即可，磁盘状态本来就是干净的
        }
    }

    // ---------------------------------------------------------------- 错误文案

    /** 把异常翻成用户能看懂、能据此行动的一句话（不静默、不糊成「未知错误」）。 */
    private String describe(Throwable t) {
        if (t instanceof CancelledException) return "已取消";
        if (t instanceof SocketTimeoutException) {
            return "连接超时（" + (CONNECT_TIMEOUT_MS / 1000) + " 秒连不上 / "
                    + (READ_TIMEOUT_MS / 1000) + " 秒收不到数据），请检查网络后重试";
        }
        if (t instanceof UnknownHostException) {
            return "找不到下载地址的主机（域名解析失败）：" + safe(t.getMessage());
        }
        if (t instanceof ConnectException) {
            return "连不上下载服务器：" + safe(t.getMessage());
        }
        if (t instanceof SSLException) {
            return "HTTPS 握手或证书有问题：" + safe(t.getMessage());
        }
        if (t instanceof IOException) {
            String m = t.getMessage();
            return m == null || m.length() == 0
                    ? ("网络读写出错（" + t.getClass().getSimpleName() + "）")
                    : m;
        }
        String m = t.getMessage();
        return "下载中断（" + t.getClass().getSimpleName()
                + (m == null || m.length() == 0 ? "" : "：" + m) + "）";
    }

    private static String safe(String s) {
        return s == null || s.length() == 0 ? "没有更多信息" : s;
    }

    private static String hex(byte[] raw) {
        StringBuilder sb = new StringBuilder(raw.length * 2);
        for (int i = 0; i < raw.length; i++) {
            int v = raw[i] & 0xFF;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    private static String shortHash(String h) {
        if (h == null || h.length() == 0) return "（空）";
        return h.length() <= 12 ? h : h.substring(0, 12) + "…";
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Throwable ignored) {
            // 关闭失败不影响已经写下的字节
        }
    }

    private static void deleteQuietly(File f) {
        if (f == null) return;
        try {
            if (f.isFile()) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        } catch (Throwable ignored) {
            // 删不掉就留着，下次 start() 会再试一次
        }
    }

    /** 内部信号：用户取消。用异常跳出读循环，好让 finally 统一收尾。 */
    private static final class CancelledException extends IOException {
        CancelledException() {
            super("cancelled");
        }
    }
}
