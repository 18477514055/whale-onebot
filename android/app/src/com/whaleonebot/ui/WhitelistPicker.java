package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.content.DialogInterface;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 「从会话选择」浮层：把白名单 / 黑名单的号码从手填改成勾选。
 *
 * <p>数据来源是协议端的 {@code get_known_chats} —— 机器人<b>真的收到过消息</b>的会话。
 * 它比 {@code get_group_list} 可靠：那一条在手机上原生回调永远不触发（只回 1502），
 * 而它也不带群名。群名由只读扩展 {@code get_chat_names} 补：拿群号再问一次原生群详情
 * （与 {@code get_group_info} 同一读法），最多 50 个、逐个 3 秒。那一路失败或超时
 * <b>只影响名字</b>：照样显示号码，列表本身绝不因此失败。
 *
 * <p><b>端口与令牌</b>只从 App 私有目录里的 {@code rootfs/opt/whale/qq-state/bot.json} 读，
 * 除了塞进那一次 HTTP 请求头，不落日志、不进界面、不出现在任何提示里。读取或请求任何一步
 * 失败（没文件 / 没令牌 / 端口不通 / 3 秒超时 / JSON 结构不对）都落到同一句话：
 * 「读取会话失败，请手填」，并且只留「取消」—— 这里的失败绝不允许把面板带崩。
 *
 * <p><b>线程</b>：文件读取与 HTTP 全在后台线程，结果再 {@code runOnUiThread} 回来弹窗，
 * 主线程不碰 IO。
 *
 * <p>纯逻辑（解析 / 预勾选 / 合并 / 正则取端口令牌）都收在 {@link Model} 里：
 * 它一个 Android 类型都不引用，所以能在普通 JVM 上用假 JSON 直接跑探针。
 */
final class WhitelistPicker {

    private WhitelistPicker() {
    }

    /** 0 = 群聊（{@code type=="group"}）；1 = 私聊（{@code type=="private"}）。 */
    static final int KIND_GROUP = 0;
    static final int KIND_PRIVATE = 1;

    /** 网络超时：连接与读取都按这个算。 */
    private static final int TIMEOUT_MS = 3000;

    /**
     * 群名那一路的超时。协议端那边是「逐个群 3 秒、整批 ≤ 15 秒」，
     * 这里给 6 秒：能拿回一部分就先显示一部分，拿不回就只显示号码。
     */
    private static final int NAMES_TIMEOUT_MS = 16000;

    /** 一次最多问多少个群的群名（与协议端 {@code get_chat_names} 的上限一致）。 */
    private static final int MAX_NAME_QUERIES = 50;

    /** 一次最多拉多少行进列表（防御异常大的响应把浮层撑爆）。 */
    private static final int MAX_ROWS = 200;

    /** 列表超过这个行数就固定高度并允许滚动，否则按内容自然撑开。 */
    private static final int SCROLL_ROWS = 6;

    /** 同一时刻只允许一层浮层：连点不会叠出第二个。只在主线程读写。 */
    private static Dialog open;

    interface Callback {
        /**
         * @param ids     用户最终勾选的号码（原字段顺序在前，新勾的按点击顺序在后）
         * @param removed 原本在字段里、这次被**取消勾选**的号码（只含列表里真的显示过的）
         */
        void onPicked(List<String> ids, List<String> removed);
    }

    // ================================================================ 入口

    /**
     * 拉会话列表，回来后在自己画的浮层里让用户勾选。
     *
     * @param already 该字段当前值（含用户本次已编辑但没保存的内容），命中的号码预勾选
     * @param kind    {@link #KIND_GROUP} 或 {@link #KIND_PRIVATE}
     */
    static void show(final Activity activity, final Theme theme, final String title,
                     final List<String> already, final int kind, final Callback cb) {
        if (activity == null || theme == null) return;
        final Activity host = activity;
        final Theme t = theme;
        final String heading = title;
        final List<String> pre = already == null
                ? new ArrayList<String>() : new ArrayList<String>(already);
        final int k = kind == KIND_GROUP ? KIND_GROUP : KIND_PRIVATE;
        final Callback callback = cb;

        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                // 后台线程：读 bot.json + 一次 HTTP。失败返回 null，不抛。
                final List<WhitelistModel.Chat> chats = loadChats(host, k);
                host.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (host.isFinishing()) return;
                        try {
                            showDialog(host, t, heading, pre, chats, callback,
                                    k == KIND_PRIVATE ? "好友 + 收到过消息的会话" : "群列表 + 收到过消息的群", k);
                        } catch (Throwable ignored) {
                            // 弹窗都弹不出来时不做事，也绝不把面板带崩
                        }
                    }
                });
            }
        }, "known-chats");
        th.setDaemon(true);
        th.start();
    }

    /** 合并待写回的号码：原有行原样保留（含空行），新勾选的按顺序追加，去重。 */
    static ArrayList<String> mergeIds(List<String> existing, List<String> picked) {
        return WhitelistModel.merge(existing, picked);
    }

    // ================================================================ 取数

    /** 协议端状态文件。位置与 {@code ContainerService.qqStateDir()} 一致，只是这里只读。 */
    private static final String BOT_JSON = "rootfs/opt/whale/qq-state/bot.json";

    /** 共用协议端一次性 POST 查询，供白名单选人页与 QQ 状态卡复用（令牌绝不落日志）。 */
    static String queryProtocol(Activity activity, String action, String json, int timeoutMs) {
        try {
            if (activity == null) return null;
            String cfgText = readText(new File(activity.getFilesDir(), BOT_JSON));
            if (cfgText == null) {
                try {
                    cfgText = readText(new File("/data/data/" + activity.getPackageName()
                            + "/files/" + BOT_JSON));
                } catch (Throwable ignored) {
                    cfgText = null;
                }
            }
            if (cfgText == null) return null;
            String port = WhitelistModel.portOf(cfgText);
            String token = WhitelistModel.tokenOf(cfgText);
            if (port == null || port.length() == 0) return null;
            if (token == null || token.length() == 0) return null;
            return postJson(port, token, action, json, timeoutMs);
        } catch (Throwable th) {
            return null;
        }
    }

    /** 读 bot.json → 取端口与令牌 → POST 协议端。任何一步失败都返回 null。 */
    private static List<WhitelistModel.Chat> loadChats(Activity activity, int kind) {
        try {
            String body = queryProtocol(activity, "get_known_chats", "{}", TIMEOUT_MS);
            List<WhitelistModel.Chat> chats = body == null ? null : WhitelistModel.parse(body, kind);

            if (kind == KIND_PRIVATE) {
                String friends = queryProtocol(activity, "get_friend_list", "{}", TIMEOUT_MS);
                List<WhitelistModel.Chat> friendList = friends == null ? null : WhitelistModel.parseFriends(friends);
                chats = WhitelistModel.mergeSources(friendList, chats);
            } else if (kind == KIND_GROUP) {
                // 冷启动首次走非 Hook Web CGI 拉群列表需 10~15s，放宽超时避免提前截断
                String groups = queryProtocol(activity, "get_group_list", "{}", 15000);
                List<WhitelistModel.Chat> groupList = groups == null ? null : WhitelistModel.parseGroups(groups);
                chats = WhitelistModel.mergeSources(groupList, chats);
            }

            if (kind == KIND_GROUP && chats != null && !chats.isEmpty()) {
                // 先把本次从 get_group_list 拿到的真群名落盘缓存
                Map<String, String> fresh = new java.util.LinkedHashMap<String, String>();
                for (WhitelistModel.Chat ch : chats) {
                    if (ch != null && ch.id != null && ch.name != null && ch.name.trim().length() > 0) {
                        fresh.put(ch.id, ch.name.trim());
                    }
                }
                if (!fresh.isEmpty()) saveCachedGroupNames(activity, fresh);

                String reqJson = WhitelistModel.groupsRequest(chats);
                if (!reqJson.contains("[]")) {
                    String namesBody = queryProtocol(activity, "get_chat_names", reqJson, NAMES_TIMEOUT_MS);
                    Map<String, String> names = namesBody == null ? null : WhitelistModel.parseNames(namesBody);
                    if (names != null && !names.isEmpty()) saveCachedGroupNames(activity, names);
                    chats = WhitelistModel.withNames(chats, names);
                }
            }
            // 远程控制模式或本机无协议端时，回退经 DashApi 读取运行端已记录的会话列表（自动走 P2P 隧道）
            if ((chats == null || chats.isEmpty()) && activity != null) {
                List<WhitelistModel.Chat> fromApi = loadChatsFromDashApi(activity, kind);
                if (fromApi != null && !fromApi.isEmpty()) {
                    chats = WhitelistModel.mergeSources(chats, fromApi);
                }
            }
            // 群聊用本地持久化群名缓存 + 手动备注兜底（即使 QQ 暂离线也显示清晰群名）
            if (kind == KIND_GROUP && chats != null && !chats.isEmpty() && activity != null) {
                Map<String, String> mergedNames = loadMergedGroupNames(activity);
                if (!mergedNames.isEmpty()) {
                    chats = WhitelistModel.withNames(chats, mergedNames);
                }
            }
            return chats;
        } catch (Throwable th) {
            return null;
        }
    }

    private static final String GROUP_CACHE_FILE = "group-names-cache.json";
    private static final String GROUP_REMARK_FILE = "group-remarks.json";

    /** 读取「手动备注 > 最近一次非 Hook Web CGI 缓存」合并后的群名映射。 */
    static Map<String, String> loadMergedGroupNames(android.content.Context ctx) {
        Map<String, String> out = new java.util.LinkedHashMap<String, String>();
        if (ctx == null) return out;
        mergeJsonMap(out, new File(ctx.getFilesDir(), GROUP_CACHE_FILE));
        mergeJsonMap(out, new File(ctx.getFilesDir(), GROUP_REMARK_FILE));
        return out;
    }

    static String cachedGroupName(android.content.Context ctx, String groupId) {
        if (ctx == null || groupId == null || groupId.trim().isEmpty()) return "";
        String v = loadMergedGroupNames(ctx).get(groupId.trim());
        return v == null ? "" : v;
    }

    static void saveGroupRemark(android.content.Context ctx, String groupId, String remark) {
        if (ctx == null || groupId == null || groupId.trim().isEmpty()) return;
        File f = new File(ctx.getFilesDir(), GROUP_REMARK_FILE);
        Map<String, String> cur = new java.util.LinkedHashMap<String, String>();
        mergeJsonMap(cur, f);
        String clean = remark == null ? "" : remark.trim();
        if (clean.isEmpty()) cur.remove(groupId.trim());
        else cur.put(groupId.trim(), clean);
        writeStringMap(f, cur);
    }

    static void saveCachedGroupNames(android.content.Context ctx, Map<String, String> fresh) {
        if (ctx == null || fresh == null || fresh.isEmpty()) return;
        File f = new File(ctx.getFilesDir(), GROUP_CACHE_FILE);
        Map<String, String> cur = new java.util.LinkedHashMap<String, String>();
        mergeJsonMap(cur, f);
        cur.putAll(fresh);
        writeStringMap(f, cur);
    }

    /** 一键异步刷新全部群名（非 Hook Web CGI 优先，刷新完成回调刷新界面）。 */
    static void refreshAllGroupNames(final Activity activity, final java.util.function.Consumer<Integer> onDone) {
        if (activity == null) return;
        new Thread(() -> {
            int count = 0;
            try {
                List<WhitelistModel.Chat> list = loadChats(activity, KIND_GROUP);
                if (list != null) {
                    for (WhitelistModel.Chat ch : list) {
                        if (ch != null && ch.name != null && !ch.name.trim().isEmpty()) count++;
                    }
                }
            } catch (Throwable ignored) {}
            final int total = count;
            activity.runOnUiThread(() -> { if (onDone != null) onDone.accept(total); });
        }, "whale-refresh-groups").start();
    }

    private static void mergeJsonMap(Map<String, String> dst, File f) {
        String raw = readText(f);
        if (raw == null || raw.trim().isEmpty()) return;
        try {
            Map<String, Object> obj = BotConfigJson.asObject(BotConfigJson.parse(raw));
            if (obj == null) return;
            for (Map.Entry<String, Object> e : obj.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                String v = String.valueOf(e.getValue()).trim();
                if (!v.isEmpty()) dst.put(e.getKey().trim(), v);
            }
        } catch (Throwable ignored) {}
    }

    private static void writeStringMap(File f, Map<String, String> m) {
        try {
            Map<String, Object> obj = new java.util.LinkedHashMap<String, Object>();
            for (Map.Entry<String, String> e : m.entrySet()) obj.put(e.getKey(), e.getValue());
            java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
            try {
                fos.write(BotConfigJson.write(obj).getBytes("UTF-8"));
            } finally {
                fos.close();
            }
        } catch (Throwable ignored) {}
    }

    /** 兜底从运行端 /api/chats 拉取已知群/好友（兼容远程 P2P 模式）。 */
    private static List<WhitelistModel.Chat> loadChatsFromDashApi(Activity activity, int kind) {
        try {
            DashApi.Result r = DashApi.get(activity, "/api/chats", 5000);
            if (r == null || !r.ok || r.data == null) return null;
            List<Object> arr = null;
            if (r.data instanceof List) {
                arr = BotConfigJson.asArray(r.data);
            } else {
                Map<String, Object> m = BotConfigJson.asObject(r.data);
                if (m != null) arr = BotConfigJson.asArray(m.get("chats"));
            }
            if (arr == null || arr.isEmpty()) return null;
            List<WhitelistModel.Chat> out = new ArrayList<WhitelistModel.Chat>();
            String prefix = kind == KIND_GROUP ? "group:" : "private:";
            for (int i = 0; i < arr.size(); i++) {
                Map<String, Object> item = BotConfigJson.asObject(arr.get(i));
                if (item == null) continue;
                String chatKey = DashApi.str(item, "chatKey", "");
                if (!chatKey.startsWith(prefix)) continue;
                String id = chatKey.substring(prefix.length()).trim();
                if (id.length() == 0) continue;
                String name = DashApi.str(item, "name", "");
                if (name.length() == 0) name = DashApi.str(item, "displayName", "");
                out.add(new WhitelistModel.Chat(id, 0L, 0, name));
            }
            return out;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String readText(File f) {
        if (f == null || !f.isFile()) return null;
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Throwable th) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // 关不掉就算了，连接马上跟着回收
                }
            }
        }
    }

    /** 包装 OneBot 根路径请求体（若 paramsJson 已是完整 {"action":...} 信封则避免双重包裹）。 */
    static String buildOneBotEnvelope(String action, String json) {
        String trimmed = (json == null || json.trim().length() == 0) ? "{}" : json.trim();
        if (trimmed.startsWith("{") && trimmed.contains("\"action\"") && trimmed.contains("\"params\"")) {
            return trimmed;
        }
        String safeAction = action == null ? "" : action.replace("\\", "\\\\").replace("\"", "\\\"");
        return "{\"action\":\"" + safeAction + "\",\"params\":" + trimmed + "}";
    }

    /** POST 空对象 {@code {}} 到本机协议端。返回响应文本；任何异常 / 非 200 都返回 null。 */
    private static String post(String port, String token, String action) {
        return postJson(port, token, action, "{}", TIMEOUT_MS);
    }

    /**
     * POST 一个 JSON 体到本机协议端。返回响应文本；任何异常 / 非 200 / 超时都返回 null。
     *
     * @param json      请求体（{@code null} 按 {@code {}} 处理）
     * @param timeoutMs 连接与读取超时
     */
    private static String postJson(String port, String token, String action, String json, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            // ★ 必须发到 **根路径** `/`（payload 里带 {action, params}），不能发到 `/<action>`：
            //   实测 2026-11-19——路径式调用会把 params 当成「顶层字段」校验，我们这个带 groups 数组的
            //   请求被回 `1400 Invalid action parameters`；同样的 body 发到 `/` 则正常返回。
            URL url = new URL("http://127.0.0.1:" + port + "/");
            c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setDoOutput(true);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            try {
                // Host 是受保护头：某些实现会直接拒绝。显式写它，但被拒也不能拖垮整个请求。
                c.setRequestProperty("Host", "127.0.0.1:" + port);
            } catch (Throwable ignored) {
                // 忽略：默认 Host 本来就是它
            }
            // 正确包装 OneBot 根路径请求体；若调用方（如 WhitelistModel.groupsRequest）已构造完整 {"action":...} 信封则直接透传，杜绝双重嵌套返 1400
            String envelope = buildOneBotEnvelope(action, json);
            byte[] body = envelope.getBytes("UTF-8");
            c.setFixedLengthStreamingMode(body.length);
            OutputStream os = c.getOutputStream();
            try {
                os.write(body);
                os.flush();
            } finally {
                try {
                    os.close();
                } catch (Throwable ignored) {
                    // 同上
                }
            }
            int code = c.getResponseCode();
            if (code != 200) {
                InputStream es = null;
                try {
                    es = c.getErrorStream();
                } catch (Throwable ignored) {
                    es = null;
                }
                if (es != null) {
                    try {
                        es.close();
                    } catch (Throwable ignored) {
                        // 同上
                    }
                }
                return null;
            }
            InputStream in = c.getInputStream();
            try {
                return readAll(in);
            } finally {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // 同上
                }
            }
        } catch (Throwable th) {
            return null;
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                    // 同上
                }
            }
        }
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return null;
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "UTF-8");
    }

    // ================================================================ 浮层

    private static Dialog newDialog(Activity a) {
        try {
            Dialog d = new Dialog(a);
            try {
                // 主题里若本来就带标题栏，这个调用会抛；抛了也不影响（内容自己画）
                d.requestWindowFeature(Window.FEATURE_NO_TITLE);
            } catch (Throwable ignored) {
                // 忽略
            }
            d.setCanceledOnTouchOutside(true);
            return d;
        } catch (Throwable th) {
            return null;
        }
    }

    private static void showDialog(final Activity a, final Theme t, final String title,
                                   final List<String> already, final List<WhitelistModel.Chat> chats,
                                   final Callback cb, final String hint, final int kind) {
        if (open != null) return; // 已经有一层浮层：连点不再叠第二层
        final Dialog dlg = newDialog(a);
        if (dlg == null) return;

        LinearLayout box = Ui.column(a);
        box.setPadding(dp(a, Theme.S3), dp(a, Theme.S3), dp(a, Theme.S3), dp(a, Theme.S3));

        String heading = (title == null || title.length() == 0) ? "从会话选择" : title;
        TextView head = Ui.strong(a, heading, Theme.T_CARD, t.textPrimary);
        head.setLineSpacing(dp(a, 2), 1f);
        box.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        box.addView(tip(a, t, hint == null ? "只显示收到过消息的会话" : hint),
                top(a, 6, MATCH_PARENT, WRAP_CONTENT));

        boolean failed = chats == null;
        boolean empty = !failed && chats.isEmpty();

        final LinkedHashSet<String> sel = new LinkedHashSet<String>();
        // 进来时的勾选快照：确定时用它算「被取消勾选」的那些
        // （只做合并的话勾选形同虚设：取消了也不会从字段里删掉）。
        final LinkedHashSet<String> initial = new LinkedHashSet<String>();

        if (failed) {
            box.addView(pill(a, t, "读取会话失败，请手填"),
                    top(a, Theme.S2, MATCH_PARENT, WRAP_CONTENT));
        } else if (empty) {
            box.addView(pill(a, t, "还没有收到过消息的会话"),
                    top(a, Theme.S2, MATCH_PARENT, WRAP_CONTENT));
        } else {
            sel.addAll(WhitelistModel.preselect(already));
            initial.addAll(sel);

            ScrollView scroll = new ScrollView(a);
            scroll.setVerticalScrollBarEnabled(false);
            scroll.setClipToPadding(false);
            LinearLayout rows = Ui.column(a);
            scroll.addView(rows, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

            int n = Math.min(chats.size(), MAX_ROWS);
            for (int i = 0; i < n; i++) {
                rows.addView(checkRow(a, t, chats.get(i), sel, kind), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
                if (i + 1 < n) {
                    View div = new View(a);
                    div.setBackgroundColor(Ui.alpha(t.textPrimary, 0.08f));
                    rows.addView(div, Ui.llp(MATCH_PARENT, dp(a, 1)));
                }
            }

            if (n > SCROLL_ROWS) {
                // 行多就固定高度滚动，别让浮层长出屏幕
                LinearLayout.LayoutParams slp =
                        Ui.llp(MATCH_PARENT, dp(a, SCROLL_ROWS * Theme.TOUCH + SCROLL_ROWS));
                slp.topMargin = dp(a, Theme.S1);
                box.addView(scroll, slp);
            } else {
                box.addView(scroll, top(a, Theme.S1, MATCH_PARENT, WRAP_CONTENT));
            }
        }

        LinearLayout bar = Ui.row(a);
        TextView cancel = Ui.button(a, t, "取消", false);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dlg.dismiss();
            }
        });

        if (failed || empty) {
            // 没东西可选：只留「取消」，占满整行
            bar.addView(cancel, weight(a, 1f, 0));
        } else {
            TextView ok = Ui.button(a, t, "确定", true);
            ok.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    ArrayList<String> picked = new ArrayList<String>();
                    for (String id : sel) {
                        if (id != null && id.length() > 0) picked.add(id);
                    }
                    // 取消勾选 = 从这个字段里移除（原来在、现在不在了的那些）。
                    ArrayList<String> removed = new ArrayList<String>();
                    for (String id : initial) {
                        if (id != null && id.length() > 0 && !sel.contains(id)) removed.add(id);
                    }
                    dlg.dismiss();
                    if (cb != null) cb.onPicked(picked, removed);
                }
            });
            bar.addView(cancel, weight(a, 1f, 0));
            bar.addView(ok, weight(a, 1f, Theme.S1));
        }
        box.addView(bar, top(a, Theme.S2, MATCH_PARENT, WRAP_CONTENT));

        FrameLayout shell = new FrameLayout(a);
        shell.setPadding(dp(a, Theme.S2), dp(a, Theme.S2), dp(a, Theme.S2), dp(a, Theme.S2));
        FrameLayout card = Ui.card(a, t);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        shell.addView(card, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        dlg.setContentView(shell);

        Window w = dlg.getWindow();
        if (w != null) {
            // 系统窗口底一律抹掉，否则深色渐变上会多一块方底
            w.setBackgroundDrawable(new ColorDrawable(0x00000000));
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            w.setDimAmount(0.6f);
            w.setLayout(MATCH_PARENT, WRAP_CONTENT);
        }
        dlg.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface x) {
                if (open == dlg) open = null;
            }
        });
        open = dlg;
        try {
            dlg.show();
        } catch (Throwable th) {
            open = null; // 没有可用窗口：宁可不弹，也不崩
        }
    }

    /**
     * 一行：勾选圈 + 标题 + 右侧小字。整行可点。
     *
     * <p>群聊且拿到了群名时：标题用<b>群名</b>，右侧补「群 871721981 · 收到 N 条」；
     * 没名字的群（以及私聊）保持原样：标题是号码（等宽），右侧是备注名 / 条数。
     */
    private static View checkRow(Activity a, final Theme t, final WhitelistModel.Chat c,
                                 final LinkedHashSet<String> sel, final int kind) {
        final boolean[] on = new boolean[]{sel.contains(c.id)};
        final boolean namedGroup = kind == KIND_GROUP && c.name != null && c.name.length() > 0;

        LinearLayout row = Ui.row(a);
        row.setMinimumHeight(dp(a, Theme.TOUCH));
        row.setPadding(0, dp(a, Theme.S1), 0, dp(a, Theme.S1));
        row.setClickable(true);
        row.setFocusable(true);

        final FrameLayout mark = new FrameLayout(a);
        final TextView tick = Ui.strong(a, "✓", Theme.T_CAP, t.onAccent);
        tick.setGravity(Gravity.CENTER);
        mark.addView(tick, new FrameLayout.LayoutParams(dp(a, 22), dp(a, 22), Gravity.CENTER));
        paintMark(a, mark, tick, t, on[0]);
        row.addView(mark, Ui.llp(dp(a, 26), dp(a, 26)));

        TextView title;
        if (namedGroup) {
            title = Ui.text(a, c.name, Theme.T_BODY, t.textPrimary);
            title.setSingleLine(true);
            title.setEllipsize(TextUtils.TruncateAt.END);
        } else {
            title = Ui.text(a, c.id, Theme.T_BODY, t.textPrimary);
            title.setTypeface(Typeface.MONOSPACE);
            title.setSingleLine(true);
        }
        LinearLayout.LayoutParams ilp = Ui.llp(0, WRAP_CONTENT);
        ilp.weight = 1f;
        ilp.leftMargin = dp(a, Theme.S2);
        row.addView(title, ilp);

        String metaText;
        if (namedGroup) {
            // 群名当标题后，号码不能被吞掉：放进副标题，顺带保留条数线索
            metaText = c.count > 0 ? "群 " + c.id + " · 收到 " + c.count + " 条" : "群 " + c.id;
        } else if (c.name != null && c.name.length() > 0) {
            metaText = c.count > 0 ? c.name + " · " + c.count + " 条" : c.name;
        } else {
            metaText = c.count > 0 ? "收到 " + c.count + " 条" : "最近活跃";
        }
        TextView meta = Ui.text(a, metaText, Theme.T_CAP, t.textSecondary);
        meta.setSingleLine(true);
        meta.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams mlp = Ui.llp(0, WRAP_CONTENT);
        mlp.weight = namedGroup ? 0.85f : 0.7f;
        mlp.leftMargin = dp(a, Theme.S1);
        row.addView(meta, mlp);

        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                on[0] = !on[0];
                if (on[0]) {
                    sel.add(c.id);
                } else {
                    sel.remove(c.id);
                }
                paintMark(a, mark, tick, t, on[0]);
            }
        });
        Ui.press(row, 0.99f);
        return row;
    }

    private static void paintMark(Activity a, FrameLayout mark, TextView tick, Theme t, boolean on) {
        if (on) {
            mark.setBackground(Drawables.circle(t.accent, 0, 0));
            tick.setVisibility(View.VISIBLE);
        } else {
            mark.setBackground(Drawables.circle(t.ghostFill, t.ghostStroke, dipOrOne(a)));
            tick.setVisibility(View.GONE);
        }
    }

    private static int dipOrOne(Activity a) {
        return a == null ? 1 : dp(a, 1);
    }

    // ================================================================ 小件

    private static TextView tip(Activity a, Theme t, String text) {
        TextView v = Ui.text(a, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(a, 2), 1f);
        return v;
    }

    /** 提示胶囊：信号色淡底 + 高对比文字（{@link Theme#toneStrong}）。 */
    private static TextView pill(Activity a, Theme t, String text) {
        TextView v = Ui.text(a, text, Theme.T_CAP, t.toneStrong);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setGravity(Gravity.CENTER);
        v.setLineSpacing(dp(a, 2), 1f);
        v.setPadding(dp(a, Theme.S2), dp(a, Theme.S1), dp(a, Theme.S2), dp(a, Theme.S1));
        v.setBackground(Drawables.round(Ui.alpha(t.accent, 0.14f), 0, 0, dp(a, Theme.R_BTN)));
        return v;
    }

    private static LinearLayout.LayoutParams top(Activity a, int topDp, int w, int h) {
        LinearLayout.LayoutParams lp = Ui.llp(w, h);
        lp.topMargin = dp(a, topDp);
        return lp;
    }

    private static LinearLayout.LayoutParams weight(Activity a, float w, int leftMarginDp) {
        LinearLayout.LayoutParams lp = Ui.llp(0, WRAP_CONTENT);
        lp.weight = w;
        lp.leftMargin = dp(a, leftMarginDp);
        return lp;
    }

    private static int dp(Activity a, float v) {
        return Ui.dp(a, v);
    }

    // 纯逻辑已全部收进 WhitelistModel.java，便于 run-java-logic-tests 直接测试（零重复）。
}
