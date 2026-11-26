package com.whaleonebot.ui;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * App 外壳：背景层 + 页面栈 + 状态刷新。
 *
 * <p>结构从上到下只有三层，背景永远在最底：
 * <pre>
 *   FrameLayout (root)
 *     ├─ BackdropView   渐变或自定义图片，切页时不重建，只换主题
 *     └─ FrameLayout    pageHost：同一时刻只挂当前页
 * </pre>
 *
 * <p>页面采用「按需重建」策略：换主题时把当前页整体重建一次，
 * 这样所有 drawable 的颜色天然跟着令牌走，不需要在页面里写「重新上色」的代码。
 *
 * <p><b>页面栈</b>：每个栈元素是 {@code (kind, arg)}（{@link Entry}），不是纯 int。
 * 原因见产品规格 §6-8：纯 int 时「机器人 A 的详情页」与「机器人 B 的详情页」是同一个值，
 * 同时压栈会互相顶掉；带上 arg
 * （机器人 id）之后，返回时能原位重建<b>那一个</b>机器人。
 *
 * <p>导航入口全部在这里：{@link #pushBotList()} / {@link #pushNewBot()} / {@link #pushBot(String)} /
 * {@link #pushBotConfig(String)} / {@link #pushRuntimeDownload(String)} / {@link #popTo(int)}；
 * 旧的 {@link #push(int)} 与 {@link #handleBack()} 语义保持不变（逐级出栈，绝不从深页一次跳回主页）。
 *
 * <p><b>过渡动效只有一份</b>（{@link Motion}），{@link #showScreen} 是唯一的执行点，
 * 页面自己不许再写入场动画 —— 那正是「有的页面有动效、有的页面直接闪」的来源。
 */
public class AppShell {

    /** 宿主（Activity）提供全部业务数据；本类不自己取数据、不起后台轮询。 */
    public interface Host {
        boolean containerRunning();

        void startContainer();

        void stopContainer();

        String loginUin();

        boolean qrLive();

        Bitmap qrBitmap();

        long qrLeftSeconds();

        void requestQr();

        void saveQrToAlbum();

        String loginLog(int lines);

        String containerLog(int lines);

        void toast(String msg);
    }

    /** 选图请求码。宿主应在 onActivityResult 里把 requestCode 原样转给 {@link #onActivityResult}。 */
    public static final int REQ_PICK_IMAGE = 0x5701;
    /** 多选文本文件导入请求码（知识库 / 记忆库共用）。 */
    public static final int REQ_PICK_MULTI_TEXT = 0x5705;

    static final class PickedTextFile {
        final String name;
        final String content;

        PickedTextFile(String name, String content) {
            this.name = name;
            this.content = content;
        }
    }

    interface MultiTextCallback {
        void onPicked(java.util.List<PickedTextFile> files, String error);
    }

    private MultiTextCallback pendingMultiTextCb;

    // 过渡动效统一来自 Motion：参数只有一份，任何页面切换都不许自己再写一套入场动画。
    private static final int MOTION_PUSH = Motion.PUSH;
    private static final int MOTION_POP = Motion.POP;
    private static final int MOTION_FADE = Motion.FADE;

    static final int P_HOME = 0;
    static final int P_SETTINGS = 1;
    static final int P_THEME = 2;
    /** 环境配置：容器与 QQ 安装包。新用户拿到 APK 后第一站。 */
    static final int P_ENV = 60;
    /** 版本管理：App、内置核心与平台插件的唯一版本入口。 */
    static final int P_VERSION = 61;
    /** 扫码配对远端设备（Camera2 + 纯 Java QR 解码 + 相册选图 + 口令粘贴）。 */
    static final int P_QR_SCAN = 62;
    /** 远程设备与本机配对码管理页（永远作用在本机 App）。 */
    static final int P_REMOTE_DEVICES = 63;
    static final int P_QQ = 3;
    /** 平台运行端配置面板：14 组 / 141 项，读写 /agent/data/config.json。 */
    static final int P_BOTCONFIG = 4;
    /**
     * 机器人详情页：平台面板（QQ）与运行端配置之间的一层。
     * 一个机器人可以管 N 个平台、一个平台也可以有多个机器人，所以配置挂在机器人上，不挂在平台上。
     */
    static final int P_BOT = 5;
    /** 机器人列表（设置 → 机器人）。页面由 T2 交付（BotListScreen）。 */
    static final int P_BOTLIST = 6;
    /** 新建机器人向导。页面由 T2 交付（NewBotScreen）。 */
    static final int P_NEWBOT = 7;
    /** 内置运行端下载页（带进度条）。页面由 T3 交付（RuntimeDownloadScreen）。 */
    static final int P_RUNTIMEDL = 8;
    /**
     * 平台页第一层：<b>这个平台上挂了哪些机器人</b>（arg = 平台 id）。
     * ★ 用户 2026-11-18 定的层级：点平台先进机器人选择，再进「启动 / 配置」。
     */
    static final int P_PLATFORMBOTS = 9;
    /** 平台页第二层：某个机器人在本平台的「启动 / 配置」两项（arg = 机器人 id）。 */
    static final int P_PLATFORMBOT = 10;
    /**
     * 「模型与 Key」页：每个用途的模型、渠道（provider）、Key（只写不读）、思考强度档位。
     * ★ 用户 2026-11-18 提的：「不加秘钥的话，我怎么在面板改变各种模型的配置」。
     */
    static final int P_MODELS = 11;
    /** 渠道编辑页（arg = providerId，arg2 = 预置 id；都为 null/空 = 新建空白渠道）。 */
    static final int P_PROVIDER = 12;
    /** 某个用途的模型选择页（arg = 用途 role：chat/memory/image/asr/tts）。 */
    static final int P_MODELPICK = 13;
    /** 「按群设置」：逐群定对话模式与回复概率（群清单取自白名单）。 */
    static final int P_PERGROUP = 14;
    /** 「人格模板」：把 persona 存成模板、或一键切回某一条（读写 customPersonas[]）。 */
    static final int P_PERSONATPL = 15;
    /** 「知识库」：我们的多库知识库（libraries.json + 向量模型 ecnu.env）。 */
    static final int P_KB = 16;
    /** 「看板」：运行端只读状态（实时 / 心情精力 / 用量 / 存储 / 亲密度）。 */
    static final int P_DASH = 17;
    /** 看板入口页：只读观测子页的列表。 */
    static final int P_DASH_HUB = 18;
    /** 看板 · 会话监控（api/chats）。 */
    static final int P_CHATMON = 19;
    /** 看板 · 调用记录（api/sessions）。 */
    static final int P_CALLLOG = 20;
    /** 看板 · 记忆（会话记忆 / 人物 / 长期记忆）。 */
    static final int P_MEM = 21;
    /** 看板 · 运维（观测 / 异常 / 用量 / 技能）。 */
    static final int P_OPS = 22;
    /** 看板 · 亲密度（分数榜 / 单查 / 心情流水）。 */
    static final int P_INTIMACY = 23;
    /** 看板 · 好友（认识的人 / 申请 / 派发）。 */
    static final int P_PEOPLE = 24;
    /** 看板 · 运行状态（协议端 / 主机 / 自更新 / 时间控制 / 健康）。 */
    static final int P_CONTROL = 25;
    /** 看板 · 插件（已装 / 目录 / 待处理，只读）。 */
    static final int P_PLUGINS = 26;
    /** 看板 · 待对账：held/failed 不为 0 的会话 + 解锁 / 重试失败（**唯一会写状态的子页**）。 */
    static final int P_RECONCILE = 27;
    static final int P_BILI_ACCOUNT = 28;
    static final int P_CORE_MANAGER=29, P_EXTERNAL_ACCOUNT=30;
    /** 抖音（测试版）平台专属页：实验性 WebView 登录、写操作授权策略、定时浏览与作品队列。 */
    static final int P_DOUYIN_ACCOUNT = 31;
    /** 设置内的一键部署向导（支持多平台与本地/远程模式，完成后自动退回设置主页）。 */
    static final int P_DEPLOY_WIZARD = 64;
    void externalAccount(String bot,String binding){push(P_EXTERNAL_ACCOUNT,bot,binding==null?"":binding);}
    void corePage(String mode,String coreId){push(P_CORE_MANAGER,mode,coreId);}

    void pushBiliAccounts(String id,String tab) { push(P_BILI_ACCOUNT,id,tab); }
    void pushDouyinPlatform(String id, String tab) { push(P_DOUYIN_ACCOUNT, id, tab); }
    void pushDeployWizard() { push(P_DEPLOY_WIZARD, null); }

    final Activity activity;
    final Host host;
    final ThemeStore store;
    Theme theme;

    /** 当前要操作的机器人（带 arg 的页面缺 arg 时的兜底）。 */
    private String botId;

    private final FrameLayout root;
    private final BackdropView backdrop;
    private final FrameLayout pageHost;

    /** 页面栈：元素是 (kind, arg)，arg 是该页要操作的机器人 id（不需要时为 null）。 */
    private final ArrayList<Entry> stack = new ArrayList<Entry>();
    /**
     * 栈元素 → 已经建好的那一页。**返回上一层时复用同一个实例**，而不是重建。
     *
     * <p>为什么必须这样：运行端配置这种页面自己有「列表页 / 组页」两层内部状态。
     * 返回时若重建，就会退回它的列表页 —— 用户从「模型与接口 → 模型与 Key」按返回，
     * 看到的不是刚才那一组，而是整个配置列表（看起来像一次退了两层，就是这里来的）。
     * 复用实例同时保住了未保存的改动。
     */
    private final java.util.HashMap<Entry, Screen> screenCache = new java.util.HashMap<Entry, Screen>();
    private Screen current;

    /** 认码窗口：用来区分「还没出码」和「码已过期」，绝不拿旧码糊弄。 */
    long qrRequestedAt;
    boolean qrSeenLive;

    public AppShell(Activity activity, Host host) {
        if (activity == null || host == null) throw new IllegalArgumentException("activity/host 不能为空");
        this.activity = activity;
        this.host = host;
        com.whaleonebot.install.CoreInstaller.checkAuto(activity.getApplicationContext());
        this.store = new ThemeStore(activity);
        this.theme = store.theme();
        BotRegistry.Bot firstBot = BotRegistry.primary();
        this.botId = firstBot == null ? "" : firstBot.id;

        root = new FrameLayout(activity);
        root.setBackgroundColor(theme.g0);
        root.setClipChildren(false);

        backdrop = new BackdropView(activity, store, theme);
        root.addView(backdrop, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        pageHost = new FrameLayout(activity);
        pageHost.setClipChildren(false);
        pageHost.setClipToPadding(false);
        root.addView(pageHost, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        applyWindowColors();

        Entry home = new Entry(P_HOME, null);
        stack.add(home);
        current = create(home);
        pageHost.addView(current.root, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        current.onAttach();
    }

    public View getView() {
        return root;
    }

    /** 宿主在 onResume 里调用：只做一次全量状态同步，不启动任何轮询。 */
    public void onResume() {
        refresh();
    }

    /** 宿主每秒调用一次。内部逐项比对，值没变就不碰 View。 */
    public void refresh() {
        if (host.qrLive()) qrSeenLive = true;
        if (current != null) current.refresh();
    }

    /**
     * 返回键：true 表示已经退回上一页；false 表示当前就在首页，宿主可以 finish()。
     *
     * <p>先从当前页自己的返回处理开始（例如运行端配置在「组页」里，返回应先退回列表页），
     * 页面不认才按栈逐级出栈 —— 这样「主页 → QQ → 机器人 → 运行端配置」是一级一级退回去的，
     * 而且退回去的那一层会按自己栈元素里的 arg 重建（机器人 A 退回来的还是机器人 A）。
     */
    public boolean handleBack() {
        if (current != null && current.handleBack()) return true;
        if (stack.size() <= 1) return false;
        screenCache.remove(stack.remove(stack.size() - 1));
        Entry top = stack.get(stack.size() - 1);
        showScreen(create(top), MOTION_POP);
        return true;
    }

    /** 选图返回。返回 true 表示这个 requestCode 归本类处理。 */
    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == CoreManagerScreen.FILE_REQUEST) {
            if (current instanceof CoreManagerScreen) {
                ((CoreManagerScreen) current).picked(resultCode == Activity.RESULT_OK && data != null ? data.getData() : null);
            }
            return true;
        }
        if (requestCode == QrScanScreen.REQ_PICK_QR_IMAGE) {
            if (current instanceof QrScanScreen && resultCode == Activity.RESULT_OK && data != null) {
                ((QrScanScreen) current).onImagePicked(data.getData());
            }
            return true;
        }
        if (requestCode == EnvConfigScreen.REQ_PICK_REMOTE_QQ_DEB) {
            if (current instanceof EnvConfigScreen && resultCode == Activity.RESULT_OK && data != null) {
                ((EnvConfigScreen) current).onRemoteDebPicked(data.getData());
            }
            return true;
        }
        if (requestCode == REQ_PICK_MULTI_TEXT) {
            final MultiTextCallback cb = pendingMultiTextCb;
            pendingMultiTextCb = null;
            if (cb == null) return true;
            if (resultCode != Activity.RESULT_OK || data == null) {
                cb.onPicked(new java.util.ArrayList<PickedTextFile>(), "已取消选择");
                return true;
            }
            final java.util.List<android.net.Uri> uris = new java.util.ArrayList<android.net.Uri>();
            android.content.ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                for (int i = 0; i < clip.getItemCount() && uris.size() < 20; i++) {
                    android.net.Uri u = clip.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            if (uris.isEmpty()) {
                cb.onPicked(new java.util.ArrayList<PickedTextFile>(), "未选择有效文件");
                return true;
            }
            new Thread(new Runnable() {
                @Override
                public void run() {
                    final java.util.List<PickedTextFile> out = new java.util.ArrayList<PickedTextFile>();
                    String err = null;
                    long totalBytes = 0;
                    for (int i = 0; i < uris.size(); i++) {
                        android.net.Uri u = uris.get(i);
                        try {
                            String name = queryDisplayName(u, "doc-" + (i + 1) + ".txt");
                            java.io.InputStream in = activity.getContentResolver().openInputStream(u);
                            if (in == null) continue;
                            try {
                                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                                byte[] buf = new byte[8192];
                                int n;
                                while ((n = in.read(buf)) > 0) {
                                    bos.write(buf, 0, n);
                                    if (bos.size() > 2 * 1024 * 1024) break;
                                }
                                totalBytes += bos.size();
                                if (totalBytes > 8 * 1024 * 1024) {
                                    err = "所选文件总大小超过 8MB 上限，已截断部分文件";
                                    break;
                                }
                                String text = new String(bos.toByteArray(), "UTF-8");
                                if (text.length() > 0 && text.charAt(0) == '\uFEFF') text = text.substring(1);
                                out.add(new PickedTextFile(name, text));
                            } finally {
                                try { in.close(); } catch (Throwable ignored) { }
                            }
                        } catch (Throwable th) {
                            err = "读取部分文件失败：" + th.getMessage();
                        }
                    }
                    final String finalErr = err;
                    activity.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            cb.onPicked(out, finalErr);
                        }
                    });
                }
            }, "pick-multi-text").start();
            return true;
        }
        if (requestCode != REQ_PICK_IMAGE) return false;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            host.toast("已取消选择");
            return true;
        }
        long startedAt = System.currentTimeMillis();
        try {
            store.importBackground(activity.getContentResolver(), data.getData());
        } catch (Throwable t) {
            String m = t.getMessage();
            host.toast("图片读取失败" + (m == null ? "" : "：" + m));
            return true;
        }
        backdrop.invalidateBackground();
        long cost = System.currentTimeMillis() - startedAt;
        host.toast("背景已更新（转存 " + Math.max(1, cost) + " ms）");
        if (current != null) current.refresh();
        return true;
    }

    // ------------------------------------------------------------------ 导航

    /** 旧入口：不带参数的页面（设置 / 主题 / 平台）。语义与以前完全一致。 */
    void push(int kind) {
        push(kind, null);
    }

    /** 设置 → 机器人：机器人列表页（与「新建机器人」同层）。 */
    void pushBotList() {
        push(P_BOTLIST, null);
    }

    /** 新建机器人向导。 */
    void pushNewBot() {
        push(P_NEWBOT, null);
    }

    /**
     * 进入某个机器人的详情页。
     *
     * <p>机器人 id 记在<b>栈元素</b>里（不再记在字段里），所以两个不同机器人的详情页
     * 可以同时压在栈上，返回时各归各位。
     */
    void pushBot(String id) {
        BotRegistry.Bot b = BotRegistry.get(id);
        if (b == null) b = BotRegistry.primary();
        String use = b == null ? "" : b.id;
        if (use.length() > 0) this.botId = use;
        push(P_BOT, use);
    }

    /** 进这个机器人的运行端配置面板（现有 BotConfigScreen）。 */
    void pushBotConfig(String botId) {
        String use = resolveBotId(botId);
        if (use.length() > 0) this.botId = use;
        push(P_BOTCONFIG, use);
    }

    /** 进内置运行端下载页（带进度条），T3 交付 RuntimeDownloadScreen。 */
    void pushRuntimeDownload(String botId) {
        String use = resolveBotId(botId);
        if (use.length() > 0) this.botId = use;
        push(P_RUNTIMEDL, use);
    }

    /**
     * 首页点平台 → 这个平台的机器人选择页（用户 2026-11-18 定的层级）。
     *
     * <p>为什么不再直接进启动面板：一个平台可以有多个机器人，先取第一个是老实现，
     * 多机器人时根本分不清在配谁。层级固定为
     * <pre>主页 → 平台 → 机器人名字 → 启动 / 配置 → 启动页 / 配置页</pre>
     */
    void pushPlatformBots(String platformId) {
        String use = (platformId == null || platformId.length() == 0) ? BotRegistry.P_QQ : platformId;
        push(P_PLATFORMBOTS, use);
    }

    /** 平台页第二层：这台机器人在本平台的「启动 / 配置」。 */
    void pushManagedQqDashboard(String botId){push(P_QQ,botId,"dashboard");}

    void pushPlatformBot(String botId) {
        String use = resolveBotId(botId);
        if (use.length() > 0) this.botId = use;
        push(P_PLATFORMBOT, use);
    }

    /** 进启动页（状态 / 启停 / 二维码 / 日志），也就是 QQ 面板现在承担的角色。 */
    void pushBotStart(String botId) {
        String use = resolveBotId(botId);
        if (use.length() > 0) this.botId = use;
        push(P_QQ, use);
    }

    /** 进「模型与 Key」页（运行端配置 → 模型与接口 → 入口卡）。 */
    void pushEnv() {
        push(P_ENV, null);
    }

    void pushVersion() {
        push(P_VERSION, null);
    }

    void pushQrScan() {
        push(P_QR_SCAN, null);
    }

    void pushRemoteDevices(boolean openPairing) {
        push(P_REMOTE_DEVICES, openPairing ? "pair" : "");
    }

    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == QrScanScreen.REQ_CAMERA && current instanceof QrScanScreen) {
            if (grantResults != null && grantResults.length > 0
                    && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                ((QrScanScreen) current).onCameraPermissionGranted();
            } else {
                host.toast("未授予相机权限，可使用相册选图或粘贴配对口令");
            }
        }
    }

    /**
     * 切换当前控制目标设备（null = 本机，非 null = 远端 deviceId）。
     * 对齐 Q8：若当前页有未保存修改先弹窗提醒；确认后清空页面栈并回到目标设备的首页防串台。
     */
    void switchTargetDevice(final String peerIdOrNull) {
        Runnable apply = new Runnable() {
            @Override
            public void run() {
                com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.get(activity);
                RemoteBridge.clearCache();
                DashApi.clearRemoteCache();
                if (peerIdOrNull == null || peerIdOrNull.isEmpty()) {
                    rm.selectLocal();
                    BotRegistry.exitRemoteMode();
                    host.toast("已切回控制本机");
                } else {
                    rm.selectRemote(peerIdOrNull);
                    BotRegistry.enterRemoteMode(peerIdOrNull);
                    com.whaleonebot.remote.RemoteStore.PairedPeer p = rm.store().getPeer(peerIdOrNull);
                    host.toast("已切换到远程设备：" + (p == null ? peerIdOrNull : p.displayName()));
                }
                BotRegistry.Bot first = BotRegistry.primary();
                botId = first == null ? "" : first.id;
                screenCache.clear();
                stack.clear();
                Entry home = new Entry(P_HOME, null);
                stack.add(home);
                showScreen(create(home), MOTION_FADE);
            }
        };
        if (current != null && current.hasUnsavedChanges()) {
            PromptSheet.confirm(activity, theme, "切换控制设备",
                    "当前页面有尚未保存的修改，切换设备后将放弃修改并回到目标设备首页。确定继续吗？",
                    "放弃并切换", apply, null, null, "留在本页");
            return;
        }
        apply.run();
    }

    void pushModels() {
        push(P_MODELS, null);
    }

    /**
     * 进渠道编辑页。
     *
     * @param providerId 要编辑的渠道 id；null/空 = 新建
     * @param presetId   由哪条预置带入（可空）；非空时页面据此预填名称/地址/模型
     */
    void pushProvider(String providerId, String presetId) {
        push(P_PROVIDER, providerId, presetId);
    }

    /** 进某个用途的模型选择页（role ∈ chat/memory/image/asr/tts）。 */
    void pushModelPicker(String role) {
        push(P_MODELPICK, role == null ? "chat" : role);
    }

    /** 进「按群设置」（逐群模式 + 每群回复概率）。 */
    void pushPerGroup() {
        push(P_PERGROUP, null);
    }

    /** 进「人格模板」（当前人格存为模板 / 一键应用 / 改名 / 删除）。 */
    void pushPersonaTemplates() {
        push(P_PERSONATPL, null);
    }

    /** 进「知识库」（资料库清单 + 向量模型）。 */
    void pushKnowledge() {
        push(P_KB, null);
    }

    /** 进「看板」（运行端只读状态总览）。 */
    void pushDashboard() {
        push(P_DASH, null);
    }

    /** 进看板入口列表（各只读观测子页的目录）。 */
    void pushDashboardHub() {
        push(P_DASH_HUB, null);
    }

    void pushChatMonitor() {
        push(P_CHATMON, null);
    }

    void pushCallLog() {
        push(P_CALLLOG, null);
    }

    void pushMemory() {
        push(P_MEM, null);
    }

    void pushOps() {
        push(P_OPS, null);
    }

    void pushIntimacy() {
        push(P_INTIMACY, null);
    }

    void pushPeople() {
        push(P_PEOPLE, null);
    }

    void pushControl() {
        push(P_CONTROL, null);
    }

    void pushPlugins() {
        push(P_PLUGINS, null);
    }

    void pushReconcile() {
        push(P_RECONCILE, null);
    }

    /**
     * <b>回退到栈里最近的那一页</b>（按 kind 找），中间压着的页全部丢弃；栈里没有这一页时
     * 等价于 {@link #push(int)}。
     *
     * <p>为什么需要它：新建向导保存后要同时做两件事 ——（a）回到「设置 → 机器人」列表、
     * （b）进内置运行端下载页。若用两次 push，栈会变成
     * <pre>
     *   [BotList, NewBot, BotList, RuntimeDL]      ← 错：返回时会再看到那张已经提交过的空表单
     * </pre>
     * 用 popTo 则是：
     * <pre>
     *   [BotList, RuntimeDL]                       ← 对：返回一次就回列表
     * </pre>
     *
     * <p>语义细节（别当成「只出栈、不回退」）：
     * <ul>
     *   <li>从栈顶往下找第一个 kind 相同的元素，记为下标 i；</li>
     *   <li>i 之后的元素（含中间页与重复层）全部删掉；</li>
     *   <li>然后<b>重建并显示</b>第 i 页（走 {@link #showScreen} + {@link Motion#POP}），
     *       不是「留在原来那页上面」；</li>
     *   <li>i 就是栈顶时什么都不做（不重放动效、不重复压栈）；</li>
     *   <li>栈里没有这一页时 push 一页新的。</li>
     * </ul>
     */
    void popTo(int kind) {
        int idx = -1;
        for (int i = stack.size() - 1; i >= 0; i--) {
            if (stack.get(i).kind == kind) {
                idx = i;
                break;
            }
        }
        if (idx < 0) {
            push(kind, null);
            return;
        }
        if (idx == stack.size() - 1) return; // 已经在这一页，不需要动
        while (stack.size() > idx + 1) {
            screenCache.remove(stack.remove(stack.size() - 1));
        }
        showScreen(create(stack.get(idx)), MOTION_POP);
    }

    /**
     * 当前页面正在操作的机器人 id：先看栈顶元素的 arg，再退回「最近一次操作的机器人」，
     * 最后退回 {@link BotRegistry#primary()}。没有机器人时返回空串（不返回 null）。
     *
     * <p>宿主（{@code MainActivity}）也用它决定「这面板在给哪个机器人改运行端配置」——
     * 每个机器人一份 {@code config.json}，见 {@code MainActivity#loadConfigJson}。
     */
    public String currentBotId() {
        for (int i=stack.size()-1;i>=0;i--) {
            Entry entry=stack.get(i);
            if (entry.arg!=null && (entry.kind==P_BOT || entry.kind==P_PLATFORMBOT || entry.kind==P_BILI_ACCOUNT || entry.kind==P_DOUYIN_ACCOUNT || entry.kind==P_QQ || entry.kind==P_BOTCONFIG || entry.kind==P_RUNTIMEDL)) return entry.arg;
        }
        if (botId != null && botId.length() > 0) return botId;
        BotRegistry.Bot b = BotRegistry.primary();
        return b == null ? "" : b.id;
    }

    /** 把可能为空 / 失效的机器人 id 收敛成一个能用的 id。 */
    private String resolveBotId(String want) {
        BotRegistry.Bot b = BotRegistry.get(want);
        if (b == null) b = BotRegistry.primary();
        return b == null ? "" : b.id;
    }

    /**
     * 当前所在的平台 id：沿栈往下找最近的那个 {@link #P_PLATFORMBOTS} 元素。
     *
     * <p>为什么不让「机器人 → 启动/配置」页自己带平台参数：栈元素只有一个 arg 槽，
     * 而它已经用来放机器人 id 了（机器人 id 比平台更不可重建）。平台在这一页只是文案，
     * 所以从上一层推导即可；推不出来（直接深链进来）才退回 QQ。
     */
    private String platformOfStack() {
        for (int i = stack.size() - 1; i >= 0; i--) {
            Entry e = stack.get(i);
            if (e != null && e.kind == P_PLATFORMBOTS && e.arg != null && e.arg.length() > 0) {
                return e.arg;
            }
        }
        return BotRegistry.P_QQ;
    }

    private void push(int kind, String arg) {
        push(kind, arg, null);
    }

    private void push(int kind, String arg, String arg2) {
        Entry top = stack.isEmpty() ? null : stack.get(stack.size() - 1);
        // 同一页连点两下不重复压栈（否则返回要按两次）；不同页面照常压。
        if (top != null && top.kind == kind && same(top.arg, arg) && same(top.arg2, arg2)) return;
        Entry e = new Entry(kind, arg, arg2);
        stack.add(e);
        showScreen(create(e), MOTION_PUSH);
    }

    private static boolean same(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    // ------------------------------------------------------------------ 建页

    private Screen create(Entry e) {
        // 返回上一层时复用同一个页面实例（保住页内状态，例如运行端配置停在「组页」）。
        if(e!=null && e.kind!=P_HOME && e.kind!=P_SETTINGS && e.kind!=P_THEME && e.kind!=P_ENV && e.kind!=P_VERSION && e.kind!=P_QR_SCAN && e.kind!=P_REMOTE_DEVICES && e.kind!=P_DEPLOY_WIZARD && e.kind!=P_DOUYIN_ACCOUNT && e.kind!=P_BOT && e.kind!=P_BOTLIST && e.kind!=P_NEWBOT && e.kind!=P_PLATFORMBOTS && e.kind!=P_CORE_MANAGER) {
            BotRegistry.Bot owner=BotRegistry.get(currentBotId());
            CoreInventory.Instance scope=owner==null?null:BotRegistry.coreForBot(owner.id);
            if(scope!=null && CoreManagerScreen.managed(scope) && (e.kind==P_KB || (e.kind>=P_DASH && e.kind<=P_RECONCILE))) {
                Screen scoped=placeholder("此实例未提供此面板","请回到机器人详情管理本实例的配置。");scoped.build();return scoped;
            }
            if(owner!=null && !RuntimeSurfaces.builtin(owner)) {
                Screen neutral=new CustomRuntimeScreen(this,owner,e.kind==P_BILI_ACCOUNT?BotRegistry.P_BILIBILI:platformOfStack());neutral.build();return neutral;
            }
        }
        if (e != null) {
            Screen cached = screenCache.get(e);
            if (cached != null) return cached;
        }
        int kind = e == null ? P_HOME : e.kind;
        String arg = e == null ? null : e.arg;
        String arg2 = e == null ? null : e.arg2;
        Screen s = null;
        try {
            switch (kind) {
                case P_SETTINGS:
                    s = new SettingsScreen(this);
                    break;
                case P_ENV:
                    s = new EnvConfigScreen(this);
                    break;
                case P_VERSION:
                    s = new VersionScreen(this);
                    break;
                case P_QR_SCAN:
                    s = new QrScanScreen(this);
                    break;
                case P_REMOTE_DEVICES:
                    s = new RemoteDevicesScreen(this, "pair".equals(arg));
                    break;
                case P_THEME:
                    s = new ThemeScreen(this);
                    break;
                case P_QQ:
                    BotRegistry.Bot target = BotRegistry.get(arg == null ? currentBotId() : arg);
                    // ★ 2026-11-24 用户口径：「新登录的账号和已登录的账号是同一个启动页，只要填了 QQ 账号就能发起扫码」。
                    //   以前 legacy 走 QqScreen（有二维码），新核心走 BoundStartScreen（没二维码）⇒ 新号根本没有扫码入口。
                    //   现在两页合一：BoundStartScreen 自带容器启停 + 扫码登录 + QrPanel，legacy 与内置核心看到的是同一页。
                    s = new BoundStartScreen(this,target,"dashboard".equals(arg2));
                    break;
                case P_BILI_ACCOUNT:
                    s = arg2!=null&&(arg2.startsWith("slot:")||arg2.startsWith("new:"))?new BiliEnrollScreen(this,arg,arg2):new BiliPlatformScreen(this,BotRegistry.get(arg),arg2);
                    break;
                case P_DOUYIN_ACCOUNT:
                    s = new DouyinPlatformScreen(this, BotRegistry.get(arg), arg2);
                    break;
                case P_DEPLOY_WIZARD:
                    s = new DeployWizardScreen(this);
                    break;
                case P_PLATFORMBOTS:
                    s = new PlatformBotsScreen(this, arg);
                    break;
                case P_PLATFORMBOT:
                    s = new PlatformBotScreen(this,
                            BotRegistry.get((arg == null || arg.length() == 0) ? currentBotId() : arg),
                            platformOfStack());
                    break;
                case P_MODELS:
                    s = new ModelsScreen(this);
                    break;
                case P_PROVIDER:
                    s = new ProviderEditScreen(this, arg, arg2);
                    break;
                case P_MODELPICK:
                    s = new ModelPickerScreen(this, arg);
                    break;
                case P_PERGROUP:
                    s = new PerGroupScreen(this, (BotConfigHost) activity);
                    break;
                case P_PERSONATPL:
                    s = new PersonaTemplatesScreen(this, (BotConfigHost) activity);
                    break;
                case P_KB:
                    s = new KnowledgeScreen(this);       // 知识库：资料库 + 向量模型
                    break;
                case P_DASH:
                    s = new DashboardScreen(this);       // 看板：运行端只读状态
                    break;
                case P_DASH_HUB:
                    s = new DashboardHubScreen(this);    // 看板：子页目录
                    break;
                case P_CHATMON:
                    s = new ChatMonitorScreen(this);
                    break;
                case P_CALLLOG:
                    s = new CallLogScreen(this);
                    break;
                case P_MEM:
                    s = new MemoryScreen(this);
                    break;
                case P_OPS:
                    s = new OpsScreen(this);
                    break;
                case P_INTIMACY:
                    s = new IntimacyScreen(this);
                    break;
                case P_PEOPLE:
                    s = new PeopleScreen(this);
                    break;
                case P_CONTROL:
                    s = new ControlScreen(this);
                    break;
                case P_PLUGINS:
                    s = new PluginsScreen(this);
                    break;
                case P_RECONCILE:
                    s = new ReconcileScreen(this);       // 待对账：解锁 / 重试失败
                    break;
                case P_BOT:
                    s = new BotDetailScreen(this,
                            BotRegistry.get((arg == null || arg.length() == 0) ? currentBotId() : arg));
                    break;
                case P_BOTCONFIG:
                    s = new BotConfigScreen(activity, this, (BotConfigHost) activity);
                    break;
                // ---- 下面三页由 T2 / T3 交付（原先这里是占位兜底，类进仓后已接线）----
                case P_BOTLIST:
                    s = new BotListScreen(this);        // T2 · ui/BotListScreen.java
                    break;
                case P_NEWBOT:
                    s = new NewBotScreen(this);         // T2 · ui/NewBotScreen.java
                    break;
                case P_EXTERNAL_ACCOUNT:
                    s = new BotDetailScreen(this,BotRegistry.get(arg),arg2==null?"":arg2);
                    break;
                case P_CORE_MANAGER:
                    s = new CoreManagerScreen(this,arg,arg2);
                    break;
                case P_RUNTIMEDL:
                    s = new CoreManagerScreen(this,"download",""); // Old persisted navigation routes go to the signed installer only.
                    break;
                default:
                    s = new HomeScreen(this);
                    break;
            }
            s.build();
            if (e != null && kind != P_BOTLIST && kind != P_PLATFORMBOTS && kind != P_PLATFORMBOT && kind != P_BOT && kind != P_QQ && kind != P_BILI_ACCOUNT && kind != P_DOUYIN_ACCOUNT && kind != P_DEPLOY_WIZARD && kind != P_CORE_MANAGER && kind != P_EXTERNAL_ACCOUNT && kind != P_VERSION) screenCache.put(e, s);
            return s;
        } catch (Throwable t) {
            // 兜底：任何一页的构造 / 铺版失败都退成占位页，绝不把整个 App 崩掉。
            // 并行开发期这三页曾经用 placeholder(...) 占位，保的就是这条「任何时刻都能起来」。
            // ★ 2026-11-19 白屏定位：这里原来**吞掉了异常**，导致界面全白却没有任何日志。
            android.util.Log.e("WhaleOneBot", "screen build failed kind=" + kind, t);
            Screen fb = placeholder("页面打不开",
                    "这个页面没能加载出来（" + t.getClass().getSimpleName() + "）：返回上一层再试一次。");
            try {
                fb.build();
            } catch (Throwable ignored) {
                // 连占位页都铺不出来就留一个空页，仍然不崩 —— 但要留下证据，否则就是白屏无日志。
                android.util.Log.e("WhaleOneBot", "placeholder build failed too", ignored);
            }
            return fb;
        }
    }

    /**
     * 建设中 / 兜底占位页：标题 + 一句说明。
     *
     * <p>两段用途：
     * <ol>
     *   <li><b>并行开发期的占位</b>：T2/T3 的类还没进仓时，P_BOTLIST / P_NEWBOT / P_RUNTIMEDL
     *       用本方法兜底，保证任何时刻都能编译、能跑起来。现在这三页已经接线
     *       （{@code create()} 里一行一个 {@code new ...Screen(this)}），若哪天要临时回退，
     *       把那一行换回 {@code s = placeholder("标题", "说明");} 即可；</li>
     *   <li><b>构造失败兜底</b>：任何一页的构造 / 铺版抛异常时，退成本页而不是闪退。</li>
     * </ol>
     *
     * <p>样式与其它页面完全同源（{@link Screen#header(String)} + {@link Ui#card}），
     * 不自造颜色/圆角/字号，也不写入场动画（那是 {@link Motion} 的事）。
     */
    private Screen placeholder(final String title, final String note) {
        return new Screen(this) {
            @Override
            void build() {
                ScrollView scroll = new ScrollView(activity);
                scroll.setFillViewport(true);
                scroll.setClipChildren(false);
                root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

                LinearLayout col = Ui.column(activity);
                col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
                scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

                col.addView(header(title), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

                FrameLayout card = Ui.card(activity, t);
                LinearLayout box = Ui.column(activity);
                box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));

                TextView tv = Ui.text(activity, note, Theme.T_CAP, t.textSecondary);
                tv.setLineSpacing(dp(3), 1f);
                box.addView(tv, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

                card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
                LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
                clp.topMargin = dp(Theme.S3);
                col.addView(card, clp);
            }
        };
    }

    /**
     * 换页：<b>所有</b>页面切换都从这里走，动效统一交给 {@link Motion}，没有例外分支。
     *
     * <p>三条硬保证（原来缺的就是这些，表现为「点进去闪一下 / 页面不见了」）：
     * <ol>
     *   <li>进来的页一定先挂到 pageHost 上，动效才开始跑 —— 绝不对一个还没父容器的 View 做动画；</li>
     *   <li>清理残留视图时跳过「即将上场」的这一页，不会把它当残留删掉；</li>
     *   <li>旧页的移除放在动画结束回调里，并且先确认它「还在容器里、且已经不是当前页」，
     *       被后续导航打断时不会误删别人的视图。</li>
     * </ol>
     */
    private void showScreen(final Screen next, final int motion) {
        if (next == null || next.root == null) return; // 兜底：不拿空 View 进容器

        // 动画被打断时可能有残留视图：清掉，但绝不碰即将上场的这一页。
        for (int i = pageHost.getChildCount() - 1; i >= 0; i--) {
            View ch = pageHost.getChildAt(i);
            if (ch == next.root) continue;
            if (current == null || ch != current.root) pageHost.removeViewAt(i);
        }

        final View oldView = current == null ? null : current.root;
        current = next;
        final View nv = next.root;

        // 同一个 View 被重复挂载时先摘下来，否则 addView 会抛 IllegalStateException（看起来就是闪退）。
        if (nv.getParent() instanceof ViewGroup) {
            ((ViewGroup) nv.getParent()).removeView(nv);
        }

        final int w = Motion.widthOf(pageHost);

        pageHost.addView(nv, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        Motion.enter(nv, motion, w);

        if (oldView != null && oldView != nv) {
            Motion.exit(oldView, motion, w, new Runnable() {
                @Override
                public void run() {
                    // 只移除「确实还在容器里、且已经不是当前页」的旧页。
                    if (oldView.getParent() == pageHost && oldView != current.root) {
                        pageHost.removeView(oldView);
                    }
                }
            });
        }

        // 整页入场动效由本方法负责；页面的 onAttach 只做不涉及整页透明度/位移的装饰。
        // 万一它抛异常，也只提示、不让整页消失 —— 那正是用户看到的「闪退」。
        try {
            next.onAttach();
        } catch (Throwable t) {
            String m = t.getMessage();
            host.toast("页面入场异常：" + t.getClass().getSimpleName()
                    + (m == null || m.length() == 0 ? "" : "（" + m + "）"));
        }
    }

    // ------------------------------------------------------------------ 主题

    void useTheme(String id) {
        String want = Theme.byId(id).id;
        boolean same = want.equals(theme.id);
        store.setTheme(want);
        if (same) return;

        theme = store.theme();
        root.setBackgroundColor(theme.g0);
        backdrop.applyTheme(theme);
        applyWindowColors();
        // 原生弹窗/下拉也换一套深浅，否则换完主题之后新建的对话框还停在旧配色。
        ThemeBridge.apply(activity, theme.dark);
        // 重建当前页：所有颜色都来自令牌，重建即完成「重新上色」。
        //
        // ★★★ 清缓存这一步不能省（2026-11-21 真机复现的根因就在这里）：
        //   create() 会**优先返回 screenCache 里的旧实例**（见 create() 的 if (cached != null)）。
        //   不清缓存时上面这行等于把**同一个旧 View** 原样挂回去 —— 背景由 BackdropView 重绘所以变了，
        //   但卡片填充、文字色、选中勾都是建视图时定的，全部滞留在上一套：
        //   切到浅色主题（晨纸）后白字压近白底，整屏不可读；主题页的勾也停在旧行不动。
        //   冷启动之所以正常，正是因为它走的是「新建页面」这条路 —— 这也反证了色盘没错。
        //   清整份缓存而不是只删当前页：返回上一层同样走 create()，也必须按新主题重建。
        //   代价是各页的页内临时状态（如运行端配置停在组页）在**换主题这一次**会丢 —— 可接受。
        screenCache.clear();
        Entry top = stack.get(stack.size() - 1);
        showScreen(create(top), MOTION_FADE);
    }

    void clearCustomBg() {
        store.clearCustomBg();
        backdrop.invalidateBackground();
        if (current != null) current.refresh();
    }

    void pickImage() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            activity.startActivityForResult(
                    Intent.createChooser(intent, "选择背景图片"), REQ_PICK_IMAGE);
        } catch (Throwable t) {
            host.toast("这台机器上没有可用的图片选择器");
        }
    }

    /** 调用系统文件选择器多选 .txt/.md/.json 文件（供知识库与记忆库一键导入使用）。 */
    void pickMultipleTextFiles(MultiTextCallback cb) {
        pendingMultiTextCb = cb;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/plain", "text/markdown", "application/json", "text/*"});
        try {
            activity.startActivityForResult(
                    Intent.createChooser(intent, "选择要导入的文档（支持多选）"), REQ_PICK_MULTI_TEXT);
        } catch (Throwable t) {
            pendingMultiTextCb = null;
            host.toast("这台机器上没有可用的文件选择器");
        }
    }

    private String queryDisplayName(android.net.Uri uri, String fallback) {
        android.database.Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(uri,
                    new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                String n = cursor.getString(0);
                if (n != null && n.trim().length() > 0) return n.trim();
            }
        } catch (Throwable ignored) {
            // ignore
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Throwable ignored) { }
            }
        }
        return fallback;
    }

    /** 「QQ 登录 / 换一张码」统一入口：先清掉认码窗口，再交给宿主。 */
    void requestQr() {
        qrRequestedAt = System.currentTimeMillis();
        qrSeenLive = false;
        host.requestQr();
    }

    // ------------------------------------------------------------------ 系统栏

    /**
     * 状态栏/导航栏跟着渐变走，否则窗口上下会各出现一条与背景割裂的硬边。
     * 宿主之后若自己改这两处，覆盖掉也无妨。
     */
    private void applyWindowColors() {
        Window win = activity.getWindow();
        if (win == null) return;
        try {
            win.setStatusBarColor(theme.g0);
            win.setNavigationBarColor(theme.g2);
            View decor = win.getDecorView();
            int flags = decor.getSystemUiVisibility();
            int lightBits = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) {
                lightBits |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            if (theme.dark) {
                flags &= ~lightBits;
            } else {
                flags |= lightBits;
            }
            decor.setSystemUiVisibility(flags);
        } catch (Throwable ignored) {
            // 系统栏配色只是锦上添花，失败不影响任何功能
        }
    }

    // ------------------------------------------------------------------ 栈元素

    /**
     * 页面栈元素：{@code (kind, arg)}。
     *
     * <p>arg 只对「要操作某一个机器人」的页面有意义（详情 / 运行端配置 / 运行端下载），
     * 其余页面为 null。这个类不进任何公开签名，页面拿不到它，只能通过
     * {@link #pushBot(String)} 这类方法导航 —— 免得页面自己拼栈元素。
     */
    private static final class Entry {
        final int kind;
        final String arg;
        /** 少数页面需要两个参数（例如「渠道编辑」要同时带 providerId 与预设 id），第二个放这里。 */
        final String arg2;

        Entry(int kind, String arg) {
            this(kind, arg, null);
        }

        Entry(int kind, String arg, String arg2) {
            this.kind = kind;
            this.arg = arg;
            this.arg2 = arg2;
        }
    }
}
