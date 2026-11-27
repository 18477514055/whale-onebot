package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板子页共用的**积木**：玻璃卡、行、分面胶囊、数值缩写。
 *
 * <p>为什么不各页各写一套：四个子页（会话 / 调用 / 记忆 / 观测）的骨架是一样的 ——
 * 标题 + 若干行 + 页面内切面，只有数据源不同。收在一处之后，各页只剩下"取数 + 填行"。
 * 风格令牌一律从 {@link Theme} 与 {@link Ui} 取，不新增颜色/圆角。
 */
final class DashKit {

    private DashKit() {
    }

    /** 一张卡：标题在左、可选右侧小字，返回 body 供加行。 */
    static final class Card {
        final FrameLayout view;
        final LinearLayout body;

        Card(FrameLayout view, LinearLayout body) {
            this.view = view;
            this.body = body;
        }
    }

    static Card card(Context c, Theme t, String title, String right) {
        FrameLayout card = Ui.card(c, t);
        LinearLayout box = ModelsScreen.W.box(c);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout head = Ui.row(c);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        tlp.weight = 1f;
        head.addView(Ui.strong(c, title, Theme.T_CARD, t.textPrimary), tlp);
        if (right != null && right.length() > 0) {
            TextView r = Ui.text(c, right, Theme.T_CAP, t.textSecondary);
            r.setSingleLine(true);
            head.addView(r, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        }
        box.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout holder = Ui.column(c);
        box.addView(holder, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), Ui.dp(c, Theme.S2)));
        return new Card(card, holder);
    }

    /** 一行：左标题（可带副标题）+ 右值（可带箭头）。click 可为 null。 */
    static void row(Context c, Theme t, LinearLayout parent, String title, String sub,
                    String right, boolean chevron, View.OnClickListener click) {
        LinearLayout row = Ui.row(c);
        row.setMinimumHeight(Ui.dp(c, Theme.TOUCH));
        row.setPadding(0, Ui.dp(c, 8), 0, Ui.dp(c, 8));
        row.setBackground(Drawables.stateful(
                Drawables.round(0, 0, 0, Ui.dp(c, Theme.R_TILE)),
                Drawables.round(Ui.alpha(t.textPrimary, 0.06f), 0, 0, Ui.dp(c, Theme.R_TILE))));

        LinearLayout txt = Ui.column(c);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        tlp.weight = 1f;
        tlp.rightMargin = Ui.dp(c, Theme.S2);
        row.addView(txt, tlp);

        TextView head = Ui.text(c, title == null ? "" : title, Theme.T_BODY, t.textPrimary);
        head.setSingleLine(true);
        head.setEllipsize(android.text.TextUtils.TruncateAt.END);
        txt.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (sub != null && sub.length() > 0) {
            TextView s = Ui.text(c, sub, Theme.T_CAP, t.textSecondary);
            s.setLineSpacing(Ui.dp(c, 2), 1f);
            s.setMaxLines(2);
            s.setEllipsize(android.text.TextUtils.TruncateAt.END);
            txt.addView(s, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), Ui.dp(c, 3)));
        }

        if (right != null && right.length() > 0) {
            TextView r = Ui.text(c, right, Theme.T_CAP, t.textSecondary);
            r.setSingleLine(true);
            r.setGravity(Gravity.END);
            row.addView(r, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        }
        if (chevron) {
            row.addView(new IconView(c, IconView.CHEV_R, t.textTertiary),
                    mt(Ui.llp(Ui.dp(c, 20), Ui.dp(c, 20)), 0));
        }

        if (click != null) {
            row.setClickable(true);
            row.setFocusable(true);
            row.setOnClickListener(click);
            Ui.press(row, 0.985f);
        }
        parent.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    /** 纯文字行（左右两段，不可点）。 */
    static void kv(Context c, Theme t, LinearLayout parent, String k, String v) {
        LinearLayout row = Ui.row(c);
        row.setPadding(0, Ui.dp(c, 6), 0, Ui.dp(c, 6));

        TextView key = Ui.text(c, k == null ? "" : k, Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams klp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        klp.weight = 1f;
        row.addView(key, klp);

        TextView val = Ui.text(c, v == null ? "—" : v, Theme.T_CAP, t.textPrimary);
        val.setSingleLine(true);
        val.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        vlp.weight = 1.6f;
        vlp.leftMargin = Ui.dp(c, Theme.S2);
        val.setGravity(Gravity.END);
        row.addView(val, vlp);
        parent.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    /** 多行文本块（可换行，用于 content / trigger / message）。 */
    static void block(Context c, Theme t, LinearLayout parent, String text) {
        TextView v = Ui.text(c, text == null ? "" : text, Theme.T_CAP, t.textPrimary);
        v.setLineSpacing(Ui.dp(c, 3), 1f);
        parent.addView(v, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), Ui.dp(c, Theme.S1)));
    }

    static void divider(Context c, Theme t, LinearLayout parent) {
        parent.addView(ModelsScreen.W.divider(c, t), Ui.llp(MATCH_PARENT, Ui.dp(c, 1)));
    }

    /** 页内分面胶囊：横向一排，选中态用 accent 实心。 */
    static LinearLayout facets(Context c, Theme t, String[] labels, int selected, final OnFacet cb) {
        LinearLayout bar = Ui.row(c);
        for (int i = 0; i < labels.length; i++) {
            final int idx = i;
            TextView chip = Ui.text(c, labels[i], Theme.T_CAP,
                    i == selected ? t.onAccent : t.textSecondary);
            if (i == selected) chip.setTypeface(Typeface.DEFAULT_BOLD);
            chip.setGravity(Gravity.CENTER);
            chip.setSingleLine(true);
            chip.setPadding(Ui.dp(c, 10), Ui.dp(c, 8), Ui.dp(c, 10), Ui.dp(c, 8));
            chip.setBackground(Drawables.stateful(
                    Drawables.round(i == selected ? t.accent : t.ghostFill,
                            i == selected ? 0 : t.ghostStroke, Ui.dp(c, 1), Ui.dp(c, Theme.R_PILL)),
                    Drawables.round(i == selected ? Ui.pressedOf(t, t.accent) : Ui.pressedOf(t, t.ghostFill),
                            i == selected ? 0 : t.ghostStroke, Ui.dp(c, 1), Ui.dp(c, Theme.R_PILL))));
            chip.setClickable(true);
            chip.setFocusable(true);
            chip.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (cb != null) cb.onFacet(idx);
                }
            });
            Ui.press(chip, 0.96f);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
            lp.weight = 1f;
            if (i > 0) lp.leftMargin = Ui.dp(c, Theme.S1);
            bar.addView(chip, lp);
        }
        return bar;
    }

    interface OnFacet {
        void onFacet(int index);
    }

    /** 分页按钮条：左「上一页」右「下一页」。 */
    static LinearLayout pager(Context c, Theme t, String label, boolean prevOn, boolean nextOn,
                              View.OnClickListener prev, View.OnClickListener next) {
        LinearLayout bar = Ui.row(c);
        TextView p = Ui.button(c, t, "上一页", false);
        p.setEnabled(prevOn);
        p.setAlpha(prevOn ? 1f : 0.4f);
        if (prevOn && prev != null) p.setOnClickListener(prev);

        TextView mid = Ui.text(c, label == null ? "" : label, Theme.T_CAP, t.textSecondary);
        mid.setSingleLine(true);
        mid.setGravity(Gravity.CENTER);

        TextView n = Ui.button(c, t, "下一页", false);
        n.setEnabled(nextOn);
        n.setAlpha(nextOn ? 1f : 0.4f);
        if (nextOn && next != null) n.setOnClickListener(next);

        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        plp.weight = 1f;
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        mlp.weight = 1.2f;
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        nlp.weight = 1f;
        nlp.leftMargin = Ui.dp(c, Theme.S1);
        bar.addView(p, plp);
        bar.addView(mid, mlp);
        bar.addView(n, nlp);
        return bar;
    }

    static LinearLayout.LayoutParams mt(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }

    /** 任意 JSON 值 → 一段可读文本（对象写成 `k=v · k=v`，数组写成 `a, b`）。 */
    static String textOf(Object v) {
        if (v == null || v == BotConfigJson.MISSING || v == BotConfigJson.NULL) return "";
        Map<String, Object> m = BotConfigJson.asObject(v);
        if (m != null) {
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, Object> e : m.entrySet()) {
                Object val = e.getValue();
                if (val instanceof Map || val instanceof java.util.List) continue;
                if (sb.length() > 0) sb.append(" · ");
                sb.append(e.getKey()).append('=').append(String.valueOf(val));
            }
            return sb.toString();
        }
        java.util.List<Object> list = BotConfigJson.asArray(v);
        if (list != null) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(String.valueOf(list.get(i)));
            }
            return sb.toString();
        }
        return ModelsScreen.U.s(v);
    }

    /** 截断（含省略号）。 */
    static String cut(String s, int n) {
        if (s == null) return "";
        String v = s.replace('\n', ' ').trim();
        return v.length() <= n ? v : v.substring(0, n) + "…";
    }

    /** 数字缩写：1234 → 1.2k，1234567 → 1.23M。 */
    static String km(double n) {
        if (Double.isNaN(n)) return "—";
        if (n < 1000) return String.valueOf((long) n);
        if (n < 1000000) return String.format(java.util.Locale.US, "%.1fk", n / 1000.0);
        return String.format(java.util.Locale.US, "%.2fM", n / 1000000.0);
    }

    /** 自动同步全 App 群名与昵称目录：「群名（群号）」/「群 <群号>」/「私聊 昵称（QQ号）」。 */
    static String chatLabel(String key) {
        return NameDirectory.formatChat(key);
    }

    /** 包一层可滚动的页面：col 由调用方塞内容。 */
    static android.widget.ScrollView scroll(Context c, LinearLayout col) {
        android.widget.ScrollView s = new android.widget.ScrollView(c);
        s.setFillViewport(true);
        s.setClipChildren(false);
        s.setVerticalScrollBarEnabled(false);
        s.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return s;
    }
}
