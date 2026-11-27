package com.whaleonebot.ui;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 运行端（容器里跑的行为层）与 App 之间的**文件通道**。
 *
 * 为什么不走网络：行为层和 App 用的是同一块 files 目录，读写同一个文件最省事，
 * 也不会在回环上多开一个没有身份的口子。
 *
 * 约定（与 {@code input/agent-app/src/features/bili-behavior/scheduler.mjs} 一致）：
 *   {@code <dataDir>/bili-behavior.json}  App 写的行为配置（键名与 BiliSettings 相同）
 *   {@code <dataDir>/bili-actions.jsonl}  行为层追加的动作流水
 *   {@code <dataDir>/bili-library/}       资料库与配额
 *
 * dataDir 有两种来源：
 *   1. 旧式容器：{@code files/rootfs/agent/data}
 *   2. 受管实例：{@code files/rootfs/opt/whale/instance-data/<core>/channels/<binding>/<bot>/workers/<binding>/<platform>-<selfId>}
 * 这里只认「已经存在的目录」——目录还没建出来就写配置，等于给下一轮留垃圾。
 */
public final class BiliRuntime {

    public static final String CONFIG_FILE = "bili-behavior.json";
    public static final String PROTOCOL_FILE = "bili-protocol.json";
    public static final String ACTIONS_FILE = "bili-actions.jsonl";
    public static final String PENDING_COMMAND_FILE = "bili-pending-cmd.jsonl";
    public static final String LIBRARY_DIR = "bili-library";

    private BiliRuntime() {
    }

    /** 该机器人所有「行为层可能落盘」的目录（只返回真实存在的）。 */
    public static List<File> dataDirs(Context ctx, String botId) {
        List<File> out = new ArrayList<File>();
        if (ctx == null) return out;
        File files = ctx.getFilesDir();
        File legacy = new File(files, "rootfs/agent/data");
        if (legacy.isDirectory()) out.add(legacy);
        if (botId == null || botId.isEmpty()) return out;
        // 补齐旧版伴生目录（rootfs/opt/whale/bindings/<botId>/workers/<bindingId>/*），消除 B 站伴生静默断层
        File legacyWorkers = new File(files, "rootfs/opt/whale/bindings/" + botId + "/workers");
        File[] legacyBindingDirs = legacyWorkers.listFiles();
        if (legacyBindingDirs != null) {
            for (File wb : legacyBindingDirs) {
                File[] inner = wb.listFiles();
                if (inner == null) continue;
                for (File w : inner) {
                    if (w.isDirectory() && !out.contains(w)) out.add(w);
                }
            }
        }
        File dataRoot = new File(files, "rootfs/opt/whale/instance-data");
        File[] instances = dataRoot.listFiles();
        if (instances == null) return out;
        for (File instance : instances) {
            File channels = new File(instance, "channels");
            File[] bindings = channels.listFiles();
            if (bindings == null) continue;
            for (File binding : bindings) {
                File botDir = new File(binding, botId);
                File workers = new File(botDir, "workers");
                File[] workerBindings = workers.listFiles();
                if (workerBindings == null) continue;
                for (File workerBinding : workerBindings) {
                    File[] workers2 = workerBinding.listFiles();
                    if (workers2 == null) continue;
                    for (File worker : workers2) {
                        if (worker.isDirectory()) out.add(worker);
                    }
                }
            }
        }
        return out;
    }

    /** 把 App 侧配置拼成行为层要读的那份 JSON。键名一一对应，只加几个信封字段。 */
    public static JSONObject compose(Context ctx, String botId, String bindingId) {
        JSONObject src = BiliSettings.get(ctx, botId, bindingId);
        JSONObject out = new JSONObject();
        try {
            JSONArray names = src.names();
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String key = names.getString(i);
                    out.put(key, src.opt(key));
                }
            }
            // 顶层 enabled 是「这个平台现在开着吗」，不是「巡看开着吗」——
            // 后者是 browse.enabled，两回事：平台关掉就该整层停，而不是只剩配额在跑。
            out.put("enabled", BotRegistry.platformEnabled(botId, "bilibili"));
            out.put("botId", botId == null ? "" : botId);
            out.put("bindingId", bindingId == null ? "" : bindingId);
            // 作息窗（browse.windows）是用户在自己手机上填的钟点，而容器跑的是 UTC。
            // 不把手机时区偏移一起下发，「活跃时段 09:00-12:00」在东八区会整体偏 8 小时
            // （真机实测 2026-11-22：设了时段却整天不动作，因为容器里算出来是 01:00-04:00）。
            // getOffset 已经把夏令时算进去了，随系统设置变。
            out.put("browse.tzOffsetMinutes",
                    java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000);
            out.put("updatedAt", System.currentTimeMillis());
        } catch (Exception ignored) {
        }
        return out;
    }

    /**
     * 把配置写到每个已存在的 dataDir。返回写成功的目录数。
     * 先写临时文件再改名：行为层可能正好在同一个目录里读，读到半份 JSON 会静默不启动。
     */
    public static int publish(Context ctx, String botId, String bindingId) {
        List<File> dirs = dataDirs(ctx, botId);
        if (dirs.isEmpty()) return 0;
        JSONObject config = compose(ctx, botId, bindingId);
        return writeEach(ctx, botId, CONFIG_FILE, config.toString()) ? dirs.size() : 0;
    }

    /** 关闭：写一份 enabled=false，让行为层下一轮不再自己起（不停进程）。 */
    public static int disable(Context ctx, String botId) {
        List<File> dirs = dataDirs(ctx, botId);
        if (dirs.isEmpty()) return 0;
        String text = "{\"enabled\":false,\"updatedAt\":" + System.currentTimeMillis() + "}";
        return writeEach(ctx, botId, CONFIG_FILE, text) ? dirs.size() : 0;
    }

    /**
     * 把「协议端端点 + 令牌」交给容器里的行为 worker。
     *
     * 为什么必须 App 来写：这个端口是每次运行随机挑的、令牌是每次运行新生成的随机串，
     * 只有持有那一次 Run 的 App 知道。行为 worker 如果自己猜端口/令牌，只会一直 401。
     * 令牌只落在应用私有目录（与配置同一层信任），不上网、不进日志。
     */
    public static boolean publishProtocol(Context ctx, String botId, String selfId, int port, String token) {
        if (port < 1024 || port > 65535) return false;
        if (token == null || token.length() < 16) return false;
        JSONObject doc = new JSONObject();
        try {
            doc.put("httpUrl", "http://127.0.0.1:" + port);
            doc.put("token", token);
            doc.put("selfId", selfId == null ? "" : selfId);
            doc.put("botId", botId == null ? "" : botId);
            doc.put("updatedAt", System.currentTimeMillis());
        } catch (Exception ignored) {
            return false;
        }
        return writeEach(ctx, botId, PROTOCOL_FILE, doc.toString());
    }

    /** 协议端停了就把端点抹掉：留着一份过期端口只会让 worker 一直连不上还以为是网络问题。 */
    public static void clearProtocol(Context ctx, String botId) {
        for (File dir : dataDirs(ctx, botId)) {
            File target = new File(dir, PROTOCOL_FILE);
            if (target.isFile()) target.delete();
        }
    }

    /**
     * 读行为层写下的待审评论（`bili-library/pending.jsonl`，只取 status=pending）。
     * 新的在前：用户点进看板时最想先看刚生成的那条。
     */
    public static List<JSONObject> pendingComments(Context ctx, String botId) {
        List<JSONObject> out = new ArrayList<JSONObject>();
        for (File dir : dataDirs(ctx, botId)) {
            File file = new File(new File(dir, LIBRARY_DIR), "pending.jsonl");
            if (!file.isFile()) continue;
            BufferedReader reader = null;
            try {
                reader = new BufferedReader(new InputStreamReader(new FileInputStream(file), "UTF-8"));
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    if (trimmed.isEmpty() || !trimmed.startsWith("{")) continue;
                    try {
                        JSONObject row = new JSONObject(trimmed);
                        if (!"pending".equals(row.optString("status", ""))) continue;
                        if (row.optString("id", "").isEmpty()) continue;
                        out.add(row);
                    } catch (Exception ignored) {
                    }
                }
            } catch (Exception ignored) {
            } finally {
                try {
                    if (reader != null) reader.close();
                } catch (Exception ignored) {
                }
            }
        }
        Collections.sort(out, new Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject a, JSONObject b) {
                long x = a.optLong("createdAt", a.optLong("at", 0L));
                long y = b.optLong("createdAt", b.optLong("at", 0L));
                return x < y ? 1 : (x > y ? -1 : 0);   // 新的在前
            }
        });
        return out;
    }

    /**
     * 给运行端下一条「通过 / 不通过」命令。
     * App 不自己发评论：协议端令牌那套语义只属于运行端（D287），App 只表达意图。
     */
    public static boolean commandPending(Context ctx, String botId, String action, String id) {
        if (!"approve".equals(action) && !"reject".equals(action)) return false;
        if (id == null || id.isEmpty() || id.length() > 128) return false;
        List<File> dirs = dataDirs(ctx, botId);
        if (dirs.isEmpty()) return false;
        JSONObject row = new JSONObject();
        try {
            row.put("id", id);
            row.put("action", action);
            row.put("at", System.currentTimeMillis());
        } catch (Exception ignored) {
            return false;
        }
        boolean any = false;
        for (File dir : dirs) {
            File target = new File(dir, PENDING_COMMAND_FILE);
            FileOutputStream fos = null;
            OutputStreamWriter writer = null;
            try {
                fos = new FileOutputStream(target, true);
                writer = new OutputStreamWriter(fos, "UTF-8");
                writer.write(row.toString());
                writer.write('\n');
                writer.flush();
                any = true;
            } catch (Exception ignored) {
            } finally {
                try {
                    if (writer != null) writer.close();
                    else if (fos != null) fos.close();
                } catch (Exception ignored) {
                }
            }
        }
        return any;
    }

    private static boolean writeEach(Context ctx, String botId, String name, String text) {
        List<File> dirs = dataDirs(ctx, botId);
        if (dirs.isEmpty()) return false;
        boolean any = false;
        for (File dir : dirs) {
            File target = new File(dir, name);
            File temp = new File(dir, name + ".tmp");
            OutputStreamWriter writer = null;
            try {
                writer = new OutputStreamWriter(new FileOutputStream(temp, false), "UTF-8");
                writer.write(text);
                writer.flush();
                writer.close();
                writer = null;
                if (target.exists() && !target.delete()) continue;
                if (temp.renameTo(target)) any = true;
            } catch (Exception ignored) {
            } finally {
                try {
                    if (writer != null) writer.close();
                } catch (Exception ignored) {
                }
                if (temp.exists()) temp.delete();
            }
        }
        return any;
    }

    /**
     * 读行为层写下的动作流水，归一成看板能直接用的形状：{t, kind, title, result, detail}。
     * 单文件最多读 512 KB 尾部，避免资料库长起来之后每次开看板都整文件扫描。
     */
    public static List<JSONObject> actionRecords(Context ctx, String botId) {
        List<JSONObject> out = new ArrayList<JSONObject>();
        for (File dir : dataDirs(ctx, botId)) {
            File file = new File(dir, ACTIONS_FILE);
            if (!file.isFile()) continue;
            BufferedReader reader = null;
            try {
                long length = file.length();
                long skip = Math.max(0L, length - 512L * 1024L);
                FileInputStream in = new FileInputStream(file);
                if (skip > 0L) {
                    long skipped = 0L;
                    while (skipped < skip) {
                        long step = in.skip(skip - skipped);
                        if (step <= 0L) break;
                        skipped += step;
                    }
                }
                reader = new BufferedReader(new InputStreamReader(in, "UTF-8"));
                String line;
                while ((line = reader.readLine()) != null) {
                    JSONObject row = normalize(line);
                    if (row != null) out.add(row);
                }
            } catch (Exception ignored) {
            } finally {
                try {
                    if (reader != null) reader.close();
                } catch (Exception ignored) {
                }
            }
        }
        Collections.sort(out, new Comparator<JSONObject>() {
            @Override
            public int compare(JSONObject a, JSONObject b) {
                long x = a.optLong("t", 0L);
                long y = b.optLong("t", 0L);
                return x < y ? -1 : (x > y ? 1 : 0);
            }
        });
        return out;
    }

    /** 一行 JSONL → 看板条目；坏行返回 null（不因为是半行就整份不显示）。 */
    private static JSONObject normalize(String line) {
        if (line == null) return null;
        String trimmed = line.trim();
        if (trimmed.isEmpty() || !trimmed.startsWith("{")) return null;
        try {
            JSONObject row = new JSONObject(trimmed);
            long at = row.optLong("at", row.optLong("ts", row.optLong("t", 0L)));
            if (at <= 0L) return null;
            String type = row.optString("type", row.optString("action", ""));
            String kind = dashboardKind(type);
            JSONObject out = new JSONObject();
            out.put("t", at);
            out.put("kind", kind);
            out.put("title", row.optString("bvid", row.optString("title", "")));
            // 跳过 / 被限流不是「成功」：看板上的三个字得对得上真实发生的事。
            String result = "ok";
            if (kind.endsWith("_skipped") || kind.equals("blocked") || kind.endsWith("_error") || kind.equals("loop_error")) {
                result = "error".equals(kind) || kind.endsWith("_error") || kind.equals("loop_error") ? "fail" : "skip";
            } else if (kind.equals("error")) {
                result = "fail";
            }
            out.put("result", result);
            out.put("detail", row.optString("detail", row.optString("reason", "")));
            out.put("source", "runtime");
            return out;
        } catch (Exception ignored) {
            return null;
        }
    }

    /** 行为层的事件名 → 看板分类。认不出来的原样保留（看板会显示成「动作」）。 */
    private static String dashboardKind(String type) {
        if (type == null) return "";
        String t = type.toLowerCase();
        if (t.startsWith("browse") || t.equals("tick") || t.startsWith("watch")) return "browse";
        if (t.equals("comment") || t.equals("comment_sent") || t.equals("pending_approved")) return "comment";
        if (t.equals("comment_error")) return t;   // 失败单独一类：不能被算进「发出评论」
        if (t.startsWith("like")) return "like";
        if (t.startsWith("coin")) return "coin";
        if (t.startsWith("follow")) return "follow";
        if (t.startsWith("dm") || t.startsWith("message")) return "dm";
        if (t.equals("worker") || t.equals("worker_error")) return t;
        if (t.equals("maintenance")) return t;
        if (t.endsWith("_error") || t.equals("blocked")) return "error";
        return type;
    }
}
