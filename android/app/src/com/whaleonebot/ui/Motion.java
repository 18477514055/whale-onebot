package com.whaleonebot.ui;

import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;

import java.util.List;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;

/**
 * 页面过渡动效的<b>唯一真源</b>。
 *
 * <p>为什么要有这个类：以前页面入场有两种写法 —— 一种是 AppShell 统一做（位移 + 淡入），
 * 另一种是某个页面自己在 {@code onAttach()} 里再动一次自己的内容容器。两套叠在一起，
 * 整页透明度被重置成 0、内容又晚 260ms 才浮出来，观感就是「闪一下、动效没了」。
 * 现在规定：<b>任何页面切换都只能调这里的 enter / exit / swap</b>，页面里不再写自己的入场动画。
 *
 * <p>三类过渡：
 * <ul>
 *   <li>{@link #PUSH} 进下一层：新页从右侧 8% 处滑入 + 淡入，旧页往左 3% 退场</li>
 *   <li>{@link #POP} 退回上一层：新页从左侧 5% 处滑入，旧页往右 6% 退场</li>
 *   <li>{@link #FADE} 同层内容替换（换主题重建、重新读取配置）：只有淡入淡出</li>
 * </ul>
 *
 * <p>{@link #NONE} 不是一种动效，而是「这一帧不做动效」—— 首帧、或整页入场已经由
 * AppShell 的 PUSH 负责时用它，避免同一段动画放两遍。
 */
final class Motion {

    /** 进入下一层。 */
    static final int PUSH = 0;
    /** 退回上一层。 */
    static final int POP = 1;
    /** 同层内容替换。 */
    static final int FADE = 2;
    /** 不做动效（首帧 / 已由外层负责入场）。 */
    static final int NONE = -1;

    // ---------------------------------------------------------------- 参数
    // 时长与位移只在这里改；改完所有页面一起变，不会再出现「这个页面有、那个页面没有」。

    private static final long D_IN_PUSH = 200;
    private static final long D_IN_POP = 200;
    private static final long D_IN_FADE = 180;

    private static final long D_OUT_PUSH = 170;
    private static final long D_OUT_POP = 160;
    private static final long D_OUT_FADE = 150;

    /** 位移按容器宽度的比例给，任何屏宽下手感一致。 */
    private static final float X_IN_PUSH = 0.08f;
    private static final float X_OUT_PUSH = 0.03f;
    private static final float X_IN_POP = 0.05f;
    private static final float X_OUT_POP = 0.06f;

    private Motion() {
    }

    static DecelerateInterpolator enterCurve() {
        return new DecelerateInterpolator(1.6f);
    }

    static DecelerateInterpolator fadeCurve() {
        return new DecelerateInterpolator(1.4f);
    }

    /** 容器宽度：拿不到（还没测量）就退回屏幕宽度，绝不让位移变成 0。 */
    static int widthOf(View v) {
        if (v == null) return 0;
        int w = v.getWidth();
        if (w > 0) return w;
        if (v.getParent() instanceof ViewGroup) {
            ViewGroup p = (ViewGroup) v.getParent();
            if (p.getWidth() > 0) return p.getWidth();
        }
        return v.getResources().getDisplayMetrics().widthPixels;
    }

    // ---------------------------------------------------------------- 入场 / 退场

    /**
     * 新页入场。{@link #NONE} 时只把状态复位（保证复用的视图不会停在半透明/偏移上）。
     */
    static void enter(View v, int motion, int width) {
        if (v == null) return;
        v.animate().cancel();
        if (motion == NONE) {
            v.setAlpha(1f);
            v.setTranslationX(0f);
            return;
        }
        v.setAlpha(0f);
        if (motion == PUSH) {
            v.setTranslationX(width * X_IN_PUSH);
            v.animate().translationX(0f).alpha(1f)
                    .setDuration(D_IN_PUSH).setInterpolator(enterCurve()).start();
        } else if (motion == POP) {
            v.setTranslationX(-width * X_IN_POP);
            v.animate().translationX(0f).alpha(1f)
                    .setDuration(D_IN_POP).setInterpolator(enterCurve()).start();
        } else {
            v.setTranslationX(0f);
            v.animate().alpha(1f)
                    .setDuration(D_IN_FADE).setInterpolator(fadeCurve()).start();
        }
    }

    /**
     * 旧页退场，动画结束后执行 {@code onEnd}（通常是从父容器移除）。
     *
     * <p>{@code onEnd} 一定会被执行一次：动画被 cancel 时 ViewPropertyAnimator 仍会跑
     * withEndAction，所以调用方可以放心在里面做清理。
     */
    static void exit(final View v, int motion, int width, final Runnable onEnd) {
        if (v == null) {
            if (onEnd != null) onEnd.run();
            return;
        }
        v.animate().cancel();
        if (motion == NONE) {
            if (onEnd != null) onEnd.run();
            return;
        }
        android.view.ViewPropertyAnimator a = v.animate();
        if (motion == PUSH) {
            a.translationX(-width * X_OUT_PUSH).alpha(0f).setDuration(D_OUT_PUSH);
        } else if (motion == POP) {
            a.translationX(width * X_OUT_POP).alpha(0f).setDuration(D_OUT_POP);
        } else {
            a.alpha(0f).setDuration(D_OUT_FADE);
        }
        if (onEnd != null) a.withEndAction(onEnd);
        a.start();
    }

    // ---------------------------------------------------------------- 容器内切换

    /**
     * 同一个容器里的「页面」切换：运行端配置的列表页 ↔ 组页走这里。
     *
     * <p>旧内容按同一套动效退场后再移除，新内容同一套动效入场 —— 所以进「更深入的功能」
     * 看到的位移/淡入与整页跳转完全一致，不会再是「旧内容瞬间消失 + 新内容凭空出现」。
     *
     * @param old 即将退场的内容；null 表示首次渲染（直接显示，不做动效）
     */
    static void swap(final FrameLayout host, final View old, View next, int motion) {
        if (host == null || next == null) return;
        final int w = widthOf(host);

        if (next.getParent() instanceof ViewGroup) {
            ((ViewGroup) next.getParent()).removeView(next);
        }
        host.addView(next, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        if (old == null || old == next || motion == NONE) {
            enter(next, NONE, w);
            if (old != null && old != next && old.getParent() == host) host.removeView(old);
            return;
        }

        enter(next, motion, w);
        exit(old, motion, w, new Runnable() {
            @Override
            public void run() {
                // 只移除「确实还是本容器子 View」的旧内容：被下一次切换打断时它可能已被移除。
                if (old.getParent() == host) host.removeView(old);
            }
        });
    }

    /**
     * 错峰入场（首页卡片组这类「一块启动台」的构图）。它只动内容、不动整页透明度，
     * 与 AppShell 的整页过渡叠加不冲突；同样集中在这里，页面里不再各写一套。
     */
    static void stagger(List<View> views, long stepMs, long durationMs, float translateYPx) {
        if (views == null) return;
        for (int i = 0; i < views.size(); i++) {
            View v = views.get(i);
            if (v == null) continue;
            float target = v.getAlpha();
            v.animate().cancel();
            v.setAlpha(0f);
            v.setTranslationY(translateYPx);
            v.animate().alpha(target).translationY(0f)
                    .setStartDelay(stepMs * i)
                    .setDuration(durationMs)
                    .setInterpolator(enterCurve())
                    .start();
        }
    }

    /** 单个悬挂元素（首页 FAB）的入场：从小放大 + 淡入。参数同样只在这里。 */
    static void popIn(View v, long delayMs, long durationMs, float fromScale) {
        if (v == null) return;
        v.animate().cancel();
        v.setAlpha(0f);
        v.setScaleX(fromScale);
        v.setScaleY(fromScale);
        v.animate().alpha(1f).scaleX(1f).scaleY(1f)
                .setStartDelay(delayMs)
                .setDuration(durationMs)
                .setInterpolator(enterCurve())
                .start();
    }
}
