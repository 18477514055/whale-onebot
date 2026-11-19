package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/**
 * 代码画的图标。工程里没有 res/ 也没有 aapt -S，连一个 drawable 都拿不到，
 * 所以整套图标（平台标识、箭头、勾选、二维码占位）都在 24×24 的虚拟网格里用 Path 描出来。
 *
 * <p>描边宽度以「24 网格」为单位传入：视图放大缩小时线宽跟着同比例走，
 * 所以同一个图标在 22dp 和 26dp 上看起来粗细一致（约 2dp）。
 */
final class IconView extends View {

    static final int CHAT = 1;      // QQ：气泡 + 两点
    static final int MUSIC = 2;     // 抖音：音符
    static final int TV = 3;        // bilibili：小电视
    static final int BOX = 4;       // 小黑盒：盒子
    static final int TUNE = 5;      // 设置：三条推子
    static final int CHEV_L = 6;
    static final int CHEV_R = 7;
    static final int CHECK = 8;
    static final int IMAGE = 9;     // 选图
    static final int DOT = 10;      // 状态圆点
    static final int QR = 11;       // 二维码占位
    static final int PLAY = 12;     // 启动：播放三角

    private static final Paint S = new Paint(Paint.ANTI_ALIAS_FLAG);
    private static final Paint F = new Paint(Paint.ANTI_ALIAS_FLAG);
    private static final Path P = new Path();
    private static final RectF R = new RectF();

    private int kind;
    private int color;

    IconView(Context c, int kind, int color) {
        super(c);
        this.kind = kind;
        this.color = color;
    }

    void setColor(int c) {
        if (color != c) {
            color = c;
            invalidate();
        }
    }

    @Override
    protected void onDraw(Canvas cv) {
        float size = Math.min(getWidth(), getHeight());
        if (size <= 0) return;
        draw(cv, kind, size, getWidth() * 0.5f, getHeight() * 0.5f, color, 1.9f);
    }

    /**
     * 以 (cx,cy) 为中心画一个 size 见方的图标。FAB 也复用这个方法，不必再嵌一个 View。
     */
    static void draw(Canvas cv, int kind, float size, float cx, float cy, int color, float stroke) {
        if (size <= 0) return;
        float s = size / 24f;

        S.setColor(color);
        S.setStyle(Paint.Style.STROKE);
        S.setStrokeWidth(stroke);
        S.setStrokeCap(Paint.Cap.ROUND);
        S.setStrokeJoin(Paint.Join.ROUND);
        F.setColor(color);
        F.setStyle(Paint.Style.FILL);

        int save = cv.save();
        cv.translate(cx - 12f * s, cy - 12f * s);
        cv.scale(s, s);

        P.reset();
        switch (kind) {
            case CHAT:
                cv.drawRoundRect(3.5f, 4.5f, 20.5f, 16.5f, 5f, 5f, S);
                P.moveTo(8.5f, 16.5f);
                P.lineTo(7.5f, 21f);
                P.lineTo(13.5f, 16.5f);
                cv.drawPath(P, S);
                cv.drawCircle(9.5f, 10.5f, 1.35f, F);
                cv.drawCircle(14.5f, 10.5f, 1.35f, F);
                break;

            case MUSIC:
                cv.drawLine(14.5f, 4.5f, 14.5f, 15.5f, S);
                P.moveTo(14.5f, 4.5f);
                P.quadTo(18.2f, 5.2f, 19.2f, 9f);
                cv.drawPath(P, S);
                cv.drawCircle(11f, 16f, 3.4f, F);
                break;

            case TV:
                cv.drawRoundRect(2.5f, 7.5f, 21.5f, 19f, 4.5f, 4.5f, S);
                cv.drawLine(7.5f, 3.5f, 11f, 7.5f, S);
                cv.drawLine(16.5f, 3.5f, 13f, 7.5f, S);
                cv.drawCircle(9f, 13f, 1.35f, F);
                cv.drawCircle(15f, 13f, 1.35f, F);
                break;

            case BOX:
                cv.drawRoundRect(3.5f, 5f, 20.5f, 20f, 4.5f, 4.5f, S);
                cv.drawLine(3.5f, 10.5f, 20.5f, 10.5f, S);
                cv.drawRoundRect(9.6f, 8.4f, 14.4f, 12.6f, 1.6f, 1.6f, F);
                break;

            case TUNE:
                cv.drawLine(3f, 6.5f, 21f, 6.5f, S);
                cv.drawLine(3f, 12f, 21f, 12f, S);
                cv.drawLine(3f, 17.5f, 21f, 17.5f, S);
                cv.drawCircle(8.5f, 6.5f, 2.5f, F);
                cv.drawCircle(15.5f, 12f, 2.5f, F);
                cv.drawCircle(9.5f, 17.5f, 2.5f, F);
                break;

            case CHEV_L:
                P.moveTo(15f, 4.5f);
                P.lineTo(8.5f, 12f);
                P.lineTo(15f, 19.5f);
                cv.drawPath(P, S);
                break;

            case CHEV_R:
                P.moveTo(9f, 4.5f);
                P.lineTo(15.5f, 12f);
                P.lineTo(9f, 19.5f);
                cv.drawPath(P, S);
                break;

            case CHECK:
                P.moveTo(4.5f, 12.5f);
                P.lineTo(9.5f, 17.5f);
                P.lineTo(19.5f, 6.5f);
                cv.drawPath(P, S);
                break;

            case IMAGE:
                cv.drawRoundRect(2.5f, 4.5f, 21.5f, 19.5f, 3.5f, 3.5f, S);
                cv.drawCircle(8.2f, 9.4f, 1.5f, F);
                P.moveTo(5f, 17.5f);
                P.lineTo(10f, 12f);
                P.lineTo(13.5f, 15.5f);
                P.lineTo(16.5f, 12.5f);
                P.lineTo(20f, 17.5f);
                cv.drawPath(P, S);
                break;

            case DOT:
                cv.drawCircle(12f, 12f, 4.2f, F);
                break;

            case PLAY:
                // 播放三角：略微右移 0.5 让视觉重心落在正中（几何中心偏左会显得飘）
                P.moveTo(9f, 5.5f);
                P.lineTo(19.5f, 12f);
                P.lineTo(9f, 18.5f);
                P.close();
                cv.drawPath(P, F);
                break;

            case QR:
                R.set(3f, 3f, 10f, 10f);
                cv.drawRoundRect(R, 2f, 2f, S);
                R.set(14f, 3f, 21f, 10f);
                cv.drawRoundRect(R, 2f, 2f, S);
                R.set(3f, 14f, 10f, 21f);
                cv.drawRoundRect(R, 2f, 2f, S);
                cv.drawCircle(16.5f, 15.5f, 1.2f, F);
                cv.drawCircle(20f, 19f, 1.2f, F);
                cv.drawLine(13.5f, 20.5f, 20.5f, 20.5f, S);
                break;

            default:
                break;
        }
        cv.restoreToCount(save);
    }
}
