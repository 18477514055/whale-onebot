package com.whaleonebot.ui;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;
import android.os.Build;

import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;

/**
 * [layer: shell-android] Android 网络出口检测适配器（纯逻辑由 {@link NetworkRiskLogic} 承担）。
 */
public final class NetworkRiskDetector {

    public static final int RISK_OFFLINE = NetworkRiskLogic.RISK_OFFLINE;
    public static final int RISK_SAFE_DIRECT = NetworkRiskLogic.RISK_SAFE_DIRECT;
    public static final int RISK_TAILSCALE_ONLY = NetworkRiskLogic.RISK_TAILSCALE_ONLY;
    public static final int RISK_PROXY_HIJACK = NetworkRiskLogic.RISK_PROXY_HIJACK;

    private NetworkRiskDetector() {
    }

    public static NetworkRiskLogic.Report inspect(Context ctx) {
        if (ctx == null) {
            return NetworkRiskLogic.classify(false, false, false, "", null, null, false, false);
        }
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) {
                return NetworkRiskLogic.classify(false, false, false, "", null, null, false, false);
            }
            boolean connected = false;
            boolean wifi = false;
            boolean cellular = false;
            boolean hasV6 = false;
            String vpnIface = "";
            boolean vpnDefaultRoute = false;
            List<String> vpnAddrs = new ArrayList<String>();
            List<String> dnsList = new ArrayList<String>();

            if (Build.VERSION.SDK_INT >= 23) {
                Network active = cm.getActiveNetwork();
                NetworkCapabilities anc = active == null ? null : cm.getNetworkCapabilities(active);
                if (anc != null && anc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                    connected = true;
                    wifi = anc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
                    cellular = anc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
                }
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (nc == null) continue;
                    if (nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                        connected = true;
                        if (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifi = true;
                        if (nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) cellular = true;
                    }
                    if (lp != null) {
                        for (LinkAddress la : lp.getLinkAddresses()) {
                            InetAddress ia = la.getAddress();
                            if (ia instanceof Inet6Address && !ia.isLinkLocalAddress() && !ia.isLoopbackAddress()) {
                                hasV6 = true;
                            }
                        }
                        for (InetAddress dns : lp.getDnsServers()) {
                            if (dns != null && dns.getHostAddress() != null) {
                                dnsList.add(dns.getHostAddress());
                            }
                        }
                    }
                    if (nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                        if (lp != null) {
                            if (lp.getInterfaceName() != null && vpnIface.isEmpty()) {
                                vpnIface = lp.getInterfaceName();
                            }
                            for (LinkAddress la : lp.getLinkAddresses()) {
                                if (la.getAddress() != null && la.getAddress().getHostAddress() != null) {
                                    vpnAddrs.add(la.getAddress().getHostAddress());
                                }
                            }
                            for (RouteInfo ri : lp.getRoutes()) {
                                if (ri.isDefaultRoute()) {
                                    vpnDefaultRoute = true;
                                } else if (ri.getDestination() != null && ri.getDestination().getPrefixLength() == 0) {
                                    vpnDefaultRoute = true;
                                }
                            }
                        } else {
                            vpnDefaultRoute = true;
                        }
                    }
                }
            }
            return NetworkRiskLogic.classify(connected, wifi, cellular, vpnIface, vpnAddrs, dnsList, vpnDefaultRoute, hasV6);
        } catch (Throwable ignored) {
            return NetworkRiskLogic.classify(true, false, false, "", null, null, false, false);
        }
    }

    public static String bypassRuleSnippet(String packageName) {
        return NetworkRiskLogic.bypassRuleSnippet(packageName);
    }
}
