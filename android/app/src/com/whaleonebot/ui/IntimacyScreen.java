package com.whaleonebot.ui;

import android.text.InputType;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.List;
import java.util.Locale;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板子页：**亲密度与心情**（熟人榜 / 查一个人 / 心情与精力）。
 *
 * <p>核心升级（2026-11-26）：
 * <ul>
 *   <li>底层已改为增量统计 + 批量融合，打开即自动秒出榜单，不再干等 1 分钟；</li>
 *   <li>榜单、单查、心情流水全面中文化并展示昵称；</li>
 *   <li>单查页展示近期加减分事件记录与客观相处状态，支持「手工补记事件」；</li>
 *   <li>心情页展示当前心情/精力总览，支持快捷微调（哄一哄 / 充能 / 恢复平静 / 自定义微调）。</li>
 * </ul>
 */
final class IntimacyScreen extends Screen {

    private static final int FACET_LIST = 0;
    private static final int FACET_PERSON = 1;
    private static final int FACET_MOOD = 2;

    private static final String[] FACETS = {"熟人榜", "查一个人", "心情与精力"};

    private static final int LIST_TIMEOUT_MS = 15000;
    private static final int PERSON_TIMEOUT_MS = 15000;
    private static final int MOOD_TIMEOUT_MS = 12000;
    private static final int MIN_TICK_MS = 10000;

    private static final String[] EVENT_KIND_VALUES = {
            "praise", "care", "help", "humor", "deep_talk", "defend", "apologize", "feed",
            "annoy", "ignore", "spam", "troll", "insult", "harass"
    };
    private static final String[] EVENT_KIND_LABELS = {
            "夸奖或感谢（加分）",
            "关心体贴（加分）",
            "帮忙解决问题（加分）",
            "一起玩梗开玩笑（加分）",
            "深入聊天谈心（加分）",
            "维护机器人或群友（大加分）",
            "道歉与和好（快速回暖）",
            "投喂白饭（轻加分并回暖）",
            "反复拍打打扰（小扣分）",
            "问话不理（小扣分）",
            "刷屏灌水（扣分）",
            "恶意挑事（扣分）",
            "辱骂攻击（大扣分）",
            "骚扰纠缠（大扣分）"
    };

    private FrameLayout body;
    private ScrollView scrollView;
    private int scrollY;
    private int facet = FACET_LIST;

    // ---- 榜单 ----
    private Object listTree;
    private boolean listLoading;
    private String listError;
    private long listAt;

    // ---- 单查 ----
    private String personUin = "";
    private Object personTree;
    private boolean personLoading;
    private String personError;

    // ---- 心情与精力 ----
    private Object moodOverviewTree;
    private Object moodTree;
    private boolean moodLoading;
    private boolean moodBusy;
    private String moodError;

    private long lastTickAt;

    IntimacyScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        body = new FrameLayout(activity);
        body.setClipChildren(false);
        body.setClipToPadding(false);
        root.addView(body, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        render();
        // 底层已提速至毫秒级，进页即自动加载熟人榜
        if (listTree == null && !listLoading) loadList();
    }

    @Override
    void refresh() {
        if (body == null || facet != FACET_LIST) return;
        if (listTree == null) return;
        long now = System.currentTimeMillis();
        if (now - lastTickAt < MIN_TICK_MS) return;
        lastTickAt = now;
        render();
    }

    // ================================================================ 取数

    private void loadList() {
        if (listLoading) return;
        listLoading = true;
        listError = null;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/local/intimacy/list?limit=30", LIST_TIMEOUT_MS);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        listLoading = false;
                        if (tree == null) {
                            listError = "暂时读不到数据（请确认运行端已启动）";
                        } else {
                            listTree = tree;
                            listAt = System.currentTimeMillis();
                        }
                        render();
                    }
                });
            }
        }, "intimacy-list").start();
    }

    private void loadPerson(final String uin) {
        if (personLoading) return;
        personLoading = true;
        personError = null;
        personUin = uin;
        personTree = null;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/local/intimacy/person?uin=" + uin, PERSON_TIMEOUT_MS);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        personLoading = false;
                        if (tree == null) {
                            personError = "暂时读不到数据";
                        } else if (!truthyOk(tree)) {
                            personError = "这个人还没有互动记录";
                        } else {
                            personTree = tree;
                        }
                        render();
                    }
                });
            }
        }, "intimacy-person").start();
    }

    private void loadMood() {
        if (moodLoading) return;
        moodLoading = true;
        moodError = null;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object ov = DashApi.json(activity, "api/local/mood/overview", MOOD_TIMEOUT_MS);
                final Object lg = DashApi.json(activity, "api/local/mood/log?limit=30", MOOD_TIMEOUT_MS);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        moodLoading = false;
                        if (ov == null && lg == null) {
                            moodError = "暂时读不到心情数据";
                        } else {
                            moodOverviewTree = ov;
                            moodTree = lg;
                        }
                        render();
                    }
                });
            }
        }, "intimacy-mood").start();
    }

    private void postMoodNudge(final double dMood, final double dEnergy, final String note, final String toastOk) {
        if (moodBusy) return;
        moodBusy = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                String body = "{}";
                try {
                    body = new JSONObject()
                            .put("dMood", dMood)
                            .put("dEnergy", dEnergy)
                            .put("note", note)
                            .toString();
                } catch (Throwable ignored) {
                    // ignore
                }
                final DashApi.Resp resp = DashApi.post(DashApi.port(activity), "/api/local/mood/nudge", body, 10000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        moodBusy = false;
                        if (resp != null && resp.ok()) {
                            ModelsScreen.W.toast(activity, toastOk);
                            loadMood();
                        } else {
                            ModelsScreen.W.toast(activity, "调整失败：" + (resp == null ? "连不上运行端" : resp.reason()));
                            render();
                        }
                    }
                });
            }
        }, "mood-nudge").start();
    }

    private void postMoodSet(final double moodVal, final double energyVal, final String toastOk) {
        if (moodBusy) return;
        moodBusy = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                String body = "{}";
                try {
                    body = new JSONObject()
                            .put("mood", moodVal)
                            .put("energy", energyVal)
                            .put("by", "app")
                            .toString();
                } catch (Throwable ignored) {
                    // ignore
                }
                final DashApi.Resp resp = DashApi.post(DashApi.port(activity), "/api/local/mood/set", body, 10000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        moodBusy = false;
                        if (resp != null && resp.ok()) {
                            ModelsScreen.W.toast(activity, toastOk);
                            loadMood();
                        } else {
                            ModelsScreen.W.toast(activity, "设定失败：" + (resp == null ? "连不上运行端" : resp.reason()));
                            render();
                        }
                    }
                });
            }
        }, "mood-set").start();
    }

    private void postManualEvent(final String uin, final String chatKey, final String kind, final String note) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                String body = "{}";
                try {
                    body = new JSONObject()
                            .put("uin", uin)
                            .put("chatKey", chatKey)
                            .put("kind", kind)
                            .put("note", note)
                            .toString();
                } catch (Throwable ignored) {
                    // ignore
                }
                final DashApi.Resp resp = DashApi.post(DashApi.port(activity), "/api/local/intimacy/event", body, 10000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (resp != null && resp.ok()) {
                            ModelsScreen.W.toast(activity, "事件已补记");
                            loadPerson(uin);
                        } else {
                            ModelsScreen.W.toast(activity, "补记失败：" + (resp == null ? "连不上运行端" : resp.reason()));
                        }
                    }
                });
            }
        }, "intimacy-event-post").start();
    }

    private static boolean truthyOk(Object tree) {
        Object ok = BotConfigJson.get(tree, "ok");
        if (ok == BotConfigJson.MISSING || ok == BotConfigJson.NULL) return true;
        return ModelsScreen.U.truthy(ok);
    }

    // ================================================================ 渲染

    private void render() {
        if (body == null) return;
        final int keepY = scrollView != null ? scrollView.getScrollY() : scrollY;
        scrollY = keepY;
        body.removeAllViews();
        ScrollView v = page();
        scrollView = v;
        body.addView(v, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        if (keepY > 0) {
            v.post(new Runnable() {
                @Override
                public void run() {
                    v.scrollTo(0, keepY);
                }
            });
        }
    }

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("亲密度与心情"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, "查看熟人关系与相处事由，也可随时哄一哄或补满精力", Theme.T_CAP, t.textSecondary);
        col.addView(sub, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        LinearLayout bar = DashKit.facets(activity, t, FACETS, facet, new DashKit.OnFacet() {
            @Override
            public void onFacet(int index) {
                switchFacet(index);
            }
        });
        col.addView(bar, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        if (facet == FACET_LIST) {
            col.addView(listCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        } else if (facet == FACET_PERSON) {
            col.addView(personCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        } else {
            col.addView(moodPanel(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    private void switchFacet(int index) {
        if (index == facet) return;
        facet = index;
        scrollY = 0;
        render();
        if (facet == FACET_LIST && listTree == null && !listLoading) {
            loadList();
        } else if (facet == FACET_MOOD && moodOverviewTree == null && moodTree == null && !moodLoading) {
            loadMood();
        }
    }

    // ---------------------------------------------------------------- 面 1：熟人榜

    private View listCard() {
        int n = listTree == null ? 0 : DashApi.size(BotConfigJson.get(listTree, "rows"));
        String right = listLoading ? "读取中…" : (listTree != null ? (n + " 人上榜") : null);
        DashKit.Card c = DashKit.card(activity, t, "亲密度熟人榜", right);

        if (listLoading) {
            c.body.addView(tipLine("正在读取熟人榜…"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (listError != null) {
            c.body.addView(tipLine(listError), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (listTree == null) {
            c.body.addView(tipLine("暂无数据"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else {
            List<Object> rows = BotConfigJson.asArray(BotConfigJson.get(listTree, "rows"));
            if (rows == null || rows.isEmpty()) {
                c.body.addView(tipLine("还没有够门槛的互动对象"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            } else {
                c.body.addView(tipLine("点击任意一人可看详细事件与补记 · 更新于 " + DashApi.ago(listAt)),
                        Ui.llp(MATCH_PARENT, WRAP_CONTENT));
                int shown = Math.min(rows.size(), 30);
                for (int i = 0; i < shown; i++) {
                    Map<String, Object> r = BotConfigJson.asObject(rows.get(i));
                    if (r == null) continue;
                    if (i > 0) DashKit.divider(activity, t, c.body);
                    addRowOf(c.body, r);
                }
            }
        }

        TextView action = Ui.button(activity, t, listLoading ? "刷新中…" : "刷新榜单", false);
        Ui.enabled(action, !listLoading);
        action.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!listLoading) loadList();
            }
        });
        c.body.addView(action, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    private void addRowOf(LinearLayout parent, Map<String, Object> r) {
        final String uin = ModelsScreen.U.s(r.get("uin")).trim();
        String platLabel = ModelsScreen.U.s(r.get("platformLabel")).trim();
        String name = ModelsScreen.U.s(r.get("displayName")).trim();
        String idBadge = (platLabel.length() > 0 && !"QQ".equals(platLabel)) ? ("[" + platLabel + "] " + uin) : uin;
        String title = name.length() > 0 ? (name + "（" + idBadge + "）") : (idBadge.length() == 0 ? "—" : idBadge);
        String state = ModelsScreen.U.s(r.get("relationshipState")).trim();
        if (state.length() == 0) state = ModelsScreen.U.s(r.get("tier")).trim();
        String score = numText(BotConfigJson.numOf(r.get("score")));
        String msgs = numText(BotConfigJson.numOf(r.get("messageCount")));
        String days = numText(BotConfigJson.numOf(r.get("activeDays")));
        String rank = numText(BotConfigJson.numOf(r.get("rank")));

        StringBuilder sub = new StringBuilder();
        sub.append(score).append(" 分");
        if (state.length() > 0) sub.append(" · ").append(state);
        sub.append(" · 聊过 ").append(msgs).append(" 句 · 活跃 ").append(days).append(" 天");

        DashKit.row(activity, t, parent, title, sub.toString(),
                "—".equals(rank) ? null : ("#" + rank), uin.length() >= 3,
                uin.length() >= 3 ? new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        facet = FACET_PERSON;
                        scrollY = 0;
                        loadPerson(uin);
                    }
                } : null);
    }

    // ---------------------------------------------------------------- 面 2：查一个人

    private View personCard() {
        LinearLayout col = Ui.column(activity);
        DashKit.Card c = DashKit.card(activity, t, "单人关系明细", personUin.length() == 0 ? null : personUin);

        DashKit.row(activity, t, c.body, "查询对象（QQ 号或跨平台 ID）",
                personUin.length() == 0 ? "支持 QQ 号、bilibili:UID、douyin:ID" : personUin, null, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        askUin();
                    }
                });

        if (personLoading) {
            c.body.addView(tipLine("读取中…"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (personError != null) {
            c.body.addView(tipLine(personError), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (personTree != null) {
            Object info = BotConfigJson.get(personTree, "info");
            if (BotConfigJson.asObject(info) == null) info = personTree;
            DashKit.divider(activity, t, c.body);

            String platLabel = ModelsScreen.U.s(BotConfigJson.get(info, "platformLabel")).trim();
            if (platLabel.length() > 0) kv(c.body, "所属平台", platLabel);
            String name = ModelsScreen.U.s(BotConfigJson.get(info, "displayName")).trim();
            if (name.length() > 0) kv(c.body, "昵称", name);
            kv(c.body, "综合亲密度", numText(BotConfigJson.numOf(BotConfigJson.get(info, "score"))) + " / 100");
            String relState = ModelsScreen.U.s(BotConfigJson.get(info, "relationshipState")).trim();
            String tier = ModelsScreen.U.s(BotConfigJson.get(info, "tier")).trim();
            kv(c.body, "当前相处状态", relState.length() > 0 ? relState : (tier.length() > 0 ? tier : "—"));
            kv(c.body, "互动基础分", numText(BotConfigJson.numOf(BotConfigJson.get(info, "baseScore"))) + " 分");

            double evDelta = BotConfigJson.numOf(BotConfigJson.get(info, "eventDelta"));
            String evText = Double.isNaN(evDelta) || evDelta == 0
                    ? "无加减分影响"
                    : ((evDelta > 0 ? "+" : "") + numText(evDelta) + " 分");
            kv(c.body, "近期事件影响", evText);

            String rank = numText(BotConfigJson.numOf(BotConfigJson.get(info, "rank")));
            String total = numText(BotConfigJson.numOf(BotConfigJson.get(info, "total")));
            kv(c.body, "熟人排名", "—".equals(total) ? rank : ("第 " + rank + " / " + total + " 名"));
            kv(c.body, "累计发言", numText(BotConfigJson.numOf(BotConfigJson.get(info, "messageCount"))) + " 句");
            kv(c.body, "活跃天数", numText(BotConfigJson.numOf(BotConfigJson.get(info, "activeDays"))) + " 天");

            TextView addEv = Ui.button(activity, t, "手工补记一条事件", true);
            addEv.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    askManualEvent(personUin);
                }
            });
            c.body.addView(addEv, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        } else {
            c.body.addView(tipLine("输入 QQ 号或在「熟人榜」直接点人查看详细记录"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
        col.addView(c.view, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 近期加减分事件清单
        if (personTree != null) {
            List<Object> events = BotConfigJson.asArray(BotConfigJson.get(personTree, "events"));
            DashKit.Card evCard = DashKit.card(activity, t, "近期加减分事件",
                    events == null ? "0 条" : (events.size() + " 条"));
            if (events == null || events.isEmpty()) {
                evCard.body.addView(tipLine("还没有记录过特别事件"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            } else {
                int max = Math.min(events.size(), 25);
                for (int i = 0; i < max; i++) {
                    Map<String, Object> ev = BotConfigJson.asObject(events.get(i));
                    if (ev == null) continue;
                    if (i > 0) DashKit.divider(activity, t, evCard.body);
                    String label = ModelsScreen.U.s(ev.get("label")).trim();
                    if (label.length() == 0) label = kindLabel(ModelsScreen.U.s(ev.get("kind")));
                    double w = BotConfigJson.numOf(ev.get("weight"));
                    String wStr = Double.isNaN(w) || w == 0 ? "中性" : ((w > 0 ? "+" : "") + numText(w));
                    String note = ModelsScreen.U.s(ev.get("note")).trim();
                    long ts = (long) BotConfigJson.numOf(ev.get("ts"));
                    String sub = (ts > 0 ? DashApi.when(ts) : ModelsScreen.U.s(ev.get("day")))
                            + (note.length() > 0 ? (" · " + note) : "");
                    DashKit.row(activity, t, evCard.body, label, sub, wStr, false, null);
                }
            }
            col.addView(evCard.view, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        return col;
    }

    private void askUin() {
        ModelsScreen.W.textDialog(activity, t, "查一个人",
                "输入 QQ 号（如 123456）或跨平台 ID（如 bilibili:12345 / douyin:abc）", personUin, InputType.TYPE_CLASS_TEXT, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        String s = text == null ? "" : text.trim();
                        if (s.length() == 0) return "用户标识不能为空";
                        if (s.matches("^\\d{5,15}$")) return null;
                        if (s.matches("^(qq|bili|bilibili|douyin|dy|web|custom):[A-Za-z0-9._-]{1,80}$")) return null;
                        return "请填 5~15 位 QQ 号，或带平台前缀的 ID（如 bilibili:12345）";
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        loadPerson(text.trim());
                    }
                });
    }

    private void askManualEvent(final String uin) {
        if (uin == null || uin.length() < 3) return;
        final String defaultChatKey = uin.contains(":") ? uin.replaceFirst(":", ":private:") : ("private:" + uin);
        ModelsScreen.W.chooseDialog(activity, t, "选择事件类型", "事件会按统一规则换算成加减分，并实时更新相处状态",
                EVENT_KIND_LABELS, EVENT_KIND_VALUES, "praise",
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(final String chosenKind) {
                        ModelsScreen.W.textDialog(activity, t, "填写一句事由（可留空）",
                                "例如：帮我修了电脑 / 刚刚哄了我", "", InputType.TYPE_CLASS_TEXT, false,
                                null, new ModelsScreen.W.TextCb() {
                                    @Override
                                    public void onText(String note) {
                                        postManualEvent(uin, defaultChatKey, chosenKind,
                                                note == null ? "" : note.trim());
                                    }
                                });
                    }
                });
    }

    // ---------------------------------------------------------------- 面 3：心情与精力

    private View moodPanel() {
        LinearLayout col = Ui.column(activity);

        // 卡片 A：当前心情与精力 + 快捷微调
        DashKit.Card curCard = DashKit.card(activity, t, "当前状态与快捷调节", moodBusy ? "调整中…" : null);
        if (moodOverviewTree != null) {
            double mv = BotConfigJson.numOf(BotConfigJson.get(moodOverviewTree, "global.mood"));
            double ev = BotConfigJson.numOf(BotConfigJson.get(moodOverviewTree, "global.energy"));
            boolean sleeping = ModelsScreen.U.truthy(BotConfigJson.get(moodOverviewTree, "global.sleeping"));
            if (!Double.isNaN(mv)) {
                kv(curCard.body, "当前心情", numText(mv) + " / 100（" + moodDesc(mv) + "）");
            }
            if (!Double.isNaN(ev)) {
                kv(curCard.body, "当前精力", numText(ev) + " / 100（" + energyDesc(ev) + (sleeping ? " · 休息时段" : "") + "）");
            }
            List<Object> scopes = BotConfigJson.asArray(BotConfigJson.get(moodOverviewTree, "scopes"));
            if (scopes != null && !scopes.isEmpty()) {
                int max = Math.min(scopes.size(), 4);
                for (int i = 0; i < max; i++) {
                    Map<String, Object> s = BotConfigJson.asObject(scopes.get(i));
                    if (s == null) continue;
                    String sc = ModelsScreen.U.s(s.get("scope"));
                    double lm = BotConfigJson.numOf(BotConfigJson.get(s, "local.mood"));
                    double le = BotConfigJson.numOf(BotConfigJson.get(s, "local.energy"));
                    kv(curCard.body, DashKit.chatLabel(sc),
                            "心情 " + signedText(lm) + " · 精力 " + signedText(le));
                }
            }
        } else if (moodLoading) {
            curCard.body.addView(tipLine("正在读取心情与精力…"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (moodError != null) {
            curCard.body.addView(tipLine(moodError), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        // 快捷按钮：哄一哄 / 充能 / 恢复平静 / 精准微调
        TextView btnSoothe = Ui.button(activity, t, "哄一哄（心情 +10）", true);
        Ui.enabled(btnSoothe, !moodBusy);
        btnSoothe.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                postMoodNudge(10, 0, "手机端哄一哄", "心情变好啦（+10）");
            }
        });
        curCard.body.addView(btnSoothe, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView btnCharge = Ui.button(activity, t, "休息充能（精力 +20）", false);
        Ui.enabled(btnCharge, !moodBusy);
        btnCharge.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                postMoodNudge(0, 20, "手机端充能休息", "精力恢复啦（+20）");
            }
        });
        curCard.body.addView(btnCharge, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        TextView btnReset = Ui.button(activity, t, "恢复平静（心情 55 · 精力 75）", false);
        Ui.enabled(btnReset, !moodBusy);
        btnReset.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                postMoodSet(55, 75, "已恢复平静与充沛精力");
            }
        });
        curCard.body.addView(btnReset, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        TextView btnCustom = Ui.button(activity, t, "精准微调数值", false);
        Ui.enabled(btnCustom, !moodBusy);
        btnCustom.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askCustomMood();
            }
        });
        curCard.body.addView(btnCustom, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        col.addView(curCard.view, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 卡片 B：全中文心情变化流水
        int n = moodTree == null ? 0 : DashApi.size(BotConfigJson.get(moodTree, "rows"));
        DashKit.Card logCard = DashKit.card(activity, t, "最近心情变化记录",
                moodLoading ? "读取中…" : (moodTree == null ? null : (n + " 条")));
        if (moodLoading) {
            logCard.body.addView(tipLine("读取中…"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (moodTree == null) {
            logCard.body.addView(tipLine("还没有变化记录"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else {
            List<Object> rows = BotConfigJson.asArray(BotConfigJson.get(moodTree, "rows"));
            if (rows == null || rows.isEmpty()) {
                logCard.body.addView(tipLine("还没有变化记录"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            } else {
                int shown = Math.min(rows.size(), 30);
                for (int i = 0; i < shown; i++) {
                    Map<String, Object> r = BotConfigJson.asObject(rows.get(i));
                    if (r == null) continue;
                    if (i > 0) DashKit.divider(activity, t, logCard.body);
                    DashKit.row(activity, t, logCard.body, moodRowTitle(r), moodRowSub(r), null, false, null);
                }
            }
        }
        TextView again = Ui.button(activity, t, "刷新记录", false);
        Ui.enabled(again, !moodLoading);
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!moodLoading) loadMood();
            }
        });
        logCard.body.addView(again, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(logCard.view, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private void askCustomMood() {
        ModelsScreen.W.textDialog(activity, t, "精准设定全局心情（0~100）",
                "例如 65（50 为平静，70 以上为很开心）", "60", InputType.TYPE_CLASS_NUMBER, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        try {
                            double v = Double.parseDouble(text.trim());
                            if (v < 0 || v > 100) return "请填写 0~100 之间的数字";
                            return null;
                        } catch (Throwable th) {
                            return "请填写有效数字";
                        }
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String moodText) {
                        final double targetMood = Double.parseDouble(moodText.trim());
                        ModelsScreen.W.textDialog(activity, t, "精准设定全局精力（0~100）",
                                "例如 80（65 为正常，40 以下偏累）", "75", InputType.TYPE_CLASS_NUMBER, false,
                                new ModelsScreen.W.Check() {
                                    @Override
                                    public String check(String text) {
                                        try {
                                            double v = Double.parseDouble(text.trim());
                                            if (v < 0 || v > 100) return "请填写 0~100 之间的数字";
                                            return null;
                                        } catch (Throwable th) {
                                            return "请填写有效数字";
                                        }
                                    }
                                },
                                new ModelsScreen.W.TextCb() {
                                    @Override
                                    public void onText(String energyText) {
                                        double targetEnergy = Double.parseDouble(energyText.trim());
                                        postMoodSet(targetMood, targetEnergy, "已更新心情与精力");
                                    }
                                });
                    }
                });
    }

    private String moodRowTitle(Map<String, Object> r) {
        String key = ModelsScreen.U.s(r.get("scope")).trim();
        String place = (key.length() == 0 || "global".equals(key)) ? "全局状态" : DashKit.chatLabel(key);
        String kind = kindLabel(ModelsScreen.U.s(r.get("kind")).trim());
        return place + " · " + kind;
    }

    private String moodRowSub(Map<String, Object> r) {
        StringBuilder sb = new StringBuilder();
        long ms = timeOf(r);
        if (ms > 0) sb.append(DashApi.when(ms));
        double dm = BotConfigJson.numOf(r.get("dMood"));
        if (Double.isNaN(dm)) dm = BotConfigJson.numOf(r.get("d_mood"));
        double de = BotConfigJson.numOf(r.get("dEnergy"));
        if (Double.isNaN(de)) de = BotConfigJson.numOf(r.get("d_energy"));
        if (!Double.isNaN(dm) && dm != 0) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append("心情 ").append(signedText(dm));
        }
        if (!Double.isNaN(de) && de != 0) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append("精力 ").append(signedText(de));
        }
        String note = ModelsScreen.U.s(r.get("note")).trim();
        if (note.length() > 0) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(DashKit.cut(note, 24));
        }
        return sb.toString();
    }

    private static String kindLabel(String kind) {
        if ("praise".equals(kind)) return "夸奖/感谢";
        if ("humor".equals(kind)) return "玩梗开心";
        if ("care".equals(kind)) return "收到关心";
        if ("help".equals(kind)) return "得到帮忙";
        if ("deep_talk".equals(kind)) return "深入聊天";
        if ("defend".equals(kind)) return "被人维护";
        if ("share".equals(kind)) return "好物分享";
        if ("apologize".equals(kind)) return "道歉和好";
        if ("feed".equals(kind)) return "投喂白饭";
        if ("insult".equals(kind)) return "遭到辱骂";
        if ("harass".equals(kind)) return "遭到骚扰";
        if ("troll".equals(kind)) return "恶意挑事";
        if ("annoy".equals(kind)) return "反复打扰";
        if ("spam".equals(kind)) return "刷屏灌水";
        if ("ignore".equals(kind)) return "遭到冷落";
        if ("politics".equals(kind)) return "敏感引战";
        if ("manual".equals(kind)) return "手工微调";
        if ("admin".equals(kind)) return "管理员设定";
        return kind == null || kind.length() == 0 ? "状态变动" : kind;
    }

    private static String moodDesc(double m) {
        if (m >= 65) return "心情很好";
        if (m >= 45) return "平静正常";
        if (m >= 30) return "有点低落";
        return "很不痛快";
    }

    private static String energyDesc(double e) {
        if (e >= 70) return "精神充沛";
        if (e >= 40) return "精力正常";
        if (e >= 20) return "有点疲惫";
        return "精疲力尽";
    }

    private static String signedText(double v) {
        if (Double.isNaN(v)) return "0";
        String s = numText(v);
        return v > 0 ? ("+" + s) : s;
    }

    private static long timeOf(Map<String, Object> r) {
        String[] keys = {"ts", "at", "time", "createdAt", "updatedAt", "lastAt", "timestamp"};
        for (int i = 0; i < keys.length; i++) {
            double d = BotConfigJson.numOf(r.get(keys[i]));
            if (!Double.isNaN(d) && d > 0) return (long) d;
        }
        return 0;
    }

    private TextView tipLine(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        return v;
    }

    private void kv(LinearLayout parent, String k, String v) {
        DashKit.kv(activity, t, parent, k, v);
    }

    private static String numText(double d) {
        if (Double.isNaN(d)) return "—";
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return String.valueOf((long) d);
        return String.format(Locale.US, "%.1f", d);
    }

    private static LinearLayout.LayoutParams mt(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }
}
