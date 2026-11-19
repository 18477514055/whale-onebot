package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 「按群设置」：给每个群单独定对话模式与回复概率。
 *
 * <p>用户 2026-11-18 的要求：不想所有群统一模式 —— 不同群人数、活跃度都不一样，
 * 要能逐群调；且「每群回复概率」要与白名单群**一一对应**（所以群清单直接取 {@code allow.groups}）。
 *
 * <p>写回的三个位置（都是运行端现成字段，不造新结构）：
 * <ul>
 *   <li>{@code conversation.unifiedMode} = false（要按群覆盖就必须先关掉统一模式）</li>
 *   <li>{@code conversation.groupModes[群号]} = legacy | threaded | lifecycle（跟随全局 = 删掉这个键）</li>
 *   <li>{@code store.groupSliderPos[群号]} = 0~100（该群的回复概率；100 = 每条都回）</li>
 * </ul>
 */
final class PerGroupScreen extends Screen {

    private static final String[] MODE_IDS = {"legacy", "threaded", "lifecycle"};
    private static final String[] MODE_NAMES = {"传统触发", "参与者续接", "完整生命周期"};

    private final BotConfigHost cfg;

    private Object data;
    private boolean loaded;
    private String loadError;

    /** 群号 → 模式 id（空串 = 跟随全局）；null 值不存，代表跟随全局。 */
    private final LinkedHashMap<String, String> modeDraft = new LinkedHashMap<String, String>();
    /** 群号 → 概率（显示值 0~100）。 */
    private final LinkedHashMap<String, Integer> probDraft = new LinkedHashMap<String, Integer>();
    private boolean unifiedOffDraft;

    private LinearLayout body;
    private FrameLayout overlay;

    PerGroupScreen(AppShell shell, BotConfigHost host) {
        super(shell);
        this.cfg = host;
    }

    @Override
    void build() {
        FrameLayout page = new FrameLayout(activity);
        root.addView(page, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        page.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        col.addView(header("按群设置"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        body = Ui.column(activity);
        col.addView(body, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 保存栏固定在页面底部（原来是跟内容一起滚，12 个群时要滚到底才看得见）。
        FrameLayout bar = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        TextView discard = Ui.button(activity, t, "放弃", false);
        discard.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loaded = false;
                modeDraft.clear();
                probDraft.clear();
                ensureLoaded();
                render();
            }
        });
        TextView save = Ui.button(activity, t, "保存", true);
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                save();
            }
        });
        row.addView(discard, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams slp2 = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        slp2.leftMargin = dp(Theme.S1);
        row.addView(save, slp2);
        bar.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        barLp.gravity = Gravity.BOTTOM;
        barLp.leftMargin = dp(Theme.S4);
        barLp.rightMargin = dp(Theme.S4);
        barLp.bottomMargin = dp(Theme.S3);
        page.addView(bar, barLp);

        // 覆盖层（改一行的浮层）挂最上层，点外面关掉。
        overlay = new FrameLayout(activity);
        overlay.setVisibility(View.GONE);
        overlay.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeOverlay();
            }
        });
        page.addView(overlay, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        ensureLoaded();
        render();
    }

    // ------------------------------------------------------------------ 数据

    private void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        try {
            String json = cfg == null ? null : cfg.loadConfigJson();
            if (json == null) {
                loadError = "读不到 config.json";
                return;
            }
            data = BotConfigJson.parse(json);
            Object groups = BotConfigJson.get(data, "allow.groups");
            List<Object> list = BotConfigJson.asArray(groups);
            String unified = text("conversation.mode");
            Object um = BotConfigJson.get(data, "conversation.unifiedMode");
            unifiedOffDraft = !(um instanceof Boolean) || !((Boolean) um).booleanValue() || list == null;
            Object modes = BotConfigJson.get(data, "conversation.groupModes");
            Map<String, Object> gm = BotConfigJson.asObject(modes);
            Object pos = BotConfigJson.get(data, "store.groupSliderPos");
            Map<String, Object> ps = BotConfigJson.asObject(pos);
            int fallback = intOf(BotConfigJson.get(data, "store.randomPercent"), 5);
            for (int i = 0; list != null && i < list.size(); i++) {
                String id = list.get(i) == null ? "" : String.valueOf(list.get(i)).trim();
                if (id.length() == 0) continue;
                String mode = gm == null ? null : str(gm.get(id));
                modeDraft.put(id, mode == null ? "" : mode);
                probDraft.put(id, ps != null && ps.get(id) != null
                        ? intOf(ps.get(id), fallback) : fallback);
            }
        } catch (Throwable t) {
            loadError = "读不到 config.json";
        }
    }

    private String text(String path) {
        Object v = BotConfigJson.get(data, path);
        return v instanceof String ? (String) v : "";
    }

    private static String str(Object v) {
        return v instanceof String ? (String) v : "";
    }

    private static int intOf(Object v, int fallback) {
        double d = BotConfigJson.numOf(v);
        if (Double.isNaN(d)) return fallback;
        int n = (int) Math.round(d);
        if (n < 0) return 0;
        return Math.min(n, 100);
    }

    // ------------------------------------------------------------------ 渲染

    private void render() {
        body.removeAllViews();

        if (loadError != null) {
            body.addView(Ui.text(activity, loadError, Theme.T_BODY, t.textPrimary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return;
        }
        if (modeDraft.isEmpty()) {
            body.addView(Ui.text(activity, "白名单里还没有群", Theme.T_BODY, t.textSecondary),
                    Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return;
        }

        String globalMode = modeName(text("conversation.mode"));
        TextView note = Ui.text(activity, "全局默认：" + globalMode
                + (unifiedOffDraft ? "" : "（当前所有群统一，保存后按群生效）"),
                Theme.T_CAP, t.textTertiary);
        body.addView(note, marginTop(Theme.S1));

        for (Iterator it = new Iterator(modeDraft.keySet()); it.hasNext(); ) {
            final String id = it.next();
            body.addView(groupCard(id), marginTop(Theme.S2));
        }
        // 底部给固定保存栏留出空间，免得最后一行被压住
        View spacer = new View(activity);
        body.addView(spacer, Ui.llp(MATCH_PARENT, dp(Theme.TOUCH + Theme.S4)));
    }

    private View groupCard(final String id) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S2 + 2), dp(Theme.S2 + 2));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout box = Ui.column(activity);
        TextView name = Ui.strong(activity, id, Theme.T_CARD, t.textPrimary);
        box.addView(name, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        String mode = modeDraft.get(id);
        String shown = mode == null || mode.length() == 0 ? "跟随全局" : modeName(mode);
        Integer p = probDraft.get(id);
        TextView sub = Ui.text(activity, shown + " · " + (p == null ? 0 : p) + "%", Theme.T_CAP, t.textSecondary);
        box.addView(sub, marginTop(Theme.S1));
        row.addView(box, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openEditor(id);
            }
        });
        return card;
    }

    // ------------------------------------------------------------------ 单群编辑浮层

    private void openEditor(final String id) {
        overlay.removeAllViews();
        overlay.setBackgroundColor(0x99000000);
        overlay.setVisibility(View.VISIBLE);

        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S3));
        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        box.addView(Ui.strong(activity, "群 " + id, Theme.T_CARD, t.textPrimary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 模式：4 个胶囊，2×2 排（一行放不下，「完整生命周期」会被挤出去）
        box.addView(Ui.text(activity, "对话模式", Theme.T_CAP, t.textTertiary), marginTop(Theme.S3));
        final String curMode = modeDraft.get(id) == null ? "" : modeDraft.get(id);
        final TextView[] chipViews = new TextView[4];
        final String[] ids = {"", MODE_IDS[0], MODE_IDS[1], MODE_IDS[2]};
        final String[] names = {"跟随全局", MODE_NAMES[0], MODE_NAMES[1], MODE_NAMES[2]};
        final String[] picked = {curMode};
        for (int rowIdx = 0; rowIdx < 2; rowIdx++) {
            LinearLayout chips = Ui.row(activity);
            chips.setPadding(0, dp(rowIdx == 0 ? 6 : 6), 0, 0);
            for (int col = 0; col < 2; col++) {
                final int i = rowIdx * 2 + col;
                final int idx = i;
                TextView chip = Ui.text(activity, names[i], Theme.T_CAP, t.textPrimary);
                chip.setPadding(dp(12), dp(8), dp(12), dp(8));
                chip.setGravity(Gravity.CENTER);
                chip.setClickable(true);
                chip.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        picked[0] = ids[idx];
                        for (int k = 0; k < chipViews.length; k++) {
                            boolean on = k == idx;
                            chipViews[k].setBackground(Drawables.round(on ? t.accent : t.ghostFill,
                                    on ? 0 : t.ghostStroke, dp(1), dp(Theme.R_PILL)));
                            chipViews[k].setTextColor(on ? t.onAccent : t.textPrimary);
                        }
                    }
                });
                chipViews[i] = chip;
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
                if (col > 0) lp.leftMargin = dp(6);
                chips.addView(chip, lp);
            }
            LinearLayout.LayoutParams rowLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            rowLp.topMargin = dp(6);
            box.addView(chips, rowLp);
        }
        // 初始态
        for (int k = 0; k < ids.length; k++) {
            boolean on = ids[k].equals(curMode);
            chipViews[k].setBackground(Drawables.round(on ? t.accent : t.ghostFill,
                    on ? 0 : t.ghostStroke, dp(1), dp(Theme.R_PILL)));
            chipViews[k].setTextColor(on ? t.onAccent : t.textPrimary);
        }

        // 概率
        box.addView(Ui.text(activity, "回复概率 %（0~100）", Theme.T_CAP, t.textTertiary), marginTop(Theme.S3));
        final EditText input = new EditText(activity);
        input.setText(String.valueOf(probDraft.get(id) == null ? 0 : probDraft.get(id)));
        input.setTextSize(Theme.T_BODY);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        input.setTextColor(t.textPrimary);
        input.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        input.setPadding(dp(12), dp(8), dp(12), dp(8));
        box.addView(input, marginTop(Theme.S1));

        LinearLayout bar = Ui.row(activity);
        TextView cancel = Ui.button(activity, t, "取消", false);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeOverlay();
            }
        });
        TextView ok = Ui.button(activity, t, "确定", true);
        ok.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String raw = input.getText() == null ? "" : input.getText().toString().trim();
                int p;
                try {
                    p = Integer.parseInt(raw);
                } catch (NumberFormatException e) {
                    host().toast("概率要填 0~100 的数字");
                    return;
                }
                if (p < 0 || p > 100) {
                    host().toast("概率要在 0~100 之间");
                    return;
                }
                modeDraft.put(id, picked[0]);
                probDraft.put(id, p);
                closeOverlay();
                render();
            }
        });
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        olp.leftMargin = dp(Theme.S1);
        bar.addView(cancel, blp);
        bar.addView(ok, olp);
        box.addView(bar, marginTop(Theme.S3));

        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                Math.min(dp(Theme.S4 * 10), activity.getResources().getDisplayMetrics().widthPixels - dp(Theme.S4) * 2),
                WRAP_CONTENT);
        clp.gravity = Gravity.CENTER;
        overlay.addView(card, clp);
        // 卡片自己吃掉点击，别让外面的"点空白关闭"把编辑打断
        card.setClickable(true);
    }

    private void closeOverlay() {
        overlay.setVisibility(View.GONE);
        overlay.removeAllViews();
    }

    // ------------------------------------------------------------------ 保存

    private void save() {
        try {
            Object out = BotConfigJson.deepCopy(data);
            // 1) 关掉统一模式（否则 groupModes 不生效）
            BotConfigJson.set(out, "conversation.unifiedMode", Boolean.FALSE);
            // 2) 逐群模式：跟随全局 = 删键
            for (Map.Entry<String, String> e : modeDraft.entrySet()) {
                String mode = e.getValue();
                if (mode == null || mode.length() == 0) {
                    removeKey(out, "conversation.groupModes", e.getKey());
                } else {
                    setObjectKey(out, "conversation.groupModes", e.getKey(), mode);
                }
            }
            // 3) 逐群概率
            for (Map.Entry<String, Integer> e : probDraft.entrySet()) {
                setObjectKey(out, "store.groupSliderPos", e.getKey(),
                        new BotConfigJson.Num(String.valueOf(e.getValue())));
            }
            String json = BotConfigJson.write(out);
            if (!cfg.saveConfigJson(json)) {
                host().toast("保存失败，改动还在");
                return;
            }
            loaded = false;
            data = out;
            loaded = true;
            host().toast("已保存");
            render();
        } catch (Throwable th) {
            host().toast("保存失败：" + (th.getMessage() == null ? th.getClass().getSimpleName() : th.getMessage()));
        }
    }

    /** 在 parent 对象里写一个键（对象不存在就建）。 */
    private void setObjectKey(Object root, String parentPath, String key, Object value) {
        Object parent = BotConfigJson.get(root, parentPath);
        if (!(parent instanceof Map)) {
            Map<String, Object> created = new LinkedHashMap<String, Object>();
            BotConfigJson.set(root, parentPath, created);
            parent = created;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> map = (Map<String, Object>) parent;
        map.put(key, value);
    }

    private void removeKey(Object root, String parentPath, String key) {
        Object parent = BotConfigJson.get(root, parentPath);
        if (parent instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) parent;
            map.remove(key);
        }
    }

    // ------------------------------------------------------------------ 小工具

    private static String modeName(String id) {
        if ("legacy".equals(id)) return "传统触发";
        if ("threaded".equals(id)) return "参与者续接";
        if ("lifecycle".equals(id)) return "完整生命周期";
        return "跟随全局";
    }

    private LinearLayout.LayoutParams marginTop(int token) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(token);
        return lp;
    }

    /** 极简迭代器：只为把 keySet 的顺序遍历写成 for 语句（避免 import 额外集合）。 */
    private static final class Iterator {
        private final java.util.Iterator<String> it;

        Iterator(java.util.Set<String> keys) {
            this.it = keys.iterator();
        }

        boolean hasNext() {
            return it.hasNext();
        }

        String next() {
            return it.next();
        }
    }
}

