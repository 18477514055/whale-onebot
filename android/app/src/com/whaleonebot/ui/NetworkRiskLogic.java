package com.whaleonebot.ui;

import java.util.List;
import java.util.Locale;

/**
 * [layer: shell-android] 纯 Java 网络出口与代理劫持分类逻辑（零 Android 依赖，可进主机单测）。
 */
public final class NetworkRiskLogic {

    public static final int RISK_OFFLINE = 0;
    public static final int RISK_SAFE_DIRECT = 1;
    public static final int RISK_TAILSCALE_ONLY = 2;
    public static final int RISK_PROXY_HIJACK = 3;

    public static final class Report {
        public final int level;
        public final String transport;
        public final boolean hasVpn;
        public final boolean tailscaleOnly;
        public final boolean proxyHijack;
        public final boolean hasFakeIpDns;
        public final boolean hasV6;
        public final String ifaceName;
        public final String badge;
        public final String summary;
        public final String detail;

        public Report(int level, String transport, boolean hasVpn, boolean tailscaleOnly,
                      boolean proxyHijack, boolean hasFakeIpDns, boolean hasV6, String ifaceName,
                      String badge, String summary, String detail) {
            this.level = level;
            this.transport = transport == null ? "" : transport;
            this.hasVpn = hasVpn;
            this.tailscaleOnly = tailscaleOnly;
            this.proxyHijack = proxyHijack;
            this.hasFakeIpDns = hasFakeIpDns;
            this.hasV6 = hasV6;
            this.ifaceName = ifaceName == null ? "" : ifaceName;
            this.badge = badge == null ? "" : badge;
            this.summary = summary == null ? "" : summary;
            this.detail = detail == null ? "" : detail;
        }

        public boolean isWarn() {
            return level == RISK_PROXY_HIJACK || level == RISK_OFFLINE;
        }
    }

    private NetworkRiskLogic() {
    }

    /** 判定 IPv4 地址是否属于 Tailscale CGNAT 网段 100.64.0.0/10（100.64.0.0 ~ 100.127.255.255）。 */
    public static boolean isTailscaleCgnatIp(String ip) {
        if (ip == null) return false;
        String s = ip.trim();
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);
        String[] parts = s.split("\\.");
        if (parts.length != 4) return false;
        try {
            int a = Integer.parseInt(parts[0]);
            int b = Integer.parseInt(parts[1]);
            int c = Integer.parseInt(parts[2]);
            int d = Integer.parseInt(parts[3]);
            return a == 100 && b >= 64 && b <= 127 && c >= 0 && c <= 255 && d >= 0 && d <= 255;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 判定 IPv4 地址是否属于常见代理 fake-IP 段（198.18.0.0/15，Clash/sing-box 默认 fake-IP）。 */
    public static boolean isFakeIpAddress(String ip) {
        if (ip == null) return false;
        String s = ip.trim();
        String[] parts = s.split("\\.");
        if (parts.length != 4) return false;
        try {
            int a = Integer.parseInt(parts[0]);
            int b = Integer.parseInt(parts[1]);
            return a == 198 && (b == 18 || b == 19);
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 纯 Java 网络出口风险分类器（主机单测与真机共用）。 */
    public static Report classify(
            boolean connected,
            boolean wifi,
            boolean cellular,
            String vpnIface,
            List<String> vpnAddrs,
            List<String> dnsServers,
            boolean vpnHasDefaultRoute,
            boolean hasV6
    ) {
        if (!connected) {
            return new Report(
                    RISK_OFFLINE, "无可用网络", false, false, false, false, false, "",
                    "网络断开", "当前设备未联网",
                    "请检查手机 Wi-Fi 或移动数据连接，网络恢复后将自动温和唤醒会话。"
            );
        }
        String transport = wifi ? "Wi-Fi" : (cellular ? "移动网络" : "其他网络");
        String iface = vpnIface == null ? "" : vpnIface.trim();

        boolean fakeDns = false;
        if (dnsServers != null) {
            for (String dns : dnsServers) {
                if (isFakeIpAddress(dns)) {
                    fakeDns = true;
                    break;
                }
            }
        }

        boolean hasVpnIface = !iface.isEmpty() || (vpnAddrs != null && !vpnAddrs.isEmpty()) || vpnHasDefaultRoute;
        if (!hasVpnIface && !fakeDns) {
            return new Report(
                    RISK_SAFE_DIRECT, transport, false, false, false, false, hasV6, "",
                    "直连正常", transport + " · 直连无代理" + (hasV6 ? " · 双栈" : " · IPv4"),
                    "当前 QQ / B 站 / 抖音 均走本机直接联网，不存在 TUN 劫持风险。"
            );
        }

        boolean anyTailscaleIp = false;
        boolean anyNonTailscaleVpnIp = false;
        if (vpnAddrs != null) {
            for (String addr : vpnAddrs) {
                if (addr == null || addr.trim().isEmpty()) continue;
                if (addr.contains(":")) {
                    if (addr.toLowerCase(Locale.ROOT).startsWith("fd7a:115c:")) {
                        anyTailscaleIp = true;
                    } else {
                        anyNonTailscaleVpnIp = true;
                    }
                } else if (isTailscaleCgnatIp(addr)) {
                    anyTailscaleIp = true;
                } else {
                    anyNonTailscaleVpnIp = true;
                }
            }
        }

        boolean tailscaleOnly = anyTailscaleIp && !anyNonTailscaleVpnIp && !vpnHasDefaultRoute && !fakeDns;
        if (tailscaleOnly) {
            return new Report(
                    RISK_TAILSCALE_ONLY, transport, true, true, false, false, hasV6, iface,
                    "组网安全", transport + " · Tailscale 仅内网组网（直连安全）",
                    "检测到 Tailscale 仅接管 100.64.0.0/10 组网网段，未劫持公网默认路由与 DNS，QQ 流量保持直连安全。"
            );
        }

        StringBuilder reason = new StringBuilder();
        if (!iface.isEmpty()) reason.append("接口 ").append(iface);
        if (vpnHasDefaultRoute) reason.append(reason.length() > 0 ? " / " : "").append("接管默认路由");
        if (fakeDns) reason.append(reason.length() > 0 ? " / " : "").append("Fake-IP DNS (198.18.x.x)");
        if (reason.length() == 0) reason.append("VPN/TUN 活跃");

        return new Report(
                RISK_PROXY_HIJACK, transport, true, false, true, fakeDns, hasV6, iface,
                "代理劫持风险", transport + " · 检测到全局代理/TUN (" + reason + ")",
                "全局代理（如 sing-box / Clash TUN）会劫持 QQ MSF 长连接或篡改出口 IP，极易触发 -10003 断连或安全中心踢下线。\n"
                        + "建议在代理分流规则中将本应用（com.whaleonebot）及 *.qq.com / *.tencent.com 设为直连或绕过。"
        );
    }

    /** 生成可一键复制给 sing-box / Clash 的绕行排除规则文本。 */
    public static String bypassRuleSnippet(String packageName) {
        String pkg = (packageName == null || packageName.trim().isEmpty()) ? "com.whaleonebot" : packageName.trim();
        return "# 1) 手机代理软件（sing-box / Clash Meta / Nekobox）建议在「分应用代理」中排除：\n"
                + "#    " + pkg + "\n\n"
                + "# 2) sing-box route.rules 片段：\n"
                + "{\n"
                + "  \"package_name\": [\"" + pkg + "\"],\n"
                + "  \"outbound\": \"direct\"\n"
                + "},\n"
                + "{\n"
                + "  \"domain_suffix\": [\"qq.com\", \"tencent.com\", \"gtimg.com\", \"bilibili.com\", \"douyin.com\"],\n"
                + "  \"outbound\": \"direct\"\n"
                + "}\n\n"
                + "# 3) Clash / Mihomo rules 片段：\n"
                + "#   - PROCESS-NAME," + pkg + ",DIRECT\n"
                + "#   - DOMAIN-SUFFIX,qq.com,DIRECT\n"
                + "#   - DOMAIN-SUFFIX,tencent.com,DIRECT\n";
    }
}
