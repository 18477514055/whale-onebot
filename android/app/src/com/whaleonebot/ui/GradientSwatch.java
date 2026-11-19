package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Shader;
import android.view.View;

/** 主题色卡：把一套主题的渐变原样画成一小块圆角，用户点之前就看得见结果。 */
final class GradientSwatch extends View {

    private final int c0;
    private final int c1;
    private final int c2;
    private final float radius;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private Shader shader;

    GradientSwatch(Context c, Theme t, float radiusPx) {
        super(c);
        this.c0 = t.g0;
        this.c1 = t.g1;
        this.c2 = t.g2;
        this.radius = radiusPx;
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldW, int oldH) {
        super.onSizeChanged(w, h, oldW, oldH);
        shader = null;
    }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;
        if (shader == null) {
            shader = new LinearGradient(0f, 0f, w, h,
                    new int[]{c0, c1, c2}, new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP);
        }
        paint.setShader(shader);
        cv.drawRoundRect(0f, 0f, w, h, radius, radius, paint);
        paint.setShader(null);
    }
}
