package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.content.DialogInterface;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 遵循 DESIGN_SYSTEM.md 的统一主题底部面板（全面替代原生系统黑框 AlertDialog）。
 * 复用现有 Theme 色盘、Drawables 圆角卡片与 Ui 按钮体系，零新增依赖；
 * 支持：确认框 / 单选列表 / 多选列表 / 文本输入 / 自定义 View / 全屏 WebView / FLAG_SECURE 防截屏。
 */
public final class PromptSheet {

    interface ItemClick { void onSelect(int index); }
    interface MultiConfirm { void onConfirm(boolean[] checked); }
    interface TextConfirm { void onConfirm(String text); }
    interface DialogAction { void onClick(Dialog dialog, TextView button); }

    private PromptSheet() {}

    /** 跨包便捷入口（供 MainActivity 等外壳根类替代系统原生 AlertDialog）。 */
    public static Dialog showConfirm(Activity activity, String title, String message,
                                     String positiveLabel, Runnable onPositive,
                                     String negativeLabel) {
        return confirm(activity, currentTheme(activity), title, message,
                positiveLabel, onPositive, null, null, negativeLabel);
    }

    /** 确认弹窗便捷重载：默认带「取消」按钮。 */
    static Dialog confirm(Activity activity, Theme t, String title, String message,
                          String positiveLabel, boolean destructive, Runnable onPositive) {
        return confirm(activity, t, title, message, positiveLabel, onPositive,
                null, null, "取消", false, null);
    }

    /** 确认弹窗：标题 + 正文 + 主操作 / 可选中性操作 / 取消。 */
    static Dialog confirm(Activity activity, Theme t, String title, String message,
                          String positiveLabel, Runnable onPositive,
                          String neutralLabel, Runnable onNeutral,
                          String negativeLabel) {
        return confirm(activity, t, title, message, positiveLabel, onPositive,
                neutralLabel, onNeutral, negativeLabel, false, null);
    }

    /** 确认弹窗（完整版：支持 FLAG_SECURE 防截屏与关闭回调）。 */
    static Dialog confirm(Activity activity, Theme t, String title, String message,
                          String positiveLabel, Runnable onPositive,
                          String neutralLabel, Runnable onNeutral,
                          String negativeLabel, boolean secure,
                          DialogInterface.OnDismissListener onDismiss) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return null;
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
        if (negativeLabel != null && negativeLabel.length() > 0) {
            TextView neg = Ui.button(activity, t, negativeLabel, false);
            neg.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            neg.setOnClickListener(v -> d.dismiss());
            LinearLayout.LayoutParams nlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            nlp.topMargin = Ui.dp(activity, Theme.S2);
            actions.addView(neg, nlp);
        }

        card.addView(actions, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        if (onDismiss != null) d.setOnDismissListener(onDismiss);
        showCard(activity, d, card, secure, false);
        return d;
    }

    /** 单选列表面板：点击任意一项立即回调并关闭。 */
    static Dialog choose(Activity activity, Theme t, String title, String[] items,
                         ItemClick onSelect, String extraLabel, Runnable onExtra) {
        return choose(activity, t, title, items, onSelect, extraLabel, onExtra, "取消");
    }

    static Dialog choose(Activity activity, Theme t, String title, String[] items,
                         ItemClick onSelect, String extraLabel, Runnable onExtra, String cancelLabel) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return null;
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

        TextView cancel = Ui.button(activity, t, cancelLabel == null ? "取消" : cancelLabel, false);
        cancel.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
        cancel.setOnClickListener(v -> d.dismiss());
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = Ui.dp(activity, Theme.S2);
        card.addView(cancel, clp);

        showCard(activity, d, card, false, false);
        return d;
    }

    /** 多选列表面板（统一主题 CheckBox + 滚动列表 + 确定/取消）。 */
    static Dialog multiChoice(Activity activity, Theme t, String title, String[] labels,
                              boolean[] initial, MultiConfirm onConfirm) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return null;
        final Dialog d = createSheetDialog(activity);
        final boolean[] state = new boolean[labels.length];
        for (int i = 0; i < labels.length; i++) state[i] = initial != null && i < initial.length && initial[i];

        LinearLayout card = buildCard(activity, t, title, null);
        ScrollView sv = new ScrollView(activity);
        LinearLayout list = Ui.column(activity);
        for (int i = 0; i < labels.length; i++) {
            final int idx = i;
            CheckBox cb = new CheckBox(activity);
            cb.setText(labels[i]);
            cb.setTextColor(t.textPrimary);
            cb.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            cb.setChecked(state[idx]);
            cb.setOnCheckedChangeListener((btn, checked) -> state[idx] = checked);
            list.addView(cb, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
        sv.addView(list, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams svlp = Ui.llp(MATCH_PARENT, Ui.dp(activity, 340));
        svlp.topMargin = Ui.dp(activity, Theme.S2);
        card.addView(sv, svlp);

        TextView ok = Ui.button(activity, t, "确定", true);
        ok.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
        ok.setOnClickListener(v -> { d.dismiss(); if (onConfirm != null) onConfirm.onConfirm(state); });
        LinearLayout.LayoutParams olp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        olp.topMargin = Ui.dp(activity, Theme.S3);
        card.addView(ok, olp);

        TextView cancel = Ui.button(activity, t, "取消", false);
        cancel.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
        cancel.setOnClickListener(v -> d.dismiss());
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = Ui.dp(activity, Theme.S2);
        card.addView(cancel, clp);

        showCard(activity, d, card, false, false);
        return d;
    }

    /** 单行或多行文本输入面板（带说明文字）。 */
    static Dialog showInput(Activity activity, String title, String message, String hint, String initial,
                            boolean multiline, String positiveLabel, TextConfirm onConfirm) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return null;
        Theme t = currentTheme(activity);
        LinearLayout box = Ui.column(activity);
        if (message != null && message.length() > 0) {
            TextView tv = Ui.text(activity, message, Theme.T_CAP, t.textSecondary);
            tv.setLineSpacing(Ui.dp(activity, 3), 1f);
            LinearLayout.LayoutParams mlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            mlp.bottomMargin = Ui.dp(activity, Theme.S2);
            box.addView(tv, mlp);
        }
        EditText edit = new EditText(activity);
        edit.setSingleLine(!multiline);
        if (multiline) {
            edit.setMinLines(3);
            edit.setMaxLines(6);
            edit.setGravity(Gravity.TOP | Gravity.START);
        }
        edit.setTextColor(t.textPrimary);
        edit.setHintTextColor(t.textTertiary);
        if (hint != null) edit.setHint(hint);
        if (initial != null) edit.setText(initial);
        edit.setBackground(Drawables.round(t.cardFill, t.cardStroke, Ui.dp(activity, 1), Ui.dp(activity, Theme.R_BTN)));
        int hp = Ui.dp(activity, Theme.S2);
        edit.setPadding(hp, hp, hp, hp);
        box.addView(edit, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        return custom(activity, t, title, box,
                positiveLabel == null ? "确定" : positiveLabel, (d, btn) -> {
                    d.dismiss();
                    if (onConfirm != null) onConfirm.onConfirm(edit.getText().toString().trim());
                },
                null, null,
                "取消", (d, btn) -> d.dismiss(),
                false, false, null, null);
    }

    /** 单行文本输入面板。 */
    static Dialog input(Activity activity, Theme t, String title, String hint, String initial,
                        String positiveLabel, TextConfirm onConfirm) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return null;
        EditText edit = new EditText(activity);
        edit.setSingleLine(true);
        edit.setTextColor(t.textPrimary);
        edit.setHintTextColor(t.textTertiary);
        if (hint != null) edit.setHint(hint);
        if (initial != null) edit.setText(initial);
        edit.setBackground(Drawables.round(t.cardFill, t.cardStroke, Ui.dp(activity, 1), Ui.dp(activity, Theme.R_BTN)));
        int hp = Ui.dp(activity, Theme.S2);
        edit.setPadding(hp, hp, hp, hp);
        return custom(activity, t, title, edit,
                positiveLabel == null ? "确定" : positiveLabel, (d, btn) -> {
                    d.dismiss();
                    if (onConfirm != null) onConfirm.onConfirm(edit.getText().toString().trim());
                },
                null, null,
                "取消", (d, btn) -> d.dismiss(),
                false, false, null, null);
    }

    /**
     * 自定义内容面板：支持任意子 View（二维码/表单/WebView）、不自动关闭的按钮回调、
     * 中性操作按钮（可选返回引用供外部切换文案/可用态）、FLAG_SECURE 防截屏与全屏模式。
     */
    static Dialog custom(Activity activity, Theme t, String title, View content,
                         String positiveLabel, DialogAction onPositive,
                         String neutralLabel, DialogAction onNeutral,
                         String negativeLabel, DialogAction onNegative,
                         boolean secure, boolean fullScreen,
                         DialogInterface.OnDismissListener onDismiss,
                         TextView[] neutralOut) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return null;
        final Dialog d = createSheetDialog(activity);
        LinearLayout card = buildCard(activity, t, title, null);

        if (content != null) {
            if (content.getParent() instanceof ViewGroup) ((ViewGroup) content.getParent()).removeView(content);
            LinearLayout.LayoutParams vlp = fullScreen
                    ? new LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
                    : Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            vlp.topMargin = Ui.dp(activity, Theme.S2);
            card.addView(content, vlp);
        }

        if (positiveLabel != null && positiveLabel.length() > 0) {
            TextView pos = Ui.button(activity, t, positiveLabel, true);
            pos.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            pos.setOnClickListener(v -> {
                if (onPositive != null) onPositive.onClick(d, pos);
                else d.dismiss();
            });
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = Ui.dp(activity, Theme.S3);
            card.addView(pos, lp);
        }
        if (neutralLabel != null && neutralLabel.length() > 0) {
            TextView neu = Ui.button(activity, t, neutralLabel, false);
            neu.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            neu.setOnClickListener(v -> {
                if (onNeutral != null) onNeutral.onClick(d, neu);
                else d.dismiss();
            });
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = Ui.dp(activity, Theme.S2);
            card.addView(neu, lp);
            if (neutralOut != null && neutralOut.length > 0) neutralOut[0] = neu;
        }
        if (negativeLabel != null && negativeLabel.length() > 0) {
            TextView neg = Ui.button(activity, t, negativeLabel, false);
            neg.setMinimumHeight(Ui.dp(activity, Theme.TOUCH));
            neg.setOnClickListener(v -> {
                if (onNegative != null) onNegative.onClick(d, neg);
                else d.dismiss();
            });
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = Ui.dp(activity, Theme.S2);
            card.addView(neg, lp);
        }

        if (onDismiss != null) d.setOnDismissListener(onDismiss);
        showCard(activity, d, card, secure, fullScreen);
        return d;
    }

    /** 兜底取当前主题（供没有 Screen 实例的工具类，如 BiliAuthorizationDialog / BiliWebLogin 使用）。 */
    static Theme currentTheme(Activity activity) {
        return new ThemeStore(activity).theme();
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

    private static void showCard(Activity activity, Dialog d, LinearLayout card, boolean secure, boolean fullScreen) {
        FrameLayout root = new FrameLayout(activity);
        int pad = Ui.dp(activity, fullScreen ? Theme.S2 : Theme.S3);
        root.setPadding(pad, pad, pad, pad);
        root.addView(card, new FrameLayout.LayoutParams(
                MATCH_PARENT,
                fullScreen ? MATCH_PARENT : WRAP_CONTENT,
                fullScreen ? Gravity.CENTER : Gravity.BOTTOM));
        d.setContentView(root);
        Window w = d.getWindow();
        if (w != null) {
            if (secure) w.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setGravity(fullScreen ? Gravity.CENTER : Gravity.BOTTOM);
            w.setLayout(WindowManager.LayoutParams.MATCH_PARENT,
                    fullScreen ? WindowManager.LayoutParams.MATCH_PARENT : WindowManager.LayoutParams.WRAP_CONTENT);
            w.setDimAmount(0.55f);
        }
        d.show();
    }
}
