package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 内置机器人运行端下载页（产品规格 §3 ②「内置机器人」：点它之后要显示进度条）。
 *
 * <p>页面只做三件事：<b>说清要下什么</b>（版本 / 体积 / 校验方式）、<b>如实显示进度</b>
 * （百分比 + 已下载 / 总量 + 速度）、<b>失败了给出原因并能重试</b>。
 *
 * <p><b>诚实原则</b>（比好看重要）：
 * <ul>
 *   <li>没有下载源就显示「下载源未配置」并把按钮置灰，不发请求、不编百分比；</li>
 *   <li>进度只来自 {@link RuntimeDownloader} 回传的真实字节数；总量未知时只显示已下载字节，隐藏百分比；</li>
 *   <li>失败、取消、超时都有明确可见的状态，绝不把进度条停在中间不动。</li>
 * </ul>
 *
 * <p><b>进出</b>：由 T1 的 {@code AppShell.pushRuntimeDownload(botId)} → {@link AppShell#P_RUNTIMEDL} 进入；
 * 机器人 id 从 {@link AppShell#currentBotId()} 取（页面不自己造 id）。下载成功后把版本号写进该机器人的
 * {@code runtimeRef}，toast「运行端已就绪」，然后 {@link AppShell#pushBotList()} —— 机器人列表是新建流程的
 * 上一层，这样返回键不会一次跳过它。离开本页（返回键或页内取消）一律停掉下载。
 *
 * <p>动效：本页<b>不写</b>任何入场动画，换页动效只有 {@link Motion} 一处。
 */
final class RuntimeDownloadScreen extends Screen {

    // ---------------------------------------------------------------- 页面状态

    /** 没有下载源：不下载，按钮置灰。 */
    private static final int ST_UNSOURCED = 0;
    /** 有源、还没开始（返回本页后，或取消之后）。 */
    private static final int ST_IDLE = 1;
    /** 正在下载。 */
    private static final int ST_RUNNING = 2;
    /** 正在取消（等工作线程收尾）。 */
    private static final int ST_CANCELLING = 3;
    /** 失败了：显示原因 + 重试。 */
    private static final int ST_FAILED = 4;
    /** 目录里已经有可用的运行端。 */
    private static final int ST_PRESENT = 5;
    /** 本轮刚下完（马上要跳走，通常看不到）。 */
    private static final int ST_DONE = 6;

    /**
     * 兜底看门狗：这么多秒一个字节都没动，就认定卡住并中断。
     * 下载器自己已有 15s/20s 超时，这里是第二道保险（两条都不会让进度条僵在那儿）。
     */
    private static final long STALL_MS = 60000L;

    /**
     * 本进程内已经自动开过下载的 (机器人 + 版本)。返回本页时不该再悄悄重下一次 ——
     * 用户没点，就不动网络；这也避免「失败 → 返回 → 又自动开始」的死循环观感。
     */
    private static final java.util.HashSet<String> AUTO_STARTED = new java.util.HashSet<String>();

    private boolean built;
    private int state = ST_UNSOURCED;
    private String botId;
    private String lastError;
    private long lastCallbackAt;

    private RuntimeCatalog.Entry entry;
    private RuntimeDownloader downloader;

    // 视图（build 之后才非空）
    private TextView statusTitle;
    private TextView percentText;
    private TextView byteText;
    private TextView speedText;
    private TextView noticeText;
    private TextView primaryBtn;
    private TextView ghostBtn;
    private Bar bar;

    RuntimeDownloadScreen(AppShell shell) {
        super(shell);
    }

    // ================================================================ 骨架

    @Override
    void build() {
        if (built) {
            // 被重建（换主题）：旧下载先停掉，别让两个线程抢同一个文件
            if (downloader != null) downloader.cancel();
            root.removeAllViews();
        }
        built = true;
        state = ST_UNSOURCED;
        lastError = null;

        botId = shell.currentBotId();
        entry = RuntimeCatalog.latest(activity);
        downloader = new RuntimeDownloader(activity, entry, listener);

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("内置机器人运行端"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView lead = Ui.text(activity,
                "内置机器人要先下载运行端才能启动。下载完会自动记到这个机器人名下，不用再点保存。",
                Theme.T_CAP, t.textTertiary);
        lead.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams leadLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        leadLp.topMargin = dp(Theme.S1);
        col.addView(lead, leadLp);

        col.addView(infoCard(), margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(progressCard(), margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        primaryBtn = Ui.button(activity, t, "开始下载", true);
        primaryBtn.setVisibility(View.GONE);
        primaryBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (state == ST_FAILED || state == ST_IDLE) {
                    startDownload();
                } else if (state == ST_PRESENT || state == ST_DONE) {
                    finishWithReady();
                }
            }
        });
        col.addView(primaryBtn, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        ghostBtn = Ui.button(activity, t, "取消下载", false);
        ghostBtn.setVisibility(View.GONE);
        ghostBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (state == ST_RUNNING) {
                    cancelDownload();
                } else if (state == ST_PRESENT) {
                    // 已有文件还想再下一遍：明确是用户主动要求，不是偷偷重下
                    startDownload();
                }
            }
        });
        col.addView(ghostBtn, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        TextView foot = Ui.text(activity,
                "下载内容会先落到临时文件，字节数与清单核对、清单给了 sha256 再核对一次哈希，"
                        + "全部通过才算就绪；中途失败或取消都不会留下半截文件。",
                Theme.T_CAP, t.textTertiary);
        foot.setLineSpacing(dp(3), 1f);
        col.addView(foot, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        // 初始状态：有源且文件已存在 → 已存在；否则第一次进入自动开始下载
        if (!entry.hasSource()) {
            setState(ST_UNSOURCED, "下载源未配置");
        } else if (downloader.hasCompletedFile()) {
            setState(ST_PRESENT, "运行端已存在");
            showNotice(true, "目录里已经有这个版本（" + RuntimeCatalog.formatBytes(
                    downloader.targetFile().length()) + "），点完成直接记到机器人名下", false);
        } else {
            final String key = (botId == null ? "" : botId) + "|" + entry.version;
            final boolean first = AUTO_STARTED.add(key);
            // 等这一页真的挂进容器再开始：既保证回调时页面还在，也不会在 build 里做导航
            root.post(new Runnable() {
                @Override
                public void run() {
                    if (!alive()) return;
                    if (first) {
                        startDownload();
                    } else {
                        setState(ST_IDLE, "还没开始");
                        showNotice(false, "", false);
                    }
                }
            });
        }
    }

    private FrameLayout infoCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2));

        BotRegistry.Bot bot = BotRegistry.get(botId);
        String botName = bot != null ? bot.name
                : (botId == null || botId.length() == 0 ? "未指定" : botId);

        box.addView(infoRow("机器人", botName), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        box.addView(infoRow("版本", entry.version),
                margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        box.addView(infoRow("体积", entry.sizeText()),
                margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        box.addView(infoRow("校验", entry.verifyText()),
                margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        box.addView(infoRow("来源", entry.sourceText()),
                margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        TextView pathLabel = Ui.text(activity, "保存位置", Theme.T_CAP, t.textTertiary);
        box.addView(pathLabel, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView path = Ui.mono(activity, Theme.T_MONO, t.textTertiary);
        path.setText(downloader.targetFile().getAbsolutePath());
        path.setSingleLine(true);
        path.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        box.addView(path, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    private FrameLayout progressCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2));

        LinearLayout head = Ui.row(activity);
        statusTitle = Ui.strong(activity, "准备下载", Theme.T_CARD, t.textPrimary);
        LinearLayout.LayoutParams slp = Ui.llp(0, WRAP_CONTENT);
        slp.weight = 1f;
        slp.rightMargin = dp(Theme.S1);
        head.addView(statusTitle, slp);

        percentText = Ui.strong(activity, "0%", Theme.T_CARD, t.accent);
        percentText.setVisibility(View.GONE);
        head.addView(percentText, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        box.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 自绘圆角进度条：轨道 = t.ghostFill，填充 = t.accent（不新造颜色）
        bar = new Bar(activity, t.ghostFill, t.accent);
        bar.setVisibility(View.GONE);
        box.addView(bar, margin(Ui.llp(MATCH_PARENT, dp(10)), dp(Theme.S2)));

        byteText = Ui.text(activity, "—", Theme.T_CAP, t.textSecondary);
        box.addView(byteText, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        speedText = Ui.text(activity, "", Theme.T_CAP, t.textTertiary);
        speedText.setLineSpacing(dp(3), 1f);
        box.addView(speedText, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        // 失败原因 / 取消说明共用这一块：不许把错误藏在日志里
        noticeText = Ui.text(activity, "", Theme.T_BODY, t.textPrimary);
        noticeText.setLineSpacing(dp(4), 1f);
        noticeText.setVisibility(View.GONE);
        box.addView(noticeText, margin(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    /** 一行「标签 —— 值」：值靠右，长了就省略，不撑破卡片。 */
    private View infoRow(String label, String value) {
        LinearLayout row = Ui.row(activity);
        row.addView(Ui.text(activity, label, Theme.T_CAP, t.textSecondary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        TextView v = Ui.text(activity, value, Theme.T_CAP, t.textPrimary);
        v.setSingleLine(true);
        v.setEllipsize(TextUtils.TruncateAt.END);
        v.setGravity(Gravity.END);
        LinearLayout.LayoutParams vlp = Ui.llp(0, WRAP_CONTENT);
        vlp.weight = 1f;
        vlp.leftMargin = dp(Theme.S2);
        row.addView(v, vlp);
        return row;
    }

    private LinearLayout.LayoutParams margin(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }

    // ================================================================ 下载

    /** 开始（或重试）一次下载。进度从 0 起是真的 0，不是假的重置。 */
    private void startDownload() {
        if (!entry.hasSource()) {
            setState(ST_UNSOURCED, "下载源未配置");
            return;
        }
        lastError = null;
        showNotice(false, "", false);
        downloader.start();
        lastCallbackAt = System.currentTimeMillis();
        // 条子从真正的 0 重新开始（不是把旧进度留在那儿）
        if (bar != null) bar.setFraction(0f);
        setState(ST_RUNNING, downloader.attempts() > 1
                ? ("正在下载 · 第 " + downloader.attempts() + " 次尝试")
                : "正在下载");
        byteText.setText(entry.hasBytes()
                ? ("0 B / " + RuntimeCatalog.formatBytes(entry.bytes))
                : "0 B");
        speedText.setText("正在连接下载源…");
    }

    private void cancelDownload() {
        downloader.cancel();
        setState(ST_CANCELLING, "正在取消…");
        speedText.setText("正在断开连接并清理临时文件…");
        showNotice(false, "", false);
    }

    private void applyProgress(long bytes, long total, long speed) {
        if (state != ST_RUNNING) return; // 迟到的进度不许覆盖终态
        lastCallbackAt = System.currentTimeMillis();

        boolean known = total > 0;
        if (known) {
            float p = (float) ((double) bytes / (double) total);
            if (p < 0f) p = 0f;
            if (p > 1f) p = 1f;
            bar.setVisibility(View.VISIBLE);
            bar.setFraction(p);
            percentText.setVisibility(View.VISIBLE);
            percentText.setText(Math.round(p * 100f) + "%");
        } else {
            // 总量不知道就不显示百分比，也不让条子在那里假装走动
            bar.setVisibility(View.GONE);
            percentText.setVisibility(View.GONE);
        }

        byteText.setText(known
                ? (RuntimeCatalog.formatBytes(bytes) + " / " + RuntimeCatalog.formatBytes(total))
                : ("已下载 " + RuntimeCatalog.formatBytes(bytes) + " · 总量未声明"));
        speedText.setText(speed > 0
                ? ("速度 " + RuntimeCatalog.formatBytes(speed) + "/s")
                : "速度 计算中…");
    }

    /** 运行端就绪：写进该机器人的 {@code runtimeRef}，再回机器人列表。 */
    private void finishWithReady() {
        BotRegistry.Bot bot = BotRegistry.get(botId);
        if (bot == null) {
            host().toast("运行端已就绪，但没找到这个机器人");
        } else {
            bot.runtimeRef = entry.version;
            if (BotRegistry.update(bot)) {
                host().toast("运行端已就绪");
            } else {
                // 文件是真的，只是没写进注册表 —— 说清后果，别让用户以为白下了
                host().toast("运行端已就绪，但记录失败（下次进这里还能看到已下载）");
            }
        }
        // popTo：下载页自己从栈上退掉，别在列表之上再压一个重复的 BotList
        // （否则 [.., BotList, RuntimeDL, BotList]，用户返回会落在已完成的下载页）。
        shell.popTo(AppShell.P_BOTLIST);
    }

    // ================================================================ 回调

    private final RuntimeDownloader.Listener listener = new RuntimeDownloader.Listener() {
        @Override
        public void onProgress(long bytes, long total, long bytesPerSec) {
            if (!alive()) return;
            applyProgress(bytes, total, bytesPerSec);
        }

        @Override
        public void onDone(File file) {
            if (!alive()) return;
            lastCallbackAt = System.currentTimeMillis();
            setState(ST_DONE, "已就绪");
            byteText.setText("已下载 " + RuntimeCatalog.formatBytes(file.length()));
            speedText.setText("校验通过");
            showNotice(false, "", false);
            finishWithReady();
        }

        @Override
        public void onError(String message) {
            if (!alive()) return;
            lastError = message;
            lastCallbackAt = System.currentTimeMillis();
            setState(ST_FAILED, "下载失败");
            showNotice(true, lastError, true);
        }

        @Override
        public void onCancelled() {
            if (!alive()) return;
            // 看门狗已经判过超时的话，别把「超时」改写成「已取消」
            if (state == ST_FAILED) return;
            lastCallbackAt = System.currentTimeMillis();
            setState(ST_IDLE, "已取消");
            byteText.setText("—");
            speedText.setText("临时文件已清理，可以重新下载");
            showNotice(true, "已取消，没有留下半截文件", false);
        }
    };

    // ================================================================ 状态渲染

    private void setState(int next, String title) {
        state = next;
        if (statusTitle != null) statusTitle.setText(title);

        switch (next) {
            case ST_UNSOURCED:
                showPrimary("开始下载", false);
                hideGhost();
                showBar(false);
                if (byteText != null) byteText.setText("未配置下载源");
                if (speedText != null) speedText.setText(
                        "地址写在 RuntimeCatalog 的 BUILTIN_URL；也可以用 runtime 偏好项临时指定（改完重启 App）");
                break;

            case ST_IDLE:
                showPrimary("开始下载", true);
                hideGhost();
                showBar(false);
                break;

            case ST_RUNNING:
                hidePrimary();
                showGhost("取消下载", true);
                // 条子的可见性由进度决定（总量未知时隐藏）
                break;

            case ST_CANCELLING:
                hidePrimary();
                showGhost("正在取消…", false);
                break;

            case ST_FAILED:
                showPrimary("重试", true);
                hideGhost();
                showBar(false);
                if (byteText != null) byteText.setText("下载没有完成");
                if (speedText != null) speedText.setText("可以重试；也可以返回，稍后再来");
                break;

            case ST_PRESENT:
                showPrimary("完成", true);
                showGhost("重新下载", true);
                showBar(false);
                if (byteText != null) byteText.setText("已下载 "
                        + RuntimeCatalog.formatBytes(downloader.targetFile().length()));
                if (speedText != null) speedText.setText("不用再下一次，点完成即可");
                break;

            case ST_DONE:
                showPrimary("已就绪", false);
                hideGhost();
                showBar(false);
                break;

            default:
                break;
        }
    }

    private void showPrimary(String label, boolean enabled) {
        if (primaryBtn == null) return;
        primaryBtn.setVisibility(View.VISIBLE);
        if (label != null) primaryBtn.setText(label);
        Ui.enabled(primaryBtn, enabled);
    }

    private void hidePrimary() {
        if (primaryBtn != null) primaryBtn.setVisibility(View.GONE);
    }

    private void showGhost(String label, boolean enabled) {
        if (ghostBtn == null) return;
        ghostBtn.setVisibility(View.VISIBLE);
        ghostBtn.setText(label);
        Ui.enabled(ghostBtn, enabled);
    }

    private void hideGhost() {
        if (ghostBtn != null) ghostBtn.setVisibility(View.GONE);
    }

    private void showBar(boolean on) {
        if (bar != null) bar.setVisibility(on ? View.VISIBLE : View.GONE);
        if (percentText != null) percentText.setVisibility(on ? View.VISIBLE : View.GONE);
    }

    /** 错误摘要 / 取消说明。{@code emphasize} 为真时用正文主色（唯一没有红令牌，就不新造颜色）。 */
    private void showNotice(boolean on, String text, boolean emphasize) {
        if (noticeText == null) return;
        noticeText.setVisibility(on ? View.VISIBLE : View.GONE);
        noticeText.setTextColor(emphasize ? t.textPrimary : t.textSecondary);
        noticeText.setText(text == null ? "" : text);
    }

    // ================================================================ 生命周期

    /**
     * 这一页还在容器里吗。页面被换掉之后（返回、换主题）回调一律不再碰 View；
     * 顺手把还在跑的下载停掉 —— 离开页面就该停止下载。
     */
    private boolean alive() {
        boolean attached = root.getParent() != null && root.isAttachedToWindow();
        if (!attached) {
            if (downloader != null && state == ST_RUNNING) downloader.cancel();
            return false;
        }
        return true;
    }

    /**
     * 返回键：先停下载再让 AppShell 正常出栈（返回 false = 本页不消费这次返回）。
     */
    @Override
    boolean handleBack() {
        if (downloader != null) downloader.cancel();
        return false;
    }

    /**
     * 看门狗：下载器的 15s/20s 超时是第一道保险，这里是第二道 ——
     * 万一回调真的断了，也要把界面推进到「超时」并允许重试，绝不让进度条僵在那儿。
     */
    @Override
    void refresh() {
        if (state != ST_RUNNING) return;
        if (System.currentTimeMillis() - lastCallbackAt <= STALL_MS) return;
        downloader.cancel();
        lastError = "等了 " + (STALL_MS / 1000) + " 秒没有任何进展，已中断（可能是网络断了）";
        setState(ST_FAILED, "下载超时");
        showNotice(true, lastError, true);
    }

    // ================================================================ 自绘进度条

    /**
     * 圆角进度条。只画两种颜色，都来自主题令牌（轨道 ghostFill、填充 accent），
     * 进度值只由真实字节数驱动，没有任何自走的动画。
     */
    private static final class Bar extends View {

        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF rect = new RectF();
        private final int trackColor;
        private final int fillColor;
        private float fraction;

        Bar(Context c, int trackColor, int fillColor) {
            super(c);
            this.trackColor = trackColor;
            this.fillColor = fillColor;
        }

        void setFraction(float f) {
            if (f < 0f) f = 0f;
            if (f > 1f) f = 1f;
            if (Math.abs(f - fraction) < 0.0005f) return; // 没变就不重绘
            fraction = f;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas cv) {
            float w = getWidth();
            float h = getHeight();
            if (w <= 0f || h <= 0f) return;
            float r = h / 2f;

            paint.setStyle(Paint.Style.FILL);
            paint.setColor(trackColor);
            rect.set(0f, 0f, w, h);
            cv.drawRoundRect(rect, r, r, paint);

            float fw = w * fraction;
            if (fw > 0.5f) {
                // 圆角跟着实际宽度收：刚开始的一小截也还是一颗小胶囊，不会被画成大圆饼
                float cr = Math.min(r, fw / 2f);
                rect.set(0f, 0f, fw, h);
                paint.setColor(fillColor);
                cv.drawRoundRect(rect, cr, cr, paint);
            }
        }
    }
}
