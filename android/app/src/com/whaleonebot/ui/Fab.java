package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.view.View;
import android.view.ViewOutlineProvider;

/**
 * 圆形悬浮按钮。背景是信号色的径向渐变（左上偏亮一点，像个球），
 * 圆形 outline 同时供 elevation 阴影使用 —— 所以它真的浮在卡片之上。
 */
final class Fab extends View {

    private final Theme theme;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private Shader shader;
    private int shaderW;
    private int shaderH;

    Fab(Context c, Theme theme) {
        super(c);
        this.theme = theme;
        setClickable(true);
        setFocusable(true);
        Ui.elevate(this, 5f, theme);
        setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View v, Outline o) {
                if (v.getWidth() <= 0 || v.getHeight() <= 0) return;
                o.setOval(0, 0, v.getWidth(), v.getHeight());
            }
        });
        setClipToOutline(false);
        Ui.press(this, 0.93f);
    }

    @Override
    protected void onDraw(Canvas cv) {
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;

        if (shader == null || shaderW != w || shaderH != h) {
            shaderW = w;
            shaderH = h;
            float r = Math.min(w, h) * 0.5f;
            shader = new RadialGradient(w * 0.34f, h * 0.26f, r * 1.45f,
                    new int[]{Ui.mix(theme.accent, 0xFFFFFFFF, 0.28f), theme.accent},
                    null, Shader.TileMode.CLAMP);
        }

        paint.setShader(shader);
        cv.drawCircle(w * 0.5f, h * 0.5f, Math.min(w, h) * 0.5f, paint);

        if (isPressed()) {
            paint.setShader(null);
            paint.setColor(0x33FFFFFF);
            cv.drawCircle(w * 0.5f, h * 0.5f, Math.min(w, h) * 0.5f, paint);
        }

        paint.setShader(null);
        IconView.draw(cv, IconView.TUNE, Math.min(w, h) * 0.46f,
                w * 0.5f, h * 0.5f, theme.onAccent, 2.0f);
    }
}
