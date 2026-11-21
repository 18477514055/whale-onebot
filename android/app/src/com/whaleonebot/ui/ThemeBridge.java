package com.whaleonebot.ui;

import android.app.Activity;

/**
 * 把「原生控件」的主题也切到与自绘界面同一深浅。
 *
 * <p><b>为什么需要这一层</b>（真机 2026-11-21 实测出来的，不是预防性代码）：
 * 清单里 Activity 的主题是深色的 {@code @android:style/Theme.Material.NoActionBar}，
 * 而页面本身全是自绘、颜色来自 {@link Theme} 令牌。于是任何<b>没自己上色</b>的原生控件
 * 都吃清单那套深色默认值：
 * <ul>
 *   <li>「下载并创建 N 份核心？」这类 {@code AlertDialog}：浅色主题下是深底白字，与浅色页面割裂；</li>
 *   <li>新建机器人页的「空闲核心」{@code Spinner}：白字压浅底，几乎读不出来；</li>
 *   <li>{@code EditText} 的提示字同理（浅色主题下发灰到看不清）。</li>
 * </ul>
 * 换主题之后也要再 apply 一次 —— 否则之后新建的弹窗还停在旧主题（Activity 的 theme 是创建时就定下来的）。
 */
public final class ThemeBridge {

    private ThemeBridge() {
    }

    /** 按已存的偏好把 Activity 的原生控件主题切成深/浅。创建界面之前调用。 */
    public static void apply(Activity activity) {
        Theme theme;
        try {
            theme = new ThemeStore(activity).theme();
        } catch (Throwable ignored) {
            return; // 读不到偏好就用清单里的默认主题，不该因此起不来
        }
        apply(activity, theme.dark);
    }

    /** 已知深浅时直接切（换主题那一刻用）。 */
    public static void apply(Activity activity, boolean dark) {
        if (activity == null) return;
        try {
            activity.setTheme(dark
                    ? android.R.style.Theme_Material_NoActionBar
                    : android.R.style.Theme_Material_Light_NoActionBar);
        } catch (Throwable ignored) {
            // 切不过去不该影响功能：界面是自绘的，最坏只是原生弹窗配色不对。
        }
    }
}
