package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.DialogInterface;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 键值映射（{@link BotConfigSchema#MAP}）控件：一行一条「键 → 值」，可增、可改、可删。
 *
 * <p>第一个用户是 {@code store.groupSliderPos}（群号 → 回复概率 %，
 * 形如 {@code {"200000003":10,"200000006":0.5}}）—— 以前手机上改不了，群被设成 0.5% 也只能干看着。
 *
 * <p><b>纯自绘</b>：没有 XML 布局、没有 AndroidX；配色 / 圆角 / 字号全部走 {@link Theme} 与
 * {@link Drawables}，浮起感走 {@link Ui#elevate}（≤2dp，且它会把 ambient shadow 着色置 0，
 * 不会出现那圈灰晕）。行内按下反馈用两态背景，不用缩放 —— 整行缩放会把列表撑得一跳一跳。
 *
 * <p><b>值编辑走浮层（Dialog）</b>，不是行内 EditText。这不只是观感问题：
 * 行内输入框会落在父 {@code ScrollView} 的子树里，一旦获得焦点，
 * {@code ScrollView.requestChildRectangleOnScreen} 就会在后续布局里把页面滚到那个输入框
 * （本项目 {@code NewBotScreen} 踩过的「点一下输入框、页面自己弹回顶部」就是它）。
 * 把输入框搬进独立窗口后，这条链路根本不存在；同时约束也写死在浮层里：数字键盘、
 * 0~100（或 Field 自带区间）校验、越界就地提示、**不写回**。
 *
 * <p><b>手势</b>：本控件<b>不调用</b> {@code requestDisallowInterceptTouchEvent} ——
 * 行只是「点」，没有任何拖动交互，手指一移动就应该让父 ScrollView 滚，抢过来才是 bug。
 *
 * <p><b>不直接写盘</b>：每次改动都 {@link Listener#onChanged} 回屏幕侧，由 {@code Pending} 机制
 * 统一在点「保存」时写回 config.json。
 */
public final class BotConfigMap extends LinearLayout {

    /** 改动回调。给的是当前值的<b>副本</b>，屏幕侧可以随便留着。 */
    public interface Listener {
        void onChanged(LinkedHashMap<String, String> entries);
    }

    private final Context ctx;
    private final Theme t;
    private final BotConfigSchema.Field f;
    private final Listener listener;

    /** 键 → 显示文本（数字存字面量）。插入序不参与展示，展示顺序见 {@link #displayOrder()}。 */
    private final LinkedHashMap<String, String> values = new LinkedHashMap<String, String>();

    /** 数据行容器（在圆角底里）。 */
    private final LinearLayout rows;
    private final FrameLayout listBox;

    /** 当前开着的浮层。防止连点弹出两层。 */
    private Dialog open;

    /**
     * 契约里点名的构造式。主题按当前 Context 读到的偏好解析
     * （屏幕侧请用带 {@link Theme} 的那个重载，颜色才和页面严格同一份）。
     */
    public BotConfigMap(Context c, BotConfigSchema.Field f,
                        LinkedHashMap<String, String> seed, Listener l) {
        this(c, f, seed, l, themeOf(c));
    }

    public BotConfigMap(Context c, BotConfigSchema.Field f,
                        LinkedHashMap<String, String> seed, Listener l, Theme theme) {
        super(c);
        if (f == null) throw new IllegalArgumentException("BotConfigMap 需要 BotConfigSchema.Field");
        this.ctx = c;
        this.f = f;
        this.t = theme == null ? Theme.ALL[0] : theme;
        this.listener = l;

        setOrientation(VERTICAL);
        setClipChildren(false);
        setClipToPadding(false);

        // 种子：屏幕侧已按 trim 去过重；这里再兜一次，保证「同一个键只出现一行」。
        if (seed != null) {
            for (Map.Entry<String, String> en : seed.entrySet()) {
                String k = en.getKey() == null ? "" : en.getKey().trim();
                if (k.length() == 0 || values.containsKey(k)) continue;
                values.put(k, en.getValue() == null ? "" : en.getValue().trim());
            }
        }

        listBox = new FrameLayout(ctx);
        listBox.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_TILE)));
        // 只到 2dp，并且必须走 Ui.elevate：它会把 ambient shadow 着色置 0，
        // 否则深色渐变上会浮出一圈均匀灰雾（本项目已修过的坑）。
        Ui.elevate(listBox, 2f, t);
        listBox.setClipChildren(false);
        listBox.setClipToPadding(false);

        rows = Ui.column(ctx);
        rows.setPadding(dp(Theme.S1), dp(4), dp(Theme.S1), dp(4));
        listBox.addView(rows, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        addView(listBox, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        TextView add = Ui.button(ctx, t, "＋ 添加一行", false);
        add.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View v) {
                showAddDialog();
            }
        });
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        alp.topMargin = dp(Theme.S1);
        addView(add, alp);

        rebuild();
    }

    /** 当前值（副本，便于自检 / 回读）。空表返回空表，不是 null。 */
    public LinkedHashMap<String, String> entries() {
        return new LinkedHashMap<String, String>(values);
    }

    @Override
    protected void onDetachedFromWindow() {
        // 页面被整体换掉时（保存 / 放弃 / 重新读取都会重建组页），浮层不能留在屏幕上变成野窗口。
        dismissOpen();
        super.onDetachedFromWindow();
    }

    // ================================================================ 行

    private void rebuild() {
        rows.removeAllViews();
        List<String> order = displayOrder();
        if (order.isEmpty()) {
            TextView empty = Ui.text(ctx, emptyText(), Theme.T_CAP, t.textTertiary);
            empty.setLineSpacing(dp(3), 1f);
            empty.setPadding(dp(Theme.S1), dp(Theme.S1), dp(Theme.S1), dp(Theme.S1));
            rows.addView(empty, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            return;
        }
        for (int i = 0; i < order.size(); i++) {
            if (i > 0) rows.addView(divider(), new LinearLayout.LayoutParams(MATCH_PARENT, dp(1)));
            rows.addView(rowOf(order.get(i)), new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        }
    }

    private View divider() {
        View v = new View(ctx);
        v.setBackgroundColor(Ui.alpha(t.textTertiary, 0.16f));
        return v;
    }

    /** 一行：键（等宽、右对齐）+ 值 + 单位 + 删除。整行可点 = 改值。 */
    private View rowOf(final String key) {
        LinearLayout row = Ui.row(ctx);
        row.setMinimumHeight(dp(Theme.TOUCH));
        row.setPadding(dp(Theme.S1), dp(6), dp(4), dp(6));
        // 按下反馈用背景两态，不用缩放：整行缩放会让列表每一行都在跳。
        row.setBackground(Drawables.stateful(
                Drawables.round(0, 0, 0, dp(Theme.R_TILE)),
                Drawables.round(Ui.alpha(t.textPrimary, 0.06f), 0, 0, dp(Theme.R_TILE))));

        TextView keyView = Ui.mono(ctx, Theme.T_BODY, t.textSecondary);
        keyView.setText(key);
        keyView.setSingleLine(true);
        keyView.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        keyView.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        LinearLayout.LayoutParams klp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        klp.weight = 1f;
        row.addView(keyView, klp);

        String shown = values.get(key);
        String suffix = unit();
        boolean blank = shown == null || shown.length() == 0;
        TextView valueView = blank
                ? Ui.text(ctx, "—", Theme.T_BODY, t.textTertiary)
                : Ui.strong(ctx, suffix.length() == 0 ? shown : (shown + " " + suffix),
                        Theme.T_BODY, t.textPrimary);
        valueView.setSingleLine(true);
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
        vlp.leftMargin = dp(Theme.S2);
        row.addView(valueView, vlp);

        FrameLayout del = new FrameLayout(ctx);
        del.setBackground(Drawables.circle(t.ghostFill, t.ghostStroke, dp(1)));
        del.setClickable(true);
        del.setFocusable(true);
        TextView x = Ui.text(ctx, "×", Theme.T_CARD, t.textSecondary);
        x.setGravity(Gravity.CENTER);
        del.addView(x, new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER));
        del.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View v) {
                delete(key);
            }
        });
        Ui.press(del, 0.9f);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(36), dp(36));
        dlp.leftMargin = dp(Theme.S1);
        row.addView(del, dlp);

        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View v) {
                showValueDialog(key);
            }
        });
        return row;
    }

    /**
     * 展示顺序：数字键按<b>数值</b>升序（避免 "10" 排在 "9" 前面、也避免每次重建顺序漂移），
     * 非数字键排在数字键后面、按字典序。完全相同的情况按字面量定序 —— 结果一定是确定的。
     */
    private List<String> displayOrder() {
        ArrayList<String> keys = new ArrayList<String>(values.keySet());
        Collections.sort(keys, new Comparator<String>() {
            @Override
            public int compare(String a, String b) {
                Double na = numericKey(a);
                Double nb = numericKey(b);
                if (na != null && nb != null) {
                    int c = Double.compare(na.doubleValue(), nb.doubleValue());
                    if (c != 0) return c;
                } else if (na != null) {
                    return -1;
                } else if (nb != null) {
                    return 1;
                }
                return a.compareTo(b);
            }
        });
        return keys;
    }

    private static Double numericKey(String k) {
        if (k == null || k.length() == 0) return null;
        try {
            return Double.valueOf(k.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private String emptyText() {
        String keyLabel = f.mapKeyLabel == null ? "" : f.mapKeyLabel;
        // 契约指定的第一个使用者是「每群回复概率」；别的 MAP 字段走通用文案，免得出现「所有群」字样。
        if (keyLabel.indexOf('群') >= 0) return "还没有单独设置，所有群都用默认概率";
        return "还没有单独设置，全部使用默认值";
    }

    /**
     * 单位：取「值列提示」里<b>最后一个空格后的片段</b>（{@code "概率 %"} → {@code "%"}）。
     * 只有一段（{@code "概率"}）时视为提示语而不是单位，不显示 —— 免得写出「10概率」。
     */
    private String unit() {
        String label = f.mapValueLabel == null ? "" : f.mapValueLabel.trim();
        if (label.length() == 0) return "";
        String[] parts = label.split("\\s+");
        if (parts.length < 2) return "";
        String last = parts[parts.length - 1].trim();
        return (last.length() > 0 && last.length() <= 4) ? last : "";
    }

    private double lo() {
        return f.hasRange ? f.min : 0d;
    }

    private double hi() {
        return f.hasRange ? f.max : 100d;
    }

    // ================================================================ 改值浮层

    private void showValueDialog(final String key) {
        if (open != null) return; // 已经有一层浮层在：连点不再叠第二层
        final Dialog dlg = newDialog();
        if (dlg == null) return; // 上下文拿不到窗口（理论上不会走到）

        String cur = values.get(key);
        LinearLayout box = dialogBox();
        box.addView(dialogTitle("修改「" + key + "」的值"),
                new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        addTip(box, rangeTip());

        final EditText input = newInput(valueInputType(), valueHint());
        input.setText(cur == null ? "" : cur);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        ilp.topMargin = dp(Theme.S2);
        box.addView(input, ilp);

        final TextView err = errorPill();
        LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        elp.topMargin = dp(Theme.S1);
        box.addView(err, elp);

        LinearLayout bar = buttonBar(dlg, new Runnable() {
            @Override
            public void run() {
                String raw = textOf(input);
                String bad = checkValue(raw);
                if (bad != null) {
                    showError(err, bad);
                    return;
                }
                values.put(key, commitValue(raw));
                fire();
                rebuild();
                dlg.dismiss();
            }
        });
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        blp.topMargin = dp(Theme.S2);
        box.addView(bar, blp);

        show(dlg, box);
        focusAndShowKeyboard(input);
    }

    // ================================================================ 新增浮层

    private void showAddDialog() {
        if (open != null) return;
        final Dialog dlg = newDialog();
        if (dlg == null) return;

        LinearLayout box = dialogBox();
        box.addView(dialogTitle("添加一行"), new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        addTip(box, keyHint() + "：不能有空格或冒号，已有的键不会重复添加；" + rangeTip());

        final EditText keyIn = newInput(InputType.TYPE_CLASS_TEXT, keyHint());
        LinearLayout.LayoutParams klp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        klp.topMargin = dp(Theme.S2);
        box.addView(keyIn, klp);

        final EditText valIn = newInput(valueInputType(), valueHint());
        valIn.setText(defaultNewValue());
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        vlp.topMargin = dp(Theme.S1);
        box.addView(valIn, vlp);

        final TextView err = errorPill();
        LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        elp.topMargin = dp(Theme.S1);
        box.addView(err, elp);

        LinearLayout bar = buttonBar(dlg, new Runnable() {
            @Override
            public void run() {
                String k = textOf(keyIn);
                String bad = checkKey(k);
                if (bad == null && values.containsKey(k)) bad = "已经有这个键了：" + k;
                if (bad == null) bad = checkValue(textOf(valIn));
                if (bad != null) {
                    showError(err, bad);
                    return;
                }
                values.put(k, commitValue(textOf(valIn)));
                fire();
                rebuild();
                dlg.dismiss();
            }
        });
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        blp.topMargin = dp(Theme.S2);
        box.addView(bar, blp);

        show(dlg, box);
        focusAndShowKeyboard(keyIn);
    }

    private LinearLayout dialogBox() {
        LinearLayout box = Ui.column(ctx);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        return box;
    }

    private TextView dialogTitle(String text) {
        TextView v = Ui.strong(ctx, text, Theme.T_CARD, t.textPrimary);
        v.setLineSpacing(dp(2), 1f);
        return v;
    }

    private void addTip(LinearLayout box, String text) {
        if (text == null || text.length() == 0) return;
        TextView v = Ui.text(ctx, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(6);
        box.addView(v, lp);
    }

    /** 取消 / 确定。确定走 primary，取消留描边。 */
    private LinearLayout buttonBar(final Dialog dlg, final Runnable confirm) {
        LinearLayout bar = Ui.row(ctx);
        TextView cancel = Ui.button(ctx, t, "取消", false);
        cancel.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View v) {
                dlg.dismiss();
            }
        });
        TextView ok = Ui.button(ctx, t, "确定", true);
        ok.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View v) {
                confirm.run();
            }
        });
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        clp.weight = 1f;
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        olp.weight = 1f;
        olp.leftMargin = dp(Theme.S1);
        bar.addView(cancel, clp);
        bar.addView(ok, olp);
        return bar;
    }

    // ================================================================ 浮层外壳

    private Dialog newDialog() {
        Activity a = activityOf(ctx);
        if (a == null) return null;
        Dialog d = new Dialog(a);
        try {
            // 主题里若本来就带标题栏，这个调用会抛；抛了也不该把面板带崩 —— 大不了标题栏留空。
            d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        } catch (Throwable ignored) {
            // 忽略：内容是自己画的，有没有系统标题栏都不影响功能
        }
        d.setCanceledOnTouchOutside(true);
        return d;
    }

    /**
     * 浮层外壳：透明窗口 + 自己画的玻璃卡片。
     * 系统的窗口背景一律抹掉 —— 否则深色渐变上会多出一块方形底。
     *
     * <p>{@code SOFT_INPUT_ADJUST_RESIZE} 在 SDK 30+ 被标了 deprecated（那边改成靠 insets 自己算），
     * 但本 App 的 targetSdk 固定在 28，正是这个常量还在正常生效的分支，所以照用并就地抑制告警。
     */
    @SuppressWarnings("deprecation")
    private void show(final Dialog d, View content) {
        FrameLayout shell = new FrameLayout(ctx);
        shell.setPadding(dp(Theme.S2), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        FrameLayout card = Ui.card(ctx, t);
        card.addView(content, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        shell.addView(card, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        d.setContentView(shell);

        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(0x00000000));
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            w.setDimAmount(0.6f);
            // 键盘一弹就顶上来，别把输入框盖住
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE
                    | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            w.setLayout(MATCH_PARENT, WRAP_CONTENT);
        }
        d.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface x) {
                if (open == d) open = null;
            }
        });
        open = d;
        try {
            d.show();
        } catch (Throwable th) {
            open = null; // 没有可用的窗口：宁可不弹，也不能让面板崩
        }
    }

    private void dismissOpen() {
        Dialog d = open;
        open = null;
        if (d == null) return;
        try {
            d.dismiss();
        } catch (Throwable ignored) {
            // 已经没了就算了
        }
    }

    /** Context 可能是包装过的（ContextThemeWrapper 之类），沿 base 链找 Activity。 */
    private static Activity activityOf(Context c) {
        Context cur = c;
        for (int guard = 0; cur != null && guard < 8; guard++) {
            if (cur instanceof Activity) return (Activity) cur;
            if (!(cur instanceof ContextWrapper)) return null;
            Context next = ((ContextWrapper) cur).getBaseContext();
            if (next == cur) return null;
            cur = next;
        }
        return null;
    }

    // ================================================================ 输入件

    private EditText newInput(int inputType, String hint) {
        EditText e = new EditText(ctx);
        e.setTextSize(Theme.T_BODY);
        e.setTextColor(t.textPrimary);
        e.setHintTextColor(Ui.alpha(t.textSecondary, 0.75f));
        e.setBackground(Drawables.round(Ui.alpha(t.textPrimary, t.dark ? 0.08f : 0.05f),
                t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        e.setPadding(dp(Theme.S2), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        e.setSingleLine(true);
        e.setInputType(inputType);
        e.setHint(hint);
        e.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        return e;
    }

    private int valueInputType() {
        if (!f.mapValueNum) return InputType.TYPE_CLASS_TEXT;
        int type = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL;
        if (lo() < 0) type |= InputType.TYPE_NUMBER_FLAG_SIGNED;
        return type;
    }

    private TextView errorPill() {
        TextView v = Ui.text(ctx, "", Theme.T_CAP, t.toneStrong);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), Ui.alpha(t.accent, 0.30f),
                dp(1), dp(Theme.R_PILL)));
        v.setPadding(dp(10), dp(6), dp(10), dp(6));
        v.setLineSpacing(dp(2), 1f);
        v.setVisibility(GONE);
        return v;
    }

    private void showError(TextView pill, String msg) {
        if (pill == null) return;
        pill.setText(msg);
        pill.setVisibility(VISIBLE);
    }

    private void focusAndShowKeyboard(final EditText e) {
        if (e == null) return;
        e.requestFocus();
        cursorToEnd(e);
        e.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    InputMethodManager imm = (InputMethodManager)
                            ctx.getSystemService(Context.INPUT_METHOD_SERVICE);
                    if (imm != null && e.getWindowToken() != null) {
                        imm.showSoftInput(e, InputMethodManager.SHOW_IMPLICIT);
                    }
                } catch (Throwable ignored) {
                    // 键盘弹不出来不影响输入（用户自己点一下输入框即可）
                }
            }
        }, 150);
    }

    /** 光标挪到末尾，省得用户先点两下才能接着改。 */
    private static void cursorToEnd(EditText e) {
        try {
            CharSequence s = e.getText();
            e.setSelection(s == null ? 0 : s.length());
        } catch (Throwable ignored) {
            // 某些输入法会临时改 selection，失败无所谓
        }
    }

    private static String textOf(EditText e) {
        if (e == null) return "";
        CharSequence s = e.getText();
        return s == null ? "" : s.toString().trim();
    }

    // ================================================================ 值规则

    private String keyHint() {
        return f.mapKeyLabel == null || f.mapKeyLabel.length() == 0 ? "键" : f.mapKeyLabel;
    }

    private String valueHint() {
        return f.mapValueLabel == null || f.mapValueLabel.length() == 0 ? "值" : f.mapValueLabel;
    }

    /** 浮层里那行灰字：把量纲和区间说清楚，用户不用猜。 */
    private String rangeTip() {
        if (!f.mapValueNum) return "值按文本原样写回";
        String unit = unit();
        return (unit.length() == 0 ? "" : ("单位 " + unit + "，")) + "范围 "
                + BotConfigJson.pretty(lo(), 3) + " ~ " + BotConfigJson.pretty(hi(), 3);
    }

    private String defaultNewValue() {
        return f.mapValueNum ? BotConfigJson.pretty(lo(), 3) : "";
    }

    /** 键规则与写回时（屏幕侧 jsonOf）完全一致：非空、无空白、无冒号。 */
    private String checkKey(String k) {
        if (k == null || k.length() == 0) return "键不能为空";
        for (int i = 0; i < k.length(); i++) {
            char c = k.charAt(i);
            if (c == ':' || c == '\uFF1A') return "键里不能有冒号：" + k;
            if (Character.isWhitespace(c) || Character.isSpaceChar(c)) return "键里不能有空白：" + k;
        }
        return null;
    }

    /** 值规则：非空；数字型必须能写成合法 JSON 数字且在区间内。null = 通过。 */
    private String checkValue(String raw) {
        if (raw == null || raw.length() == 0) return "值不能为空";
        if (!f.mapValueNum) return null;
        String num = jsonNumberOrNull(raw);
        if (num == null) return "「" + raw + "」不是数字";
        double d;
        try {
            d = Double.parseDouble(num);
        } catch (NumberFormatException e) {
            return "「" + raw + "」不是数字";
        }
        if (d < lo() || d > hi()) {
            return "必须在 " + BotConfigJson.pretty(lo(), 3) + " ~ " + BotConfigJson.pretty(hi(), 3)
                    + " 之间（现在填的是 " + num + "）";
        }
        return null;
    }

    /** 校验通过后的落库文本：数字型统一成「合法 JSON 数字字面量」，别的原样。 */
    private String commitValue(String raw) {
        if (!f.mapValueNum) return raw == null ? "" : raw;
        String num = jsonNumberOrNull(raw);
        return num == null ? (raw == null ? "" : raw) : num;
    }

    /**
     * 把用户输入规整成<b>合法的 JSON 数字字面量</b>，不合法返回 null。
     *
     * <p>为什么不信手抄原文本：面板写回的是一整份 config.json，运行端用 {@code JSON.parse} 读。
     * {@code 010}、{@code 1.}、{@code +5}、{@code 1e999} 这些都不是合法 JSON 数字 ——
     * 抄进去会让<b>整份配置</b>解析失败（不是这一项没生效，是整个运行端起不来）。
     * 这里保留用户的字面量精度（不经过 double 再转回字符串），只修掉前导零这类致命形状。
     *
     * <p>屏幕侧 {@code jsonOf} 也用这个方法，保证「界面上看到的」和「写进去的」是同一个字符串。
     */
    public static String jsonNumberOrNull(String shown) {
        if (shown == null) return null;
        String s = shown.trim();
        int n = s.length();
        if (n == 0) return null;

        int i = 0;
        if (s.charAt(0) == '-') i++;
        int intStart = i;
        while (i < n && isDigit(s.charAt(i))) i++;
        if (i == intStart) return null; // 整数部分至少要有一位
        int intEnd = i;

        if (i < n && s.charAt(i) == '.') {
            i++;
            int fracStart = i;
            while (i < n && isDigit(s.charAt(i))) i++;
            if (i == fracStart) return null; // "1." 不是合法 JSON
        }
        if (i < n && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
            i++;
            if (i < n && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
            int expStart = i;
            while (i < n && isDigit(s.charAt(i))) i++;
            if (i == expStart) return null; // "1e" 不是合法 JSON
        }
        if (i != n) return null; // 中间出现别的字符（"+5"、"1,5"、"1 0" 都会到这里）

        // 前导零：JSON 不允许 010，这里无损去掉（保留至少一位）
        int z = intStart;
        while (z < intEnd - 1 && s.charAt(z) == '0') z++;
        String out = (z == intStart) ? s : (s.substring(0, intStart) + s.substring(z));

        try {
            double d = Double.parseDouble(out);
            if (Double.isNaN(d) || Double.isInfinite(d)) return null; // 1e999 会溢出成 Infinity
        } catch (NumberFormatException e) {
            return null;
        }
        return out;
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    // ================================================================ 杂项

    private void fire() {
        if (listener == null) return;
        listener.onChanged(entries());
    }

    private void delete(String key) {
        values.remove(key);
        fire();
        rebuild();
    }

    private int dp(float v) {
        return Ui.dp(ctx, v);
    }

    /**
     * 主题：屏幕侧会显式传 {@link Theme}，这个兜底只服务契约里那个不带 Theme 的构造式。
     * 只读偏好，不做任何写入（{@code ThemeStore} 的构造会顺手修 bg 状态，这里不想有副作用）。
     */
    private static Theme themeOf(Context c) {
        try {
            String id = c.getSharedPreferences("whaleonebot.ui", Context.MODE_PRIVATE)
                    .getString("theme", Theme.ALL[0].id);
            return Theme.byId(id);
        } catch (Throwable th) {
            return Theme.ALL[0];
        }
    }
}
