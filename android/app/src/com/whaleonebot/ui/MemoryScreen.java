package com.whaleonebot.ui;

import android.text.InputType;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板 ·「记忆」：四个清晰页面 —— 群印象 / 最近的事 / 人物 / 长期记忆。
 *
 * <p>核心升级（2026-11-26）：
 * <ul>
 *   <li>点进某个群后直接查看该群所有成员的详细印象，不再跳到默认空白的长期记忆页；</li>
 *   <li>支持直接「新增人工印象（永久保护不被自动删）」和点击「删除写错的印象」（含防误触确认）；</li>
 *   <li>新增「最近的事」标签页，按天翻看机器人记住的群里大事小事；</li>
 *   <li>人物详情异步补齐该人的「最新近况」与「相处里程碑/转折」。</li>
 * </ul>
 */
final class MemoryScreen extends Screen {

    private static final int F_SESSION = 0;
    private static final int F_EPISODES = 1;
    private static final int F_PEOPLE = 2;
    private static final int F_LONG = 3;
    private static final int F_TOOLS = 4;

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;

    private int facet = F_SESSION;
    private Object filesTree;
    private String selectedChatKey;
    private Object chatDetailTree;
    private Object episodesTree;
    private Object peopleTree;
    private Object longTree;
    private String longTypeFilter = "";
    private Object supersededTree;
    private Object vectorStatusTree;
    private Object importJobsTree;
    private boolean toolBusy;
    private String toolNote;
    private String scopeKey;
    private String error;
    private boolean loading;
    private long lastFetchAt;

    MemoryScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        host = new FrameLayout(activity);
        host.setClipChildren(false);
        host.setClipToPadding(false);
        root.addView(host, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        render();
        loadFiles();
    }

    @Override
    void onAttach() {
        if (filesTree == null && !loading) loadFiles();
    }

    @Override
    void refresh() {
        if (facet != F_SESSION || selectedChatKey != null || loading) return;
        if (System.currentTimeMillis() - lastFetchAt < 15000) return;
        loadFiles();
    }

    // ---------------------------------------------------------------- 取数

    private void loadFiles() {
        loading = true;
        lastFetchAt = System.currentTimeMillis();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/memory-files", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到记忆数据";
                        else {
                            filesTree = tree;
                            error = null;
                            if (scopeKey == null || scopeKey.length() == 0) {
                                List<Map<String, Object>> files =
                                        DashApi.objects(BotConfigJson.get(tree, "files"));
                                if (!files.isEmpty()) scopeKey = DashApi.str(files.get(0), "chatKey");
                            }
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-files").start();
    }

    private void loadChatDetail(final String chatKey) {
        if (chatKey == null || chatKey.length() == 0) return;
        selectedChatKey = chatKey;
        chatDetailTree = null;
        loading = true;
        scrollY = 0;
        render();
        final String path = "api/memory-files/" + chatKey.replace(':', '_');
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, path, 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到该会话的印象详情";
                        else {
                            chatDetailTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-chat-detail").start();
    }

    private void loadEpisodes() {
        loading = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/local/episodes/list?limit=60&days=90", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到最近发生的事";
                        else {
                            episodesTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-episodes").start();
    }

    private void loadPeople() {
        loading = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity,
                        "api/identity-pilot/people?limit=50", 20000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到人物列表";
                        else {
                            peopleTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-people").start();
    }

    private void loadLong() {
        if (scopeKey == null || scopeKey.length() == 0) {
            render();
            return;
        }
        loading = true;
        longTree = null;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity,
                        "api/living-memory/memories?scopeKey=" + scopeKey + "&limit=20", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到长期记忆数据";
                        else {
                            longTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-long").start();
    }

    private void appendManualImpression(final String uin, final String name, final String chatKey, final String content) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String body = "{}";
                try {
                    body = new JSONObject()
                            .put("content", content)
                            .put("chatKey", chatKey == null ? "" : chatKey)
                            .put("name", name == null ? "" : name)
                            .toString();
                } catch (Throwable ignored) {
                    // ignore
                }
                final DashApi.Resp resp = DashApi.post(DashApi.port(activity),
                        "/api/memory-files/global/members/" + uin + "/append", body, 12000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (resp != null && resp.ok()) {
                            ModelsScreen.W.toast(activity, "已添加永久保护的人工印象");
                            if (selectedChatKey != null) loadChatDetail(selectedChatKey);
                            else loadFiles();
                        } else {
                            ModelsScreen.W.toast(activity, "添加失败：" + (resp == null ? "连不上运行端" : resp.reason()));
                        }
                    }
                });
            }
        }, "dm-mem-append").start();
    }

    private void deleteImpressionItem(final String uin, final String content) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String body = "{}";
                try {
                    body = new JSONObject()
                            .put("confirm", true)
                            .put("content", content)
                            .toString();
                } catch (Throwable ignored) {
                    // ignore
                }
                final DashApi.Resp resp = DashApi.post(DashApi.port(activity),
                        "/api/memory-files/global/members/" + uin + "/delete-item", body, 12000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (resp != null && resp.ok()) {
                            ModelsScreen.W.toast(activity, "已删除这条印象");
                            if (selectedChatKey != null) loadChatDetail(selectedChatKey);
                        } else {
                            ModelsScreen.W.toast(activity, "删除失败：" + (resp == null ? "连不上运行端" : resp.reason()));
                        }
                    }
                });
            }
        }, "dm-mem-del").start();
    }

    // ---------------------------------------------------------------- 渲染

    private void render() {
        if (host == null) return;
        int keep = scrollView == null ? scrollY : scrollView.getScrollY();
        scrollY = keep;
        host.removeAllViews();
        ScrollView v = page();
        scrollView = v;
        host.addView(v, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        if (keep > 0) {
            v.post(new Runnable() {
                @Override
                public void run() {
                    if (scrollView != null) scrollView.scrollTo(0, keep);
                }
            });
        }
    }

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("记忆库"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        col.addView(DashKit.facets(activity, t,
                new String[]{"群印象", "最近的事", "人物", "长期记忆", "导入与工具"}, facet, new DashKit.OnFacet() {
                    @Override
                    public void onFacet(int index) {
                        if (index == facet) return;
                        facet = index;
                        scrollY = 0;
                        if (index == F_EPISODES && episodesTree == null) loadEpisodes();
                        else if (index == F_PEOPLE && peopleTree == null) loadPeople();
                        else if (index == F_LONG && longTree == null) loadLong();
                        else if (index == F_TOOLS) loadToolsData();
                        else render();
                    }
                }), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (facet == F_SESSION) col.addView(sessionFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else if (facet == F_EPISODES) col.addView(episodesFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else if (facet == F_PEOPLE) col.addView(peopleFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else if (facet == F_LONG) col.addView(longFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else col.addView(toolsFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    // ---------------------------------------------------------------- ① 群印象（列表 + 详细编辑）

    private View sessionFacet() {
        if (selectedChatKey != null && selectedChatKey.length() > 0) {
            return chatDetailView();
        }
        LinearLayout col = Ui.column(activity);

        List<Map<String, Object>> files = DashApi.objects(BotConfigJson.get(filesTree, "files"));
        Object stats = BotConfigJson.get(filesTree, "stats");
        long entries = (long) DashApi.num(stats, "entries");
        long people = (long) DashApi.num(stats, "people");

        TextView sub = Ui.text(activity,
                filesTree == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : files.size() + " 个会话 · 共记住 " + entries + " 条印象（" + people + " 人）· 点进群查看和编辑",
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 顶部一键导入记忆快捷卡（文档或 .zip/.tar.gz 压缩包 → 提交记忆整理模型提炼入向量库）
        DashKit.Card quickImp = DashKit.card(activity, t, "导入文档 / 压缩包到记忆库", null);
        DashKit.kv(activity, t, quickImp.body, "提炼管线",
                "支持 .md / .txt / .json / .csv 或整个 .zip / .tar.gz 压缩包，提交后由记忆整理模型自动提炼并写入向量库。");
        LinearLayout qRow = Ui.row(activity);
        TextView qBg = Ui.button(activity, t, "导入背景记忆", true);
        Ui.enabled(qBg, !toolBusy);
        qBg.setOnClickListener(v -> startMemoryFileImport("background"));
        TextView qProf = Ui.button(activity, t, "提炼人物画像", false);
        Ui.enabled(qProf, !toolBusy);
        qProf.setOnClickListener(v -> startMemoryFileImport("profile"));
        qRow.addView(qBg, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams qLp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        qLp.leftMargin = dp(Theme.S2);
        qRow.addView(qProf, qLp);
        quickImp.body.addView(qRow, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(quickImp.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        DashKit.Card c = DashKit.card(activity, t, "各群/私聊印象", null);
        if (files.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "还没有印象记录");
        for (int i = 0; i < files.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> m = files.get(i);
            final String key = DashApi.str(m, "chatKey");
            long imp = (long) DashApi.num(m, "impressionCount");
            long mem = (long) DashApi.num(m, "memberCount");
            long upd = (long) DashApi.num(m, "updatedAt");
            boolean busy = ModelsScreen.U.truthy(BotConfigJson.get(m, "consolidating"));
            DashKit.row(activity, t, c.body, DashKit.chatLabel(key),
                    "记住 " + imp + " 条印象 · " + mem + " 人 · 更新于 " + DashApi.ago(upd),
                    busy ? "整理中" : "", true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            loadChatDetail(key);
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private View chatDetailView() {
        LinearLayout col = Ui.column(activity);

        LinearLayout top = Ui.row(activity);
        TextView backBtn = Ui.button(activity, t, "← 返回群列表", false);
        backBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                selectedChatKey = null;
                chatDetailTree = null;
                scrollY = 0;
                render();
            }
        });
        top.addView(backBtn, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        TextView addBtn = Ui.button(activity, t, "+ 新增人工印象", true);
        addBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askAddImpression("", "", selectedChatKey);
            }
        });
        LinearLayout.LayoutParams alp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        alp.leftMargin = dp(Theme.S2);
        top.addView(addBtn, alp);
        col.addView(top, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView head = Ui.text(activity,
                DashKit.chatLabel(selectedChatKey) + " · 点某条印象可删除（手写印象永久保护）",
                Theme.T_CAP, t.textSecondary);
        col.addView(head, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (loading) {
            DashKit.Card c = DashKit.card(activity, t, "读取中…", null);
            DashKit.kv(activity, t, c.body, "状态", "正在拉取本群成员印象…");
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            return col;
        }

        List<Map<String, Object>> members = DashApi.objects(BotConfigJson.get(chatDetailTree, "members"));
        if (members.isEmpty()) {
            DashKit.Card c = DashKit.card(activity, t, "本群印象", null);
            DashKit.kv(activity, t, c.body, "状态", "这个会话还没有成员印象，可以点上方「+ 新增人工印象」手动记一条。");
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            return col;
        }

        for (int i = 0; i < members.size(); i++) {
            final Map<String, Object> mem = members.get(i);
            final String uid = DashApi.str(mem, "userId");
            final String name = DashApi.str(mem, "name");
            String cardTitle = name.length() > 0 ? (name + "（" + uid + "）") : uid;
            List<Map<String, Object>> imps = DashApi.objects(BotConfigJson.get(mem, "impressions"));

            DashKit.Card mc = DashKit.card(activity, t, cardTitle, imps.size() + " 条");
            if (imps.isEmpty()) {
                DashKit.kv(activity, t, mc.body, "印象", "暂无");
            } else {
                for (int j = 0; j < imps.size(); j++) {
                    if (j > 0) DashKit.divider(activity, t, mc.body);
                    final Map<String, Object> imp = imps.get(j);
                    final String content = DashApi.str(imp, "content");
                    String origin = DashApi.str(imp, "origin");
                    long at = (long) DashApi.num(imp, "lastObservedAt");
                    if (at <= 0) at = (long) DashApi.num(imp, "createdAt");
                    String tag = "manual".equals(origin) ? "手写·永久保留"
                            : "consolidated".equals(origin) ? "自动整理" : "聊天记住";
                    String subLine = tag + (at > 0 ? (" · " + DashApi.when(at)) : "");
                    DashKit.row(activity, t, mc.body, content, subLine, "删除", true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            confirmDeleteImpression(uid, cardTitle, content);
                        }
                    });
                }
            }
            TextView addForPerson = Ui.button(activity, t, "给 TA 补充一条人工印象", false);
            addForPerson.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    askAddImpression(uid, name, selectedChatKey);
                }
            });
            mc.body.addView(addForPerson, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            col.addView(mc.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return col;
    }

    private void askAddImpression(final String presetUin, final String presetName, final String chatKey) {
        if (presetUin != null && presetUin.length() >= 5) {
            askImpressionContent(presetUin, presetName, chatKey);
            return;
        }
        ModelsScreen.W.textDialog(activity, t, "新增人工印象（第 1 步）",
                "请输入对方 QQ 号（5~15 位数字）", "", InputType.TYPE_CLASS_NUMBER, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.length() < 5 || text.length() > 15) return "请输入 5~15 位 QQ 号";
                        for (int i = 0; i < text.length(); i++) {
                            char c = text.charAt(i);
                            if (c < '0' || c > '9') return "只能填数字";
                        }
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String uin) {
                        askImpressionContent(uin.trim(), "", chatKey);
                    }
                });
    }

    private void askImpressionContent(final String uin, final String name, final String chatKey) {
        String title = name != null && name.length() > 0
                ? ("给 " + name + " 新增人工印象")
                : ("给 QQ " + uin + " 新增人工印象");
        ModelsScreen.W.textDialog(activity, t, title,
                "例如：喜欢喝拿铁、对剧透很敏感（手写印象永久保留，不会被自动整理删掉）", "",
                InputType.TYPE_CLASS_TEXT, true,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.trim().length() == 0) return "印象内容不能为空";
                        if (text.trim().length() > 300) return "最多 300 字";
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String content) {
                        appendManualImpression(uin, name, chatKey, content.trim());
                    }
                });
    }

    private void confirmDeleteImpression(final String uin, final String who, final String content) {
        ModelsScreen.W.chooseDialog(activity, t, "确认删除这条印象？",
                who + "：\n「" + DashKit.cut(content, 80) + "」",
                new String[]{"确认删除", "先留着"},
                new String[]{"yes", "no"},
                "no",
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String v) {
                        if ("yes".equals(v)) deleteImpressionItem(uin, content);
                    }
                });
    }

    // ---------------------------------------------------------------- ② 最近发生的事（事件记忆）

    private View episodesFacet() {
        LinearLayout col = Ui.column(activity);
        List<Map<String, Object>> rows = DashApi.objects(BotConfigJson.get(episodesTree, "rows"));

        LinearLayout bar = Ui.row(activity);
        TextView sub = Ui.text(activity,
                episodesTree == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : ("最近 " + rows.size() + " 件群里发生过的事（按天记录）"),
                Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        slp.weight = 1f;
        bar.addView(sub, slp);

        TextView ref = Ui.button(activity, t, "刷新", false);
        ref.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadEpisodes();
            }
        });
        bar.addView(ref, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        col.addView(bar, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        DashKit.Card c = DashKit.card(activity, t, "最近发生的事", null);
        if (rows.isEmpty()) {
            DashKit.kv(activity, t, c.body, "状态", loading ? "读取中…" : "还没有整理出的近期事件（聊满 20 条会自动按天总结）");
        } else {
            for (int i = 0; i < rows.size(); i++) {
                if (i > 0) DashKit.divider(activity, t, c.body);
                Map<String, Object> r = rows.get(i);
                String day = DashApi.str(r, "day");
                String ck = DashApi.str(r, "chatKey");
                String who = DashApi.str(r, "who");
                String summary = DashApi.str(r, "summary");
                String title = (day.length() > 0 ? ("[" + day + "] ") : "") + summary;
                String meta = DashKit.chatLabel(ck) + (who.length() > 0 ? (" · 涉及：" + who) : "");
                DashKit.row(activity, t, c.body, title, meta, null, false, null);
            }
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    // ---------------------------------------------------------------- ③ 人物（含近况与相处转折）

    private View peopleFacet() {
        LinearLayout col = Ui.column(activity);

        List<Map<String, Object>> people = DashApi.objects(BotConfigJson.get(peopleTree, "people"));
        int friends = 0;
        for (int i = 0; i < people.size(); i++) {
            if (ModelsScreen.U.truthy(BotConfigJson.get(people.get(i), "isFriend"))) friends++;
        }

        TextView sub = Ui.text(activity,
                peopleTree == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : people.size() + " 人 · 好友 " + friends + " · 点人看近况与相处转折",
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        DashKit.Card c = DashKit.card(activity, t, "认识的人", null);
        if (people.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "还没有记录");
        for (int i = 0; i < people.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> m = people.get(i);
            String name = DashApi.str(m, "primaryName");
            String uid = DashApi.str(m, "userId");
            long msgs = (long) DashApi.num(m, "messageCount");
            long chats = (long) DashApi.num(m, "chatCount");
            boolean isFriend = ModelsScreen.U.truthy(BotConfigJson.get(m, "isFriend"));
            long last = (long) DashApi.num(m, "lastSeenAt");
            DashKit.row(activity, t, c.body, name.length() > 0 ? name : uid,
                    uid + " · 聊过 " + msgs + " 句 · " + chats + " 个会话" + (isFriend ? " · 好友" : ""),
                    DashApi.ago(last), true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            showPersonWithInsights(m);
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private void showPersonWithInsights(final Map<String, Object> m) {
        final String uid = DashApi.str(m, "userId");
        final String title = DashApi.str(m, "primaryName").length() > 0 ? DashApi.str(m, "primaryName") : uid;
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object insights = uid.length() >= 5
                        ? DashApi.json(activity, "api/local/person/insights?uin=" + uid, 8000)
                        : null;
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        StringBuilder sb = new StringBuilder();
                        sb.append("QQ 号：").append(uid).append('\n');

                        List<Map<String, Object>> aliases = DashApi.objects(BotConfigJson.get(m, "aliases"));
                        if (!aliases.isEmpty()) {
                            StringBuilder al = new StringBuilder();
                            for (int i = 0; i < aliases.size(); i++) {
                                String a = DashApi.str(aliases.get(i), "alias");
                                if (a.length() == 0) continue;
                                if (al.length() > 0) al.append("、");
                                al.append(a);
                            }
                            if (al.length() > 0) sb.append("曾用昵称：").append(al).append('\n');
                        }

                        // 6 维立体人物画像（中量级 Hindsight Entity Mental Model）
                        Object profDims = BotConfigJson.get(insights, "profile.dimensions");
                        if (BotConfigJson.asObject(profDims) != null) {
                            String[][] dims = {
                                    {"identity", "基本身份与背景"},
                                    {"style", "性格与说话风格"},
                                    {"interests", "兴趣爱好与常聊话题"},
                                    {"boundaries", "沟通偏好与雷点边界"},
                                    {"shared", "彼此关系与共同梗"},
                                    {"recent", "近期动态与约定"}
                            };
                            StringBuilder pb = new StringBuilder();
                            for (int i = 0; i < dims.length; i++) {
                                String val = DashApi.str(profDims, dims[i][0]);
                                if (val.length() > 0) {
                                    pb.append("· ").append(dims[i][1]).append("：").append(val).append('\n');
                                }
                            }
                            if (pb.length() > 0) {
                                sb.append("\n【6 维立体人物画像】\n").append(pb);
                            }
                        }

                        // 最新近况
                        String stLine = DashApi.str(BotConfigJson.get(insights, "status"), "line");
                        String stAgo = DashApi.str(BotConfigJson.get(insights, "status"), "ago");
                        if (stLine.length() > 0) {
                            sb.append("\n【最近近况】\n").append(stLine);
                            if (stAgo.length() > 0) sb.append("（").append(stAgo).append("）");
                            sb.append('\n');
                        }

                        // 相处里程碑/转折
                        List<Map<String, Object>> msItems = DashApi.objects(BotConfigJson.get(insights, "milestones.items"));
                        if (!msItems.isEmpty()) {
                            sb.append("\n【相处转折与里程碑】\n");
                            for (int i = 0; i < msItems.size(); i++) {
                                Map<String, Object> it = msItems.get(i);
                                String lb = DashApi.str(it, "label");
                                String dt = DashApi.str(it, "detail");
                                if (lb.length() > 0) {
                                    sb.append("· ").append(lb);
                                    if (dt.length() > 0) sb.append("：").append(dt);
                                    sb.append('\n');
                                }
                            }
                        }

                        sb.append("\n【印象统计】\n");
                        sb.append("全库 ").append((long) DashApi.num(m, "globalMemoryCount"))
                                .append(" 条 · 本会话 ").append((long) DashApi.num(m, "currentMemoryCount"))
                                .append(" 条\n");
                        sb.append("初次认识：").append(DashApi.when((long) DashApi.num(m, "firstSeenAt"))).append('\n');
                        sb.append("最近活跃：").append(DashApi.when((long) DashApi.num(m, "lastSeenAt"))).append('\n');

                        String profile = DashKit.textOf(BotConfigJson.get(m, "safeProfile"));
                        if (profile.length() > 0) sb.append('\n').append(profile);

                        ModelsScreen.W.infoDialog(activity, t, title, sb.toString());
                    }
                });
            }
        }, "dm-person-insights").start();
    }

    // ---------------------------------------------------------------- ④ 长期记忆（高级）

    private View longFacet() {
        LinearLayout col = Ui.column(activity);

        LinearLayout bar = Ui.row(activity);
        TextView scope = Ui.text(activity,
                scopeKey == null || scopeKey.length() == 0 ? "先选一个会话范围"
                        : "范围：" + DashKit.chatLabel(scopeKey) + " · 共 "
                        + (long) DashApi.num(longTree, "total") + " 条",
                Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        slp.weight = 1f;
        bar.addView(scope, slp);

        TextView filterBtn = Ui.button(activity, t,
                longTypeFilter.length() == 0 ? "分类：全部" : ("分类：" + typeLabel(longTypeFilter)), false);
        filterBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                chooseLongType();
            }
        });
        bar.addView(filterBtn, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        TextView pick = Ui.button(activity, t, "换范围", false);
        pick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                chooseScope();
            }
        });
        LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        plp.leftMargin = dp(Theme.S1);
        bar.addView(pick, plp);
        col.addView(bar, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        List<Map<String, Object>> rawEntries = DashApi.objects(BotConfigJson.get(longTree, "entries"));
        List<Map<String, Object>> entries = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < rawEntries.size(); i++) {
            Map<String, Object> e = rawEntries.get(i);
            if (longTypeFilter.length() == 0 || longTypeFilter.equals(DashApi.str(e, "type"))) {
                entries.add(e);
            }
        }
        if (entries.isEmpty()) {
            DashKit.Card c = DashKit.card(activity, t, "语义长期记忆（高级）", null);
            DashKit.kv(activity, t, c.body, "状态",
                    loading ? "读取中…" : (longTree == null
                            ? (scopeKey == null ? "先选一个范围" : (error == null ? "—" : error))
                            : (longTypeFilter.length() > 0 ? "这个分类下还没有记忆卡片" : "这个范围还没有语义长期记忆（需在设置 → 记忆里手动开启）")));
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            return col;
        }

        for (int i = 0; i < entries.size(); i++) {
            Map<String, Object> e = entries.get(i);
            String type = typeLabel(DashApi.str(e, "type"));
            double importance = DashApi.num(e, "importance");
            long created = (long) DashApi.num(e, "createdAt");
            long recalls = (long) DashApi.num(e, "recallCount");
            String meta = DashApi.when(created)
                    + (Double.isNaN(importance) ? "" : (" · 重要度 " + String.format(java.util.Locale.US, "%.1f", importance)))
                    + (recalls > 0 ? (" · 已巩固 " + recalls + " 次") : "");
            DashKit.Card c = DashKit.card(activity, t, "【" + type + "】", meta);
            String summary = DashApi.str(e, "summary");
            if (summary.length() > 0) DashKit.block(activity, t, c.body, summary);
            String content = DashApi.str(e, "content");
            if (content.length() > 0 && !content.equals(summary)) DashKit.block(activity, t, c.body, DashKit.cut(content, 160));
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return col;
    }

    private void chooseLongType() {
        ModelsScreen.W.chooseDialog(activity, t, "按分类筛选长期记忆", null,
                new String[]{"全部分类", "约定", "偏好", "规则", "事实", "事件", "项目", "画像"},
                new String[]{"", "commitment", "preference", "rule", "fact", "episode", "project", "profile"},
                longTypeFilter,
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String value) {
                        longTypeFilter = value == null ? "" : value;
                        render();
                    }
                });
    }

    // ---------------------------------------------------------------- ⑤ 记忆工具箱（过时恢复 / 语义向量 / 多文件导入）

    private void loadToolsData() {
        loading = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object vec = DashApi.json(activity, "api/local/memory/vector-status", 10000);
                final Object sup = DashApi.json(activity, "api/local/memory/superseded?limit=40", 10000);
                final Object imp = DashApi.json(activity, "api/local/import/status", 10000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (vec != null) vectorStatusTree = vec;
                        if (sup != null) supersededTree = sup;
                        if (imp != null) importJobsTree = imp;
                        render();
                    }
                });
            }
        }, "dm-mem-tools").start();
    }

    private View toolsFacet() {
        LinearLayout col = Ui.column(activity);

        if (toolNote != null && toolNote.length() > 0) {
            TextView nt = Ui.text(activity, toolNote, Theme.T_CAP, t.accent);
            nt.setLineSpacing(dp(3), 1f);
            col.addView(nt, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        // 卡 1：三层语义向量状态 + 一键为老印象补齐向量 + 离线轻量中文向量包
        DashKit.Card vCard = DashKit.card(activity, t, "按意思联想（三层语义引擎）", toolBusy ? "处理中…" : null);
        if (vectorStatusTree == null) {
            DashKit.kv(activity, t, vCard.body, "状态", loading ? "读取中…" : "尚未读取");
        } else {
            String active = DashApi.str(BotConfigJson.get(vectorStatusTree, "engine"), "activeLabel");
            long total = (long) DashApi.num(vectorStatusTree, "total");
            long ready = (long) DashApi.num(vectorStatusTree, "ready");
            boolean offlineOk = ModelsScreen.U.truthy(BotConfigJson.get(vectorStatusTree, "engine.offline.installed"));
            DashKit.kv(activity, t, vCard.body, "当前生效引擎", active.length() > 0 ? active : "内置高级语义增强");
            DashKit.kv(activity, t, vCard.body, "印象向量覆盖", ready + " / " + total + " 条已建立语义向量");
            DashKit.kv(activity, t, vCard.body, "离线轻量向量包", offlineOk ? "已安装（纯离线毫秒级可用）" : "未安装（可一键下载或直接用在线/FTS5垫底）");
        }
        TextView bfBtn = Ui.button(activity, t, toolBusy ? "正在补齐向量…" : "一键为老印象补齐语义向量", true);
        Ui.enabled(bfBtn, !toolBusy);
        bfBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                runVectorBackfill();
            }
        });
        vCard.body.addView(bfBtn, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView dlPackBtn = Ui.button(activity, t, "下载安装离线轻量中文向量包（几十 MB）", false);
        Ui.enabled(dlPackBtn, !toolBusy);
        dlPackBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askInstallOfflinePack();
            }
        });
        vCard.body.addView(dlPackBtn, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        col.addView(vCard.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 卡 2：多选文档或压缩包导入记忆库（经记忆整理模型提炼入向量库）
        DashKit.Card iCard = DashKit.card(activity, t, "从手机导入文档或压缩包到记忆库", null);
        DashKit.kv(activity, t, iCard.body, "说明", "支持多选 .txt / .md / .json / .csv 以及 .zip / .tar.gz / .tar 压缩包，自动安全解压并交由记忆整理模型提炼写入向量库。");
        TextView impProfileBtn = Ui.button(activity, t, "选文件 → 提炼为某人的 6 维人物画像", true);
        Ui.enabled(impProfileBtn, !toolBusy);
        impProfileBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startMemoryFileImport("profile");
            }
        });
        iCard.body.addView(impProfileBtn, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView impBgBtn = Ui.button(activity, t, "选文件 → 导入为背景记忆卡片", false);
        Ui.enabled(impBgBtn, !toolBusy);
        impBgBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startMemoryFileImport("background");
            }
        });
        iCard.body.addView(impBgBtn, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        List<Map<String, Object>> jobs = DashApi.objects(BotConfigJson.get(importJobsTree, "jobs"));
        if (!jobs.isEmpty()) {
            DashKit.divider(activity, t, iCard.body);
            int max = Math.min(jobs.size(), 5);
            for (int i = 0; i < max; i++) {
                Map<String, Object> j = jobs.get(i);
                String st = DashApi.str(j, "status");
                String stLabel = "done".equals(st) ? "已完成" : ("running".equals(st) ? "消化中" : ("queued".equals(st) ? "排队中" : "失败"));
                String title = ("profile".equals(DashApi.str(j, "mode")) ? "人物画像导入" : "背景记忆导入")
                        + "（" + (long) DashApi.num(j, "fileCount") + " 个文件）";
                String sub = stLabel + " · 产出 " + (long) DashApi.num(j, "processedItems") + " 项 · "
                        + DashApi.ago((long) DashApi.num(j, "createdAt"));
                DashKit.row(activity, t, iCard.body, title, sub, null, false, null);
            }
        }
        col.addView(iCard.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 卡 3：已过时 / 被新替旧换下的旧记忆（支持一键恢复）
        List<Map<String, Object>> profHist = DashApi.objects(BotConfigJson.get(supersededTree, "profileItems"));
        List<Map<String, Object>> cardHist = DashApi.objects(BotConfigJson.get(supersededTree, "cardItems"));
        int totalSup = profHist.size() + cardHist.size();
        DashKit.Card sCard = DashKit.card(activity, t, "已过时 / 被替换的旧记忆", totalSup + " 条");
        if (totalSup == 0) {
            DashKit.kv(activity, t, sCard.body, "状态", "暂无被新情况顶替掉的旧记忆（发生搬家、偏好变更等新替旧后会留痕在此，随时可一键恢复）。");
        } else {
            int shown = 0;
            for (int i = 0; i < profHist.size() && shown < 15; i++, shown++) {
                if (shown > 0) DashKit.divider(activity, t, sCard.body);
                final Map<String, Object> r = profHist.get(i);
                final String hid = String.valueOf((long) DashApi.num(r, "id"));
                String title = DashApi.str(r, "actorId") + " · " + DashApi.str(r, "dimensionLabel");
                String sub = "旧：" + DashKit.cut(DashApi.str(r, "oldValue"), 40)
                        + "\n新：" + DashKit.cut(DashApi.str(r, "newValue"), 40);
                DashKit.row(activity, t, sCard.body, title, sub, "恢复", true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        confirmRestoreSuperseded("profile", hid, DashApi.str(r, "oldValue"));
                    }
                });
            }
            for (int i = 0; i < cardHist.size() && shown < 25; i++, shown++) {
                if (shown > 0) DashKit.divider(activity, t, sCard.body);
                final Map<String, Object> r = cardHist.get(i);
                final String cid = DashApi.str(r, "id");
                String title = "【" + typeLabel(DashApi.str(r, "type")) + "】" + DashKit.chatLabel(DashApi.str(r, "scopeKey"));
                String sub = "旧卡片：" + DashKit.cut(DashApi.str(r, "oldValue"), 60);
                DashKit.row(activity, t, sCard.body, title, sub, "恢复", true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        confirmRestoreSuperseded("living-memory", cid, DashApi.str(r, "oldValue"));
                    }
                });
            }
        }
        TextView refTools = Ui.button(activity, t, "刷新工具箱状态", false);
        refTools.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                loadToolsData();
            }
        });
        sCard.body.addView(refTools, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(sCard.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private void runVectorBackfill() {
        if (toolBusy) return;
        toolBusy = true;
        toolNote = "正在为所有历史印象补齐语义向量…";
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final DashApi.Resp resp = DashApi.post(DashApi.port(activity),
                        "/api/local/memory/vector-backfill", "{}", 120000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        toolBusy = false;
                        if (resp != null && resp.ok()) {
                            toolNote = "老印象语义向量补齐完成。";
                            ModelsScreen.W.toast(activity, "语义向量补齐完成");
                            loadToolsData();
                        } else {
                            toolNote = "补齐失败：" + (resp == null ? "连不上运行端" : resp.reason());
                            render();
                        }
                    }
                });
            }
        }, "dm-vec-backfill").start();
    }

    private void askInstallOfflinePack() {
        ModelsScreen.W.textDialog(activity, t, "下载离线轻量中文向量包",
                "填入 WZVEC001 格式向量包的 https 下载地址（零原生依赖，下载校验后即刻生效）",
                "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || !text.trim().startsWith("https://")) return "请填写 https:// 开头的安全下载地址";
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(final String url) {
                        toolBusy = true;
                        toolNote = "正在下载并校验离线轻量中文向量包…";
                        render();
                        new Thread(new Runnable() {
                            @Override
                            public void run() {
                                String body = "{}";
                                try {
                                    body = new JSONObject().put("url", url.trim()).toString();
                                } catch (Throwable ignored) { }
                                final DashApi.Resp resp = DashApi.post(DashApi.port(activity),
                                        "/api/local/semantic/install-pack", body, 180000);
                                activity.runOnUiThread(new Runnable() {
                                    @Override
                                    public void run() {
                                        toolBusy = false;
                                        if (resp != null && resp.ok()) {
                                            toolNote = "离线轻量中文向量包已校验并安装生效。";
                                            ModelsScreen.W.toast(activity, "离线向量包安装成功");
                                            loadToolsData();
                                        } else {
                                            toolNote = "安装失败：" + (resp == null ? "连不上运行端" : resp.reason());
                                            render();
                                        }
                                    }
                                });
                            }
                        }, "dm-vec-install").start();
                    }
                });
    }

    private void startMemoryFileImport(final String mode) {
        if ("profile".equals(mode)) {
            ModelsScreen.W.textDialog(activity, t, "导入为谁的 6 维人物画像？",
                    "填对方 QQ 号或跨平台 ID（如 bilibili:12345）", "", InputType.TYPE_CLASS_TEXT, false,
                    new ModelsScreen.W.Check() {
                        @Override
                        public String check(String text) {
                            String s = text == null ? "" : text.trim();
                            if (s.matches("^\\d{5,15}$") || s.matches("^(qq|bili|bilibili|douyin|dy|web|custom):[A-Za-z0-9._-]{1,80}$")) return null;
                            return "请填合法 QQ 号或带平台前缀的用户 ID";
                        }
                    },
                    new ModelsScreen.W.TextCb() {
                        @Override
                        public void onText(final String actorId) {
                            pickAndSubmitMemoryFiles("profile", actorId.trim());
                        }
                    });
        } else {
            pickAndSubmitMemoryFiles("background", "");
        }
    }

    private void pickAndSubmitMemoryFiles(final String mode, final String targetActorId) {
        shell.pickMultipleTextFiles(new AppShell.MultiTextCallback() {
            @Override
            public void onPicked(final java.util.List<AppShell.PickedTextFile> files, String err) {
                if (files == null || files.isEmpty()) {
                    if (err != null) ModelsScreen.W.toast(activity, err);
                    return;
                }
                toolBusy = true;
                toolNote = "正在提交 " + files.size() + " 个文件进记忆库后台消化队列…";
                render();
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        String body = "{}";
                        try {
                            org.json.JSONArray arr = new org.json.JSONArray();
                            for (int i = 0; i < files.size(); i++) {
                                AppShell.PickedTextFile f = files.get(i);
                                arr.put(new JSONObject().put("name", f.name).put("content", f.content));
                            }
                            body = new JSONObject()
                                    .put("mode", mode)
                                    .put("targetActorId", targetActorId)
                                    .put("chatKey", scopeKey == null ? "" : scopeKey)
                                    .put("files", arr)
                                    .toString();
                        } catch (Throwable ignored) { }
                        final DashApi.Resp resp = DashApi.post(DashApi.port(activity),
                                "/api/local/import/memory", body, 60000);
                        activity.runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                toolBusy = false;
                                if (resp != null && (resp.ok() || resp.code == 202)) {
                                    toolNote = "已提交 " + files.size() + " 个文件进后台队列消化，可随时刷新查看进度。";
                                    ModelsScreen.W.toast(activity, "已进入后台记忆消化队列");
                                    loadToolsData();
                                } else {
                                    toolNote = "提交失败：" + (resp == null ? "连不上运行端" : resp.reason());
                                    render();
                                }
                            }
                        });
                    }
                }, "dm-mem-file-import").start();
            }
        });
    }

    private void confirmRestoreSuperseded(final String source, final String id, final String oldVal) {
        ModelsScreen.W.chooseDialog(activity, t, "确认恢复这条旧记忆？",
                "恢复后内容：\n「" + DashKit.cut(oldVal, 100) + "」",
                new String[]{"确认恢复", "取消"},
                new String[]{"yes", "no"},
                "no",
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String v) {
                        if (!"yes".equals(v)) return;
                        new Thread(new Runnable() {
                            @Override
                            public void run() {
                                String body = "{}";
                                try {
                                    body = new JSONObject().put("source", source).put("id", id).toString();
                                } catch (Throwable ignored) { }
                                final DashApi.Resp resp = DashApi.post(DashApi.port(activity),
                                        "/api/local/memory/restore", body, 10000);
                                activity.runOnUiThread(new Runnable() {
                                    @Override
                                    public void run() {
                                        if (resp != null && resp.ok()) {
                                            ModelsScreen.W.toast(activity, "已恢复该条旧记忆");
                                            loadToolsData();
                                        } else {
                                            ModelsScreen.W.toast(activity, "恢复失败：" + (resp == null ? "连不上运行端" : resp.reason()));
                                        }
                                    }
                                });
                            }
                        }, "dm-mem-restore").start();
                    }
                });
    }

    private void chooseScope() {
        List<Map<String, Object>> files = DashApi.objects(BotConfigJson.get(filesTree, "files"));
        final List<String> keys = new ArrayList<String>();
        List<String> labels = new ArrayList<String>();
        for (int i = 0; i < files.size(); i++) {
            String k = DashApi.str(files.get(i), "chatKey");
            if (k.length() == 0) continue;
            keys.add(k);
            labels.add(DashKit.chatLabel(k) + " · " + (long) DashApi.num(files.get(i), "impressionCount") + " 条");
        }
        if (keys.isEmpty()) {
            ModelsScreen.W.toast(activity, "会话列表还没加载");
            return;
        }
        ModelsScreen.W.chooseDialog(activity, t, "选一个会话范围", null,
                labels.toArray(new String[0]), keys.toArray(new String[0]), scopeKey,
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String value) {
                        scopeKey = value;
                        longTree = null;
                        scrollY = 0;
                        loadLong();
                    }
                });
    }

    private static String typeLabel(String type) {
        if ("episode".equals(type)) return "事件";
        if ("fact".equals(type)) return "事实";
        if ("profile".equals(type)) return "画像";
        if ("preference".equals(type)) return "偏好";
        if ("commitment".equals(type)) return "约定";
        if ("project".equals(type)) return "项目";
        if ("rule".equals(type)) return "规则";
        return type == null || type.length() == 0 ? "记忆" : type;
    }
}
