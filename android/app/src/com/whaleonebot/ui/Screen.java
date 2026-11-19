package com.whaleonebot.ui;

import android.app.Activity;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 页面基类。每个页面就是一个 FrameLayout，由 AppShell 挂进 pageHost。
 *
 * <p>注意：{@link #build()} 由 AppShell 在构造之后显式调用，
 * 不在构造函数里调 —— 否则子类的字段初始化会晚于 build()，刚建好的引用会被清掉。
 */
abstract class Screen {

    final AppShell shell;
    final Activity activity;
    final Theme t;
    final FrameLayout root;

    Screen(AppShell shell) {
        this.shell = shell;
        this.activity = shell.activity;
        this.t = shell.theme;
        this.root = new FrameLayout(activity);
        root.setClipChildren(false);
        root.setClipToPadding(false);
    }

    /** 按当前令牌铺满本页内容。换主题后整页重建，颜色自然跟着走。 */
    abstract void build();

    /** 宿主每秒调一次；实现方必须逐项比对，值没变就别碰 View。 */
    void refresh() {
    }

    /** 挂上来时调一次（入场动画等）。 */
    void onAttach() {
    }

    /**
     * 页内返回：true 表示本页已经把这次返回消费掉了（例如运行端配置在「组页」里，
     * 返回应先退回它的列表页），AppShell 就不再出栈。
     *
     * <p>注意：页面<b>不要</b>在这里做整页入场动效 —— 那是 {@link Motion} 的事。
     */
    boolean handleBack() {
        return false;
    }

    AppShell.Host host() {
        return shell.host;
    }

    int dp(float v) {
        return Ui.dp(activity, v);
    }

    /**
     * 子页通用页头：左侧圆形返回钮 + 22sp 标题。
     * 返回钮触控区 48dp，图标 24dp，符合 Android 最小触控边长。
     */
    LinearLayout header(String title) {
        LinearLayout row = Ui.row(activity);

        FrameLayout back = new FrameLayout(activity);
        back.setBackground(Drawables.circle(t.ghostFill, t.ghostStroke, dp(1)));
        back.setClickable(true);
        back.setFocusable(true);
        IconView chev = new IconView(activity, IconView.CHEV_L, t.textPrimary);
        back.addView(chev, new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        back.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                shell.handleBack();
            }
        });
        Ui.press(back, 0.9f);

        LinearLayout.LayoutParams blp = Ui.llp(dp(Theme.TOUCH), dp(Theme.TOUCH));
        row.addView(back, blp);

        TextView tv = Ui.strong(activity, title, Theme.T_TITLE, t.textPrimary);
        LinearLayout.LayoutParams tlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        tlp.leftMargin = dp(Theme.S3);
        row.addView(tv, tlp);

        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        row.setLayoutParams(rlp);
        return row;
    }
}
