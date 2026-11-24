package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 遵循 DESIGN_SYSTEM.md 的自制主题底部面板（替代原生系统黑框 AlertDialog）。
 * 复用了现有 Theme 色盘、Drawables 圆角卡片与 Ui 按钮体系，零新增依赖。
 */
final class PromptSheet {

    interface ItemClick { void onSelect(int index); }

    private PromptSheet() {}

    /** 确认弹窗：标题 + 正文 + 取消/主操作（可选第三中性按钮）。 */
    static void confirm(Activity activity, Theme t, String title, String message,
                        String positiveLabel, Runnable onPositive,
                        String neutralLabel, Runnable onNeutral,
                        String negativeLabel) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        final Dialog d = createSheetDialog(activity);
        LinearLayout card = buildCard(activity, t, title, message);

        LinearLayout actions = Ui.column(activity);
        if (positiveLabel != null && positiveLabel.length() > 0) {
            TextView pos = Ui.button(activity, t, positiveLabel, true);
            pos.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            pos.setOnClickListener(v -> { d.dismiss(); if (onPositive != null) onPositive.run(); });
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = Ui.dp(activity, Theme.S3);
            actions.addView(pos, lp);
        }
        if (neutralLabel != null && neutralLabel.length() > 0) {
            TextView neu = Ui.button(activity, t, neutralLabel, false);
            neu.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            neu.setOnClickListener(v -> { d.dismiss(); if (onNeutral != null) onNeutral.run(); });
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = Ui.dp(activity, Theme.S2);
            actions.addView(neu, lp);
        }
        TextView neg = Ui.button(activity, t, negativeLabel == null ? "取消" : negativeLabel, false);
        neg.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
        neg.setOnClickListener(v -> d.dismiss());
        LinearLayout.LayoutParams nlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        nlp.topMargin = Ui.dp(activity, Theme.S2);
        actions.addView(neg, nlp);

        card.addView(actions, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        showCard(activity, d, card);
    }

    /** 列表选择面板：点击任意一项立即回调并关闭。 */
    static void choose(Activity activity, Theme t, String title, String[] items,
                       ItemClick onSelect, String extraLabel, Runnable onExtra) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        final Dialog d = createSheetDialog(activity);
        LinearLayout card = buildCard(activity, t, title, null);

        ScrollView sv = new ScrollView(activity);
        LinearLayout list = Ui.column(activity);
        for (int i = 0; i < items.length; i++) {
            final int idx = i;
            TextView row = Ui.button(activity, t, items[i], false);
            row.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            row.setOnClickListener(v -> { d.dismiss(); if (onSelect != null) onSelect.onSelect(idx); });
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = Ui.dp(activity, Theme.S2);
            list.addView(row, lp);
        }
        sv.addView(list, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams svlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        svlp.topMargin = Ui.dp(activity, Theme.S2);
        card.addView(sv, svlp);

        if (extraLabel != null && extraLabel.length() > 0) {
            TextView ext = Ui.button(activity, t, extraLabel, false);
            ext.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            ext.setOnClickListener(v -> { d.dismiss(); if (onExtra != null) onExtra.run(); });
            LinearLayout.LayoutParams elp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            elp.topMargin = Ui.dp(activity, Theme.S2);
            card.addView(ext, elp);
        }

        TextView cancel = Ui.button(activity, t, "取消", false);
        cancel.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
        cancel.setOnClickListener(v -> d.dismiss());
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = Ui.dp(activity, Theme.S2);
        card.addView(cancel, clp);

        showCard(activity, d, card);
    }

    private static Dialog createSheetDialog(Activity activity) {
        Dialog d = new Dialog(activity);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setCanceledOnTouchOutside(true);
        return d;
    }

    private static LinearLayout buildCard(Activity activity, Theme t, String title, String message) {
        LinearLayout box = Ui.column(activity);
        int p = Ui.dp(activity, Theme.S4);
        box.setPadding(p, p, p, p);
        box.setBackground(Drawables.round(t.g1, t.cardStroke, Ui.dp(activity, 1), Ui.dp(activity, Theme.R_CARD)));
        if (title != null && title.length() > 0) {
            box.addView(Ui.strong(activity, title, Theme.T_CARD, t.textPrimary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
        if (message != null && message.length() > 0) {
            ScrollView msgScroll = new ScrollView(activity);
            TextView msg = Ui.text(activity, message, Theme.T_BODY, t.textSecondary);
            msgScroll.addView(msg, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            LinearLayout.LayoutParams mlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            mlp.topMargin = Ui.dp(activity, Theme.S2);
            box.addView(msgScroll, mlp);
        }
        return box;
    }

    private static void showCard(Activity activity, Dialog d, LinearLayout card) {
        FrameLayout root = new FrameLayout(activity);
        int pad = Ui.dp(activity, Theme.S3);
        root.setPadding(pad, pad, pad, pad);
        root.addView(card, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM));
        d.setContentView(root);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setGravity(Gravity.BOTTOM);
            w.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT);
            w.setDimAmount(0.55f);
        }
        d.show();
    }
}
