package com.whaleonebot.ui;

import android.text.InputType;
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
 * 「按群设置」：独立单群详情子页架构（告别弹窗遮挡），支持：
 * <ul>
 *   <li>非 Hook 一键刷新全部群名（Web CGI 优先）+ 本地群名缓存 + 手动修改群备注；</li>
 *   <li>锁定「完整生命周期」模式，逐群精调回复概率（0~100）、被 @ 冷却、戳一戳冷却；</li>
 *   <li>逐群独立人设覆盖（{@code personaPerChat["group:<id>"]}）与记忆隔离开关；</li>
 *   <li>保存后严格保持当前滚动位置不回顶。</li>
 * </ul>
 */
final class PerGroupScreen extends Screen {

    private final BotConfigHost cfg;

    private Object data;
    private boolean loaded;
    private String loadError;
    private boolean refreshingNames = false;

    /** 当前点进编辑的群号；null = 群列表页，非空 = 独立单群设置子页。 */
    private String selectedGroupId = null;

    /** 群号 → 概率（0~100）。 */
    private final LinkedHashMap<String, Integer> probDraft = new LinkedHashMap<String, Integer>();
    /** 群号 → 被 @ 冷却（秒；null = 跟随全局，0 = 不限制）。 */
    private final LinkedHashMap<String, Integer> mentionCdDraft = new LinkedHashMap<String, Integer>();
    /** 群号 → 戳一戳冷却（秒；null = 跟随全局，0 = 不限制）。 */
    private final LinkedHashMap<String, Integer> pokeCdDraft = new LinkedHashMap<String, Integer>();
    /** 群号 → 独立人设模板 id / 名称（空串 = 跟随全局人设）。 */
    private final LinkedHashMap<String, String> personaDraft = new LinkedHashMap<String, String>();
    /** 群号 → 独立记忆隔离标志（true = 仅使用本群记忆，false = 默认全局/共享）。 */
    private final LinkedHashMap<String, Boolean> isolatedMemDraft = new LinkedHashMap<String, Boolean>();

    private ScrollView pageScroll;
    private int savedListScrollY = 0;
    private int savedDetailScrollY = 0;
    private LinearLayout body;
    private FrameLayout bottomBar;

    // 详情子页输入控件引用（用于保存前同步草稿）
    private EditText detailProbInput;
    private EditText detailMentionInput;
    private EditText detailPokeInput;

    PerGroupScreen(AppShell shell, BotConfigHost host) {
        super(shell);
        this.cfg = host;
    }

    @Override
    void build() {
        root.removeAllViews();
        FrameLayout page = new FrameLayout(activity);
        root.addView(page, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));

        pageScroll = new ScrollView(activity);
        pageScroll.setFillViewport(true);
        pageScroll.setVerticalScrollBarEnabled(false);
        pageScroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        page.addView(pageScroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        body = Ui.column(activity);
        col.addView(body, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 底部固定保存栏（保存后严格保持当前滚动位置，绝不跳回顶部）
        bottomBar = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        TextView discard = Ui.button(activity, t, "重新载入", false);
        discard.setOnClickListener(v -> {
            loaded = false;
            probDraft.clear();
            mentionCdDraft.clear();
            pokeCdDraft.clear();
            personaDraft.clear();
            isolatedMemDraft.clear();
            ensureLoaded();
            render();
            host().toast("已恢复为已保存配置");
        });
        TextView saveBtn = Ui.button(activity, t, "保存配置", true);
        saveBtn.setOnClickListener(v -> {
            if (selectedGroupId != null && !applyDetailInputs(selectedGroupId)) return;
            save();
        });
        row.addView(discard, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        slp.leftMargin = dp(Theme.S1);
        row.addView(saveBtn, slp);
        bottomBar.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        barLp.gravity = Gravity.BOTTOM;
        barLp.leftMargin = dp(Theme.S4);
        barLp.rightMargin = dp(Theme.S4);
        barLp.bottomMargin = dp(Theme.S3);
        page.addView(bottomBar, barLp);

        ensureLoaded();
        render();
    }

    @Override
    boolean handleBack() {
        if (selectedGroupId != null) {
            applyDetailInputs(selectedGroupId);
            selectedGroupId = null;
            savedDetailScrollY = 0;
            render();
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ 数据

    private void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        loadError = null;
        try {
            String json = cfg == null ? null : cfg.loadConfigJson();
            if (json == null || json.trim().isEmpty()) {
                loadError = "读不到 config.json";
                return;
            }
            data = BotConfigJson.parse(json);
            List<Object> list = BotConfigJson.asArray(BotConfigJson.get(data, "allow.groups"));
            Map<String, Object> ps = BotConfigJson.asObject(BotConfigJson.get(data, "store.groupSliderPos"));
            Map<String, Object> mcd = BotConfigJson.asObject(BotConfigJson.get(data, "conversation.groupMentionCooldownSec"));
            Map<String, Object> pcd = BotConfigJson.asObject(BotConfigJson.get(data, "conversation.groupPokeCooldownSec"));
            Map<String, Object> ppc = BotConfigJson.asObject(BotConfigJson.get(data, "personaPerChat"));
            Map<String, Object> mpc = BotConfigJson.asObject(BotConfigJson.get(data, "memoryPerChat"));
            int fallback = intOf(BotConfigJson.get(data, "store.contextSliderPos"),
                    intOf(BotConfigJson.get(data, "store.randomPercent"), 5));

            probDraft.clear();
            mentionCdDraft.clear();
            pokeCdDraft.clear();
            personaDraft.clear();
            isolatedMemDraft.clear();

            for (int i = 0; list != null && i < list.size(); i++) {
                String id = list.get(i) == null ? "" : String.valueOf(list.get(i)).trim();
                if (id.isEmpty()) continue;
                probDraft.put(id, ps != null && ps.get(id) != null ? intOf(ps.get(id), fallback) : fallback);
                mentionCdDraft.put(id, mcd != null ? optCooldown(mcd.get(id)) : null);
                pokeCdDraft.put(id, pcd != null ? optCooldown(pcd.get(id)) : null);

                String pTpl = "";
                if (ppc != null) {
                    Map<String, Object> gp = BotConfigJson.asObject(ppc.get("group:" + id));
                    if (gp != null) {
                        pTpl = str(gp.get("templateId")).trim();
                        if (pTpl.isEmpty()) pTpl = str(gp.get("botName")).trim();
                    }
                }
                personaDraft.put(id, pTpl);

                boolean iso = false;
                if (mpc != null) {
                    Map<String, Object> gm = BotConfigJson.asObject(mpc.get("group:" + id));
                    if (gm != null && Boolean.TRUE.equals(gm.get("isolated"))) iso = true;
                }
                isolatedMemDraft.put(id, iso);
            }
        } catch (Throwable ex) {
            loadError = "读取配置失败：" + ex.getMessage();
        }
    }

    // ------------------------------------------------------------------ 渲染

    private void render() {
        if (body == null) return;
        if (pageScroll != null) {
            if (selectedGroupId == null) savedListScrollY = pageScroll.getScrollY();
            else savedDetailScrollY = pageScroll.getScrollY();
        }
        detailProbInput = null;
        detailMentionInput = null;
        detailPokeInput = null;
        body.removeAllViews();

        if (selectedGroupId != null) {
            renderGroupDetail(selectedGroupId);
        } else {
            renderGroupList();
        }

        View spacer = new View(activity);
        body.addView(spacer, Ui.llp(MATCH_PARENT, dp(Theme.TOUCH + Theme.S4 + 16)));

        final int targetY = selectedGroupId == null ? savedListScrollY : savedDetailScrollY;
        if (pageScroll != null) {
            pageScroll.post(() -> { if (pageScroll != null) pageScroll.scrollTo(0, targetY); });
        }
    }

    private void renderGroupList() {
        body.addView(header("按群设置"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (loadError != null) {
            body.addView(Ui.text(activity, loadError, Theme.T_BODY, t.textPrimary), marginTop(Theme.S2));
            return;
        }

        // 顶部群名刷新卡
        FrameLayout topCard = Ui.card(activity, t);
        LinearLayout topBox = Ui.column(activity);
        topBox.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S3), dp(Theme.S2));
        TextView refreshBtn = Ui.button(activity, t,
                refreshingNames ? "正在刷新群名…" : "刷新群名并同步全应用", false);
        Ui.enabled(refreshBtn, !refreshingNames);
        refreshBtn.setOnClickListener(v -> {
            refreshingNames = true;
            render();
            WhitelistPicker.refreshAllGroupNames(activity, count -> {
                refreshingNames = false;
                host().toast(count > 0 ? ("已刷新 " + count + " 个群名") : "已完成同步（未拉取到的群可点进手动设备注）");
                render();
            });
        });
        topBox.addView(refreshBtn, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        topCard.addView(topBox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        body.addView(topCard, marginTop(Theme.S2));

        if (probDraft.isEmpty()) {
            body.addView(Ui.text(activity, "群白名单为空。",
                    Theme.T_BODY, t.textSecondary), marginTop(Theme.S3));
            return;
        }

        NameDirectory.init(activity);
        for (String id : probDraft.keySet()) {
            body.addView(groupCard(id), marginTop(Theme.S2));
        }
    }

    private View groupCard(final String id) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S2 + 2), dp(Theme.S2 + 2));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout box = Ui.column(activity);
        box.addView(Ui.strong(activity, NameDirectory.formatGroup(id), Theme.T_BODY, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        Integer p = probDraft.get(id);
        Integer mcd = mentionCdDraft.get(id);
        Integer pcd = pokeCdDraft.get(id);
        String pTpl = personaDraft.get(id);
        boolean iso = Boolean.TRUE.equals(isolatedMemDraft.get(id));

        StringBuilder meta = new StringBuilder();
        meta.append("概率 ").append(p == null ? 0 : p).append("%");
        if (mcd != null) meta.append(" · @冷却 ").append(mcd == 0 ? "关" : (mcd + "s"));
        if (pcd != null) meta.append(" · 戳冷却 ").append(pcd == 0 ? "关" : (pcd + "s"));
        if (pTpl != null && !pTpl.isEmpty()) meta.append(" · 人设 ").append(pTpl);
        if (iso) meta.append(" · 独立记忆");
        box.addView(Ui.text(activity, meta.toString(), Theme.T_CAP, t.textSecondary), marginTop(Theme.S1));
        row.addView(box, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(v -> {
            if (pageScroll != null) savedListScrollY = pageScroll.getScrollY();
            selectedGroupId = id;
            savedDetailScrollY = 0;
            render();
        });
        return card;
    }

    // ------------------------------------------------------------------ 独立单群设置子页

    private void renderGroupDetail(final String id) {
        String name = WhitelistPicker.cachedGroupName(activity, id);
        String title = name.isEmpty() ? ("群 " + id) : name;
        body.addView(header(title), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 卡 1：群身份与本地备注
        FrameLayout idCard = Ui.card(activity, t);
        LinearLayout idBox = Ui.column(activity);
        idBox.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        idBox.addView(Ui.strong(activity, "群号：" + id, Theme.T_BODY, t.textPrimary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        idBox.addView(Ui.text(activity, name.isEmpty() ? "当前无缓存群名（可手动设备注或回列表刷新）" : ("展示名称：" + name),
                Theme.T_CAP, t.textSecondary), marginTop(4));
        TextView remarkBtn = Ui.button(activity, t, "修改本群备注名", false);
        remarkBtn.setOnClickListener(v -> ModelsScreen.W.textDialog(activity, t, "修改群备注（群 " + id + "）",
                "仅保存于本机，优先于拉取群名展示；留空则恢复默认", name, InputType.TYPE_CLASS_TEXT, false, null,
                val -> {
                    WhitelistPicker.saveGroupRemark(activity, id, val);
                    host().toast("已更新群备注");
                    render();
                }));
        idBox.addView(remarkBtn, marginTop(Theme.S2));
        idCard.addView(idBox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        body.addView(idCard, marginTop(Theme.S2));

        // 卡 2：回复概率与冷却
        FrameLayout freqCard = Ui.card(activity, t);
        LinearLayout freqBox = Ui.column(activity);
        freqBox.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        freqBox.addView(Ui.strong(activity, "回复概率与冷却", Theme.T_CARD, t.textPrimary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        freqBox.addView(Ui.text(activity, "回复概率 %（0 = 仅响应 @ 与关键词，100 = 每条都回）", Theme.T_CAP, t.textSecondary), marginTop(Theme.S2));
        detailProbInput = numBox(String.valueOf(probDraft.get(id) == null ? 0 : probDraft.get(id)), "0~100");
        freqBox.addView(detailProbInput, marginTop(Theme.S1));

        freqBox.addView(Ui.text(activity, "被 @ 最小回复间隔（秒，留空=跟随全局，0=不限制）", Theme.T_CAP, t.textSecondary), marginTop(Theme.S2));
        Integer curMcd = mentionCdDraft.get(id);
        detailMentionInput = numBox(curMcd == null ? "" : String.valueOf(curMcd), "留空跟随全局");
        freqBox.addView(detailMentionInput, marginTop(Theme.S1));

        freqBox.addView(Ui.text(activity, "戳一戳最小回复间隔（秒，留空=跟随全局，0=不限制）", Theme.T_CAP, t.textSecondary), marginTop(Theme.S2));
        Integer curPcd = pokeCdDraft.get(id);
        detailPokeInput = numBox(curPcd == null ? "" : String.valueOf(curPcd), "留空跟随全局");
        freqBox.addView(detailPokeInput, marginTop(Theme.S1));

        freqCard.addView(freqBox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        body.addView(freqCard, marginTop(Theme.S2));

        // 卡 3：本群专属人设与记忆范围
        FrameLayout extCard = Ui.card(activity, t);
        LinearLayout extBox = Ui.column(activity);
        extBox.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        extBox.addView(Ui.strong(activity, "专属人设与记忆范围", Theme.T_CARD, t.textPrimary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        final String curPersona = personaDraft.get(id) == null ? "" : personaDraft.get(id);
        extBox.addView(Ui.text(activity, "当前人设：" + (curPersona.isEmpty() ? "跟随全局默认人设" : curPersona),
                Theme.T_CAP, t.textSecondary), marginTop(Theme.S1));
        TextView pickPersonaBtn = Ui.button(activity, t, "选择本群专属人设", false);
        pickPersonaBtn.setOnClickListener(v -> {
            applyDetailInputs(id);
            choosePersonaForGroup(id);
        });
        extBox.addView(pickPersonaBtn, marginTop(Theme.S2));

        final boolean iso = Boolean.TRUE.equals(isolatedMemDraft.get(id));
        extBox.addView(ModelsScreen.W.switchRow(activity, t, "本群记忆独立隔离",
                "开启后本群仅召回本群历史，不与其他群交叉联想", iso, now -> {
                    applyDetailInputs(id);
                    isolatedMemDraft.put(id, now);
                }), marginTop(Theme.S2));
        extCard.addView(extBox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        body.addView(extCard, marginTop(Theme.S2));
    }

    private EditText numBox(String val, String hint) {
        EditText et = new EditText(activity);
        et.setText(val);
        et.setHint(hint);
        et.setSingleLine(true);
        et.setInputType(InputType.TYPE_CLASS_NUMBER);
        Ui.styleInput(et, activity, t);
        return et;
    }

    private boolean applyDetailInputs(String id) {
        if (detailProbInput != null) {
            String raw = detailProbInput.getText().toString().trim();
            try {
                int p = Integer.parseInt(raw);
                if (p < 0 || p > 100) { host().toast("回复概率要在 0~100 之间"); return false; }
                probDraft.put(id, p);
            } catch (NumberFormatException e) {
                host().toast("回复概率需填写整数");
                return false;
            }
        }
        if (detailMentionInput != null) {
            String raw = detailMentionInput.getText().toString().trim();
            if (raw.isEmpty()) mentionCdDraft.put(id, null);
            else {
                try {
                    int n = Integer.parseInt(raw);
                    if (n < 0 || n > 3600) { host().toast("被 @ 冷却需在 0~3600 秒之间"); return false; }
                    mentionCdDraft.put(id, n);
                } catch (NumberFormatException e) { host().toast("被 @ 冷却需为整数或留空"); return false; }
            }
        }
        if (detailPokeInput != null) {
            String raw = detailPokeInput.getText().toString().trim();
            if (raw.isEmpty()) pokeCdDraft.put(id, null);
            else {
                try {
                    int n = Integer.parseInt(raw);
                    if (n < 0 || n > 3600) { host().toast("戳一戳冷却需在 0~3600 秒之间"); return false; }
                    pokeCdDraft.put(id, n);
                } catch (NumberFormatException e) { host().toast("戳一戳冷却需为整数或留空"); return false; }
            }
        }
        return true;
    }

    private void choosePersonaForGroup(final String id) {
        List<String> labels = new ArrayList<String>();
        List<String> values = new ArrayList<String>();
        labels.add("跟随全局默认人设");
        values.add("");

        List<Object> customs = BotConfigJson.asArray(BotConfigJson.get(data, "customPersonas"));
        if (customs != null) {
            for (Object o : customs) {
                Map<String, Object> m = BotConfigJson.asObject(o);
                if (m == null) continue;
                String n = str(m.get("name")).trim();
                if (!n.isEmpty()) {
                    labels.add("自定义：" + n);
                    values.add(n);
                }
            }
        }
        for (String[] role : PersonaEditScreen.BUILTIN_ROLES) {
            labels.add("内置：" + role[1]);
            values.add(role[0]);
        }
        ModelsScreen.W.chooseDialog(activity, t, "选择本群专属人设",
                "仅对群 " + id + " 生效",
                labels.toArray(new String[0]), values.toArray(new String[0]),
                personaDraft.get(id) == null ? "" : personaDraft.get(id),
                picked -> {
                    personaDraft.put(id, picked);
                    render();
                });
    }

    // ------------------------------------------------------------------ 保存

    private void save() {
        try {
            Object out = BotConfigJson.deepCopy(data);
            // 锁定完整生命周期模式并关闭概率统一档位，让按群概率立即生效
            BotConfigJson.set(out, "conversation.mode", "lifecycle");
            BotConfigJson.set(out, "conversation.unifiedMode", Boolean.TRUE);
            BotConfigJson.set(out, "store.unifiedTier", Boolean.FALSE);

            for (Map.Entry<String, Integer> e : probDraft.entrySet()) {
                setObjectKey(out, "store.groupSliderPos", e.getKey(),
                        new BotConfigJson.Num(String.valueOf(e.getValue())));
            }
            for (Map.Entry<String, Integer> e : mentionCdDraft.entrySet()) {
                if (e.getValue() == null) removeKey(out, "conversation.groupMentionCooldownSec", e.getKey());
                else setObjectKey(out, "conversation.groupMentionCooldownSec", e.getKey(),
                        new BotConfigJson.Num(String.valueOf(e.getValue())));
            }
            for (Map.Entry<String, Integer> e : pokeCdDraft.entrySet()) {
                if (e.getValue() == null) removeKey(out, "conversation.groupPokeCooldownSec", e.getKey());
                else setObjectKey(out, "conversation.groupPokeCooldownSec", e.getKey(),
                        new BotConfigJson.Num(String.valueOf(e.getValue())));
            }
            for (Map.Entry<String, String> e : personaDraft.entrySet()) {
                String key = "group:" + e.getKey();
                String val = e.getValue() == null ? "" : e.getValue().trim();
                if (val.isEmpty()) {
                    removeKey(out, "personaPerChat", key);
                } else {
                    LinkedHashMap<String, Object> entry = new LinkedHashMap<String, Object>();
                    entry.put("templateId", val);
                    String md = findPersonaText(val);
                    if (!md.isEmpty()) entry.put("roleText", md);
                    setObjectKey(out, "personaPerChat", key, entry);
                }
            }
            for (Map.Entry<String, Boolean> e : isolatedMemDraft.entrySet()) {
                String key = "group:" + e.getKey();
                if (!Boolean.TRUE.equals(e.getValue())) {
                    removeKey(out, "memoryPerChat", key);
                } else {
                    LinkedHashMap<String, Object> entry = new LinkedHashMap<String, Object>();
                    entry.put("isolated", Boolean.TRUE);
                    setObjectKey(out, "memoryPerChat", key, entry);
                }
            }

            if (!cfg.saveConfigJson(BotConfigJson.write(out))) {
                host().toast("保存失败，改动仍在当前页面");
                return;
            }
            data = out;
            host().toast("已保存按群配置");
            render();
        } catch (Throwable ex) {
            host().toast("保存失败：" + ex.getMessage());
        }
    }

    private String findPersonaText(String idOrName) {
        List<Object> customs = BotConfigJson.asArray(BotConfigJson.get(data, "customPersonas"));
        if (customs != null) {
            for (Object o : customs) {
                Map<String, Object> m = BotConfigJson.asObject(o);
                if (m != null && idOrName.equals(str(m.get("name")).trim())) {
                    String tx = str(m.get("text")).trim();
                    return tx.isEmpty() ? str(m.get("roleText")).trim() : tx;
                }
            }
        }
        return PersonaEditScreen.readBuiltinRoleMarkdown(activity, idOrName);
    }

    private static void setObjectKey(Object root, String parentPath, String key, Object value) {
        Map<String, Object> m = BotConfigJson.asObject(BotConfigJson.get(root, parentPath));
        if (m == null) {
            m = new LinkedHashMap<String, Object>();
            BotConfigJson.set(root, parentPath, m);
        }
        m.put(key, value);
    }

    private static void removeKey(Object root, String parentPath, String key) {
        Map<String, Object> m = BotConfigJson.asObject(BotConfigJson.get(root, parentPath));
        if (m != null) m.remove(key);
    }

    private static String str(Object v) { return v instanceof String ? (String) v : ""; }

    private static int intOf(Object v, int fallback) {
        double d = BotConfigJson.numOf(v);
        if (Double.isNaN(d)) return fallback;
        int n = (int) Math.round(d);
        return Math.max(0, Math.min(n, 100));
    }

    private static Integer optCooldown(Object v) {
        if (v == null) return null;
        double d = BotConfigJson.numOf(v);
        if (Double.isNaN(d)) return null;
        int n = (int) Math.round(d);
        return Math.max(0, Math.min(n, 3600));
    }

    private LinearLayout.LayoutParams marginTop(int token) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(token);
        return lp;
    }
}
