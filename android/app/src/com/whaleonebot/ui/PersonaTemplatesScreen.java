package com.whaleonebot.ui;

import android.text.InputType;
import android.text.TextUtils;
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
 * 「人格模板」：把运行端现成的 {@code customPersonas[]} 摊成一张可切换的清单。
 *
 * <p>用户 2026-11-18 的要求：人格正文（{@code persona.roleText}，实测 6 KB 上下）
 * 在界面里只能整段编辑，想回到上一版就得手动粘回去。本页只做四件事：<b>应用 / 存为模板 /
 * 重命名 / 删掉</b>。
 *
 * <p>写回的位置全部是运行端现成字段，<b>不造新结构</b>：
 * <ul>
 *   <li>应用：{@code persona.roleText} = 模板的 {@code text}，
 *       {@code persona.templateId} = 模板的 {@code name}，
 *       {@code persona.changedAt} = 现在；</li>
 *   <li>存为模板：往 {@code customPersonas[]} 追加
 *       {@code {name, text, behaviorProfile, customRules, changedAt}}，
 *       后三个取当前 {@code persona.*} 的值；</li>
 *   <li>重命名：只改那一项的 {@code name}（若它正是当前已应用的模板，
 *       顺带把 {@code persona.templateId} 跟上，免得留下一个指向不存在名字的悬空 id）；</li>
 *   <li>删掉：只从 {@code customPersonas[]} 移除那一项，<b>绝不碰 {@code persona} 段</b>。</li>
 * </ul>
 *
 * <p><b>长文本不进列表</b>：列表只显示模板名与字数（{@code text.length()} 个字），
 * 正文只在「应用」那一刻直接写盘 —— 一页里塞三段 6 KB 正文，滚动和渲染都会很难看。
 *
 * <p>保存策略：每个动作都是「读整棵树 → 只改该动的叶子 → 整份写回」，
 * 没有「保存」按钮，也没有草稿态；写盘失败只 toast，不崩。
 * 删除与覆盖（同名新建）都要在同一个浮层里再点一次确认按钮才执行。
 */
final class PersonaTemplatesScreen extends Screen {

    /** 浮层里再点一次才算数的确认按钮，文案与页内其它按钮同一套字阶。 */
    private static final String ACT_DELETE = "确定删除";
    private static final String ACT_OVERWRITE = "确定覆盖";

    private final BotConfigHost cfg;

    private Object data;
    private boolean loaded;
    private String loadError;

    /** 列表容器：页头固定，只重建这一块。 */
    private LinearLayout body;
    /** 页内浮层：改名 / 删除确认 / 覆盖确认共用同一个实例，换内容不换层。 */
    private FrameLayout overlay;

    /** 本次渲染用的倒序下标（{@code customPersonas} 里的原始位置）。 */
    private int[] order = new int[0];

    PersonaTemplatesScreen(AppShell shell, BotConfigHost host) {
        super(shell);
        this.cfg = host;
    }

    // ================================================================ 骨架

    @Override
    void build() {
        if (root.getChildCount() > 0) root.removeAllViews();

        FrameLayout page = new FrameLayout(activity);
        root.addView(page, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        page.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        col.addView(header("人格模板"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        body = Ui.column(activity);
        col.addView(body, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 浮层挂在 root 最上层，点空白处关掉；卡片自己吃掉点击，别把输入打断。
        overlay = new FrameLayout(activity);
        overlay.setVisibility(View.GONE);
        overlay.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeOverlay();
            }
        });
        root.addView(overlay, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        ensureLoaded();
        render();
    }

    /** 浮层开着时，返回键先关浮层，而不是直接退出本页。 */
    @Override
    boolean handleBack() {
        if (overlay != null && overlay.getVisibility() == View.VISIBLE) {
            closeOverlay();
            return true;
        }
        return false;
    }

    // ================================================================ 读配置

    private void ensureLoaded() {
        if (loaded || loadError != null) return;
        if (cfg == null) {
            loadError = "读不到 config.json";
            return;
        }
        String json;
        try {
            json = cfg.loadConfigJson();
        } catch (Throwable th) {
            loadError = "读不到 config.json";
            return;
        }
        if (json == null || json.trim().length() == 0) {
            loadError = "读不到 config.json";
            return;
        }
        try {
            data = BotConfigJson.parse(json);
        } catch (Throwable th) {
            data = null;
            loadError = "配置不是合法 JSON";
            return;
        }
        if (BotConfigJson.asObject(data) == null) {
            data = null;
            loadError = "配置根节点不是对象";
            return;
        }
        loaded = true;
    }

    private void reload() {
        loaded = false;
        loadError = null;
        data = null;
        ensureLoaded();
        render();
    }

    private static String str(Object v) {
        return v instanceof String ? (String) v : "";
    }

    private String personaText(String key) {
        return str(BotConfigJson.get(data, "persona." + key)).trim();
    }

    /** 取 {@code customPersonas[index]}（越界 / 不是对象都给 null）。 */
    private static Map<String, Object> itemAt(Object root, int index) {
        List<Object> list = BotConfigJson.asArray(BotConfigJson.get(root, "customPersonas"));
        if (list == null || index < 0 || index >= list.size()) return null;
        return BotConfigJson.asObject(list.get(index));
    }

    // ================================================================ 渲染

    private void render() {
        if (body == null) return;
        body.removeAllViews();

        if (loadError != null) {
            body.addView(errorCard(loadError), marginTop(Theme.S2));
            return;
        }

        TextView current = Ui.text(activity, currentLine(), Theme.T_BODY, t.textPrimary);
        current.setSingleLine(true);
        current.setEllipsize(TextUtils.TruncateAt.END);
        body.addView(current, marginTop(Theme.S2));

        TextView hint = Ui.text(activity, "点「应用」切换人格", Theme.T_CAP, t.textTertiary);
        body.addView(hint, marginTop(4));

        List<Object> list = BotConfigJson.asArray(BotConfigJson.get(data, "customPersonas"));
        order = orderDesc(list);

        if (order.length == 0) {
            TextView empty = Ui.text(activity, "还没有模板", Theme.T_BODY, t.textSecondary);
            body.addView(empty, marginTop(Theme.S2));
        } else {
            for (int i = 0; i < order.length; i++) {
                body.addView(templateRow(order[i]), marginTop(Theme.S2));
            }
        }

        FrameLayout foot = Ui.card(activity, t);
        LinearLayout footBox = Ui.column(activity);
        footBox.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        TextView save = Ui.button(activity, t, "把当前人格存为模板", true);
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openNameEditor(-1, "模板名字", "");
            }
        });
        footBox.addView(save, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        foot.addView(footBox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        body.addView(foot, marginTop(Theme.S3));
    }

    /**
     * 「当前：名字 · 模板 id」—— 用户要求简短，这里给名字 6 字、模板 id 5 字的预算，
     * 合计不超过 20 字（超出的折成「…」，不换行）。
     *
     * <p>static + 只吃一棵树：探针在纯 JVM 上跑的就是这一份文案。
     */
    static String currentLineOf(Object data) {
        String botName = str(BotConfigJson.get(data, "persona.botName")).trim();
        String templateId = str(BotConfigJson.get(data, "persona.templateId")).trim();
        return "当前：" + clip(botName.length() == 0 ? "未命名" : botName, 6)
                + " · 模板 " + (templateId.length() == 0 ? "未命名" : clip(templateId, 5));
    }

    private String currentLine() {
        return currentLineOf(data);
    }

    /** 行内小字：已应用 / N 字（正文长度，绝不贴正文）。 */
    static String subtitleText(int chars, boolean applied) {
        return applied ? "已应用" : (chars + " 字");
    }

    private View errorCard(String note) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));

        TextView tv = Ui.text(activity, note, Theme.T_BODY, t.textSecondary);
        tv.setLineSpacing(dp(3), 1f);
        box.addView(tv, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView retry = Ui.button(activity, t, "重新读取", false);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                reload();
            }
        });
        LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        rlp.topMargin = dp(Theme.S2);
        box.addView(retry, rlp);

        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    /** 一行模板：名字 + 小字（已应用 / N 字）+ 应用 + 「…」；长按与「…」都开同一张菜单。 */
    private View templateRow(final int index) {
        final Map<String, Object> item = itemAt(data, index);
        String rawName = item == null ? "" : str(item.get("name")).trim();
        String shownName = rawName.length() == 0 ? "未命名" : rawName;
        int chars = item == null ? 0 : str(item.get("text")).length();
        boolean applied = isApplied(shownName);

        FrameLayout card = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        card.addView(row, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout box = Ui.column(activity);
        TextView name = Ui.strong(activity, shownName, Theme.T_CARD, t.textPrimary);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        box.addView(name, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, subtitleText(chars, applied),
                Theme.T_CAP, applied ? t.accent : t.textSecondary);
        LinearLayout.LayoutParams subLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        subLp.topMargin = dp(3);
        box.addView(sub, subLp);

        LinearLayout.LayoutParams boxLp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        boxLp.rightMargin = dp(Theme.S2);
        row.addView(box, boxLp);

        TextView apply = Ui.button(activity, t, "应用", !applied);
        apply.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                applyTemplate(index);
            }
        });
        row.addView(apply, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        TextView more = Ui.text(activity, "…", Theme.T_CARD, t.textSecondary);
        more.setGravity(Gravity.CENTER);
        more.setMinWidth(dp(40));
        more.setMinHeight(dp(40));
        more.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_PILL)));
        more.setClickable(true);
        more.setFocusable(true);
        Ui.press(more, 0.92f);
        more.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openMenu(index);
            }
        });
        LinearLayout.LayoutParams moreLp = Ui.llp(dp(40), dp(40));
        moreLp.leftMargin = dp(Theme.S1);
        row.addView(more, moreLp);

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                openMenu(index);
                return true;
            }
        });
        return card;
    }

    private boolean isApplied(String name) {
        String templateId = personaText("templateId");
        return templateId.length() > 0 && templateId.equals(name);
    }

    // ================================================================ 排序

    /**
     * 按 {@code changedAt} 倒序的下标表。
     *
     * <p>两个必须扛住的现实：完整备份里就存在<b>没有 changedAt</b> 的老模板（实测那一项只有
     * name/text/behaviorProfile/customRules），所以缺值 / 非数字一律垫底；同值时保持数组原序
     * （插入排序天然稳定），这样刷新页面不会把顺序抖来抖去。
     */
    static int[] orderDesc(List<Object> list) {
        if (list == null || list.isEmpty()) return new int[0];
        int n = list.size();
        int[] idx = new int[n];
        double[] at = new double[n];
        for (int i = 0; i < n; i++) {
            idx[i] = i;
            Map<String, Object> it = BotConfigJson.asObject(list.get(i));
            at[i] = it == null ? Double.NaN : BotConfigJson.numOf(it.get("changedAt"));
        }
        for (int i = 1; i < n; i++) {
            int cur = idx[i];
            double cv = at[cur];
            int j = i - 1;
            while (j >= 0 && ranksBefore(cv, cur, at[idx[j]], idx[j])) {
                idx[j + 1] = idx[j];
                j--;
            }
            idx[j + 1] = cur;
        }
        return idx;
    }

    private static boolean ranksBefore(double a, int ai, double b, int bi) {
        boolean na = Double.isNaN(a), nb = Double.isNaN(b);
        if (na || nb) {
            if (na && nb) return ai < bi;
            return !na; // 有时间的在前，缺 changedAt 的垫底
        }
        if (a != b) return a > b;
        return ai < bi;
    }

    // ================================================================ 四个动作

    /**
     * 应用：只写 {@code persona.roleText / templateId / changedAt} 三个叶子，
     * 其它键一个字节都不动（整棵树 deepCopy 后只改这三处）。
     */
    private void applyTemplate(int index) {
        if (!loaded || data == null) {
            host().toast("保存失败");
            return;
        }
        if (itemAt(data, index) == null) {
            host().toast("没有这个模板");
            return;
        }
        try {
            Object out = appliedTree(data, index, System.currentTimeMillis());
            if (out == null) {
                host().toast("没有这个模板");
                return;
            }
            if (save(out)) host().toast("已应用");
        } catch (Throwable th) {
            host().toast("保存失败");
        }
    }

    /**
     * 「应用」这一步的纯数据部分：{@code persona} 段只改
     * {@code roleText / templateId / changedAt} 三个键，返回新树（不改入参）。
     * 拎成 static 是为了让探针能在纯 JVM 上直接跑同一份实现。
     */
    static Object appliedTree(Object data, int index, long now) {
        Map<String, Object> item = itemAt(data, index);
        if (item == null) return null;
        String text = str(item.get("text"));
        String name = str(item.get("name")).trim();
        Object out = BotConfigJson.deepCopy(data);
        BotConfigJson.set(out, "persona.roleText", text);
        BotConfigJson.set(out, "persona.templateId", name);
        BotConfigJson.set(out, "persona.changedAt", new BotConfigJson.Num(String.valueOf(now)));
        // 作者的模板页是「整份人格」一起切换的，所以模板里存了的这几项要一起还原
        // （之前只还原正文，切换后交流策略/附加规则还是上一个人的 —— 那不是模板）。
        if (item.containsKey("behaviorProfile")) {
            BotConfigJson.set(out, "persona.behaviorProfile", str(item.get("behaviorProfile")));
        }
        if (item.containsKey("customRules")) {
            BotConfigJson.set(out, "persona.customRules", str(item.get("customRules")));
        }
        if (item.containsKey("participation")) {
            BotConfigJson.set(out, "persona.participation", str(item.get("participation")));
        }
        return out;
    }

    /** 存为模板：追加一条到 {@code customPersonas[]}，值取自当前 {@code persona.*}。 */
    private void saveAsTemplate(String name) {
        if (!loaded || data == null) {
            host().toast("保存失败");
            return;
        }
        String roleText = str(BotConfigJson.get(data, "persona.roleText"));
        if (roleText.length() == 0) {
            host().toast("当前人格是空的");
            return;
        }
        try {
            Object out = treeWithTemplate(data, name, roleText,
                    str(BotConfigJson.get(data, "persona.behaviorProfile")),
                    str(BotConfigJson.get(data, "persona.customRules")),
                    System.currentTimeMillis());
            // 参与度（participation）也算人格的一部分：作者的模板是整份切的，存的时候一并带上。
            java.util.List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(out, "customPersonas"));
            if (arr != null && !arr.isEmpty()) {
                Object last = arr.get(arr.size() - 1);
                if (last instanceof Map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> m = (Map<String, Object>) last;
                    m.put("participation", str(BotConfigJson.get(data, "persona.participation")));
                }
            }
            if (save(out)) host().toast("已存为模板");
        } catch (Throwable th) {
            host().toast("保存失败");
        }
    }

    /**
     * 「存为模板」的纯数据部分：往 {@code customPersonas[]} 追加
     * {@code {name, text, behaviorProfile, customRules, changedAt}}；
     * 同名旧项先移除（调用方已确认过 = 覆盖）。{@code customPersonas} 不存在 / 不是数组时
     * 补一个新数组（老配置里该键可能缺失）。
     */
    static Object treeWithTemplate(Object data, String name, String text,
                                   String behavior, String rules, long now) {
        Object out = BotConfigJson.deepCopy(data);
        List<Object> list = BotConfigJson.asArray(BotConfigJson.get(out, "customPersonas"));
        if (list == null) {
            list = new ArrayList<Object>();
            BotConfigJson.set(out, "customPersonas", list);
        }
        removeByName(list, name);

        LinkedHashMap<String, Object> item = new LinkedHashMap<String, Object>();
        item.put("name", name);
        item.put("text", text);
        item.put("behaviorProfile", behavior);
        item.put("customRules", rules);
        item.put("changedAt", new BotConfigJson.Num(String.valueOf(now)));
        list.add(item);
        return out;
    }

    /** 重命名：只改 {@code name}；若它正是当前应用的模板，顺带把 {@code persona.templateId} 跟上。 */
    private void renameTemplate(int index, String newName) {
        if (!loaded || data == null) {
            host().toast("保存失败");
            return;
        }
        if (itemAt(data, index) == null) {
            host().toast("没有这个模板");
            return;
        }
        try {
            Object out = treeWithRename(data, index, newName);
            if (out == null) {
                host().toast("没有这个模板");
                return;
            }
            if (save(out)) host().toast("已重命名");
        } catch (Throwable th) {
            host().toast("保存失败");
        }
    }

    /**
     * 「重命名」的纯数据部分：只改那一项的 {@code name}（键序不变）；
     * 若它正是当前已应用的模板，顺带把 {@code persona.templateId} 跟上，
     * 免得留一个指向不存在名字的悬空 id。
     */
    static Object treeWithRename(Object data, int index, String newName) {
        Map<String, Object> old = itemAt(data, index);
        if (old == null) return null;
        String oldName = str(old.get("name")).trim();
        String appliedId = str(BotConfigJson.get(data, "persona.templateId")).trim();

        Object out = BotConfigJson.deepCopy(data);
        Map<String, Object> now = itemAt(out, index);
        if (now == null) return null;
        now.put("name", newName); // 键已存在 ⇒ LinkedHashMap 位置不变
        if (oldName.length() > 0 && oldName.equals(appliedId)) {
            BotConfigJson.set(out, "persona.templateId", newName);
        }
        return out;
    }

    /** 删掉：只从 {@code customPersonas[]} 移除这一项，{@code persona} 段完全不碰。 */
    private void deleteTemplate(int index) {
        if (!loaded || data == null) {
            host().toast("保存失败");
            return;
        }
        try {
            Object out = treeWithoutTemplate(data, index);
            if (out == null) {
                host().toast("没有这个模板");
                return;
            }
            if (save(out)) host().toast("已删掉");
        } catch (Throwable th) {
            host().toast("保存失败");
        }
    }

    /** 「删掉」的纯数据部分：只从 {@code customPersonas[]} 移除这一项，{@code persona} 段不碰。 */
    static Object treeWithoutTemplate(Object data, int index) {
        Object out = BotConfigJson.deepCopy(data);
        List<Object> list = BotConfigJson.asArray(BotConfigJson.get(out, "customPersonas"));
        if (list == null || index < 0 || index >= list.size()) return null;
        list.remove(index);
        return out;
    }

    /** 整份写回；成功才把内存里的树换成刚写出去的那份，失败一律只提示。 */
    private boolean save(Object out) {
        try {
            String json = BotConfigJson.write(out);
            if (cfg == null || !cfg.saveConfigJson(json)) {
                host().toast("保存失败");
                return false;
            }
            data = out;
            loaded = true;
            loadError = null;
            render();
            return true;
        } catch (Throwable th) {
            host().toast("保存失败");
            return false;
        }
    }

    private static void removeByName(List<Object> list, String name) {
        for (int i = list.size() - 1; i >= 0; i--) {
            Map<String, Object> it = BotConfigJson.asObject(list.get(i));
            if (it != null && name.equals(str(it.get("name")).trim())) list.remove(i);
        }
    }

    private boolean nameTaken(String name, int skipIndex) {
        List<Object> list = BotConfigJson.asArray(BotConfigJson.get(data, "customPersonas"));
        if (list == null) return false;
        for (int i = 0; i < list.size(); i++) {
            if (i == skipIndex) continue;
            Map<String, Object> it = BotConfigJson.asObject(list.get(i));
            if (it != null && name.equals(str(it.get("name")).trim())) return true;
        }
        return false;
    }

    // ================================================================ 浮层

    private void showOverlay(LinearLayout box) {
        overlay.removeAllViews();
        overlay.setBackgroundColor(0x99000000);
        overlay.setVisibility(View.VISIBLE);

        FrameLayout card = Ui.card(activity, t);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        int screen = activity.getResources().getDisplayMetrics().widthPixels;
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                Math.min(dp(Theme.S4 * 10), screen - dp(Theme.S4) * 2), WRAP_CONTENT);
        clp.gravity = Gravity.CENTER;
        overlay.addView(card, clp);
        // 卡片自己吃掉点击，别让外面的「点空白关闭」把输入打断
        card.setClickable(true);
    }

    private void closeOverlay() {
        if (overlay == null) return;
        overlay.setVisibility(View.GONE);
        overlay.removeAllViews();
    }

    /** 行菜单：重命名 / 删掉模板 / 取消。 */
    private void openMenu(final int index) {
        Map<String, Object> item = itemAt(data, index);
        if (item == null) return;
        final String raw = str(item.get("name")).trim();

        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S3));

        TextView title = Ui.strong(activity, raw.length() == 0 ? "未命名" : raw,
                Theme.T_CARD, t.textPrimary);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        box.addView(title, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView rename = Ui.button(activity, t, "重命名", false);
        rename.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openNameEditor(index, "重命名", raw);
            }
        });
        box.addView(rename, topMargin(Theme.S2, MATCH_PARENT));

        TextView del = Ui.button(activity, t, "删掉模板", false);
        del.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openDeleteConfirm(index);
            }
        });
        box.addView(del, topMargin(Theme.S1, MATCH_PARENT));

        TextView cancel = Ui.button(activity, t, "取消", false);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeOverlay();
            }
        });
        box.addView(cancel, topMargin(Theme.S2, MATCH_PARENT));

        showOverlay(box);
    }

    /** 删除确认：与菜单同一个浮层，换内容后再点一次「确定删除」才落盘。 */
    private void openDeleteConfirm(final int index) {
        Map<String, Object> item = itemAt(data, index);
        String name = item == null ? "" : str(item.get("name")).trim();
        if (name.length() == 0) name = "未命名";

        LinearLayout box = confirmBox("删掉「" + clip(name, 10) + "」？", "删除后不可恢复",
                ACT_DELETE, new Runnable() {
                    @Override
                    public void run() {
                        closeOverlay();
                        deleteTemplate(index);
                    }
                });
        showOverlay(box);
    }

    /** 覆盖确认：同名新建 = 覆盖，旧正文会被替换，所以要再点一次。 */
    private void openOverwriteConfirm(final String name) {
        LinearLayout box = confirmBox("已有「" + clip(name, 10) + "」", "覆盖后旧内容会丢",
                ACT_OVERWRITE, new Runnable() {
                    @Override
                    public void run() {
                        closeOverlay();
                        saveAsTemplate(name);
                    }
                });
        showOverlay(box);
    }

    private LinearLayout confirmBox(String titleText, String noteText, String actionLabel,
                                    final Runnable action) {
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S3));

        TextView title = Ui.strong(activity, titleText, Theme.T_CARD, t.textPrimary);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        box.addView(title, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView note = Ui.text(activity, noteText, Theme.T_CAP, t.textTertiary);
        box.addView(note, topMargin(Theme.S1, MATCH_PARENT));

        LinearLayout bar = Ui.row(activity);
        TextView cancel = Ui.button(activity, t, "取消", false);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeOverlay();
            }
        });
        TextView ok = Ui.button(activity, t, actionLabel, true);
        ok.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                action.run();
            }
        });
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        olp.leftMargin = dp(Theme.S1);
        bar.addView(cancel, clp);
        bar.addView(ok, olp);
        box.addView(bar, topMargin(Theme.S3, MATCH_PARENT));
        return box;
    }

    /**
     * 名字编辑浮层。
     *
     * @param index -1 = 新建模板；否则 = 给第 index 项重命名
     */
    private void openNameEditor(final int index, String heading, String initial) {
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S3));

        box.addView(Ui.strong(activity, heading, Theme.T_CARD, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        final EditText input = new EditText(activity);
        input.setText(initial);
        input.setTextSize(Theme.T_BODY);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setTextColor(t.textPrimary);
        input.setHint("名字");
        input.setHintTextColor(t.textTertiary);
        input.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        input.setPadding(dp(12), dp(8), dp(12), dp(8));
        box.addView(input, topMargin(Theme.S2, MATCH_PARENT));

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
                if (raw.length() == 0) {
                    host().toast("名字不能空");
                    return;
                }
                if (raw.length() > 40) {
                    host().toast("名字太长");
                    return;
                }
                if (index < 0) {
                    // 同名 = 覆盖，先确认（不直接盖掉别人存好的正文）
                    if (nameTaken(raw, -1)) {
                        openOverwriteConfirm(raw);
                        return;
                    }
                    closeOverlay();
                    saveAsTemplate(raw);
                } else {
                    if (nameTaken(raw, index)) {
                        host().toast("名字重复");
                        return;
                    }
                    closeOverlay();
                    renameTemplate(index, raw);
                }
            }
        });
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        olp.leftMargin = dp(Theme.S1);
        bar.addView(cancel, clp);
        bar.addView(ok, olp);
        box.addView(bar, topMargin(Theme.S3, MATCH_PARENT));

        showOverlay(box);
    }

    // ================================================================ 小工具

    private static String clip(String s, int max) {
        if (s == null) return "";
        if (s.length() <= max) return s;
        if (max <= 1) return s.substring(0, max);
        return s.substring(0, max - 1) + "…";
    }

    private LinearLayout.LayoutParams marginTop(int token) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(token);
        return lp;
    }

    private LinearLayout.LayoutParams topMargin(int token, int width) {
        LinearLayout.LayoutParams lp = Ui.llp(width, WRAP_CONTENT);
        lp.topMargin = dp(token);
        return lp;
    }
}
