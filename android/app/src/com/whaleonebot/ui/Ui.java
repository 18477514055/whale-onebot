package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 组件原语。默认控件一律不用 —— Button 的灰底、TextView 的默认行距在渐变上都很难看，
 * 这里每次都用代码画出圆角背景 + 自定文字色 + 自定按下反馈。
 */
final class Ui {

    private Ui() {
    }

    // ------------------------------------------------------------ 尺寸换算

    static int dp(Context c, float v) {
        return (int) (v * c.getResources().getDisplayMetrics().density + 0.5f);
    }

    // ------------------------------------------------------------ 颜色工具

    /** 按通道线性插值，t=0 取 a，t=1 取 b（含 alpha 通道）。 */
    static int mix(int a, int b, float t) {
        float it = 1f - t;
        int aa = (a >>> 24) & 0xFF, ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
        int ba = (b >>> 24) & 0xFF, br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
        int oa = (int) (aa * it + ba * t + 0.5f);
        int or = (int) (ar * it + br * t + 0.5f);
        int og = (int) (ag * it + bg * t + 0.5f);
        int ob = (int) (ab * it + bb * t + 0.5f);
        return (oa << 24) | (or << 16) | (og << 8) | ob;
    }

    /** 保留 RGB，替换 alpha（0..1）。 */
    static int alpha(int color, float a) {
        int ai = (int) (a * 255f + 0.5f);
        if (ai < 0) ai = 0;
        if (ai > 255) ai = 255;
        return (ai << 24) | (color & 0x00FFFFFF);
    }

    /** 按下态：深色主题往白里提，浅色主题往黑里压。 */
    static int pressedOf(Theme t, int fill) {
        return mix(fill, t.dark ? 0xFFFFFFFF : 0xFF000000, 0.12f);
    }

    // ------------------------------------------------------------ 文本

    static TextView text(Context c, CharSequence s, int sizeSp, int color) {
        TextView v = new TextView(c);
        v.setText(s);
        v.setTextSize(sizeSp);
        v.setTextColor(color);
        v.setIncludeFontPadding(false);
        return v;
    }

    static TextView strong(Context c, CharSequence s, int sizeSp, int color) {
        TextView v = text(c, s, sizeSp, color);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    /** 等宽小字，日志专用。 */
    static TextView mono(Context c, int sizeSp, int color) {
        TextView v = new TextView(c);
        v.setTextSize(sizeSp);
        v.setTextColor(color);
        v.setTypeface(Typeface.MONOSPACE);
        v.setIncludeFontPadding(false);
        v.setLineSpacing(dp(c, 2), 1f);
        return v;
    }

    // ------------------------------------------------------------ 容器

    static LinearLayout column(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    /** 玻璃卡片：半透明填充 + 极淡描边 + 一点点 elevation，才有「浮在渐变之上」的感觉。 */
    static FrameLayout card(Context c, Theme t) {
        FrameLayout f = new FrameLayout(c);
        f.setBackground(Drawables.round(t.cardFill, t.cardStroke,
                dp(c, 1), dp(c, Theme.R_CARD)));
        elevate(f, 3f, t);
        f.setClipChildren(false);
        f.setClipToPadding(false);
        return f;
    }

    // ------------------------------------------------------------ 悬浮

    /**
     * 悬浮感的唯一来源。两个要点：
     * <ol>
     *   <li>elevation 很小（卡片 3dp / FAB 5dp），只够投出一圈很浅的边影；</li>
     *   <li><b>关掉环境光晕</b>（ambient shadow）—— 那圈均匀的灰雾就是「阴影很刻意」的元凶，
     *       深色渐变上尤其脏；只保留一点方向性投影，并染成主题压暗色，边缘干净。</li>
     * </ol>
     * ambient/spot 的着色是 API 28 的接口，minSdk 也是 28。
     */
    static void elevate(View v, float elevDp, Theme t) {
        v.setElevation(dp(v.getContext(), elevDp));
        if (elevDp <= 0f) return;
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            v.setOutlineAmbientShadowColor(0x00000000);
            v.setOutlineSpotShadowColor(t.shadowColor);
        }
    }

    // ------------------------------------------------------------ 按钮

    /**
     * 自绘按钮：primary = 信号色实心；否则 = 半透明描边。
     * 两态背景（常态 / 按下）保证按下 100ms 内就有视觉反馈。
     */
    static TextView button(Context c, Theme t, CharSequence label, boolean primary) {
        TextView v = new TextView(c);
        v.setText(label);
        v.setTextSize(Theme.T_BODY);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setLetterSpacing(0.03f);
        v.setGravity(Gravity.CENTER);
        v.setMinHeight(dp(c, Theme.TOUCH));
        v.setPadding(dp(c, Theme.S2), dp(c, 13), dp(c, Theme.S2), dp(c, 13));
        v.setClickable(true);
        v.setFocusable(true);

        int fill = primary ? t.accent : t.ghostFill;
        int strokeColor = primary ? 0 : t.ghostStroke;
        v.setTextColor(primary ? t.onAccent : t.ghostText);

        v.setBackground(Drawables.stateful(
                Drawables.round(fill, strokeColor, dp(c, 1), dp(c, Theme.R_BTN)),
                Drawables.round(pressedOf(t, fill), strokeColor, dp(c, 1), dp(c, Theme.R_BTN))));
        // 实心主按钮留 2dp 的浅影；描边按钮完全不投，靠填充与描边立住
        elevate(v, primary ? 2f : 0f, t);
        v.setStateListAnimator(null);
        press(v, 0.97f);
        return v;
    }

    /**
     * 轻微按下反馈（缩放）。最大 0.97，150ms 内回来 —— 只是「按到了」的确认，不做花活。
     */
    static void press(final View v, final float down) {
        v.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View view, MotionEvent e) {
                if (!view.isEnabled()) return false;
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        view.animate().scaleX(down).scaleY(down).setDuration(90).start();
                        break;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        view.animate().scaleX(1f).scaleY(1f).setDuration(150).start();
                        break;
                    default:
                        break;
                }
                return false;
            }
        });
    }

    /**
     * 启用/禁用 + 视觉同步。只在真的变化时才动，避免每秒 refresh 里反复触发重绘。
     */
    static void enabled(View v, boolean on) {
        if (v.isEnabled() == on) return;
        v.setEnabled(on);
        v.setAlpha(on ? 1f : 0.4f);
    }

    // ------------------------------------------------------------ 布局参数

    static LinearLayout.LayoutParams llp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    // ------------------------------------------------------------ 统一卡片、胶囊、分割线与格式原语
    // [layer: shell-android] 按 2026-11-25 问答报告（Q1/Q3/Q8/Q14）补齐外壳层通用视觉原语，
    // 复用现有 Theme 色盘与 Drawables，确保 6 套主题（含默认浅色晨纸）下卡片、胶囊、输入框与进度一致。

    static final int TONE_NEUTRAL = 0;
    static final int TONE_OK = 1;
    static final int TONE_WARN = 2;
    static final int TONE_DANGER = 3;

    /** 状态胶囊（浅描边 / 信号绿 / 暖黄 / 危险红）。 */
    static TextView pill(Context c, Theme t, CharSequence label, int tone) {
        int bg, stroke, fg;
        if (tone == TONE_OK) {
            bg = alpha(t.accent, t.dark ? 0.22f : 0.14f);
            stroke = alpha(t.accent, 0.45f);
            fg = t.dark ? t.accent : t.toneStrong;
        } else if (tone == TONE_WARN) {
            int amber = t.dark ? 0xFFF5B762 : 0xFFB45309;
            bg = alpha(amber, t.dark ? 0.20f : 0.12f);
            stroke = alpha(amber, 0.45f);
            fg = amber;
        } else if (tone == TONE_DANGER) {
            int red = t.dark ? 0xFFF87171 : 0xFFB91C1C;
            bg = alpha(red, t.dark ? 0.20f : 0.12f);
            stroke = alpha(red, 0.45f);
            fg = red;
        } else {
            bg = t.ghostFill;
            stroke = t.ghostStroke;
            fg = t.textSecondary;
        }
        TextView v = text(c, label, Theme.T_CAP, fg);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setLetterSpacing(0.02f);
        v.setPadding(dp(c, 9), dp(c, 4), dp(c, 9), dp(c, 4));
        v.setBackground(Drawables.round(bg, stroke, dp(c, 1), dp(c, Theme.R_PILL)));
        return v;
    }

    /** 1dp 卡内淡分割线。 */
    static View divider(Context c, Theme t) {
        View line = new View(c);
        int color = t.dark ? 0x22FFFFFF : 0x1A000000;
        line.setBackgroundColor(color);
        LinearLayout.LayoutParams lp = llp(MATCH_PARENT, Math.max(1, dp(c, 1)));
        lp.topMargin = dp(c, Theme.S2);
        lp.bottomMargin = dp(c, Theme.S2);
        line.setLayoutParams(lp);
        return line;
    }

    /** 创建标准圆角卡片并挂入父容器，返回内部带标准 S3 内边距的列容器。 */
    static LinearLayout addCard(LinearLayout parent, Context c, Theme t, int topMarginDp) {
        FrameLayout card = card(c, t);
        LinearLayout box = column(c);
        int p = dp(c, Theme.S3);
        box.setPadding(p, p, p, p);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams lp = llp(MATCH_PARENT, WRAP_CONTENT);
        if (topMarginDp > 0) lp.topMargin = dp(c, topMarginDp);
        parent.addView(card, lp);
        return box;
    }

    /** 统一输入框样式（圆角描边 + 主题字色 + 触控高度）。 */
    static void styleInput(android.widget.EditText e, Context c, Theme t) {
        e.setTextColor(t.textPrimary);
        e.setHintTextColor(t.textTertiary);
        e.setMinHeight(dp(c, Theme.TOUCH));
        int hp = dp(c, Theme.S2);
        e.setPadding(hp, dp(c, 10), hp, dp(c, 10));
        e.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(c, 1), dp(c, Theme.R_BTN)));
    }

    /** 字节数转人类可读单位（B / KB / MB / GB）。 */
    static String formatBytes(long bytes) {
        if (bytes < 0L) return "未知大小";
        if (bytes < 1024L) return bytes + " B";
        if (bytes < 1024L * 1024L) return String.format(java.util.Locale.ROOT, "%.1f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024L * 1024L) return String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1024.0 / 1024.0);
        return String.format(java.util.Locale.ROOT, "%.2f GB", bytes / 1024.0 / 1024.0 / 1024.0);
    }

    /** 进度格式化：12.4 MB / 51.2 MB（24%）。 */
    static String formatProgress(long done, long total) {
        if (total <= 0L) return done > 0L ? formatBytes(done) : "准备中…";
        int pct = (int) Math.min(100L, Math.max(0L, (done * 100L) / total));
        return formatBytes(done) + " / " + formatBytes(total) + "（" + pct + "%）";
    }

    /** 核心短 ID（去掉 core- 前缀并取前 8 位，避免 41 字符 UUID 撑爆屏幕）。 */
    static String coreShortId(String id) {
        if (id == null || id.isEmpty()) return "—";
        String s = id.startsWith("core-") ? id.substring(5) : id;
        int dash = s.indexOf('-');
        if (dash > 0 && dash <= 10) return s.substring(0, dash);
        return s.length() > 8 ? s.substring(0, 8) : s;
    }

    /** 友好核心展示标题：突出归属机器人名或「空闲核心」，不以 UUID 开头（问答报告 Q3）。 */
    static String coreDisplayTitle(CoreInventory.Instance c) {
        if (c == null) return "未知核心";
        if (c.ownerId == null || c.ownerId.isEmpty()) return "空闲核心";
        BotRegistry.Bot b = BotRegistry.get(c.ownerId);
        return b == null ? c.ownerId : b.name;
    }

    /** 友好核心副信息：类型 · 版本 · #短ID。 */
    static String coreMetaLine(CoreInventory.Instance c) {
        if (c == null) return "";
        String kind = "builtin".equals(c.kind) ? (c.legacy ? "沿用内置" : "内置核心") : "自定义核心";
        String ver = (c.version == null || c.version.isEmpty()) ? "未知版本" : c.version;
        return kind + " · " + ver + " · #" + coreShortId(c.id);
    }

    static LinearLayout.LayoutParams llp(int w, int h, int l, int tp, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, h);
        lp.leftMargin = l;
        lp.topMargin = tp;
        lp.rightMargin = r;
        lp.bottomMargin = b;
        return lp;
    }
}
