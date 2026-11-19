package com.whaleonebot.ui;

import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;

/**
 * 代码画的圆角图形。工程里没有 res 目录，也没有 aapt -S，
 * 所以所有圆角、描边、按下态只能这样造出来。
 */
final class Drawables {

    private Drawables() {
    }

    /** 圆角矩形：填充 + 可选描边。radiusPx 传 Theme.R_PILL 就退化成胶囊。 */
    static GradientDrawable round(int fill, int strokeColor, int strokePx, int radiusPx) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(fill);
        d.setCornerRadius(radiusPx);
        if (strokePx > 0 && (strokeColor >>> 24) != 0) {
            d.setStroke(strokePx, strokeColor);
        }
        return d;
    }

    /** 默认 + 按下 两态。禁用态交给 Ui.enabled() 用整体透明度处理，不额外造一层。 */
    static StateListDrawable stateful(Drawable normal, Drawable pressed) {
        StateListDrawable d = new StateListDrawable();
        d.addState(new int[]{android.R.attr.state_pressed}, pressed);
        d.addState(new int[]{}, normal);
        return d;
    }

    /** 空心圆（返回按钮的底、FAB 的底）。 */
    static GradientDrawable circle(int fill, int strokeColor, int strokePx) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(fill);
        if (strokePx > 0 && (strokeColor >>> 24) != 0) {
            d.setStroke(strokePx, strokeColor);
        }
        return d;
    }
}
