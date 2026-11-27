package com.whaleonebot.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import com.whaleonebot.remote.NostrSignaling;
import com.whaleonebot.remote.RemoteControlManager;
import com.whaleonebot.remote.RemoteCrypto;
import com.whaleonebot.remote.RemoteHostServer;
import com.whaleonebot.remote.RemoteStore;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import io.nayuki.qrcodegen.QrCode;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 远程设备与本机配对码管理页（永远作用在本机 App）。
 *
 * <p>四卡结构（严格遵循 Ui.card 白色圆角卡片）：
 * <ol>
 *   <li>本机被控与 60 秒一次性配对码（含总开关、本机名、二维码、倒计时、复制配对口令、刷新/作废）；</li>
 *   <li>我控制的远端设备（1 控多，实时展示在线/离线/通道/延迟，支持切换、改备注、设 Tailscale/直连地址、重连、移除）；</li>
 *   <li>已授权控制本机的设备（权限标签、在线状态、踢下线、永久吊销）；</li>
 *   <li>跨公网免费公共信令节点（多节点冗余、匿名加密、支持自定义增删）。</li>
 * </ol>
 */
final class RemoteDevicesScreen extends Screen {

    private final boolean autoShowPairing;
    private LinearLayout content;
    private RemoteCrypto.PairPayload activePayload;
    private TextView countdownView;
    private TextView hostStatusView;
    private LinearLayout peerListBox;
    private LinearLayout clientListBox;
    private long lastListRefreshAt;

    RemoteDevicesScreen(AppShell shell, boolean autoShowPairing) {
        super(shell);
        this.autoShowPairing = autoShowPairing;
    }

    @Override
    void build() {
        root.removeAllViews();
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        content = Ui.column(activity);
        content.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(content, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        content.addView(header("远程设备与配对"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        RemoteControlManager mgr = RemoteControlManager.get(activity);
        if (autoShowPairing && activePayload == null) {
            try {
                activePayload = mgr.host().createPairingPayload();
            } catch (Throwable t) {
                host().toast("生成配对码失败：" + t.getMessage());
            }
        }
        renderCards();
    }

    private void renderCards() {
        // 保留顶部的 header，重建下方 4 张卡片
        while (content.getChildCount() > 1) content.removeViewAt(content.getChildCount() - 1);
        RemoteControlManager mgr = RemoteControlManager.get(activity);
        RemoteStore store = mgr.store();
        RemoteStore.LocalIdentity me = store.identity();

        // ==================== 卡 1：本机被控与 60 秒配对码 ====================
        LinearLayout hostCard = Ui.addCard(content, activity, t, Theme.S3);
        LinearLayout topRow = Ui.row(activity);
        LinearLayout titleCol = Ui.column(activity);
        titleCol.addView(Ui.strong(activity, "让其他设备控制本机", Theme.T_CARD, t.textPrimary));
        hostStatusView = Ui.text(activity, hostStatusSummary(mgr), Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams hslp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        hslp.topMargin = dp(4);
        titleCol.addView(hostStatusView, hslp);
        LinearLayout.LayoutParams tclp = Ui.llp(0, WRAP_CONTENT);
        tclp.weight = 1f;
        topRow.addView(titleCol, tclp);

        Switch hostSwitch = new Switch(activity);
        hostSwitch.setChecked(me.hostEnabled);
        hostSwitch.setOnCheckedChangeListener((btn, checked) -> {
            store.setHostEnabled(checked);
            if (checked) {
                mgr.host().start();
                host().toast("已开启本机远程被控监听");
            } else {
                store.cancelPairingTicket();
                activePayload = null;
                mgr.host().stop();
                host().toast("已关闭远程被控，已断开所有远端控制会话");
            }
            renderCards();
        });
        topRow.addView(hostSwitch, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        hostCard.addView(topRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        hostCard.addView(Ui.divider(activity, t));

        // 本机名称行
        LinearLayout nameRow = Ui.row(activity);
        LinearLayout nameCol = Ui.column(activity);
        nameCol.addView(Ui.text(activity, "本机名称：" + me.deviceName, Theme.T_BODY, t.textPrimary));
        nameCol.addView(Ui.text(activity, "设备指纹：" + me.deviceId.substring(0, Math.min(12, me.deviceId.length())),
                Theme.T_CAP, t.textTertiary));
        LinearLayout.LayoutParams nclp = Ui.llp(0, WRAP_CONTENT);
        nclp.weight = 1f;
        nameRow.addView(nameCol, nclp);
        TextView renameMe = Ui.button(activity, t, "改名", false);
        renameMe.setOnClickListener(v -> PromptSheet.showInput(activity, "修改本机名称",
                "其他设备配对或切换时将看到此名称：", "设备名称", me.deviceName, false, "保存", name -> {
                    if (!name.isEmpty()) {
                        store.setDeviceName(name);
                        host().toast("本机名称已更新");
                        renderCards();
                    }
                }));
        nameRow.addView(renameMe, Ui.llp(WRAP_CONTENT, dp(40)));
        hostCard.addView(nameRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 60 秒二维码区域
        RemoteStore.PairingTicket tk = store.activeTicket();
        boolean showQr = activePayload != null && tk != null && tk.isActive(System.currentTimeMillis());
        if (showQr) {
            FrameLayout qrWrap = new FrameLayout(activity);
            qrWrap.setBackground(Drawables.round(0xFFFFFFFF, t.cardStroke, dp(1), dp(Theme.R_PANEL)));
            int pad = dp(12);
            qrWrap.setPadding(pad, pad, pad, pad);
            ImageView iv = new ImageView(activity);
            iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
            Bitmap bmp = renderQrBitmap(activePayload.toCompactQrUri(), 720);
            if (bmp != null) iv.setImageBitmap(bmp);
            qrWrap.addView(iv, new FrameLayout.LayoutParams(dp(268), dp(268), Gravity.CENTER));
            LinearLayout.LayoutParams qlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            qlp.topMargin = dp(Theme.S3);
            hostCard.addView(qrWrap, qlp);

            countdownView = Ui.text(activity, pairingStatusLine(mgr, tk), Theme.T_CAP, t.accent);
            countdownView.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams cdlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            cdlp.topMargin = dp(Theme.S2);
            hostCard.addView(countdownView, cdlp);

            LinearLayout qrBtns = Ui.row(activity);
            TextView copyUri = Ui.button(activity, t, "复制配对口令", true);
            copyUri.setOnClickListener(v -> {
                ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("WhalePair", activePayload.toUri()));
                    host().toast("已复制 3 分钟单次配对口令，可发到微信/QQ 供另一台手机粘贴配对");
                }
            });
            TextView refreshQr = Ui.button(activity, t, "刷新", false);
            refreshQr.setOnClickListener(v -> {
                activePayload = mgr.host().createPairingPayload();
                renderCards();
            });
            TextView cancelQr = Ui.button(activity, t, "作废", false);
            cancelQr.setOnClickListener(v -> {
                store.cancelPairingTicket();
                activePayload = null;
                host().toast("已作废当前配对码");
                renderCards();
            });
            LinearLayout.LayoutParams q1 = Ui.llp(0, dp(Theme.TOUCH)); q1.weight = 1.6f;
            LinearLayout.LayoutParams q2 = Ui.llp(0, dp(Theme.TOUCH)); q2.weight = 1f; q2.leftMargin = dp(Theme.S1);
            LinearLayout.LayoutParams q3 = Ui.llp(0, dp(Theme.TOUCH)); q3.weight = 1f; q3.leftMargin = dp(Theme.S1);
            qrBtns.addView(copyUri, q1);
            qrBtns.addView(refreshQr, q2);
            qrBtns.addView(cancelQr, q3);
            LinearLayout.LayoutParams qblp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            qblp.topMargin = dp(Theme.S2);
            hostCard.addView(qrBtns, qblp);
        } else {
            countdownView = null;
            TextView genBtn = Ui.button(activity, t, "生成配对二维码（3 分钟单次有效）", true);
            genBtn.setOnClickListener(v -> {
                try {
                    activePayload = mgr.host().createPairingPayload();
                    renderCards();
                } catch (Throwable err) {
                    host().toast("生成失败：" + err.getMessage());
                }
            });
            LinearLayout.LayoutParams glp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
            glp.topMargin = dp(Theme.S3);
            hostCard.addView(genBtn, glp);
        }

        // ==================== 卡 2：我控制的远端设备 ====================
        LinearLayout peersCard = Ui.addCard(content, activity, t, Theme.S3);
        peersCard.addView(Ui.strong(activity, "我控制的远端设备", Theme.T_CARD, t.textPrimary));
        peerListBox = Ui.column(activity);
        LinearLayout.LayoutParams pllp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        pllp.topMargin = dp(Theme.S2);
        peersCard.addView(peerListBox, pllp);
        populatePeerList(mgr);

        TextView scanNew = Ui.button(activity, t, "扫码配对新设备", true);
        scanNew.setOnClickListener(v -> shell.pushQrScan());
        LinearLayout.LayoutParams snlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        snlp.topMargin = dp(Theme.S3);
        peersCard.addView(scanNew, snlp);

        // ==================== 卡 3：已授权控制本机的设备 ====================
        LinearLayout clientsCard = Ui.addCard(content, activity, t, Theme.S3);
        clientsCard.addView(Ui.strong(activity, "已授权控制本机的设备", Theme.T_CARD, t.textPrimary));
        TextView cHint = Ui.text(activity, "已配对的控制端默认拥有完全控制权，可随时踢下线或永久吊销。",
                Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams chlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        chlp.topMargin = dp(4);
        clientsCard.addView(cHint, chlp);
        clientListBox = Ui.column(activity);
        LinearLayout.LayoutParams cllp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        cllp.topMargin = dp(Theme.S2);
        clientsCard.addView(clientListBox, cllp);
        populateClientList(mgr);

        // ==================== 卡 4：跨公网无服务器密文信令配置 ====================
        LinearLayout relayCard = Ui.addCard(content, activity, t, Theme.S3);
        relayCard.addView(Ui.strong(activity, "跨公网无服务器加密信令（国内免代理直连）", Theme.T_CARD, t.textPrimary));
        List<String> relays = store.effectiveRelays();
        StringBuilder rDesc = new StringBuilder("同 Wi-Fi 秒走局域网；跨 5G/不同网络自动走多协议密文信令与中继并在后台升级直连 P2P（全程端到端加密，节点不可见明文）。\n当前节点（")
                .append(relays.size()).append(" 个）：\n");
        for (String r : relays) rDesc.append("• ").append(r).append('\n');
        TextView rText = Ui.text(activity, rDesc.toString().trim(), Theme.T_CAP, t.textSecondary);
        rText.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        rlp.topMargin = dp(Theme.S1);
        relayCard.addView(rText, rlp);

        TextView editRelay = Ui.button(activity, t, "自定义信令节点", false);
        editRelay.setOnClickListener(v -> {
            StringBuilder cur = new StringBuilder();
            for (String r : store.identity().customRelays) cur.append(r).append('\n');
            PromptSheet.showInput(activity, "自定义公共/自建信令节点",
                    "每行填一个 mqtts:// 或 wss:// 地址；留空保存将恢复内置 6 个免费节点（EMQX/HiveMQ MQTT-TLS + Nostr）：",
                    "mqtts://broker-cn.emqx.io:8883", cur.toString().trim(), true, "保存", text -> {
                        List<String> next = new ArrayList<String>();
                        if (!text.isEmpty()) {
                            for (String line : text.split("\n")) {
                                String u = line.trim();
                                if (NostrSignaling.isSupportedRelayUrl(u)) next.add(u);
                            }
                        }
                        store.setCustomRelays(next);
                        host().toast(next.isEmpty() ? "已恢复默认多协议信令节点" : ("已保存 " + next.size() + " 个信令节点"));
                        renderCards();
                    });
        });
        LinearLayout.LayoutParams erlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        erlp.topMargin = dp(Theme.S2);
        relayCard.addView(editRelay, erlp);
    }

    private void populatePeerList(RemoteControlManager mgr) {
        if (peerListBox == null) return;
        peerListBox.removeAllViews();
        List<RemoteStore.PairedPeer> peers = mgr.store().listPeers();
        if (peers.isEmpty()) {
            peerListBox.addView(Ui.text(activity, "还没有配对任何远端设备。点下方「扫码配对新设备」即可开始。",
                    Theme.T_CAP, t.textTertiary));
            return;
        }
        String activeId = mgr.activePeerId();
        for (int i = 0; i < peers.size(); i++) {
            final RemoteStore.PairedPeer peer = peers.get(i);
            if (i > 0) peerListBox.addView(Ui.divider(activity, t));
            RemoteControlManager.PeerStatus st = mgr.statusOf(peer.deviceId);
            boolean isCurrent = peer.deviceId.equals(activeId);

            LinearLayout row = Ui.row(activity);
            LinearLayout info = Ui.column(activity);
            LinearLayout titleLine = Ui.row(activity);
            titleLine.addView(Ui.strong(activity, peer.displayName(), Theme.T_BODY, t.textPrimary));
            if (isCurrent) {
                LinearLayout.LayoutParams blp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
                blp.leftMargin = dp(6);
                titleLine.addView(Ui.pill(activity, t, "当前控制", Ui.TONE_OK), blp);
            }
            info.addView(titleLine);

            String sub = (st == null ? "探测中…" : st.summaryText())
                    + (peer.customDirect.isEmpty() ? "" : " · 已设直连地址");
            int toneColor = (st != null && st.state == RemoteControlManager.ConnState.CONNECTED)
                    ? t.toneStrong : t.textSecondary;
            info.addView(Ui.text(activity, sub, Theme.T_CAP, toneColor));

            LinearLayout.LayoutParams ilp = Ui.llp(0, WRAP_CONTENT);
            ilp.weight = 1f;
            row.addView(info, ilp);

            TextView act = Ui.button(activity, t, isCurrent ? "管理" : "切换", !isCurrent);
            act.setOnClickListener(v -> {
                if (!isCurrent) {
                    shell.switchTargetDevice(peer.deviceId);
                } else {
                    openPeerActions(mgr, peer);
                }
            });
            row.addView(act, Ui.llp(WRAP_CONTENT, dp(38)));
            row.setOnClickListener(v -> openPeerActions(mgr, peer));
            peerListBox.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
    }

    private void openPeerActions(RemoteControlManager mgr, RemoteStore.PairedPeer peer) {
        String[] opts = {"切换到此设备", "修改备注名", "设置固定/Tailscale 直连地址", "立即重连", "移除此设备"};
        PromptSheet.choose(activity, t, peer.displayName(), opts, idx -> {
            if (idx == 0) {
                shell.switchTargetDevice(peer.deviceId);
            } else if (idx == 1) {
                PromptSheet.showInput(activity, "修改设备备注", "留空恢复使用原机型名：", "备注名",
                        peer.alias, false, "保存", text -> {
                            mgr.store().renamePeer(peer.deviceId, text);
                            renderCards();
                        });
            } else if (idx == 2) {
                PromptSheet.showInput(activity, "设置固定直连 / Tailscale 地址",
                        "极端对称 NAT 无法 UDP 打洞时，可填该设备的 Tailscale/ZeroTier/内网穿透地址（格式 IP:端口，例如 100.64.0.2:41988；留空清除）：",
                        "100.64.x.x:41988", peer.customDirect, false, "保存", text -> {
                            mgr.store().setPeerCustomDirect(peer.deviceId, text);
                            mgr.reconnectNow(peer.deviceId);
                            host().toast("直连地址已保存，正在尝试连接");
                            renderCards();
                        });
            } else if (idx == 3) {
                mgr.reconnectNow(peer.deviceId);
                host().toast("正在重连 " + peer.displayName());
            } else if (idx == 4) {
                PromptSheet.confirm(activity, t, "移除远端设备",
                        "确定移除「" + peer.displayName() + "」吗？移除后如需再次控制需重新扫码配对。",
                        "移除", () -> {
                            mgr.removePeer(peer.deviceId);
                            host().toast("已移除");
                            renderCards();
                        }, null, null, "取消");
            }
        }, null, null);
    }

    private void populateClientList(RemoteControlManager mgr) {
        if (clientListBox == null) return;
        clientListBox.removeAllViews();
        List<RemoteStore.AuthorizedClient> list = mgr.store().listAuthorizedClients();
        if (list.isEmpty()) {
            clientListBox.addView(Ui.text(activity, "暂无已授权的外部控制端。", Theme.T_CAP, t.textTertiary));
            return;
        }
        SimpleDateFormat fmt = new SimpleDateFormat("MM-dd HH:mm", Locale.US);
        for (int i = 0; i < list.size(); i++) {
            final RemoteStore.AuthorizedClient c = list.get(i);
            if (i > 0) clientListBox.addView(Ui.divider(activity, t));
            boolean online = mgr.host().isClientOnline(c.deviceId);

            LinearLayout row = Ui.row(activity);
            LinearLayout info = Ui.column(activity);
            LinearLayout titleLine = Ui.row(activity);
            titleLine.addView(Ui.strong(activity, c.name, Theme.T_BODY, t.textPrimary));
            LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            plp.leftMargin = dp(6);
            titleLine.addView(Ui.pill(activity, t,
                    c.revoked ? "已吊销" : (online ? "在线 · 完全控制" : "离线 · 完全控制"),
                    c.revoked ? Ui.TONE_DANGER : (online ? Ui.TONE_OK : Ui.TONE_NEUTRAL)), plp);
            info.addView(titleLine);
            info.addView(Ui.text(activity, "最近活跃：" + fmt.format(new Date(c.lastSeenAt)),
                    Theme.T_CAP, t.textTertiary));
            LinearLayout.LayoutParams ilp = Ui.llp(0, WRAP_CONTENT);
            ilp.weight = 1f;
            row.addView(info, ilp);

            TextView manage = Ui.button(activity, t, c.revoked ? "删除" : "管理", false);
            manage.setOnClickListener(v -> {
                if (c.revoked) {
                    mgr.store().removeClient(c.deviceId);
                    renderCards();
                    return;
                }
                String[] actions = {"踢下线（断开当前连接）", "永久吊销授权"};
                PromptSheet.choose(activity, t, c.name, actions, idx -> {
                    if (idx == 0) {
                        mgr.host().kickClient(c.deviceId);
                        host().toast("已断开 " + c.name);
                        renderCards();
                    } else if (idx == 1) {
                        mgr.host().revokeClient(c.deviceId);
                        host().toast("已永久吊销 " + c.name + " 的远程控制权");
                        renderCards();
                    }
                }, null, null);
            });
            row.addView(manage, Ui.llp(WRAP_CONTENT, dp(38)));
            clientListBox.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
    }

    private String hostStatusSummary(RemoteControlManager mgr) {
        if (!mgr.store().identity().hostEnabled) return "已关闭 · 不会响应任何外部远程连接";
        if (!mgr.host().isRunning()) return "正在启动原生远程监听…";
        String lan = RemoteHostServer.localIpv4();
        return "监听中（端口 " + mgr.host().listenPort() + (lan == null ? "" : " · " + lan) + " · 独立于容器常驻）";
    }

    private String pairingStatusLine(RemoteControlManager mgr, RemoteStore.PairingTicket tk) {
        int online = mgr.host().pairingSignalOnlineCount();
        int total = mgr.host().pairingSignalTotalCount();
        String sig = online > 0
                ? ("跨网加密信令就绪（" + online + "/" + total + " 节点在线）")
                : ("正在连接跨网信令节点（0/" + total + "，同 Wi-Fi 可直接扫）");
        return "剩余 " + tk.leftSeconds(System.currentTimeMillis()) + " 秒 · 单次扫码即作废\n" + sig;
    }

    @Override
    void refresh() {
        super.refresh();
        RemoteControlManager mgr = RemoteControlManager.get(activity);
        if (hostStatusView != null) hostStatusView.setText(hostStatusSummary(mgr));
        if (countdownView != null) {
            RemoteStore.PairingTicket tk = mgr.store().activeTicket();
            if (tk == null || !tk.isActive(System.currentTimeMillis())) {
                activePayload = null;
                renderCards();
                return;
            }
            countdownView.setText(pairingStatusLine(mgr, tk));
        }
        long now = System.currentTimeMillis();
        if (now - lastListRefreshAt >= 2000L) {
            lastListRefreshAt = now;
            populatePeerList(mgr);
            populateClientList(mgr);
        }
    }

    private static Bitmap renderQrBitmap(String text, int sizePx) {
        try {
            // 手机拍手机屏幕场景下，大点阵（Ecc.LOW）比高密细点阵抗失焦/摩尔纹能力显著更强
            QrCode qr = QrCode.encodeText(text, QrCode.Ecc.LOW);
            int border = 4;
            int total = qr.size + border * 2;
            int scale = Math.max(4, sizePx / total);
            int dim = total * scale;
            int[] px = new int[dim * dim];
            for (int y = 0; y < dim; y++) {
                int my = y / scale - border;
                for (int x = 0; x < dim; x++) {
                    int mx = x / scale - border;
                    boolean dark = mx >= 0 && mx < qr.size && my >= 0 && my < qr.size && qr.getModule(mx, my);
                    px[y * dim + x] = dark ? Color.BLACK : Color.WHITE;
                }
            }
            Bitmap bmp = Bitmap.createBitmap(dim, dim, Bitmap.Config.ARGB_8888);
            bmp.setPixels(px, 0, dim, 0, 0, dim, dim);
            return bmp;
        } catch (Throwable t) {
            return null;
        }
    }
}
