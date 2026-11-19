package com.whaleonebot.ui;

import android.app.Activity;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 平台多选控件（可复用）：一行一个平台胶囊。
 *
 * <p>三态，全部只读 {@link BotRegistry#PLATFORMS} / {@code PLATFORM_LABEL} / {@code PLATFORM_SUPPORTED}，
 * 平台清单<b>不在本类里写死</b> —— 以后接通抖音/bilibili/小黑盒，只要改注册表里的常量，
 * 这里自动跟着变可选项：
 * <ul>
 *   <li><b>已选中</b>：主题色实心 + 文字反色（{@code t.onAccent}）+ 勾；</li>
 *   <li><b>可选中未选</b>：描边胶囊（{@code t.ghostFill / ghostStroke}）；</li>
 *   <li><b>置灰</b>：整体压暗、文字改三级色、带「敬请期待」角标；点击不发选中事件，
 *       只回调 {@link Listener#onUnavailable}，由页面去 toast —— 明确告知能力边界，不做假可点。</li>
 * </ul>
 *
 * <p>为什么做成「一行一个」而不是紧凑的流式排列：平台名长度差很多（QQ / bilibili / 小黑盒），
 * 流式换行在不同屏宽下会给出不同的折行位置，观感不稳；等宽整行胶囊在任何屏宽下都整齐，
 * 而且天然满足 48dp 最小触控边长。
 *
 * <p>动效：本控件<b>不做</b>入场动画（那是 {@link Motion} 的事），只有 {@link Ui#press} 的按下反馈。
 */
final class PlatformPicker extends LinearLayout {

    /** 选中集合变化 / 点了置灰项，都从这里回去。 */
    interface Listener {
        /** @param selected 变化后的选中集合（副本，调用方可以留存） */
        void onSelectionChanged(List<String> selected);

        /** 点了置灰平台：本类不 toast（它是纯控件），交给页面处理。 */
        void onUnavailable(String platformId);
    }

    private final Activity activity;
    private final Theme t;
    private final Listener listener;

    /** 选中集合，顺序即点击顺序；不含置灰平台（那些根本进不来）。 */
    private final List<String> selected = new ArrayList<String>();

    /**
     * @param selected 初始选中集合；为 null / 含非法 id 时自动过滤（非法 = 不在 PLATFORMS 里或不可选）
     * @param listener 回调；可为 null（纯展示用）
     */
    PlatformPicker(Activity activity, Theme t, List<String> selected, Listener listener) {
        super(activity);
        if (activity == null || t == null) throw new IllegalArgumentException("activity/theme 不能为空");
        this.activity = activity;
        this.t = t;
        this.listener = listener;
        setOrientation(VERTICAL);
        if (selected != null) {
            for (int i = 0; i < selected.size(); i++) {
                admit(selected.get(i));
            }
        }
        rebuild();
    }

    /** 当前选中集合（副本）。 */
    List<String> selected() {
        return new ArrayList<String>(selected);
    }

    /** 单个平台是否已选中。 */
    boolean isSelected(String platformId) {
        return platformId != null && selected.contains(platformId);
    }

    /** 代码里预选一个平台（不触发回调）。置灰平台会被忽略。 */
    void select(String platformId) {
        if (!admit(platformId)) return;
        rebuild();
    }

    /** 代码里取消一个平台（不触发回调）。 */
    void deselect(String platformId) {
        if (platformId == null) return;
        if (!selected.remove(platformId)) return;
        rebuild();
    }

    // ------------------------------------------------------------------ 内部

    /** 平台可不可以进选中集合：必须在 PLATFORMS 里，且 PLATFORM_SUPPORTED 为真。 */
    private boolean admit(String platformId) {
        if (platformId == null || platformId.length() == 0) return false;
        if (!known(platformId)) return false;
        if (!BotRegistry.PLATFORM_SUPPORTED(platformId)) return false;
        if (selected.contains(platformId)) return false;
        selected.add(platformId);
        return true;
    }

    private static boolean known(String platformId) {
        for (String id : BotRegistry.PLATFORMS) {
            if (platformId.equals(id)) return true;
        }
        return false;
    }

    /** 全量重建四行胶囊。4 行而已，重建比逐行改状态更不容易出错。 */
    private void rebuild() {
        removeAllViews();
        boolean first = true;
        for (String id : BotRegistry.PLATFORMS) {
            View row = pill(id);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
            if (!first) lp.topMargin = dp(Theme.S1);
            addView(row, lp);
            first = false;
        }
    }

    private View pill(final String platformId) {
        final boolean supported = BotRegistry.PLATFORM_SUPPORTED(platformId);
        final boolean on = supported && selected.contains(platformId);
        String label = BotRegistry.PLATFORM_LABEL(platformId);

        LinearLayout row = Ui.row(activity);
        row.setMinimumHeight(dp(Theme.TOUCH));
        row.setPadding(dp(Theme.S3), dp(Theme.S2 + 1), dp(Theme.S2), dp(Theme.S2 + 1));
        row.setGravity(Gravity.CENTER_VERTICAL);

        // 选中：主题色实心 + 文字反色；未选：描边胶囊；置灰：淡底 + 极淡描边（再整体压暗）
        if (on) {
            row.setBackground(Drawables.round(t.accent, 0, 0, dp(Theme.R_PILL)));
        } else {
            row.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_PILL)));
        }

        TextView name = Ui.text(activity, label, Theme.T_BODY,
                on ? t.onAccent : (supported ? t.ghostText : t.textTertiary));
        name.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        nlp.weight = 1f;
        name.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(name, nlp);

        if (!supported) {
            // 「敬请期待」角标：淡底 + 高对比信号色文字（与详情页的预留入口同一套视觉）
            TextView badge = Ui.text(activity, "敬请期待", Theme.T_CAP, t.toneStrong);
            badge.setTypeface(Typeface.DEFAULT_BOLD);
            badge.setLetterSpacing(0.02f);
            badge.setPadding(dp(10), dp(4), dp(10), dp(4));
            badge.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f),
                    Ui.alpha(t.accent, 0.30f), dp(1), dp(Theme.R_PILL)));
            row.addView(badge, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
            // 置灰：整体压暗，看着就「点不动」；但仍可点 —— 点了只告诉用户敬请期待
            row.setAlpha(0.55f);
        } else if (on) {
            IconView check = new IconView(activity, IconView.CHECK, t.onAccent);
            row.addView(check, new LinearLayout.LayoutParams(dp(20), dp(20)));
        }

        row.setClickable(true);
        row.setFocusable(true);
        Ui.press(row, 0.985f);
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!supported) {
                    if (listener != null) listener.onUnavailable(platformId);
                    return;
                }
                if (on) {
                    selected.remove(platformId);
                } else {
                    selected.add(platformId);
                }
                rebuild();
                if (listener != null) listener.onSelectionChanged(selected());
            }
        });
        return row;
    }

    private int dp(float v) {
        return Ui.dp(activity, v);
    }
}
