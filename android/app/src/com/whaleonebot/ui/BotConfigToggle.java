package com.whaleonebot.ui;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;

/**
 * 开关。按 Material 的比例自己画：轨道 46×28dp、滑块 22dp，开启时滑块滑到右边。
 *
 * <p>不用 {@code android.widget.Switch} 的原因和整个工程一致 —— 系统控件的灰底、主题色、
 * 拇指阴影都不受我们那套令牌控制，在渐变背景上会立刻「串味」。
 */
final class BotConfigToggle extends FrameLayout {

    interface OnChange {
        void onChanged(boolean on);
    }

    private static final int TRACK_W = 46;
    private static final int TRACK_H = 28;
    private static final int THUMB = 22;

    private final Theme theme;
    private final View thumb;
    private boolean on;

    BotConfigToggle(Context c, Theme t, boolean on, final OnChange cb) {
        super(c);
        this.theme = t;
        this.on = on;

        setLayoutParams(new FrameLayout.LayoutParams(Ui.dp(c, TRACK_W), Ui.dp(c, TRACK_H)));
        setClickable(true);
        setFocusable(true);
        setClipChildren(false);
        setClipToPadding(false);
        paintTrack();

        thumb = new View(c);
        // 滑块用令牌里的「纸白」：和二维码纸同一个色，六套主题下都够亮、够圆润。
        thumb.setBackground(Drawables.circle(t.qrPaper, 0, 0));
        thumb.setElevation(Ui.dp(c, 2));
        int margin = Ui.dp(c, (TRACK_H - THUMB) / 2f);
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(
                Ui.dp(c, THUMB), Ui.dp(c, THUMB), Gravity.START | Gravity.CENTER_VERTICAL);
        tlp.leftMargin = margin;
        addView(thumb, tlp);

        thumb.setTranslationX(on ? Ui.dp(c, TRACK_W - THUMB - (TRACK_H - THUMB)) : 0f);

        setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View v) {
                setOn(!BotConfigToggle.this.on, true);
                if (cb != null) cb.onChanged(BotConfigToggle.this.on);
            }
        });
    }

    private void paintTrack() {
        int fill = on ? theme.accent : Ui.alpha(theme.textPrimary, theme.dark ? 0.18f : 0.14f);
        setBackground(Drawables.round(fill, 0, 0, Ui.dp(getContext(), TRACK_H / 2f)));
    }

    /** {@code animated = false} 用于首帧同步，避免整页重建时滑块从左边飞过来。 */
    void setOn(boolean next, boolean animated) {
        if (on == next && animated) return;
        on = next;
        paintTrack();
        float to = next ? Ui.dp(getContext(), TRACK_W - THUMB - (TRACK_H - THUMB)) : 0f;
        thumb.animate().cancel();
        if (animated) {
            thumb.animate().translationX(to).setDuration(140).start();
        } else {
            thumb.setTranslationX(to);
        }
    }

    boolean isOn() {
        return on;
    }
}
