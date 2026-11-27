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
 * 原生高级运营与自有生态管理工作台（彻底移除上游 Web 控制台后的 4 合 1 原生闭环）：
 * <ul>
 *   <li>{@code skills}：Whale OneBot 自有技能市场（安装/卸载/总开关/重载）</li>
 *   <li>{@code mcp}：手机适配 MCP 管理器（自有精选目录导入 / 远程 HTTP/SSE 与本机 Node 添加 / 一键测通 / 重载）</li>
 *   <li>{@code content-ops}：群梗库增删 / 表情包 AI 批量分析与清理 / 每日动态与日报草稿试跑</li>
 *   <li>{@code living-memory}：长期语义记忆（LivingMemory）固化启停 / 语义召回测试 / 手动录入与归档恢复</li>
 * </ul>
 * 全部接口走 {@link DashApi}，天然同时支持本机容器与远程 P2P 操控，全套遵循主题面板规范。
 */
final class NativeManageScreen extends Screen {

    private final String mode;
    private LinearLayout content;
    private int contentTab = 0; // content-ops 子页签：0 群梗 / 1 表情包 / 2 动态与日报
    private boolean busy = false;
    private String lastRecallSummary = "";

    private Object primaryData;
    private Object secondaryData;
    private Object tertiaryData;
    private String loadError;

    NativeManageScreen(AppShell shell, String mode) {
        super(shell);
        this.mode = mode == null ? "skills" : mode;
    }

    @Override
    void build() {
        root.removeAllViews();
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        content = Ui.column(activity);
        int p = dp(Theme.S4);
        content.setPadding(p, dp(Theme.S3 + 4), p, p);
        scroll.addView(content, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        render();
        reload();
    }

    private String titleOf() {
        if ("mcp".equals(mode)) return "MCP 管理器（手机适配）";
        if ("content-ops".equals(mode)) return "群梗 · 表情包 · 动态草稿";
        if ("living-memory".equals(mode)) return "长期语义记忆";
        return "自有技能市场";
    }

    private void reload() {
        if (busy) return;
        busy = true;
        loadError = null;
        render();
        new Thread(() -> {
            Object p1 = null, p2 = null, p3 = null;
            String err = null;
            try {
                if ("skills".equals(mode)) {
                    DashApi.Result r1 = DashApi.get(activity, "/api/skills", 10000);
                    DashApi.Result r2 = DashApi.get(activity, "/api/skills/market", 15000);
                    p1 = r1.data;
                    p2 = r2.data;
                    if (!r1.ok && !r2.ok) err = r1.error;
                } else if ("mcp".equals(mode)) {
                    DashApi.Result r1 = DashApi.get(activity, "/api/mcp", 10000);
                    DashApi.Result r2 = DashApi.get(activity, "/api/mcp/market", 15000);
                    p1 = r1.data;
                    p2 = r2.data;
                    if (!r1.ok) err = r1.error;
                } else if ("content-ops".equals(mode)) {
                    if (contentTab == 0) {
                        DashApi.Result r1 = DashApi.get(activity, "/api/memes", 10000);
                        p1 = r1.data;
                        if (!r1.ok) err = r1.error;
                    } else if (contentTab == 1) {
                        DashApi.Result r1 = DashApi.get(activity, "/api/assets/stickers?limit=30", 10000);
                        p1 = r1.data;
                        if (!r1.ok) err = r1.error;
                    } else {
                        p1 = DashApi.get(activity, "/api/daily-moments/status", 10000).data;
                        p2 = DashApi.get(activity, "/api/group-digest/status", 10000).data;
                        p3 = DashApi.get(activity, "/api/admin-briefing/status", 10000).data;
                        if (p1 == null && p2 == null && p3 == null) err = "连不上运行端接口";
                    }
                } else if ("living-memory".equals(mode)) {
                    DashApi.Result r1 = DashApi.get(activity, "/api/living-memory/status", 10000);
                    DashApi.Result r2 = DashApi.get(activity, "/api/living-memory/memories?limit=25", 10000);
                    p1 = r1.data;
                    p2 = r2.data;
                    if (!r1.ok) err = r1.error;
                }
            } catch (Throwable ex) {
                err = ex.getMessage();
            }
            final Object f1 = p1, f2 = p2, f3 = p3;
            final String fErr = err;
            activity.runOnUiThread(() -> {
                busy = false;
                primaryData = f1;
                secondaryData = f2;
                tertiaryData = f3;
                loadError = fErr;
                render();
            });
        }, "native-manage-" + mode).start();
    }

    private void render() {
        if (content == null) return;
        content.removeAllViews();
        content.addView(header(titleOf()), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (loadError != null && !loadError.isEmpty()) {
            LinearLayout errCard = Ui.addCard(content, activity, t, Theme.S3);
            errCard.addView(Ui.strong(activity, "暂未连上运行端", Theme.T_BODY, t.textPrimary));
            errCard.addView(Ui.text(activity, loadError + "（请先启动机器人容器）", Theme.T_CAP, t.textSecondary), mt(dp(Theme.S1)));
            TextView retry = Ui.button(activity, t, "重新读取", true);
            retry.setOnClickListener(v -> reload());
            errCard.addView(retry, mt(dp(Theme.S2)));
            return;
        }

        if ("skills".equals(mode)) renderSkills();
        else if ("mcp".equals(mode)) renderMcp();
        else if ("content-ops".equals(mode)) renderContentOps();
        else renderLivingMemory();
    }

    // ================================================================ 1. 自有技能市场

    private void renderSkills() {
        Map<String, Object> st = BotConfigJson.asObject(primaryData);
        boolean enabled = st != null && Boolean.TRUE.equals(st.get("enabled"));
        List<Object> installed = st == null ? null : BotConfigJson.asArray(st.get("skills"));

        LinearLayout top = Ui.addCard(content, activity, t, Theme.S3);
        top.addView(Ui.strong(activity, "Whale OneBot 自有技能市场", Theme.T_CARD, t.textPrimary));
        top.addView(Ui.text(activity, "只读 Markdown 流程指南，不执行第三方代码；索引托管在本项目仓库并走国内镜像免 VPN。",
                Theme.T_CAP, t.textSecondary), mt(dp(4)));
        top.addView(ModelsScreen.W.switchRow(activity, t, "启用技能包", enabled ? "已开启" : "已关闭", enabled,
                on -> postJsonAndReload("/api/skills/state", "{\"enabled\":" + on + "}", on ? "已启用技能包" : "已关闭技能包")),
                mt(dp(Theme.S2)));

        LinearLayout row = Ui.row(activity);
        TextView refreshBtn = Ui.button(activity, t, busy ? "刷新中…" : "刷新市场", false);
        refreshBtn.setOnClickListener(v -> reload());
        TextView reloadBtn = Ui.button(activity, t, "重新扫描本地", false);
        reloadBtn.setOnClickListener(v -> postJsonAndReload("/api/skills/reload", "{}", "已重新扫描技能目录"));
        row.addView(refreshBtn, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        lp2.leftMargin = dp(Theme.S1);
        row.addView(reloadBtn, lp2);
        top.addView(row, mt(dp(Theme.S2)));

        // 已安装技能
        LinearLayout instCard = Ui.addCard(content, activity, t, Theme.S2);
        instCard.addView(Ui.strong(activity, "已安装技能（" + (installed == null ? 0 : installed.size()) + "）", Theme.T_BODY, t.textPrimary));
        if (installed == null || installed.isEmpty()) {
            instCard.addView(Ui.text(activity, "还没有安装技能，可以从下方自有市场一键安装。", Theme.T_CAP, t.textTertiary), mt(dp(Theme.S1)));
        } else {
            for (int i = 0; i < installed.size(); i++) {
                Map<String, Object> sk = BotConfigJson.asObject(installed.get(i));
                if (sk == null) continue;
                instCard.addView(Ui.divider(activity, t));
                final String sid = DashApi.str(sk, "id", "");
                String sname = DashApi.str(sk, "name", sid);
                String sdesc = DashApi.str(sk, "description", "");
                boolean builtin = Boolean.TRUE.equals(sk.get("builtin"));
                LinearLayout r = Ui.row(activity);
                LinearLayout col = Ui.column(activity);
                col.addView(Ui.strong(activity, sname + (builtin ? "（内置）" : ""), Theme.T_BODY, t.textPrimary));
                if (!sdesc.isEmpty()) col.addView(Ui.text(activity, sdesc, Theme.T_CAP, t.textSecondary), mt(dp(2)));
                r.addView(col, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                if (!builtin && !sid.isEmpty()) {
                    TextView del = Ui.button(activity, t, "卸载", false);
                    del.setOnClickListener(v -> PromptSheet.confirm(activity, t, "卸载技能「" + sname + "」？",
                            "卸载后可随时从市场重新安装。", "卸载", true,
                            () -> postJsonAndReload("/api/skills/market/uninstall",
                                    "{\"id\":" + jsonStr(sid) + "}", "已卸载 " + sname)));
                    r.addView(del, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
                }
                instCard.addView(r, mt(dp(Theme.S1)));
            }
        }

        // 自有市场目录
        Map<String, Object> mkt = BotConfigJson.asObject(secondaryData);
        List<Object> mktList = mkt == null ? null : BotConfigJson.asArray(mkt.get("skills"));
        LinearLayout mktCard = Ui.addCard(content, activity, t, Theme.S2);
        mktCard.addView(Ui.strong(activity, "自有市场可装技能", Theme.T_BODY, t.textPrimary));
        if (mktList == null || mktList.isEmpty()) {
            mktCard.addView(Ui.text(activity, "暂未拉取到远端技能列表（请检查网络或点上方「刷新市场」）。", Theme.T_CAP, t.textTertiary), mt(dp(Theme.S1)));
        } else {
            for (int i = 0; i < mktList.size(); i++) {
                Map<String, Object> sk = BotConfigJson.asObject(mktList.get(i));
                if (sk == null) continue;
                mktCard.addView(Ui.divider(activity, t));
                final String sid = DashApi.str(sk, "id", "");
                String sname = DashApi.str(sk, "name", sid);
                String sdesc = DashApi.str(sk, "description", "");
                LinearLayout r = Ui.row(activity);
                LinearLayout col = Ui.column(activity);
                col.addView(Ui.strong(activity, sname, Theme.T_BODY, t.textPrimary));
                if (!sdesc.isEmpty()) col.addView(Ui.text(activity, sdesc, Theme.T_CAP, t.textSecondary), mt(dp(2)));
                r.addView(col, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                TextView ins = Ui.button(activity, t, "安装", true);
                ins.setOnClickListener(v -> postJsonAndReload("/api/skills/market/install",
                        "{\"id\":" + jsonStr(sid) + "}", "已安装技能 " + sname));
                r.addView(ins, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
                mktCard.addView(r, mt(dp(Theme.S1)));
            }
        }
    }

    // ================================================================ 2. MCP 管理器（手机适配）

    private void renderMcp() {
        Map<String, Object> st = BotConfigJson.asObject(primaryData);
        List<Object> statusRows = st == null ? null : BotConfigJson.asArray(st.get("status"));
        boolean globalEnabled = false;
        if (statusRows != null && !statusRows.isEmpty()) {
            Map<String, Object> first = BotConfigJson.asObject(statusRows.get(0));
            globalEnabled = first != null && Boolean.TRUE.equals(first.get("globalEnabled"));
        }

        LinearLayout top = Ui.addCard(content, activity, t, Theme.S3);
        top.addView(Ui.strong(activity, "手机端适配 MCP 管理器", Theme.T_CARD, t.textPrimary));
        top.addView(Ui.text(activity, "优先推荐接入「远程 HTTP/SSE MCP」或容器内 Node 脚本，避免手机上折腾 npx/uvx 失败。",
                Theme.T_CAP, t.textSecondary), mt(dp(4)));
        top.addView(ModelsScreen.W.switchRow(activity, t, "启用 MCP 外部工具", globalEnabled ? "已开启" : "已关闭", globalEnabled,
                on -> updateMcpConfig(cfg -> cfg.put("enabled", on), on ? "已启用 MCP" : "已关闭 MCP")),
                mt(dp(Theme.S2)));

        LinearLayout btns = Ui.row(activity);
        TextView addHttp = Ui.button(activity, t, "＋ 接入远程 HTTP MCP", true);
        addHttp.setOnClickListener(v -> showAddRemoteMcpDialog());
        TextView reloadBtn = Ui.button(activity, t, "热重载", false);
        reloadBtn.setOnClickListener(v -> postJsonAndReload("/api/mcp/reload", "{}", "MCP 已热重载"));
        btns.addView(addHttp, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1.5f));
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        rlp.leftMargin = dp(Theme.S1);
        btns.addView(reloadBtn, rlp);
        top.addView(btns, mt(dp(Theme.S2)));

        // 已配置的 MCP 服务
        LinearLayout curCard = Ui.addCard(content, activity, t, Theme.S2);
        curCard.addView(Ui.strong(activity, "已配置 MCP 服务（" + (statusRows == null ? 0 : statusRows.size()) + "）", Theme.T_BODY, t.textPrimary));
        if (statusRows == null || statusRows.isEmpty()) {
            curCard.addView(Ui.text(activity, "暂未接入任何 MCP 服务；可点上方按钮添加远程地址，或从下方精选目录一键导入。",
                    Theme.T_CAP, t.textTertiary), mt(dp(Theme.S1)));
        } else {
            for (int i = 0; i < statusRows.size(); i++) {
                Map<String, Object> item = BotConfigJson.asObject(statusRows.get(i));
                if (item == null) continue;
                curCard.addView(Ui.divider(activity, t));
                final String id = DashApi.str(item, "id", "");
                String transport = DashApi.str(item, "transport", "stdio");
                boolean ready = Boolean.TRUE.equals(item.get("ready"));
                String err = DashApi.str(item, "error", "");
                List<Object> tools = BotConfigJson.asArray(item.get("tools"));
                int toolCount = tools == null ? 0 : tools.size();
                String endpoint = "http".equals(transport) ? DashApi.str(item, "url", "") : DashApi.str(item, "command", "");

                LinearLayout head = Ui.row(activity);
                head.addView(Ui.strong(activity, id + " (" + ("http".equals(transport) ? "远程 HTTP" : "本机") + ")", Theme.T_BODY, t.textPrimary),
                        new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                head.addView(Ui.pill(activity, t, ready ? ("就绪 · " + toolCount + " 工具") : "未就绪",
                        ready ? Ui.TONE_OK : Ui.TONE_NEUTRAL));
                curCard.addView(head, mt(dp(Theme.S1)));
                if (!endpoint.isEmpty()) curCard.addView(Ui.text(activity, endpoint, Theme.T_CAP, t.textSecondary), mt(dp(2)));
                if (!err.isEmpty()) curCard.addView(Ui.text(activity, "异常：" + err, Theme.T_CAP, t.toneStrong), mt(dp(2)));

                LinearLayout ops = Ui.row(activity);
                TextView delBtn = Ui.button(activity, t, "移除", false);
                delBtn.setOnClickListener(v -> PromptSheet.confirm(activity, t, "移除 MCP「" + id + "」？",
                        "将从配置中移除并重载 MCP。", "移除", true,
                        () -> removeMcpServer(id)));
                ops.addView(delBtn, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
                curCard.addView(ops, mt(dp(Theme.S1)));
            }
        }

        // 自有精选 MCP 目录
        Map<String, Object> mkt = BotConfigJson.asObject(secondaryData);
        List<Object> mktList = mkt == null ? null : BotConfigJson.asArray(mkt.get("results"));
        LinearLayout mktCard = Ui.addCard(content, activity, t, Theme.S2);
        mktCard.addView(Ui.strong(activity, "Whale OneBot 精选 MCP 目录", Theme.T_BODY, t.textPrimary));
        if (mktList == null || mktList.isEmpty()) {
            mktCard.addView(Ui.text(activity, "暂无精选目录，可点上方「接入远程 HTTP MCP」手动添加。", Theme.T_CAP, t.textTertiary), mt(dp(Theme.S1)));
        } else {
            for (int i = 0; i < mktList.size(); i++) {
                Map<String, Object> s = BotConfigJson.asObject(mktList.get(i));
                if (s == null) continue;
                mktCard.addView(Ui.divider(activity, t));
                final String title = DashApi.str(s, "title", DashApi.str(s, "id", ""));
                String desc = DashApi.str(s, "description", "");
                final Map<String, Object> srvCfg = BotConfigJson.asObject(s.get("config"));
                LinearLayout r = Ui.row(activity);
                LinearLayout col = Ui.column(activity);
                col.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary));
                if (!desc.isEmpty()) col.addView(Ui.text(activity, desc, Theme.T_CAP, t.textSecondary), mt(dp(2)));
                r.addView(col, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                if (srvCfg != null) {
                    TextView imp = Ui.button(activity, t, "导入", true);
                    imp.setOnClickListener(v -> importMcpServer(srvCfg, title));
                    r.addView(imp, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
                }
                mktCard.addView(r, mt(dp(Theme.S1)));
            }
        }
    }

    private void showAddRemoteMcpDialog() {
        ModelsScreen.W.textDialog(activity, t, "接入远程 HTTP/SSE MCP",
                "请输入远程 MCP 的完整 https:// 地址（如 https://mcp.context7.com/mcp）",
                "https://", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, false,
                text -> (text == null || !text.trim().startsWith("http")) ? "必须以 http:// 或 https:// 开头" : null,
                url -> {
                    final String cleanUrl = url.trim();
                    ModelsScreen.W.textDialog(activity, t, "可选：认证令牌（Bearer Token）",
                            "如果该远程 MCP 需要 Authorization 令牌请填入；公开服务直接留空点确定",
                            "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false,
                            null, token -> {
                                Map<String, Object> srv = new LinkedHashMap<String, Object>();
                                String id = "mcp-" + Math.abs(cleanUrl.hashCode() % 10000);
                                srv.put("id", id);
                                srv.put("enabled", Boolean.TRUE);
                                srv.put("transport", "http");
                                srv.put("url", cleanUrl);
                                Map<String, Object> hdrs = new LinkedHashMap<String, Object>();
                                if (token != null && !token.trim().isEmpty()) {
                                    String tk = token.trim();
                                    hdrs.put("Authorization", tk.startsWith("Bearer ") ? tk : ("Bearer " + tk));
                                }
                                srv.put("headers", hdrs);
                                srv.put("timeoutMs", new BotConfigJson.Num("20000"));
                                srv.put("maxCallsPerMinute", new BotConfigJson.Num("30"));
                                srv.put("toolMounting", "direct");
                                testAndAddMcp(srv);
                            });
                });
    }

    private void testAndAddMcp(final Map<String, Object> srv) {
        host().toast("正在测试远程 MCP 连通性…");
        new Thread(() -> {
            String body = "{\"server\":" + BotConfigJson.write(srv) + "}";
            DashApi.Result r = DashApi.post(activity, "/api/mcp/test", body, 15000);
            Map<String, Object> resObj = BotConfigJson.asObject(r.data);
            final boolean ok = r.ok && resObj != null && Boolean.TRUE.equals(resObj.get("ok"));
            List<Object> tools = resObj == null ? null : BotConfigJson.asArray(resObj.get("tools"));
            final int count = tools == null ? 0 : tools.size();
            final String err = resObj != null ? DashApi.str(resObj, "error", r.error == null ? "" : r.error) : (r.error == null ? "" : r.error);
            activity.runOnUiThread(() -> {
                if (ok) {
                    importMcpServer(srv, "远程 MCP（测通 " + count + " 个工具）");
                } else {
                    PromptSheet.confirm(activity, t, "连通测试未通过",
                            "测试返回：" + (err.isEmpty() ? "连接超时或格式不符" : err) + "\n是否仍然保存该配置？",
                            "仍然保存", false, () -> importMcpServer(srv, "远程 MCP"));
                }
            });
        }, "mcp-test").start();
    }

    @SuppressWarnings("unchecked")
    private void importMcpServer(final Map<String, Object> srv, final String label) {
        updateMcpConfig(mcpObj -> {
            mcpObj.put("enabled", Boolean.TRUE);
            List<Object> list = BotConfigJson.asArray(mcpObj.get("servers"));
            if (list == null) {
                list = new ArrayList<Object>();
                mcpObj.put("servers", list);
            }
            String id = String.valueOf(srv.get("id"));
            for (int i = list.size() - 1; i >= 0; i--) {
                Map<String, Object> old = BotConfigJson.asObject(list.get(i));
                if (old != null && id.equals(String.valueOf(old.get("id")))) list.remove(i);
            }
            list.add(srv);
        }, "已保存 " + label + " 并热重载");
    }

    private void removeMcpServer(final String id) {
        updateMcpConfig(mcpObj -> {
            List<Object> list = BotConfigJson.asArray(mcpObj.get("servers"));
            if (list == null) return;
            for (int i = list.size() - 1; i >= 0; i--) {
                Map<String, Object> old = BotConfigJson.asObject(list.get(i));
                if (old != null && id.equals(String.valueOf(old.get("id")))) list.remove(i);
            }
        }, "已移除 MCP " + id);
    }

    private interface MapMutator { void apply(Map<String, Object> m); }

    @SuppressWarnings("unchecked")
    private void updateMcpConfig(final MapMutator mutator, final String okMsg) {
        try {
            BotConfigHost cfgHost = (activity instanceof BotConfigHost) ? (BotConfigHost) activity : null;
            if (cfgHost == null) return;
            String raw = cfgHost.loadConfigJson();
            Object doc = (raw != null && !raw.trim().isEmpty()) ? BotConfigJson.parse(raw) : new LinkedHashMap<String, Object>();
            Map<String, Object> mcpObj = BotConfigJson.asObject(BotConfigJson.get(doc, "mcp"));
            if (mcpObj == null) {
                mcpObj = new LinkedHashMap<String, Object>();
                BotConfigJson.set(doc, "mcp", mcpObj);
            }
            mutator.apply(mcpObj);
            if (cfgHost.saveConfigJson(BotConfigJson.write(doc))) {
                postJsonAndReload("/api/mcp/reload", "{}", okMsg);
            } else {
                host().toast("写入 config.json 失败");
            }
        } catch (Throwable ex) {
            host().toast("更新 MCP 失败：" + ex.getMessage());
        }
    }

    // ================================================================ 3. 群梗 / 表情包 / 动态草稿

    private void renderContentOps() {
        // 顶部 3 段切换
        LinearLayout tabs = Ui.row(activity);
        final String[] labels = new String[] { "群梗库", "表情包分析", "动态与日报" };
        for (int i = 0; i < 3; i++) {
            final int idx = i;
            boolean sel = contentTab == idx;
            TextView ch = Ui.text(activity, labels[i], Theme.T_CAP, sel ? t.onAccent : t.textPrimary);
            ch.setGravity(Gravity.CENTER);
            ch.setPadding(dp(8), dp(10), dp(8), dp(10));
            ch.setBackground(Drawables.round(sel ? t.accent : t.ghostFill, sel ? t.accent : t.ghostStroke, dp(1), dp(Theme.R_PILL)));
            ch.setClickable(true);
            ch.setOnClickListener(v -> {
                if (contentTab == idx) return;
                contentTab = idx;
                primaryData = null; secondaryData = null; tertiaryData = null;
                reload();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
            if (i > 0) lp.leftMargin = dp(Theme.S1);
            tabs.addView(ch, lp);
        }
        content.addView(tabs, mt(dp(Theme.S3)));

        if (contentTab == 0) renderMemesTab();
        else if (contentTab == 1) renderStickersTab();
        else renderMomentsTab();
    }

    private void renderMemesTab() {
        Map<String, Object> m = BotConfigJson.asObject(primaryData);
        List<Object> list = m == null ? null : BotConfigJson.asArray(m.get("entries"));
        LinearLayout card = Ui.addCard(content, activity, t, Theme.S2);
        card.addView(Ui.strong(activity, "群梗库（" + (list == null ? 0 : list.size()) + " 条）", Theme.T_BODY, t.textPrimary));
        TextView addBtn = Ui.button(activity, t, "＋ 新增一条群梗", true);
        addBtn.setOnClickListener(v -> addMemeDialog());
        card.addView(addBtn, mt(dp(Theme.S2)));

        if (list == null || list.isEmpty()) {
            card.addView(Ui.text(activity, "暂无群梗记录。", Theme.T_CAP, t.textTertiary), mt(dp(Theme.S2)));
            return;
        }
        for (int i = 0; i < Math.min(list.size(), 40); i++) {
            Map<String, Object> it = BotConfigJson.asObject(list.get(i));
            if (it == null) continue;
            card.addView(Ui.divider(activity, t));
            final String id = DashApi.str(it, "id", "");
            final String term = DashApi.str(it, "term", "");
            String meaning = DashApi.str(it, "meaning", "");
            String chatKey = DashApi.str(it, "chatKey", "");
            LinearLayout r = Ui.row(activity);
            LinearLayout col = Ui.column(activity);
            col.addView(Ui.strong(activity, term + (chatKey.isEmpty() ? "" : " · " + chatKey), Theme.T_BODY, t.textPrimary));
            if (!meaning.isEmpty()) col.addView(Ui.text(activity, meaning, Theme.T_CAP, t.textSecondary), mt(dp(2)));
            r.addView(col, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            TextView del = Ui.button(activity, t, "删", false);
            del.setOnClickListener(v -> deleteAndReload("/api/memes", "{\"id\":" + jsonStr(id) + "}", "已删除群梗 " + term));
            r.addView(del, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
            card.addView(r, mt(dp(Theme.S1)));
        }
    }

    private void addMemeDialog() {
        ModelsScreen.W.textDialog(activity, t, "群梗名称", "例如：草 / 典 / 某群专属黑话", "",
                InputType.TYPE_CLASS_TEXT, false,
                s -> (s == null || s.trim().isEmpty()) ? "梗名不能为空" : null,
                term -> ModelsScreen.W.textDialog(activity, t, "含义说明", "告诉机器人这个梗是什么意思", "",
                        InputType.TYPE_CLASS_TEXT, false,
                        s -> (s == null || s.trim().isEmpty()) ? "含义不能为空" : null,
                        meaning -> ModelsScreen.W.textDialog(activity, t, "适用群号（留空=全局）", "例如 group:123456789 或直接填群号", "",
                                InputType.TYPE_CLASS_TEXT, false, null, rawChat -> {
                                    String ck = rawChat == null ? "" : rawChat.trim();
                                    if (ck.matches("\\d{5,15}")) ck = "group:" + ck;
                                    String body = "{\"chatKey\":" + jsonStr(ck) + ",\"term\":" + jsonStr(term.trim())
                                            + ",\"meaning\":" + jsonStr(meaning.trim()) + "}";
                                    postJsonAndReload("/api/memes", body, "已添加群梗「" + term.trim() + "」");
                                })));
    }

    private void renderStickersTab() {
        Map<String, Object> m = BotConfigJson.asObject(primaryData);
        List<Object> list = m == null ? null : BotConfigJson.asArray(m.get("items"));
        if (list == null && m != null) list = BotConfigJson.asArray(m.get("stickers"));

        LinearLayout card = Ui.addCard(content, activity, t, Theme.S2);
        card.addView(Ui.strong(activity, "表情包管理与 AI 批量分析", Theme.T_BODY, t.textPrimary));
        TextView analyzeBtn = Ui.button(activity, t, "触发 AI 分析未标注表情包", true);
        analyzeBtn.setOnClickListener(v -> postJsonAndReload("/api/assets/stickers/analyze", "{\"limit\":10}", "已触发表情包 AI 分析"));
        card.addView(analyzeBtn, mt(dp(Theme.S2)));

        if (list == null || list.isEmpty()) {
            card.addView(Ui.text(activity, "暂无已收藏的表情包。", Theme.T_CAP, t.textTertiary), mt(dp(Theme.S2)));
            return;
        }
        for (int i = 0; i < Math.min(list.size(), 30); i++) {
            Map<String, Object> it = BotConfigJson.asObject(list.get(i));
            if (it == null) continue;
            card.addView(Ui.divider(activity, t));
            final String id = DashApi.str(it, "id", "");
            String desc = DashApi.str(it, "description", DashApi.str(it, "label", "未标注表情"));
            LinearLayout r = Ui.row(activity);
            r.addView(Ui.text(activity, desc, Theme.T_CAP, t.textPrimary), new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            if (!id.isEmpty()) {
                TextView del = Ui.button(activity, t, "删", false);
                del.setOnClickListener(v -> deleteAndReload("/api/assets/stickers/" + id, "", "已删除表情包"));
                r.addView(del, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
            }
            card.addView(r, mt(dp(Theme.S1)));
        }
    }

    private void renderMomentsTab() {
        Map<String, Object> dm = BotConfigJson.asObject(primaryData);
        Map<String, Object> gd = BotConfigJson.asObject(secondaryData);
        Map<String, Object> ab = BotConfigJson.asObject(tertiaryData);

        LinearLayout c1 = Ui.addCard(content, activity, t, Theme.S2);
        c1.addView(Ui.strong(activity, "每日 QQ 空间动态", Theme.T_BODY, t.textPrimary));
        c1.addView(Ui.text(activity, "启用状态：" + (dm != null && Boolean.TRUE.equals(dm.get("enabled")) ? "已启用" : "未启用")
                + " · 自动发布：" + (dm != null && Boolean.TRUE.equals(dm.get("autoPublish")) ? "开启" : "仅草稿"),
                Theme.T_CAP, t.textSecondary), mt(dp(4)));
        TextView draftBtn = Ui.button(activity, t, "立即生成一条动态草稿（不自动发布）", true);
        draftBtn.setOnClickListener(v -> postJsonAndReload("/api/daily-moments/run", "{\"dryRun\":true}", "已触发生成今日动态草稿"));
        c1.addView(draftBtn, mt(dp(Theme.S2)));

        List<Object> recs = dm == null ? null : BotConfigJson.asArray(dm.get("records"));
        if (recs != null && !recs.isEmpty()) {
            for (int i = 0; i < Math.min(recs.size(), 5); i++) {
                Map<String, Object> r = BotConfigJson.asObject(recs.get(i));
                if (r == null) continue;
                c1.addView(Ui.divider(activity, t));
                final String rid = DashApi.str(r, "id", "");
                String txt = DashApi.str(r, "text", DashApi.str(r, "content", ""));
                String status = DashApi.str(r, "status", "");
                c1.addView(Ui.text(activity, "[" + status + "] " + txt, Theme.T_CAP, t.textPrimary), mt(dp(Theme.S1)));
                if ("draft".equalsIgnoreCase(status) && !rid.isEmpty()) {
                    TextView pub = Ui.button(activity, t, "发布这条草稿", false);
                    pub.setOnClickListener(v -> PromptSheet.confirm(activity, t, "发布动态到 QQ 空间？",
                            txt, "确认发布", false,
                            () -> postJsonAndReload("/api/daily-moments/records/" + rid + "/publish", "{}", "已提交发布")));
                    c1.addView(pub, mt(dp(Theme.S1)));
                }
            }
        }

        LinearLayout c2 = Ui.addCard(content, activity, t, Theme.S2);
        c2.addView(Ui.strong(activity, "群日报与管理员早报", Theme.T_BODY, t.textPrimary));
        c2.addView(Ui.text(activity,
                "群日报：" + (gd != null && Boolean.TRUE.equals(gd.get("enabled")) ? "已启用" : "未启用")
                        + "\n管理员早报：" + (ab != null && Boolean.TRUE.equals(ab.get("enabled")) ? "已启用" : "未启用"),
                Theme.T_CAP, t.textSecondary), mt(dp(4)));
    }

    // ================================================================ 4. 长期语义记忆（LivingMemory）

    private void renderLivingMemory() {
        Map<String, Object> st = BotConfigJson.asObject(primaryData);
        boolean enabled = st != null && Boolean.TRUE.equals(st.get("enabled"));
        String lmMode = st == null ? "shadow" : DashApi.str(st, "mode", "shadow");

        LinearLayout top = Ui.addCard(content, activity, t, Theme.S3);
        top.addView(Ui.strong(activity, "长期语义记忆（LivingMemory）", Theme.T_CARD, t.textPrimary));
        top.addView(Ui.text(activity, "当前状态：" + (enabled ? ("已启用 · " + lmMode) : "未启用")
                + "（active = 正式注入聊天提示词；shadow = 仅后台积累不注入）",
                Theme.T_CAP, t.textSecondary), mt(dp(4)));

        LinearLayout modeRow = Ui.row(activity);
        TextView btnActive = Ui.button(activity, t, "固化上线 (active)", enabled && "active".equals(lmMode));
        btnActive.setOnClickListener(v -> saveLivingMemoryMode(true, "active"));
        TextView btnShadow = Ui.button(activity, t, "影子观察", enabled && !"active".equals(lmMode));
        btnShadow.setOnClickListener(v -> saveLivingMemoryMode(true, "shadow"));
        TextView btnOff = Ui.button(activity, t, "关闭", !enabled);
        btnOff.setOnClickListener(v -> saveLivingMemoryMode(false, "shadow"));
        modeRow.addView(btnActive, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1.2f));
        LinearLayout.LayoutParams sLp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        sLp.leftMargin = dp(Theme.S1);
        modeRow.addView(btnShadow, sLp);
        LinearLayout.LayoutParams oLp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 0.8f);
        oLp.leftMargin = dp(Theme.S1);
        modeRow.addView(btnOff, oLp);
        top.addView(modeRow, mt(dp(Theme.S2)));

        // 召回测试卡
        LinearLayout recallCard = Ui.addCard(content, activity, t, Theme.S2);
        recallCard.addView(Ui.strong(activity, "语义召回实测", Theme.T_BODY, t.textPrimary));
        final EditText qBox = new EditText(activity);
        qBox.setSingleLine(true);
        qBox.setHint("输入一句话测试机器人能回忆起哪些长期记忆");
        Ui.styleInput(qBox, activity, t);
        recallCard.addView(qBox, mt(dp(Theme.S1)));
        TextView testBtn = Ui.button(activity, t, "测试语义召回", true);
        testBtn.setOnClickListener(v -> {
            final String q = qBox.getText().toString().trim();
            if (q.isEmpty()) { host().toast("先输入测试问题"); return; }
            new Thread(() -> {
                DashApi.Result r = DashApi.post(activity, "/api/living-memory/recall-test",
                        "{\"query\":" + jsonStr(q) + ",\"limit\":5}", 12000);
                String summary;
                if (r.ok && r.data != null) {
                    Map<String, Object> m = BotConfigJson.asObject(r.data);
                    List<Object> hits = m == null ? null : BotConfigJson.asArray(m.get("results"));
                    if (hits == null && m != null) hits = BotConfigJson.asArray(m.get("items"));
                    if (hits == null || hits.isEmpty()) summary = "未命中相关长期记忆。";
                    else {
                        StringBuilder sb = new StringBuilder("命中 " + hits.size() + " 条：\n");
                        for (int i = 0; i < hits.size(); i++) {
                            Map<String, Object> h = BotConfigJson.asObject(hits.get(i));
                            if (h != null) sb.append(i + 1).append(". ").append(DashApi.str(h, "content", DashApi.str(h, "summary", ""))).append('\n');
                        }
                        summary = sb.toString().trim();
                    }
                } else {
                    summary = "召回失败：" + (r.error == null ? "未知错误" : r.error);
                }
                final String out = summary;
                activity.runOnUiThread(() -> { lastRecallSummary = out; render(); });
            }, "lm-recall").start();
        });
        recallCard.addView(testBtn, mt(dp(Theme.S1)));
        if (!lastRecallSummary.isEmpty()) {
            recallCard.addView(Ui.text(activity, lastRecallSummary, Theme.T_CAP, t.textPrimary), mt(dp(Theme.S2)));
        }

        // 记忆条目列表 + 手动录入
        Map<String, Object> memObj = BotConfigJson.asObject(secondaryData);
        List<Object> items = memObj == null ? null : BotConfigJson.asArray(memObj.get("items"));
        if (items == null && memObj != null) items = BotConfigJson.asArray(memObj.get("memories"));
        LinearLayout listCard = Ui.addCard(content, activity, t, Theme.S2);
        listCard.addView(Ui.strong(activity, "最近长期记忆（" + (items == null ? 0 : items.size()) + "）", Theme.T_BODY, t.textPrimary));
        TextView addMem = Ui.button(activity, t, "＋ 手动录入一条长期记忆", false);
        addMem.setOnClickListener(v -> ModelsScreen.W.textDialog(activity, t, "录入长期记忆",
                "写一句希望机器人长期记住的事实或约定", "", InputType.TYPE_CLASS_TEXT, true,
                s -> (s == null || s.trim().isEmpty()) ? "内容不能为空" : null,
                txt -> postJsonAndReload("/api/living-memory/memories",
                        "{\"content\":" + jsonStr(txt.trim()) + ",\"scope\":\"global\",\"kind\":\"fact\"}", "已录入长期记忆")));
        listCard.addView(addMem, mt(dp(Theme.S2)));

        if (items != null) {
            for (int i = 0; i < Math.min(items.size(), 25); i++) {
                Map<String, Object> it = BotConfigJson.asObject(items.get(i));
                if (it == null) continue;
                listCard.addView(Ui.divider(activity, t));
                final String id = DashApi.str(it, "id", "");
                String txt = DashApi.str(it, "content", DashApi.str(it, "summary", ""));
                boolean archived = "archived".equalsIgnoreCase(DashApi.str(it, "status", ""));
                LinearLayout r = Ui.row(activity);
                r.addView(Ui.text(activity, (archived ? "[已归档] " : "") + txt, Theme.T_CAP,
                        archived ? t.textTertiary : t.textPrimary), new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                if (!id.isEmpty()) {
                    TextView act = Ui.button(activity, t, archived ? "恢复" : "归档", false);
                    act.setOnClickListener(v -> postJsonAndReload(
                            "/api/living-memory/memories/" + id + (archived ? "/restore" : "/archive"),
                            "{}", archived ? "已恢复记忆" : "已归档记忆"));
                    r.addView(act, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
                }
                listCard.addView(r, mt(dp(Theme.S1)));
            }
        }
    }

    private void saveLivingMemoryMode(boolean enabled, String lmMode) {
        String body = "{\"livingMemory\":{\"enabled\":" + enabled + ",\"mode\":" + jsonStr(lmMode) + "}}";
        postJsonAndReload("/api/config", body, "长期语义记忆已更新为 " + (enabled ? lmMode : "关闭"));
    }

    // ================================================================ 公共工具

    private void postJsonAndReload(final String path, final String jsonBody, final String okMsg) {
        new Thread(() -> {
            DashApi.Result r = DashApi.post(activity, path, jsonBody, 15000);
            activity.runOnUiThread(() -> {
                host().toast(r.ok ? okMsg : ("操作失败：" + (r.error == null ? "未知错误" : r.error)));
                reload();
            });
        }, "native-post").start();
    }

    private void deleteAndReload(final String path, final String jsonBody, final String okMsg) {
        new Thread(() -> {
            DashApi.Result r = DashApi.delete(activity, path, jsonBody, 15000);
            activity.runOnUiThread(() -> {
                host().toast(r.ok ? okMsg : ("删除失败：" + (r.error == null ? "未知错误" : r.error)));
                reload();
            });
        }, "native-del").start();
    }

    private static String jsonStr(String s) {
        String v = s == null ? "" : s;
        StringBuilder sb = new StringBuilder(v.length() + 2);
        sb.append('"');
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '"') sb.append("\\\"");
            else if (c == '\\') sb.append("\\\\");
            else if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("\\r");
            else sb.append(c);
        }
        sb.append('"');
        return sb.toString();
    }

    private LinearLayout.LayoutParams mt(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }
}
