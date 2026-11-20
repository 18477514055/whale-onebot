package com.whaleonebot.ui;

/** Proof is per binding; navigation, scanning and a running process cannot substitute for account identity. */
final class BiliPlatformState {
    static boolean verified(String state,String expected,String actual){return "verified".equals(state)&&expected!=null&&!expected.isEmpty()&&expected.equals(actual);}
    static boolean useSaved(boolean stored,String state){return stored && !"reauth_required".equals(state) && !"session_expired".equals(state) && !"identity_mismatch".equals(state);}
    static String label(String state,String expected,String actual){
        if(verified(state,expected,actual))return "账号授权：已验证";
        if(state==null)return "协议端：暂无可验证状态";
        switch(state){
            case "verified": case "identity_mismatch":return "账号不匹配，未连接。请使用配置的本人 UID 授权。";
            case "waiting":case "awaiting_confirmation":return "等待本人在官方页面确认授权";
            case "scanned":return "已扫码，等待本人确认";
            case "starting":case "approved":return "正在核验 B 站账号";
            case "reauth_required":case "session_expired":return "需要重新登录，请手动授权";
            case "network_error":case "network_unavailable":return "网络暂不可用，稍后重试快速登录";
            case "expired":return "本次授权已过期，可手动重新发起";
            case "cancelled":case "stopped":return "协议端已停止";
            case "authorization_failed":return "官方授权未完成，尚未连接。请重新发起；若再次失败，请核对账号和网络。";
            case "invalid_configuration":return "绑定配置无效，请核对本人 UID 和私信对端后重试。";
            case "authorization_required":return "尚未授权，请手动发起网页登录";
            case "runtime_missing":return "缺少 B 站协议端或兼容的运行环境";
            case "container_required":return "本地容器未就绪";case "peer_required":return "请在配置中指定获准的私信对端";
            case "failed":return "授权或启动失败，请检查配置后手动重试";
            case "disconnected":return "连接已断开，当前未通过核验";
            default:return "协议端：暂无可验证状态";
        }
    }
}
