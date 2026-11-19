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

    static LinearLayout.LayoutParams llp(int w, int h, int l, int tp, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, h);
        lp.leftMargin = l;
        lp.topMargin = tp;
        lp.rightMargin = r;
        lp.bottomMargin = b;
        return lp;
    }
}
