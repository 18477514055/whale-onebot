package com.whaleonebot.ui;

import android.app.Activity;
import android.graphics.Typeface;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 运行端配置面板：分组列表 → 逐项编辑 → 只把改动过的字段写回 config.json。
 *
 * <p>三层结构，<pre>
 *   列表页           14 张分组卡（每组写明有多少项）
 *     └ 组页          小节 → 字段（开关 / 数字 / 单行 / 多行 / 枚举 / 字符串列表 / 键值映射）
 *          └ 保存栏  「有 N 项未保存」 放弃 + 保存
 * </pre>
 *
 * <p><b>写回策略</b>：进页面时把整份 JSON 解析成一棵保序树（{@link BotConfigJson}），
 * 用户改一项只在 {@code pending} 里记下「这条路径的新值」；点保存时深拷贝原树、把 pending
 * 逐条 set 进去、整棵重新序列化后交给宿主。<b>没改过的键、键序、没改过的数字字面量全部原样保留</b>
 * —— 不重排、不丢字段。密钥类字段既不进 schema，也有 {@link BotConfigJson#isSecret(String)}
 * 兜底过滤，双保险。
 *
 * <p>接线：宿主实现 {@link BotConfigHost}，构造本页后用 AppShell 调 {@code build()}（与其它页面一致）。
 * {@link #getView()} 会自动补一次 build，方便宿主直接挂视图；{@link #handleBack()} 用于把
 * 系统返回键交给本页先消费（在组页里先退回列表页）。
 */
public final class BotConfigScreen extends Screen {

    private static final int PAGE_LIST = 0;

    /** L2 专家全部参数区展开态与实时关键词搜索词。 */
    private boolean expertExpanded = false;
    private String searchQuery = "";

    private final BotConfigHost cfg;

    private FrameLayout body;
    private FrameLayout saveBar;
    /** 当前正文（列表页或组页）。切换时交给 {@link Motion#swap} 做退出入场。*/
    private View content;
    private TextView saveStatus;
    private TextView saveAction;
    private TextView discardAction;
    private TextView onlineLine;

    /** 路径 → 待写回的新值。改一项进来一条，保存成功清空。*/
    private final LinkedHashMap<String, Pending> pending = new LinkedHashMap<String, Pending>();
    /** 路径 → 标签旁那颗「已改」小圆点（页面重建时重置）。*/
    private final HashMap<String, View> dots = new HashMap<String, View>();

    private Object data;
    private boolean loaded;
    private String loadError;
    private int page = PAGE_LIST;
    private boolean built;
    private int savedListScrollY = 0;
    private int savedGroupScrollY = 0;

    private String lastOnlineText;
    private TextView saveHintLine;

    public BotConfigScreen(Activity activity, AppShell shell, BotConfigHost host) {
        super(shell);
        if (host == null) throw new IllegalArgumentException("BotConfigHost 不能为空");
        this.cfg = host;
    }

    // ================================================================ 骨架

    @Override
    void build() {
        if (built) root.removeAllViews();
        built = true;
        content = null;

        body = new FrameLayout(activity);
        body.setClipChildren(false);
        body.setClipToPadding(false);
        root.addView(body, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        saveBar = Ui.card(activity, t);
        LinearLayout inner = Ui.row(activity);
        inner.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        saveBar.addView(inner, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout statusBox = Ui.column(activity);
        LinearLayout.LayoutParams sbLp = Ui.llp(0, WRAP_CONTENT);
        sbLp.weight = 1f;
        sbLp.rightMargin = dp(Theme.S1);
        saveStatus = Ui.strong(activity, "没有未保存的改动", Theme.T_CAP, t.textPrimary);
        statusBox.addView(saveStatus, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        saveHintLine = Ui.text(activity, "点保存才写回 config.json", Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams hlLp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        hlLp.topMargin = dp(3);
        statusBox.addView(saveHintLine, hlLp);
        inner.addView(statusBox, sbLp);

        discardAction = Ui.button(activity, t, "放弃", false);
        discardAction.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (pending.isEmpty()) return;
                // 清空 pending + 整页重建 = 所有改动一起回滚。
                // 键值映射也走这条路：Pending.map 被丢掉，mapBlock 重新从 config.json 取种子，
                // 控件是重建出来的新实例，旧的行状态不会残留。
                pending.clear();
                cfg.toast("已放弃未保存的改动");
                renderPage();
            }
        });
        inner.addView(discardAction, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        saveAction = Ui.button(activity, t, "保存", true);
        saveAction.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                doSave();
            }
        });
        LinearLayout.LayoutParams saveLp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        saveLp.leftMargin = dp(Theme.S1);
        inner.addView(saveAction, saveLp);

        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        barLp.leftMargin = dp(Theme.S3);
        barLp.rightMargin = dp(Theme.S3);
        barLp.bottomMargin = dp(Theme.S3);
        root.addView(saveBar, barLp);

        ensureLoaded();
        // 首帧不做动效：整页入场由 AppShell 的 PUSH 统一负责，同一段动画不叠两遍。
        renderPage(Motion.NONE);
    }

    /** 宿主若不起 AppShell 的 create()，可直接用这个方法拿视图（内部保证已 build）。*/
    public android.view.View getView() {
        if (!built) build();
        return root;
    }

    /**
     * 让系统返回键先问本页：在组页里返回 true 并退回列表页，
     * 已经在列表页返回 false，交回 AppShell 正常出栈。
     */
    @Override
    boolean handleBack() {
        if (page != PAGE_LIST) {
            goList();
            return true;
        }
        return false;
    }

    @Override
    boolean hasUnsavedChanges() {
        return !pending.isEmpty();
    }

    @Override
    void onAttach() {
        super.onAttach();
        // 从子页（模型与 Key / 按群设置 / 人格模板）返回时，若当前无未保存改动则静默重载最新 config.json，防止冲掉刚保存的 Key
        if (built && pending.isEmpty()) {
            loaded = false;
            data = null;
            loadError = null;
            ensureLoaded();
            renderPage(Motion.NONE);
        }
    }

    // 注意：本页不在 onAttach 里做入场动效 —— 整页入场统一由 AppShell 的 Motion 负责。
    // 以前这里自己把内容容器 alpha 置 0 再花 260ms 淡进来，和 AppShell 的整页位移淡入叠在一起：
    // 整页已经滑到位置了，内容却还是全透明、然后才慢慢浮出来 —— 看起来就是「闪一下、动效没了」。
    // 页面内部「列表页 ↔ 组页」的切换走 Motion.swap，与整页跳转用同一套参数。
    @Override
    void refresh() {
        // 列表页有一行「运行端在线 / 离线」，值没变就一个 View 都不碰。
        if (onlineLine == null || page != PAGE_LIST) return;
        String want = onlineText();
        if (want.equals(lastOnlineText)) return;
        onlineLine.setText(want);
        lastOnlineText = want;
    }

    // ================================================================ 载入

    private void ensureLoaded() {
        if (loaded) return;
        String txt = null;
        try {
            txt = cfg.loadConfigJson();
        } catch (Throwable th) {
            loadError = "读取配置时抛异常：" + describe(th);
            return;
        }
        if (txt == null || txt.trim().length() == 0) {
            loadError = "读不到 /agent/data/config.json（容器未启动或运行端尚未生成配置）。";
            return;
        }
        try {
            Object parsed = BotConfigJson.parse(txt);
            if (!(parsed instanceof Map)) throw new IllegalArgumentException("根节点不是 JSON 对象");
            data = parsed;
            loaded = true;
            loadError = null;
        } catch (Throwable th) {
            loadError = "JSON 解析失败：" + describe(th);
        }
    }

    private void reload() {
        loaded = false;
        data = null;
        loadError = null;
        ensureLoaded();
        if (loaded) {
            // 重新读回来的树才是真源：之前挂着的改动全部作废，避免用旧值覆盖新文件。
            // 注意 pending 是按路径整条替换的（Pending 一个类型装所有值），
            // 所以这里的 clear() 同样覆盖 map ——「重新载入」后键值映射回到文件里的样子。
            pending.clear();
            cfg.toast("已重新读取 config.json");
        }
        renderPage();
    }

    private static String describe(Throwable th) {
        if (th == null) return "未知错误";
        String m = th.getMessage();
        if (m == null || m.length() == 0) return th.getClass().getSimpleName();
        return m;
    }

    // ================================================================ 页面

    /** 同层内容替换（重新读取配置 / 保存 / 放弃改动）。*/
    private void renderPage() {
        renderPage(Motion.FADE);
    }

    /**
     * 换正文。
     *
     * <p>动效不再在这里手写：交给 {@link Motion#swap}，与整页跳转用同一套参数，
     * 所以「进更深入的功能」和「进这个页面本身」看到的是同一种位移 + 淡入。
     *
     * @param motion {@link Motion#PUSH} 进组页 / {@link Motion#POP} 回列表页 /
     *               {@link Motion#FADE} 同层替换 / {@link Motion#NONE} 首帧
     */
    private void renderPage(int motion) {
        if (body == null) return;
        // 保存滚动位置：同页保存/放弃/开关切换后不回顶
        if (content instanceof ScrollView) {
            int curY = ((ScrollView) content).getScrollY();
            if (page == PAGE_LIST) savedListScrollY = curY;
            else savedGroupScrollY = curY;
        }
        dots.clear();
        onlineLine = null;

        View v;
        if (!loaded) {
            v = errorPage(loadError == null ? "配置尚未载入" : loadError);
        } else if (page == PAGE_LIST) {
            v = listPage();
        } else {
            v = groupPage(BotConfigSchema.GROUPS[page - 1]);
        }

        View old = content;
        content = v;
        Motion.swap(body, old, v, motion);
        if ((motion == Motion.FADE || motion == Motion.NONE) && v instanceof ScrollView) {
            final ScrollView targetScroll = (ScrollView) v;
            final int keepY = (page == PAGE_LIST) ? savedListScrollY : savedGroupScrollY;
            if (keepY > 0) {
                targetScroll.post(new Runnable() {
                    @Override
                    public void run() {
                        targetScroll.scrollTo(0, keepY);
                    }
                });
            }
        }
        refreshSaveBar();
    }

    private void goList() {
        if (page == PAGE_LIST) return;
        savedGroupScrollY = 0;
        page = PAGE_LIST;
        renderPage(Motion.POP);
        if (content instanceof ScrollView && savedListScrollY > 0) {
            final ScrollView sv = (ScrollView) content;
            final int y = savedListScrollY;
            sv.post(() -> sv.scrollTo(0, y));
        }
    }

    private void openGroup(int index) {
        if (index < 0 || index >= BotConfigSchema.GROUPS.length) return;
        if (content instanceof ScrollView && page == PAGE_LIST) {
            savedListScrollY = ((ScrollView) content).getScrollY();
        }
        savedGroupScrollY = 0;
        page = index + 1;
        renderPage(Motion.PUSH);
    }

    private ScrollView pageShell(LinearLayout col, int bottomPad) {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), bottomPad);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return scroll;
    }

    private int bottomPad() {
        // 底部保存栏是浮层：它露脸时给内容留出空位，否则最后一屏会被盖住。
        boolean barVisible = page != PAGE_LIST || !pending.isEmpty();
        return barVisible ? dp(120) : dp(Theme.S4);
    }

    // ---------------------------------------------------------------- 列表页（4 区块清晰结构 + 关键词全参搜索）
    private View listPage() {
        LinearLayout col = Ui.column(activity);

        col.addView(pageHeader("机器人配置", false), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        col.addView(statusCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        // ---------------- 区块 1：核心配置 ----------------
        col.addView(blockLabel("核心配置", true), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S4)));
        col.addView(l1EntryCard(IconView.CPU, "模型库", "服务商与 API Key",
                v -> shell.pushModelLibrary()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.TUNE, "模型分配", "用途模型、思考强度与自动路由",
                v -> shell.pushModels()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.CHECK, "白名单与黑名单", "允许或禁止的群与私聊",
                v -> openGroupByTitle("白名单")), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.CHAT, "按群设置", "回复概率、冷却、专属人设与群名",
                v -> shell.pushPerGroup()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.PALETTE, "人设管理", "自定义与内置人设",
                v -> shell.pushPersonaTemplates()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.GLOBE, "联网搜索", "搜索引擎与独立 Key",
                v -> shell.pushWebSearch()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // ---------------- 区块 2：资料与记忆 ----------------
        col.addView(blockLabel("资料与记忆", true), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S4)));
        col.addView(l1EntryCard(IconView.CHAT, "记忆库", "群印象、人物画像、搜索与导入",
                v -> shell.pushMemory()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.SHIELD, "知识库", "资料库、搜索、导入与向量模型",
                v -> shell.pushKnowledge()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.BOX, "长期语义记忆", "固化、召回测试与归档",
                v -> shell.pushNativeManage("living-memory")), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(l1EntryCard(IconView.DOT, "亲密度与心情", "熟人榜与心情精力",
                v -> shell.pushIntimacy()), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // ---------------- 区块 3：聊天行为与日常玩法 ----------------
        col.addView(blockLabel("聊天行为与日常玩法", false), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S4)));
        String[] dailyPrefixes = new String[] { "回复与发送", "主动发言", "记忆", "表情包", "消息类型", "日报与动态", "群游戏", "提醒", "内容审核" };
        for (String pref : dailyPrefixes) {
            int gi = findGroupIndexByTitle(pref);
            if (gi >= 0 && BotConfigSchema.GROUPS[gi].fieldCount() > 0) {
                col.addView(groupCard(gi), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            }
        }

        // ---------------- 区块 4：高级与底层参数（带全局关键词搜索） ----------------
        col.addView(blockLabel("高级与底层参数", false), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S4)));

        TextView toggleExpert = Ui.button(activity, t,
                expertExpanded
                        ? ("收起全部 " + BotConfigSchema.totalFieldCount() + " 项高级参数与搜索 ▴")
                        : ("展开全部 " + BotConfigSchema.totalFieldCount() + " 项高级参数与搜索 ▾"),
                false);
        toggleExpert.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                expertExpanded = !expertExpanded;
                renderPage(Motion.FADE);
            }
        });
        col.addView(toggleExpert, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (expertExpanded) {
            EditText searchBox = new EditText(activity);
            searchBox.setSingleLine(true);
            searchBox.setHint("搜索任意参数名或关键词（如：预算、冷却、搜索、记忆、拟人化）");
            searchBox.setText(searchQuery);
            searchBox.setSelection(searchQuery.length());
            Ui.styleInput(searchBox, activity, t);
            final LinearLayout expertList = Ui.column(activity);
            searchBox.addTextChangedListener(new TextWatcher() {
                @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
                @Override
                public void afterTextChanged(Editable s) {
                    searchQuery = s == null ? "" : s.toString().trim();
                    populateExpertList(expertList);
                }
            });
            col.addView(searchBox, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            populateExpertList(expertList);
            col.addView(expertList, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        return pageShell(col, bottomPad());
    }

    private TextView blockLabel(String title, boolean accent) {
        TextView tv = Ui.strong(activity, title, Theme.T_CAP, accent ? t.accent : t.textTertiary);
        tv.setLetterSpacing(0.08f);
        return tv;
    }

    private int findGroupIndexByTitle(String prefix) {
        if (prefix == null) return -1;
        for (int i = 0; i < BotConfigSchema.GROUPS.length; i++) {
            String title = BotConfigSchema.GROUPS[i].title;
            if (title != null && title.startsWith(prefix)) return i;
        }
        return -1;
    }

    private void openGroupByTitle(String prefix) {
        int idx = findGroupIndexByTitle(prefix);
        if (idx >= 0) openGroup(idx);
    }

    private View l1EntryCard(int icon, String title, String desc, View.OnClickListener click) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, icon, t.accent),
                new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(44), dp(44)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary), Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity, desc, Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(2), 1f);
        box.addView(sub, marginTop(Ui.llp(WRAP_CONTENT, WRAP_CONTENT), dp(4)));
        row.addView(box, blp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));
        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(click);
        return card;
    }

    private void populateExpertList(LinearLayout host) {
        host.removeAllViews();
        String q = searchQuery == null ? "" : searchQuery.trim().toLowerCase(java.util.Locale.ROOT);
        if (q.length() > 0) {
            int hits = 0;
            for (int gi = 0; gi < BotConfigSchema.GROUPS.length; gi++) {
                final int groupIdx = gi;
                BotConfigSchema.Group g = BotConfigSchema.GROUPS[gi];
                for (int si = 0; si < g.sections.length; si++) {
                    for (int fi = 0; fi < g.sections[si].fields.length; fi++) {
                        BotConfigSchema.Field f = g.sections[si].fields[fi];
                        if (f == null || BotConfigJson.isSecret(f.path)) continue;
                        String hay = (g.title + " " + f.label + " " + (f.hint == null ? "" : f.hint) + " " + f.path)
                                .toLowerCase(java.util.Locale.ROOT);
                        if (hay.contains(q)) {
                            hits++;
                            if (hits <= 25) {
                                FrameLayout hitCard = Ui.card(activity, t);
                                LinearLayout inner = Ui.column(activity);
                                inner.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S3), dp(Theme.S2));
                                hitCard.addView(inner, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
                                LinearLayout top = Ui.row(activity);
                                top.addView(Ui.text(activity, g.title + " · " + f.path, Theme.T_CAP, t.textTertiary),
                                        new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                                TextView jump = Ui.text(activity, "进所在组 →", Theme.T_CAP, t.accent);
                                jump.setClickable(true);
                                jump.setOnClickListener(v -> openGroup(groupIdx));
                                top.addView(jump, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
                                inner.addView(top, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
                                inner.addView(fieldBlock(f), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
                                host.addView(hitCard, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
                            }
                        }
                    }
                }
            }
            if (hits == 0) {
                host.addView(Ui.text(activity, "未找到匹配「" + searchQuery + "」的参数，换个关键词试试。",
                        Theme.T_CAP, t.textTertiary), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            }
            return;
        }
        for (int i = 0; i < BotConfigSchema.GROUPS.length; i++) {
            // 砍掉 0 项空壳中转组（模型与接口 / 知识库已在上方 L1 卡片直达）
            if (BotConfigSchema.GROUPS[i].fieldCount() == 0) continue;
            host.addView(groupCard(i), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
    }

    private View statusCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout row = Ui.row(activity);
        IconView dot = new IconView(activity, IconView.DOT, cfg.botRunning() ? t.accent : t.textTertiary);
        row.addView(dot, Ui.llp(dp(8), dp(8)));
        lastOnlineText = onlineText();
        onlineLine = Ui.text(activity, lastOnlineText, Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams olLp = Ui.llp(0, WRAP_CONTENT);
        olLp.weight = 1f;
        olLp.leftMargin = dp(6);
        row.addView(onlineLine, olLp);

        TextView again = Ui.button(activity, t, "重新读取", false);
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                reload();
            }
        });
        row.addView(again, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        box.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        String summary = loaded
                ? ("已载入 " + topLevelCount() + " 项顶层配置。")
                : "未载入配置。";
        TextView info = Ui.text(activity, summary, Theme.T_CAP, t.textSecondary);
        info.setLineSpacing(dp(3), 1f);
        box.addView(info, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (pending.size() > 0) {
            TextView dirty = Ui.text(activity,
                    "有 " + pending.size() + " 项改动还没保存", Theme.T_CAP, t.toneStrong);
            dirty.setTypeface(Typeface.DEFAULT_BOLD);
            box.addView(dirty, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        }
        return card;
    }

    private int topLevelCount() {
        Map<String, Object> m = BotConfigJson.asObject(data);
        return m == null ? 0 : m.size();
    }

    private String onlineText() {
        return cfg.botRunning() ? "运行端在线" : "运行端离线 · 保存后下次启动生效";
    }

    private View groupCard(final int index) {
        final BotConfigSchema.Group g = BotConfigSchema.GROUPS[index];
        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, g.icon, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, g.title, Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        if (g.desc != null && g.desc.length() > 0) {
            TextView desc = Ui.text(activity, g.desc, Theme.T_CAP, t.textSecondary);
            desc.setLineSpacing(dp(2), 1f);
            desc.setMaxLines(3);
            box.addView(desc, marginTop(Ui.llp(WRAP_CONTENT, WRAP_CONTENT), dp(4)));
        }
        row.addView(box, blp);

        TextView badge = Ui.text(activity, g.fieldCount() + " 项", Theme.T_CAP, t.toneStrong);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        badge.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), Ui.alpha(t.accent, 0.30f),
                dp(1), dp(Theme.R_PILL)));
        badge.setPadding(dp(8), dp(4), dp(8), dp(4));
        row.addView(badge, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
        LinearLayout.LayoutParams clp = Ui.llp(dp(20), dp(20));
        clp.leftMargin = dp(Theme.S1);
        row.addView(chev, clp);

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openGroup(index);
            }
        });
        return card;
    }

    // ---------------------------------------------------------------- 组页

    /**
     * 「模型与接口」组顶部的入口卡：进「模型与 Key」页（{@link ModelsScreen}）。
     *
     * <p>为什么不把 Key 直接做成这一页的文本框：密钥**永远不能回显**（运行端只给 hasXxx），
     * 一个用途又要同时选「渠道 + 模型 + 思考档位」，普通表单控件表达不了 —— 那三件事都在专门页里做。
     */
    private View modelsEntryCard() {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.TUNE, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, "模型与 Key", Theme.T_CARD, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity,
                "选模型、填 Key、调思考强度",
                Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S1 + 2);
        box.addView(sub, slp);
        row.addView(box, blp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModels();
            }
        });
        return card;
    }

    /** 白名单组顶部的入口卡：进「按群设置」。 */
    private View perGroupEntryCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.TUNE, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, "按群设置", Theme.T_CARD, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity, "每个群单独定模式与回复概率", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S1 + 2);
        box.addView(sub, slp);
        row.addView(box, blp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushPerGroup();
            }
        });
        return card;
    }

    /** 人格组顶部的入口卡：进「人格模板」。 */
    private View personaEntryCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.CHAT, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, "人格模板", Theme.T_CARD, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity, "多个模板随时切换", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S1 + 2);
        box.addView(sub, slp);
        row.addView(box, blp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushPersonaTemplates();
            }
        });
        return card;
    }

    /** 知识库组顶部的入口卡：进我们自己的「知识库」页。 */
    private View kbEntryCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.BOX, t.accent),
                new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(46), dp(46)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, "资料库与向量模型", Theme.T_CARD, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity, "管资料库、填向量模型", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S1 + 2);
        box.addView(sub, slp);
        row.addView(box, blp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushKnowledge();
            }
        });
        return card;
    }

    private View groupPage(BotConfigSchema.Group g) {
        LinearLayout col = Ui.column(activity);

        col.addView(pageHeader(g.title, true), Ui.llp(MATCH_PARENT, WRAP_CONTENT));


        // 「模型与接口」组顶部一张入口卡：真正的「按用途选模型 / 塞 Key / 调思考强度」在
        // 专门的「模型与 Key」页里（{@link ModelsScreen}）。为什么不塞进这张表：
        // ① 密钥在本页只会被当成字符串显示，而密钥*永远不能回显*；
        // ② 一个用途要同时选渠道 + 模型 + 档位，表单控件表达不了。
        if (g.title != null && g.title.startsWith("模型与接口")) {
            col.addView(modelsEntryCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }
        // 白名单组顶部：「按群设置」入口（逐群模式 + 每群回复概率，群清单取自白名单本身）。
        if (g.title != null && g.title.startsWith("白名单")) {
            col.addView(perGroupEntryCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }
        // 人格组顶部：「人格模板」入口（多条模板随时切换）。
        if (g.title != null && g.title.startsWith("人格")) {
            col.addView(personaEntryCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }
        // 知识库组顶部：进我们自己的「知识库」页（资料库清单 + 向量模型）。
        if (g.title != null && g.title.startsWith("知识库")) {
            col.addView(kbEntryCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }


        for (int i = 0; i < g.sections.length; i++) {
            BotConfigSchema.Section sec = g.sections[i];
            TextView label = Ui.strong(activity, sec.title, Theme.T_CAP, t.textTertiary);
            label.setLetterSpacing(0.08f);
            col.addView(label, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S4)));

            if (sec.note != null && sec.note.length() > 0) {
                TextView note = Ui.text(activity, sec.note, Theme.T_CAP, t.textTertiary);
                note.setLineSpacing(dp(3), 1f);
                col.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(6)));
            }

            FrameLayout card = Ui.card(activity, t);
            LinearLayout inner = Ui.column(activity);
            inner.setPadding(dp(Theme.S3 + 2), dp(Theme.S3), dp(Theme.S3 + 2), dp(Theme.S3 + 2));
            card.addView(inner, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

            int shown = 0;
            for (int k = 0; k < sec.fields.length; k++) {
                BotConfigSchema.Field f = sec.fields[k];
                if (f == null || BotConfigJson.isSecret(f.path)) continue; // 兜底过滤
                View block = fieldBlock(f);
                inner.addView(block, shown == 0
                        ? Ui.llp(MATCH_PARENT, WRAP_CONTENT)
                        : marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
                shown++;
            }
            if (shown == 0) {
                inner.addView(Ui.text(activity, "这一节没有可编辑项。", Theme.T_CAP, t.textTertiary),
                        Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
            col.addView(card, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        // 只有真的有字段时才显示「保存与生效」这张提示卡（空的组页只剩一张入口卡，不需要它）。
        FrameLayout note = Ui.card(activity, t);
        LinearLayout noteBox = Ui.column(activity);
        noteBox.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        note.addView(noteBox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        TextView noteTitle = Ui.strong(activity, "保存与生效", Theme.T_CAP, t.textPrimary);
        noteBox.addView(noteTitle, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView noteBody = Ui.text(activity, "点保存才写回；没改过的字段原样保留。",
                Theme.T_CAP, t.textSecondary);
        noteBody.setLineSpacing(dp(3), 1f);
        noteBox.addView(noteBody, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        if (g.fieldCount() > 0) {
            col.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }

        return pageShell(col, bottomPad());
    }

    private LinearLayout pageHeader(String title, final boolean backToList) {
        LinearLayout row = Ui.row(activity);

        FrameLayout back = new FrameLayout(activity);
        back.setBackground(Drawables.circle(t.ghostFill, t.ghostStroke, dp(1)));
        back.setClickable(true);
        back.setFocusable(true);
        IconView chev = new IconView(activity, IconView.CHEV_L, t.textPrimary);
        back.addView(chev, new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (backToList) {
                    goList();
                } else {
                    shell.handleBack();
                }
            }
        });
        Ui.press(back, 0.9f);
        row.addView(back, Ui.llp(dp(Theme.TOUCH), dp(Theme.TOUCH)));

        TextView tv = Ui.strong(activity, title, Theme.T_TITLE, t.textPrimary);
        tv.setSingleLine(true);
        tv.setAutoSizeTextTypeUniformWithConfiguration(
                14, Theme.T_TITLE, 1, TypedValue.COMPLEX_UNIT_SP);
        LinearLayout.LayoutParams tlp = Ui.llp(0, WRAP_CONTENT);
        tlp.weight = 1f;
        tlp.leftMargin = dp(Theme.S3);
        row.addView(tv, tlp);

        row.setLayoutParams(new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return row;
    }

    // ================================================================ 字段控件

    private View fieldBlock(BotConfigSchema.Field f) {
        switch (f.type) {
            case BotConfigSchema.BOOL:
                return boolBlock(f);
            case BotConfigSchema.ENUM:
                return enumBlock(f);
            case BotConfigSchema.LIST:
                return listBlock(f);
            case BotConfigSchema.MULTI:
                return editBlock(f, true);
            case BotConfigSchema.MAP:
                return mapBlock(f);
            default:
                return editBlock(f, false);
        }
    }

    private View boolBlock(final BotConfigSchema.Field f) {
        LinearLayout row = Ui.row(activity);

        LinearLayout txt = Ui.column(activity);
        txt.addView(labelRow(f), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams tlp = Ui.llp(0, WRAP_CONTENT);
        tlp.weight = 1f;
        tlp.rightMargin = dp(Theme.S2);
        row.addView(txt, tlp);

        BotConfigToggle toggle = new BotConfigToggle(activity, t, boolOf(f),
                new BotConfigToggle.OnChange() {
                    @Override
                    public void onChanged(boolean on) {
                        Pending p = new Pending();
                        p.bool = Boolean.valueOf(on);
                        pending.put(f.path, p);
                        afterEdit(f);
                    }
                });
        row.addView(toggle, Ui.llp(dp(46), dp(28)));
        return row;
    }

    private View editBlock(final BotConfigSchema.Field f, boolean multiline) {
        LinearLayout col = Ui.column(activity);
        col.addView(labelRow(f), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        final EditText e = new EditText(activity);
        e.setTextSize(Theme.T_BODY);
        e.setTextColor(t.textPrimary);
        e.setHintTextColor(Ui.alpha(t.textSecondary, 0.75f));
        e.setBackground(Drawables.round(Ui.alpha(t.textPrimary, t.dark ? 0.08f : 0.05f),
                t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        e.setPadding(dp(Theme.S2), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        e.setSelectAllOnFocus(false);
        e.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI);

        if (multiline) {
            e.setSingleLine(false);
            e.setMinLines(4);
            e.setMaxLines(12);
            e.setGravity(Gravity.TOP | Gravity.START);
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                    | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            e.setLineSpacing(dp(2), 1f);
        } else {
            e.setSingleLine(true);
            e.setInputType(inputTypeOf(f));
        }
        if (f.maxChars > 0) {
            e.setFilters(new InputFilter[]{new InputFilter.LengthFilter(f.maxChars)});
        }
        e.setHint(f.placeholder == null ? "未设置" : f.placeholder);

        String current = displayOf(f);
        e.setText(current == null ? "" : current);

        e.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                Pending p = new Pending();
                p.text = s == null ? "" : s.toString();
                pending.put(f.path, p);
                afterEdit(f);
            }
        });

        col.addView(e, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        return col;
    }

    private int inputTypeOf(BotConfigSchema.Field f) {
        if (f.type == BotConfigSchema.INT) {
            return InputType.TYPE_CLASS_NUMBER | (f.min < 0 ? InputType.TYPE_NUMBER_FLAG_SIGNED : 0);
        }
        if (f.type == BotConfigSchema.DEC) {
            return InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL | InputType.TYPE_NUMBER_FLAG_SIGNED;
        }
        return InputType.TYPE_CLASS_TEXT;
    }

    private View enumBlock(final BotConfigSchema.Field f) {
        LinearLayout col = Ui.column(activity);
        col.addView(labelRow(f), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        HorizontalScrollView hs = new HorizontalScrollView(activity);
        hs.setHorizontalScrollBarEnabled(false);
        hs.setClipToPadding(false);
        LinearLayout row = Ui.row(activity);
        row.setPadding(0, 0, dp(Theme.S1), 0);
        hs.addView(row, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));

        final ArrayList<TextView> chips = new ArrayList<TextView>();
        final String[] values = f.values == null ? new String[0] : f.values;
        final String[] labels = f.valueLabels == null ? values : f.valueLabels;
        String current = displayOf(f);

        for (int i = 0; i < values.length; i++) {
            final int idx = i;
            TextView chip = Ui.text(activity, labels[i], Theme.T_CAP, t.textSecondary);
            chip.setTypeface(Typeface.DEFAULT_BOLD);
            chip.setPadding(dp(Theme.S2), dp(8), dp(Theme.S2), dp(8));
            chip.setClickable(true);
            chip.setFocusable(true);
            chip.setMinHeight(dp(36));
            chip.setGravity(Gravity.CENTER);
            chips.add(chip);
            Ui.press(chip, 0.95f);
            chip.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    Pending p = new Pending();
                    p.text = values[idx];
                    pending.put(f.path, p);
                    for (int k = 0; k < chips.size(); k++) paintChip(chips.get(k), k == idx);
                    afterEdit(f);
                }
            });
            LinearLayout.LayoutParams clp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            if (i > 0) clp.leftMargin = dp(Theme.S1);
            row.addView(chip, clp);
            boolean on = current != null && current.equals(values[i]);
            paintChip(chip, on);
        }

        col.addView(hs, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        return col;
    }

    private void paintChip(TextView chip, boolean selected) {
        if (selected) {
            chip.setTextColor(t.onAccent);
            chip.setBackground(Drawables.round(t.accent, 0, 0, dp(Theme.R_PILL)));
            chip.setElevation(dp(2));
        } else {
            chip.setTextColor(t.ghostText);
            chip.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_PILL)));
            chip.setElevation(dp(0));
        }
    }

    // ---------------------------------------------------------------- 字符串列表
    private static final class ListState {
        final ArrayList<String> values = new ArrayList<String>();
        LinearLayout rows;
    }

    private View listBlock(final BotConfigSchema.Field f) {
        LinearLayout col = Ui.column(activity);
        col.addView(labelRow(f), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        final ListState st = new ListState();
        Pending p = pending.get(f.path);
        if (p != null && p.list != null) {
            st.values.addAll(p.list);
        } else {
            List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(data, f.path));
            if (arr != null) {
                for (int i = 0; i < arr.size(); i++) {
                    Object o = arr.get(i);
                    if (o == null || o == BotConfigJson.NULL) continue;
                    if (o instanceof BotConfigJson.Num) {
                        st.values.add(((BotConfigJson.Num) o).raw);
                    } else {
                        st.values.add(String.valueOf(o));
                    }
                }
            }
        }

        st.rows = Ui.column(activity);
        col.addView(st.rows, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        TextView add = Ui.button(activity, t, "＋ 添加一行", false);
        add.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                st.values.add("");
                putList(f, st);
                rebuildListRows(f, st);
            }
        });

        // 白名单 / 黑名单那四个 LIST 字段：在「添加一行」旁边多一个「从会话选择」。
        // 其它 LIST 字段（关键词、群游戏…）走 else 分支，布局与以前逐像素一致。
        boolean pickable = f.path != null
                && (f.path.startsWith("allow.") || f.path.startsWith("deny."));
        if (pickable) {
            final int kind = f.path.endsWith(".groups")
                    ? WhitelistPicker.KIND_GROUP : WhitelistPicker.KIND_PRIVATE;

            LinearLayout bar = Ui.row(activity);
            LinearLayout.LayoutParams alp = Ui.llp(0, WRAP_CONTENT);
            alp.weight = 1f;
            bar.addView(add, alp);

            TextView pick = Ui.button(activity, t, "从会话选择", false);
            pick.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    // already 传的是 pending 里的当前值（含本次已编辑但没保存的），不是配置里的旧值
                    WhitelistPicker.show(activity, t, f.label,
                            new ArrayList<String>(st.values), kind,
                            new WhitelistPicker.Callback() {
                                @Override
                                public void onPicked(List<String> ids, List<String> removed) {
                                    boolean changed = false;
                                    // 先做「取消勾选 = 移除」：只动列表里真的显示过的号码，
                                    // 手填的号码（不在会话列表里）原样保留。
                                    if (removed != null && !removed.isEmpty()) {
                                        for (int i = st.values.size() - 1; i >= 0; i--) {
                                            String one = st.values.get(i) == null ? "" : st.values.get(i).trim();
                                            if (removed.contains(one)) {
                                                st.values.remove(i);
                                                changed = true;
                                            }
                                        }
                                    }
                                    if (ids != null && !ids.isEmpty()) {
                                        ArrayList<String> merged = WhitelistPicker.mergeIds(st.values, ids);
                                        if (merged.size() != st.values.size()) changed = true;
                                        st.values.clear();
                                        st.values.addAll(merged);
                                    }
                                    if (!changed) return;
                                    putList(f, st);          // 写 pending + 点「已改」+ 刷保存栏
                                    rebuildListRows(f, st);  // 立刻重绘行
                                }
                            });
                }
            });
            LinearLayout.LayoutParams plp = Ui.llp(0, WRAP_CONTENT);
            plp.weight = 1f;
            plp.leftMargin = dp(Theme.S1);
            bar.addView(pick, plp);
            col.addView(bar, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        } else {
            col.addView(add, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        }

        rebuildListRows(f, st);
        return col;
    }

    private void rebuildListRows(final BotConfigSchema.Field f, final ListState st) {
        st.rows.removeAllViews();
        if (st.values.isEmpty()) {
            st.rows.addView(Ui.text(activity, "（空）", Theme.T_CAP, t.textTertiary),
                    Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return;
        }
        for (int i = 0; i < st.values.size(); i++) {
            final int idx = i;

            LinearLayout row = Ui.row(activity);

            final EditText e = new EditText(activity);
            e.setTextSize(Theme.T_BODY);
            e.setTextColor(t.textPrimary);
            e.setHintTextColor(Ui.alpha(t.textSecondary, 0.75f));
            e.setBackground(Drawables.round(Ui.alpha(t.textPrimary, t.dark ? 0.08f : 0.05f),
                    t.ghostStroke, dp(1), dp(Theme.R_BTN)));
            e.setPadding(dp(Theme.S2), dp(8), dp(Theme.S2), dp(8));
            e.setSingleLine(true);
            e.setInputType(InputType.TYPE_CLASS_TEXT);
            e.setHint(f.placeholder == null ? "留空则忽略这一行" : f.placeholder);
            e.setText(st.values.get(idx));
            e.addTextChangedListener(new TextWatcher() {
                @Override
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                }

                @Override
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                }

                @Override
                public void afterTextChanged(Editable s) {
                    if (idx >= st.values.size()) return;
                    st.values.set(idx, s == null ? "" : s.toString());
                    putList(f, st);
                }
            });
            LinearLayout.LayoutParams elp = Ui.llp(0, WRAP_CONTENT);
            elp.weight = 1f;
            row.addView(e, elp);

            FrameLayout del = new FrameLayout(activity);
            del.setBackground(Drawables.circle(t.ghostFill, t.ghostStroke, dp(1)));
            del.setClickable(true);
            del.setFocusable(true);
            TextView x = Ui.text(activity, "×", Theme.T_CARD, t.textSecondary);
            x.setGravity(Gravity.CENTER);
            del.addView(x, new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER));
            del.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (idx >= st.values.size()) return;
                    st.values.remove(idx);
                    putList(f, st);
                    rebuildListRows(f, st);
                }
            });
            Ui.press(del, 0.9f);
            LinearLayout.LayoutParams dlp = Ui.llp(dp(36), dp(36));
            dlp.leftMargin = dp(Theme.S1);
            row.addView(del, dlp);

            LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            if (idx > 0) rlp.topMargin = dp(Theme.S1);
            st.rows.addView(row, rlp);
        }
    }

    private void putList(BotConfigSchema.Field f, ListState st) {
        Pending p = new Pending();
        p.list = new ArrayList<String>(st.values);
        pending.put(f.path, p);
        afterEdit(f);
    }

    // ---------------------------------------------------------------- 键值映射
    /**
     * 键值映射（{@link BotConfigSchema#MAP}）：每群回复概率这类「群号 → 值」的配置。
     *
     * <p>种子取值顺序：**pending 优先**（页面重建后改动还在），其次配置里现成的对象。
     * 每次增删改都写回 {@code pending.map} 并走 {@link #afterEdit}，写盘仍然只发生在点保存时。
     */
    private View mapBlock(BotConfigSchema.Field f) {
        LinearLayout col = Ui.column(activity);
        col.addView(labelRow(f), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        BotConfigMap ctl = new BotConfigMap(activity, f, mapSeed(f), new BotConfigMap.Listener() {
            @Override
            public void onChanged(LinkedHashMap<String, String> entries) {
                Pending p = new Pending();
                p.map = entries == null
                        ? new LinkedHashMap<String, String>()
                        : new LinkedHashMap<String, String>(entries);
                pending.put(f.path, p);
                afterEdit(f);
            }
        }, t);
        col.addView(ctl, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        return col;
    }

    /**
     * 控件的初始值：pending 里已有改动就用它，否则读配置里的对象。
     *
     * <p>数字按 {@link BotConfigJson.Num} 的原始字面量取（{@code 0.5} 不会变成
     * {@code 0.5000000000000001}）；值是 {@code null} 的条目直接跳过 —— 映射里没有「空值」这种状态，
     * 硬塞一个空串会让用户在保存时才撞上校验。
     */
    private LinkedHashMap<String, String> mapSeed(BotConfigSchema.Field f) {
        LinkedHashMap<String, String> out = new LinkedHashMap<String, String>();
        Pending p = pending.get(f.path);
        if (p != null && p.map != null) {
            out.putAll(p.map);
            return out;
        }
        Map<String, Object> obj = BotConfigJson.asObject(BotConfigJson.get(data, f.path));
        if (obj == null) return out;
        for (Map.Entry<String, Object> en : obj.entrySet()) {
            String k = en.getKey() == null ? "" : en.getKey().trim();
            if (k.length() == 0 || out.containsKey(k)) continue;
            Object v = en.getValue();
            if (v == null || v == BotConfigJson.NULL) continue;
            if (v instanceof BotConfigJson.Num) {
                out.put(k, ((BotConfigJson.Num) v).raw);
            } else if (v instanceof Map || v instanceof List) {
                continue; // 嵌套结构不是这个控件能编辑的，别把它拍平成"[object]"
            } else {
                out.put(k, String.valueOf(v));
            }
        }
        return out;
    }

    // ================================================================ 通用小件

    private LinearLayout labelRow(final BotConfigSchema.Field f) {
        LinearLayout row = Ui.row(activity);
        TextView label = Ui.text(activity, f.label, Theme.T_BODY, t.textPrimary);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams llp = Ui.llp(0, WRAP_CONTENT);
        llp.weight = 1f;
        row.addView(label, llp);

        if (isHighRiskField(f.path)) {
            TextView risk = Ui.pill(activity, t, "高危", Ui.TONE_WARN);
            LinearLayout.LayoutParams rlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            rlp.leftMargin = dp(6);
            row.addView(risk, rlp);
        }

        View dot = new View(activity);
        dot.setBackground(Drawables.circle(t.accent, 0, 0));
        dot.setVisibility(pending.containsKey(f.path) ? View.VISIBLE : View.GONE);
        LinearLayout.LayoutParams dlp = Ui.llp(dp(6), dp(6));
        dlp.leftMargin = dp(6);
        row.addView(dot, dlp);
        dots.put(f.path, dot);

        // ★ 轻量「?」按需说明按钮：行内零长灰字，点击弹出完整解释、范围与风险提示（彻底废除 10 字截断）
        if (f.hint != null && f.hint.trim().length() > 0) {
            TextView q = Ui.strong(activity, "?", Theme.T_CAP, t.accent);
            q.setGravity(Gravity.CENTER);
            q.setBackground(Drawables.circle(Ui.alpha(t.accent, 0.14f), Ui.alpha(t.accent, 0.35f), dp(1)));
            q.setClickable(true);
            q.setFocusable(true);
            q.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    StringBuilder info = new StringBuilder();
                    if (isHighRiskField(f.path)) {
                        info.append("【高风险配置】修改前请确认影响范围。\n\n");
                    }
                    info.append(f.hint.trim());
                    if (f.type == BotConfigSchema.INT || f.type == BotConfigSchema.DEC) {
                        info.append("\n\n允许范围：").append(BotConfigJson.pretty(f.min, 3))
                                .append(" ~ ").append(BotConfigJson.pretty(f.max, 3));
                    }
                    info.append("\n配置路径：").append(f.path);
                    ModelsScreen.W.infoDialog(activity, t, f.label, info.toString());
                }
            });
            LinearLayout.LayoutParams qlp = Ui.llp(dp(22), dp(22));
            qlp.leftMargin = dp(8);
            row.addView(q, qlp);
        }

        return row;
    }

    private static boolean isHighRiskField(String path) {
        if (path == null) return false;
        return "allowAllWhenEmpty".equals(path)
                || "qzoneInteractions.enabled".equals(path)
                || "moderation.actions.kick".equals(path)
                || "moderation.actions.ban".equals(path)
                || "identityPilot.incomingFriendRequest.autoWhitelist".equals(path)
                || "plugins.requireNetworkIsolation".equals(path);
    }

    private TextView hintText(String hint) {
        TextView v = Ui.text(activity, hint, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        return v;
    }

    private LinearLayout.LayoutParams marginTop(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }

    // ================================================================ 值模型
    /**
     * 一项待写回的改动：开关存 bool，文本（数字 / 枚举）存显示文本，列表存副本，
     * 键值映射存「键 → 显示文本」的副本。
     */
    private static final class Pending {
        String text;
        Boolean bool;
        ArrayList<String> list;
        /** 键值映射：键 → 显示文本（数字存字面量）。null 表示这一项不是映射改动。*/
        LinkedHashMap<String,String> map;
    }

    private void afterEdit(BotConfigSchema.Field f) {
        View dot = dots.get(f.path);
        if (dot != null) dot.setVisibility(View.VISIBLE);
        refreshSaveBar();
    }

    private boolean boolOf(BotConfigSchema.Field f) {
        Pending p = pending.get(f.path);
        if (p != null && p.bool != null) return p.bool.booleanValue();
        Object v = BotConfigJson.get(data, f.path);
        if (v instanceof Boolean) return ((Boolean) v).booleanValue();
        return f.defBool;
    }

    /** 当前显示值（字符串控件用）。null = 配置里没有这一项。*/
    private String displayOf(BotConfigSchema.Field f) {
        Pending p = pending.get(f.path);
        if (p != null && p.text != null) return p.text;

        Object v = BotConfigJson.get(data, f.path);
        if (v == BotConfigJson.MISSING || v == BotConfigJson.NULL) return null;

        if (f.type == BotConfigSchema.INT) {
            double d = BotConfigJson.numOf(v);
            if (Double.isNaN(d)) return null;
            return BotConfigJson.pretty(d / f.factor, 0);
        }
        if (f.type == BotConfigSchema.DEC) {
            double d = BotConfigJson.numOf(v);
            if (Double.isNaN(d)) return null;
            return BotConfigJson.pretty(d / f.factor, 3);
        }
        if (v instanceof String) return (String) v;
        if (v instanceof Boolean) return ((Boolean) v).booleanValue() ? "true" : "false";
        return String.valueOf(v);
    }

    private BotConfigSchema.Field fieldByPath(String path) {
        for (int i = 0; i < BotConfigSchema.GROUPS.length; i++) {
            BotConfigSchema.Section[] secs = BotConfigSchema.GROUPS[i].sections;
            for (int k = 0; k < secs.length; k++) {
                BotConfigSchema.Field[] fs = secs[k].fields;
                for (int n = 0; n < fs.length; n++) {
                    if (fs[n] != null && fs[n].path.equals(path)) return fs[n];
                }
            }
        }
        return null;
    }

    /** 显示值 → 要写进 JSON 的值。校验不过抛 {@link IllegalArgumentException}。*/
    private Object jsonOf(BotConfigSchema.Field f, Pending p) {
        switch (f.type) {
            case BotConfigSchema.BOOL:
                return (p.bool != null && p.bool.booleanValue()) ? Boolean.TRUE : Boolean.FALSE;

            case BotConfigSchema.INT:
            case BotConfigSchema.DEC: {
                String txt = p.text == null ? "" : p.text.trim();
                if (txt.length() == 0) throw new IllegalArgumentException(f.label + " 不能为空");
                double shown;
                try {
                    shown = Double.parseDouble(txt);
                } catch (NumberFormatException e) {
                    throw new IllegalArgumentException(f.label + " 不是数字：" + txt);
                }
                if (Double.isNaN(shown) || Double.isInfinite(shown)) {
                    throw new IllegalArgumentException(f.label + " 不是有效数字");
                }
                if (f.hasRange && (shown < f.min || shown > f.max)) {
                    throw new IllegalArgumentException(f.label + " 必须在 "
                            + BotConfigJson.pretty(f.min, 3) + " ~ "
                            + BotConfigJson.pretty(f.max, 3) + " 之间（现在填的是 "
                            + BotConfigJson.pretty(shown, 3) + "）");
                }
                double stored = shown * f.factor;
                if (f.type == BotConfigSchema.INT) {
                    return new BotConfigJson.Num(Long.toString(Math.round(stored)));
                }
                return new BotConfigJson.Num(scale(stored));
            }

            case BotConfigSchema.TEXT:
                return p.text == null ? "" : p.text.trim();

            case BotConfigSchema.MULTI:
                return p.text == null ? "" : p.text;

            case BotConfigSchema.ENUM: {
                String val = p.text == null ? "" : p.text;
                boolean ok = false;
                for (int i = 0; f.values != null && i < f.values.length; i++) {
                    if (f.values[i].equals(val)) {
                        ok = true;
                        break;
                    }
                }
                if (!ok) throw new IllegalArgumentException(f.label + " 的取值不认识：" + val);
                // 类型跟原值走：sticker.encourage 这类是数字枚举，写回字符串会被运行端当成坏值。
                if (BotConfigJson.get(data, f.path) instanceof BotConfigJson.Num) {
                    try {
                        return new BotConfigJson.Num(Long.toString(Math.round(Double.parseDouble(val))));
                    } catch (NumberFormatException e) {
                        throw new IllegalArgumentException(f.label + " 需要数字取值：" + val);
                    }
                }
                return val;
            }

            case BotConfigSchema.LIST: {
                ArrayList<Object> out = new ArrayList<Object>();
                if (p.list != null) {
                    for (int i = 0; i < p.list.size(); i++) {
                        String one = p.list.get(i);
                        if (one == null) continue;
                        String t = one.trim();
                        if (t.length() == 0) continue; // 空行 = 忽略
                        out.add(t);
                    }
                }
                return out;
            }

            case BotConfigSchema.MAP: {
                // 空表必须是*空对象*而不是 null：写回后运行端要拿到 {}，不是把整条键删掉。
                LinkedHashMap<String, Object> out = new LinkedHashMap<String, Object>();
                LinkedHashMap<String, String> src = p.map;
                if (src == null) {
                    // 兜底：没有映射改动就用配置里原样的对象，绝不因为「Pending 里没值」把这一项清空。
                    Map<String, Object> old = BotConfigJson.asObject(BotConfigJson.get(data, f.path));
                    if (old != null) {
                        for (Map.Entry<String, Object> en : old.entrySet()) {
                            out.put(en.getKey() == null ? "" : en.getKey(),
                                    BotConfigJson.deepCopy(en.getValue()));
                        }
                    }
                    return out;
                }
                for (Map.Entry<String, String> en : src.entrySet()) {
                    String k = en.getKey() == null ? "" : en.getKey().trim();
                    if (k.length() == 0) {
                        throw new IllegalArgumentException(f.label + " 里有一个空的键（键不能为空）");
                    }
                    if (k.indexOf(':') >= 0 || k.indexOf('\uFF1A') >= 0) {
                        throw new IllegalArgumentException("键里不能有冒号：" + k);
                    }
                    if (hasWhitespace(k)) {
                        throw new IllegalArgumentException("键里不能有空白：" + k);
                    }
                    if (out.containsKey(k)) {
                        throw new IllegalArgumentException("群号重复：" + k);
                    }
                    String raw = en.getValue() == null ? "" : en.getValue().trim();
                    if (raw.length() == 0) {
                        throw new IllegalArgumentException(f.label + " 里 " + k + " 的值是空的");
                    }
                    if (f.mapValueNum) {
                        // 数字：写原字面量，*不做 factor 换算*（groupSliderPos 存的就是 0~100 本身）。
                        String num = BotConfigMap.jsonNumberOrNull(raw);
                        if (num == null) {
                            throw new IllegalArgumentException("「" + k + "」的值不是数字：" + raw);
                        }
                        out.put(k, new BotConfigJson.Num(num));
                    } else {
                        out.put(k, raw);
                    }
                }
                return out;
            }

            default:
                throw new IllegalArgumentException("未知字段类型：" + f.type);
        }
    }

    /** 键里有没有空白（含全角空格）。映射的键要原样写进 JSON，空白只会制造看不见的重复键。*/
    private static boolean hasWhitespace(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c) || Character.isSpaceChar(c)) return true;
        }
        return false;
    }

    /** 0.33000000000000002 → "0.33"；整数值不动 .0。*/
    private static String scale(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "0";
        if (v == Math.rint(v) && Math.abs(v) < 1e15) return Long.toString((long) v);
        return java.math.BigDecimal.valueOf(v).setScale(6, java.math.RoundingMode.HALF_UP)
                .stripTrailingZeros().toPlainString();
    }

    // ================================================================ 保存

    private void doSave() {
        if (!loaded || data == null) {
            cfg.toast("配置还没有载入，先点「重新读取」");
            return;
        }
        if (pending.isEmpty()) {
            cfg.toast("没有需要保存的改动");
            return;
        }

        // 1) 在*副本*上改，校验失败或写回失败都不会污染内存里的原树。
        Object working = BotConfigJson.deepCopy(data);
        ArrayList<String> errors = new ArrayList<String>();
        for (Map.Entry<String, Pending> en : pending.entrySet()) {
            String path = en.getKey();
            if (BotConfigJson.isSecret(path)) continue; // 兜底：密钥路径永不写
            BotConfigSchema.Field f = fieldByPath(path);
            if (f == null) continue;
            try {
                BotConfigJson.set(working, path, jsonOf(f, en.getValue()));
            } catch (IllegalArgumentException ex) {
                errors.add(ex.getMessage());
            }
        }
        if (!errors.isEmpty()) {
            String first = errors.get(0);
            cfg.toast(errors.size() > 1 ? (first + "（共 " + errors.size() + " 项没通过校验）") : first);
            return;
        }

        // 2) 整棵重新序列化：键序与没改过的数字字面量都保持原样。
        String json;
        try {
            json = BotConfigJson.write(working);
        } catch (Throwable th) {
            cfg.toast("序列化失败：" + describe(th));
            return;
        }

        // 3) 交给宿主写文件。
        boolean ok;
        try {
            ok = cfg.saveConfigJson(json);
        } catch (Throwable th) {
            ok = false;
        }
        if (!ok) {
            cfg.toast("保存失败：config.json 没有写成功，改动仍留在面板里（可以再试一次或点放弃）");
            return;
        }

        data = working;
        int n = pending.size();
        pending.clear();
        cfg.toast((cfg.botRunning()
                ? "已保存 " + n + " 项 · 部分配置需要重启机器人后生效"
                : "已保存 " + n + " 项 · 运行端离线，下次启动时生效"));
        renderPage();
    }

    private void refreshSaveBar() {
        if (saveBar == null) return;
        int n = pending.size();
        boolean show = page != PAGE_LIST || n > 0;
        saveBar.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) return;

        String text = n == 0 ? "没有未保存的改动" : ("有 " + n + " 项未保存");
        if (saveStatus != null && !text.equals(saveStatus.getText().toString())) {
            saveStatus.setText(text);
        }
        if (saveHintLine != null) {
            String hint = cfg.botRunning() ? "部分配置需重启机器人后生效" : "运行端离线，保存后下次启动生效";
            if (!hint.equals(saveHintLine.getText().toString())) saveHintLine.setText(hint);
        }
        boolean canSave = loaded && n > 0;
        Ui.enabled(saveAction, canSave);
        Ui.enabled(discardAction, n > 0);
    }

    // ================================================================ 错误页
    private View errorPage(String msg) {
        LinearLayout col = Ui.column(activity);
        col.addView(pageHeader("运行端配置", false), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2));
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        TextView title = Ui.strong(activity, "读不到配置文件", Theme.T_CARD, t.textPrimary);
        box.addView(title, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        TextView body = Ui.text(activity, msg, Theme.T_CAP, t.textSecondary);
        body.setLineSpacing(dp(4), 1f);
        box.addView(body, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView retry = Ui.button(activity, t, "重新读取", true);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                reload();
            }
        });
        box.addView(retry, marginTop(Ui.llp(WRAP_CONTENT, WRAP_CONTENT), dp(Theme.S3)));

        TextView tip = Ui.text(activity,
                "请先启动容器并等待运行端生成 config.json 后重试。",
                Theme.T_CAP, t.textTertiary);
        tip.setLineSpacing(dp(3), 1f);
        box.addView(tip, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        col.addView(card, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        return pageShell(col, bottomPad());
    }
}
