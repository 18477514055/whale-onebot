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
                final List<Model.Chat> chats = loadChats(host, k);
                host.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (host.isFinishing()) return;
                        try {
                            showDialog(host, t, heading, pre, chats, callback,
                                    k == KIND_PRIVATE ? "好友 + 收到过消息的会话" : "只显示收到过消息的群", k);
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
        return Model.merge(existing, picked);
    }

    // ================================================================ 取数

    /** 协议端状态文件。位置与 {@code ContainerService.qqStateDir()} 一致，只是这里只读。 */
    private static final String BOT_JSON = "rootfs/opt/whale/qq-state/bot.json";

    /** 读 bot.json → 取端口与令牌 → POST 协议端。任何一步失败都返回 null。 */
    private static List<Model.Chat> loadChats(Activity activity, int kind) {
        try {
            if (activity == null) return null;
            String cfgText = readText(new File(activity.getFilesDir(), BOT_JSON));
            if (cfgText == null) {
                // 兜底：个别设备上 /data/user/0 与 /data/data 不是同一条路径，
                // 容器那边（ContainerService.svcFilesDir）也为这留了同一个兜底。
                try {
                    cfgText = readText(new File("/data/data/" + activity.getPackageName()
                            + "/files/" + BOT_JSON));
                } catch (Throwable ignored) {
                    cfgText = null;
                }
            }
            if (cfgText == null) return null;
            String port = Model.portOf(cfgText);
            String token = Model.tokenOf(cfgText);
            if (port == null || port.length() == 0) return null;
            if (token == null || token.length() == 0) return null;

            // ① 真的收到过消息的会话（get_known_chats 是我们自己的动作，只读、不依赖原生回调）
            String body = post(port, token, "get_known_chats");
            List<Model.Chat> chats = body == null ? null : Model.parse(body, kind);

            // ② 私聊再加一路真名单：好友列表（get_friend_list 在本机 build 上是好的）。
            //    群列表没有这一路 —— get_group_list 走原生 onGroupListUpdate，本机永不触发（1502）。
            if (kind == KIND_PRIVATE) {
                String friends = post(port, token, "get_friend_list");
                List<Model.Chat> friendList = friends == null ? null : Model.parseFriends(friends);
                chats = Model.mergeSources(friendList, chats);
            }

            // ③ 群名：拿上面那批群号再问一次（只读扩展 get_chat_names）。
            //    失败 / 超时 / 结构不对都只是「没有名字」：chats 原样返回，照旧显示号码。
            if (kind == KIND_GROUP && chats != null && !chats.isEmpty()) {
                String namesBody = postJson(port, token, "get_chat_names",
                        Model.groupsRequest(chats), NAMES_TIMEOUT_MS);
                Map<String, String> names = namesBody == null ? null : Model.parseNames(namesBody);
                chats = Model.withNames(chats, names);
            }
            return chats;
        } catch (Throwable th) {
            // 令牌、端口一律不进日志：这里什么都不打
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
            byte[] body = (json == null ? "{}" : json).getBytes("UTF-8");
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
                                   final List<String> already, final List<Model.Chat> chats,
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
            sel.addAll(Model.preselect(already));
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
    private static View checkRow(Activity a, final Theme t, final Model.Chat c,
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

    // ================================================================ 纯逻辑（可在普通 JVM 上测）
    /**
     * 不引用任何 Android 类型的一层：解析 {@code get_known_chats} 的响应、预勾选、合并、
     * 从 bot.json 文本里取端口与令牌。浮层代码只调它，探针也只测它。
     */
    static final class Model {

        private Model() {
        }

        static final class Chat {
            final String id;
            final long last;
            final int count;
            /** 显示名：私聊是好友备注名 / 昵称，群聊是群名；都没有时为 null。 */
            final String name;

            Chat(String id, long last, int count) {
                this(id, last, count, null);
            }

            Chat(String id, long last, int count, String name) {
                this.id = id;
                this.last = last;
                this.count = count;
                this.name = name;
            }
        }

        /** {@code "port"\s*:\s*(\d+)}，只要纯数字（wsPort 有引号前缀，不会误命中）。 */
        private static final Pattern PORT_RE = Pattern.compile("\"port\"\\s*:\\s*(\\d+)");
        /** {@code "token"\s*:\s*"([^"]+)"}。 */
        private static final Pattern TOKEN_RE = Pattern.compile("\"token\"\\s*:\\s*\"([^\"]+)\"");

        static String portOf(String configText) {
            return firstGroup(configText, PORT_RE);
        }

        static String tokenOf(String configText) {
            return firstGroup(configText, TOKEN_RE);
        }

        private static String firstGroup(String text, Pattern re) {
            if (text == null) return null;
            try {
                Matcher m = re.matcher(text);
                if (!m.find()) return null;
                String g = m.group(1);
                return g == null ? null : g.trim();
            } catch (Throwable th) {
                return null;
            }
        }

        /**
         * 解析响应，只留 {@code kind} 对应的会话，按最近活跃倒序，同 id 去重（取较大的 last/count）。
         *
         * @return {@code null} = 结构不对（当作读取失败）；空列表 = 真的没有会话
         */
        static List<Chat> parse(String json, int kind) {
            if (json == null) return null;
            Object root;
            try {
                root = BotConfigJson.parse(json);
            } catch (Throwable th) {
                return null;
            }
            List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "data.chats"));
            if (arr == null) return null; // 没有 chats 这一层 = 不是我们要的响应

            String want = kind == KIND_GROUP ? "group" : "private";
            LinkedHashMap<String, Chat> uniq = new LinkedHashMap<String, Chat>();
            for (int i = 0; i < arr.size(); i++) {
                Map<String, Object> o = BotConfigJson.asObject(arr.get(i));
                if (o == null) continue;
                if (!want.equals(textOf(o.get("type")))) continue;
                String id = textOf(o.get("id")).trim();
                if (id.length() == 0) continue;
                long last = numOf(o.get("last"));
                int count = (int) numOf(o.get("count"));
                if (count < 0) count = 0;
                Chat old = uniq.get(id);
                if (old == null) {
                    uniq.put(id, new Chat(id, last, count));
                } else {
                    uniq.put(id, new Chat(id, Math.max(old.last, last),
                            Math.max(old.count, count)));
                }
            }

            ArrayList<Chat> out = new ArrayList<Chat>(uniq.values());
            Collections.sort(out, new Comparator<Chat>() {
                @Override
                public int compare(Chat a, Chat b) {
                    if (a.last != b.last) return a.last > b.last ? -1 : 1;
                    if (a.count != b.count) return a.count > b.count ? -1 : 1;
                    return a.id.compareTo(b.id);
                }
            });
            if (out.size() > MAX_ROWS) {
                return new ArrayList<Chat>(out.subList(0, MAX_ROWS));
            }
            return out;
        }

        /**
         * 解析 {@code get_friend_list} 的响应：{@code data[]} 里每项是
         * {@code {user_id, nickname, remark}}。名字优先用备注。
         *
         * @return {@code null} = 结构不对（当读取失败）；空列表 = 真的没有好友
         */
        static List<Chat> parseFriends(String json) {
            if (json == null) return null;
            Object root;
            try {
                root = BotConfigJson.parse(json);
            } catch (Throwable th) {
                return null;
            }
            List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "data"));
            if (arr == null) return null;

            LinkedHashMap<String, Chat> uniq = new LinkedHashMap<String, Chat>();
            for (int i = 0; i < arr.size(); i++) {
                Map<String, Object> o = BotConfigJson.asObject(arr.get(i));
                if (o == null) continue;
                String id = textOf(o.get("user_id")).trim();
                if (id.length() == 0) id = textOf(o.get("uin")).trim();
                if (id.length() == 0) continue;
                String remark = textOf(o.get("remark")).trim();
                String nick = textOf(o.get("nickname")).trim();
                String name = remark.length() > 0 ? remark : nick;
                if (uniq.containsKey(id)) continue;
                uniq.put(id, new Chat(id, 0L, 0, name.length() == 0 ? null : name));
            }
            ArrayList<Chat> out = new ArrayList<Chat>(uniq.values());
            if (out.size() > MAX_ROWS) out = new ArrayList<Chat>(out.subList(0, MAX_ROWS));
            return out;
        }

        /**
         * 两路来源合并：{@code primary}（好友，带名字）在前，{@code extra}（收到过消息的会话）里
         * 没出现过的追加在后（好友那一路没有消息计数，计数仍取会话那一路的）。
         *
         * <p>任何一路为 {@code null} 都当「那一路没取到」：两路都 null 才返回 null（= 读取失败）。
         */
        static List<Chat> mergeSources(List<Chat> primary, List<Chat> extra) {
            if (primary == null && extra == null) return null;
            LinkedHashMap<String, Chat> byId = new LinkedHashMap<String, Chat>();
            LinkedHashMap<String, Integer> counts = new LinkedHashMap<String, Integer>();
            if (extra != null) {
                for (int i = 0; i < extra.size(); i++) counts.put(extra.get(i).id, extra.get(i).count);
            }
            if (primary != null) {
                for (int i = 0; i < primary.size(); i++) {
                    Chat c = primary.get(i);
                    Integer n = counts.get(c.id);
                    byId.put(c.id, new Chat(c.id, c.last, n == null ? c.count : n.intValue(), c.name));
                    counts.remove(c.id);
                }
            }
            if (extra != null) {
                for (int i = 0; i < extra.size(); i++) {
                    Chat c = extra.get(i);
                    if (byId.containsKey(c.id) || !counts.containsKey(c.id)) continue;
                    byId.put(c.id, c);
                    counts.remove(c.id);
                }
            }
            ArrayList<Chat> out = new ArrayList<Chat>(byId.values());
            if (out.size() > MAX_ROWS) out = new ArrayList<Chat>(out.subList(0, MAX_ROWS));
            return out;
        }

        /**
         * 构造 {@code get_chat_names} 的请求体：{@code {"groups":["871721981",...]}}。
         *
         * <p>只收 5-15 位纯数字（与协议端的校验一致）：不合规的号码不发过去，
         * 免得一个坏行把整批请求打成 1400。最多 {@link #MAX_NAME_QUERIES} 个 ——
         * 协议端上限就是 50，超出部分不查（那些行照旧显示号码）。
         *
         * <p>顺序沿用列表顺序（最近活跃在前），所以「名字最可能有用」的那些排在前面。
         */
        static String groupsRequest(List<Chat> chats) {
            StringBuilder sb = new StringBuilder("{\"action\":\"get_chat_names\",\"params\":{\"groups\":[");
            int n = 0;
            if (chats != null) {
                for (int i = 0; i < chats.size() && n < MAX_NAME_QUERIES; i++) {
                    String id = chats.get(i).id;
                    if (!isGroupCode(id)) continue;
                    if (n > 0) sb.append(',');
                    sb.append('"').append(id).append('"');
                    n++;
                }
            }
            sb.append("]}}");   // 收 groups 数组 + params 对象
            return sb.toString();
        }

        /**
         * 解析 {@code get_chat_names} 的响应：{@code data.names} 是 {@code {群号: 群名}}。
         *
         * @return {@code null} = 结构不对（当「没取到名字」，调用方照旧显示号码）；
         *         空 Map = 一个名字都没拿到（同样只是没有名字，不是读取失败）
         */
        static Map<String, String> parseNames(String json) {
            if (json == null) return null;
            Object root;
            try {
                root = BotConfigJson.parse(json);
            } catch (Throwable th) {
                return null;
            }
            Map<String, Object> names = BotConfigJson.asObject(BotConfigJson.get(root, "data.names"));
            if (names == null) return null;
            LinkedHashMap<String, String> out = new LinkedHashMap<String, String>();
            for (Map.Entry<String, Object> e : names.entrySet()) {
                if (e == null) continue;
                String id = e.getKey() == null ? "" : e.getKey().trim();
                if (!isGroupCode(id)) continue;
                Object v = e.getValue();
                if (!(v instanceof String)) continue;
                String name = ((String) v).trim();
                if (name.length() == 0 || name.length() > 128) continue;
                out.put(id, name);
            }
            return out;
        }

        /**
         * 把群名并进 {@link Chat}（{@code name} 字段）。
         *
         * <p>只改「有名字」的那些行；顺序、计数、勾选语义一个都不动。
         * {@code names} 为 {@code null} / 空 ⇒ 原样返回（= 名字这一路没取到，退化成只显示号码）。
         */
        static List<Chat> withNames(List<Chat> chats, Map<String, String> names) {
            if (chats == null || names == null || names.isEmpty()) return chats;
            ArrayList<Chat> out = new ArrayList<Chat>(chats.size());
            for (int i = 0; i < chats.size(); i++) {
                Chat c = chats.get(i);
                String name = names.get(c.id);
                if (name != null && name.length() > 0) {
                    out.add(new Chat(c.id, c.last, c.count, name));
                } else {
                    out.add(c);
                }
            }
            return out;
        }

        /** 5-15 位纯数字（协议端 {@code get_chat_names} 的口径）。 */
        private static boolean isGroupCode(String code) {
            if (code == null) return false;
            int n = code.length();
            if (n < 5 || n > 15) return false;
            for (int i = 0; i < n; i++) {
                char ch = code.charAt(i);
                if (ch < '0' || ch > '9') return false;
            }
            return true;
        }

        /** 已在该字段里的号码 → 预勾选集合（去重、忽略空行）。 */
        static LinkedHashSet<String> preselect(List<String> already) {
            LinkedHashSet<String> out = new LinkedHashSet<String>();
            if (already == null) return out;
            for (int i = 0; i < already.size(); i++) {
                String v = already.get(i) == null ? "" : already.get(i).trim();
                if (v.length() > 0) out.add(v);
            }
            return out;
        }

        /**
         * 合并：原有行一个都不动（连空行也留着），新选的追加到末尾，重复的不加。
         * 这样用户手填的号码不会因为「从会话选择」被重排或被吞掉。
         */
        static ArrayList<String> merge(List<String> existing, List<String> picked) {
            ArrayList<String> out = new ArrayList<String>();
            LinkedHashSet<String> seen = new LinkedHashSet<String>();
            if (existing != null) {
                for (int i = 0; i < existing.size(); i++) {
                    String v = existing.get(i);
                    out.add(v == null ? "" : v);
                }
            }
            for (int i = 0; i < out.size(); i++) {
                String v = out.get(i).trim();
                if (v.length() > 0) seen.add(v);
            }
            if (picked != null) {
                for (int i = 0; i < picked.size(); i++) {
                    String v = picked.get(i) == null ? "" : picked.get(i).trim();
                    if (v.length() == 0 || seen.contains(v)) continue;
                    seen.add(v);
                    out.add(v);
                }
            }
            return out;
        }

        private static String textOf(Object v) {
            if (v == null || v == BotConfigJson.NULL) return "";
            if (v instanceof BotConfigJson.Num) return ((BotConfigJson.Num) v).raw;
            if (v instanceof String) return (String) v;
            return String.valueOf(v);
        }

        private static long numOf(Object v) {
            double d = BotConfigJson.numOf(v);
            if (Double.isNaN(d) || Double.isInfinite(d)) return 0L;
            return (long) d;
        }
    }
}
