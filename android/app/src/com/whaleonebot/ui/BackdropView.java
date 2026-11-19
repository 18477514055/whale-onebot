package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;

/**
 * 背景层：整个 App 的最底层，切页时**不重建**，只换主题。
 *
 * <p>默认画三档斜向渐变 + 两团极淡的信号色光晕（像暮色里的雾）；
 * 用户选了本地图片就改画图片，并在上面压一层主题相关的压暗层，
 * 保证玻璃卡片和文字在任何一张照片上都还读得清。
 */
final class BackdropView extends View {

    private final ThemeStore store;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Rect src = new Rect();
    private final Rect dst = new Rect();
    private final RectF full = new RectF();

    private Theme theme;

    private Shader base;
    private Shader glowA;
    private Shader glowB;
    private Shader scrim;

    private Bitmap image;
    private boolean imageTried;

    BackdropView(Context c, ThemeStore store, Theme theme) {
        super(c);
        this.store = store;
        this.theme = theme;
        setLayerType(View.LAYER_TYPE_NONE, null);
    }

    void applyTheme(Theme t) {
        if (t == theme) {
            invalidate();
            return;
        }
        theme = t;
        rebuild();
        invalidate();
    }

    /** 自定义背景被换掉/清掉后调用，丢掉缓存图重解一次。 */
    void invalidateBackground() {
        image = null;
        imageTried = false;
        invalidate();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldW, int oldH) {
        super.onSizeChanged(w, h, oldW, oldH);
        rebuild();
    }

    private void rebuild() {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;

        base = new LinearGradient(0f, 0f, w, h,
                new int[]{theme.g0, theme.g1, theme.g2},
                new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP);

        // 两团光晕：深色主题用信号色微微发亮；浅色主题必须用白光 ——
        // 浅底上用深色 accent 做光晕会变成一片脏灰（实测过，整屏发灰）。
        int glow1 = theme.dark ? Ui.alpha(theme.accent, 0.12f) : 0x2EFFFFFF;
        int glow2 = theme.dark ? Ui.alpha(theme.accent, 0.08f) : 0x1FFFFFFF;
        float r1 = Math.max(w, h) * 0.72f;
        glowA = new RadialGradient(w * 0.82f, h * 0.10f, r1,
                new int[]{glow1, 0x00000000}, null, Shader.TileMode.CLAMP);
        float r2 = Math.max(w, h) * 0.60f;
        glowB = new RadialGradient(w * 0.08f, h * 0.92f, r2,
                new int[]{glow2, 0x00000000}, null, Shader.TileMode.CLAMP);

        scrim = new LinearGradient(0f, 0f, 0f, h,
                new int[]{theme.scrimTop, theme.scrimBottom},
                new float[]{0f, 1f}, Shader.TileMode.CLAMP);

        // 尺寸变了，缓存图要按新尺寸重新降采样解一次
        image = null;
        imageTried = false;
    }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;
        if (base == null) rebuild();
        if (base == null) return;

        if (store.hasCustomBg()) {
            if (!imageTried) {
                imageTried = true;
                image = store.loadBackground(w, h);
            }
            if (image != null) {
                drawImageCover(cv, w, h);
                paint.setShader(scrim);
                full.set(0f, 0f, w, h);
                cv.drawRect(full, paint);
                return;
            }
        }

        paint.setShader(base);
        full.set(0f, 0f, w, h);
        cv.drawRect(full, paint);

        paint.setShader(glowA);
        cv.drawRect(full, paint);

        paint.setShader(glowB);
        cv.drawRect(full, paint);

        paint.setShader(null);
    }

    /** 按 cover 语义裁剪居中，绝不拉伸变形。 */
    private void drawImageCover(Canvas cv, int w, int h) {
        int iw = image.getWidth();
        int ih = image.getHeight();
        if (iw <= 0 || ih <= 0) return;

        float scale = Math.max((float) w / iw, (float) h / ih);
        int cw = Math.min(iw, Math.round(w / scale));
        int ch = Math.min(ih, Math.round(h / scale));
        int left = (iw - cw) / 2;
        int top = (ih - ch) / 2;
        src.set(left, top, left + cw, top + ch);
        dst.set(0, 0, w, h);
        cv.drawBitmap(image, src, dst, paint);
        paint.setShader(null);
    }
}
