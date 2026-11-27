import com.whaleonebot.ui.QqAuthState;

/**
 * 纯 Java 回归测试：验证 QQ 上下线统一状态真源、离线原因告警判定、腾讯官方 URL 安全白名单与手机 QQ 拉起协议构造。
 */
public final class QqAuthStateTest {

    private static int passed = 0;

    private static void check(boolean cond, String msg) {
        if (!cond) throw new AssertionError("FAIL: " + msg);
        passed++;
    }

    public static void main(String[] args) {
        testOnlineState();
        testOfflineAlertStates();
        testVerifyAndDeepLinkSafety();
        System.out.println("QqAuthStateTest OK (" + passed + " checks passed)");
    }

    private static void testOnlineState() {
        String json = "{\"phase\":\"agent-running\",\"uin\":\"3752609028\",\"canQuickLogin\":true,"
                + "\"needsManualLogin\":false,\"clientVer\":\"3.2.35-54395\",\"hostname\":\"deb-arm64-11223344\","
                + "\"kernelRelease\":\"6.1.0-28-arm64\"}";
        QqAuthState st = QqAuthState.parseBotJson(json);
        check(st.isOnline(), "agent-running with uin is online");
        check(!st.isOfflineAlert(), "online is not offline alert");
        check(st.healthLevel(true) == QqAuthState.LEVEL_ONLINE, "health level online");
        check(st.shortBadge(true).contains("3752609028"), "short badge shows uin");
        check("6.1.0-28-arm64".equals(st.kernelRelease), "kernel release parsed");
    }

    private static void testOfflineAlertStates() {
        QqAuthState expired = QqAuthState.parseBotJson(
                "{\"phase\":\"token-expired\",\"uin\":\"\",\"needsManualLogin\":true,"
                        + "\"offlineReason\":\"token_expired_140022015\",\"offlineMessage\":\"快登令牌已过期\"}");
        check(!expired.isOnline(), "token-expired is offline");
        check(expired.isOfflineAlert(), "token-expired triggers offline alert");
        check(expired.healthLevel(true) == QqAuthState.LEVEL_OFFLINE_ACTION, "level offline action");
        check(expired.shortBadge(true).contains("票据过期"), "badge labels token expired");

        QqAuthState kicked = QqAuthState.parseBotJson(
                "{\"phase\":\"kicked-offline\",\"uin\":\"\",\"offlineReason\":\"kicked_1006501\"}");
        check(kicked.isOfflineAlert(), "kicked-offline triggers alert");
        check(kicked.shortBadge(true).contains("被踢"), "badge labels kicked");

        QqAuthState degraded = QqAuthState.parseBotJson(
                "{\"phase\":\"degraded\",\"uin\":\"3752609028\",\"needsManualLogin\":false}");
        check(!degraded.isOnline(), "degraded is not full online");
        check(degraded.healthLevel(true) == QqAuthState.LEVEL_DEGRADED, "level degraded");
    }

    private static void testVerifyAndDeepLinkSafety() {
        QqAuthState verify = QqAuthState.parseBotJson(
                "{\"phase\":\"verify-required\",\"verifyUrl\":\"https://ssl.captcha.qq.com/cap_union_new_show?sid=99\"}");
        check(verify.hasVerifyChallenge(), "valid https qq verifyUrl accepted");

        QqAuthState phish = QqAuthState.parseBotJson(
                "{\"phase\":\"verify-required\",\"verifyUrl\":\"https://evil.example.com/fake\"}");
        check(!phish.hasVerifyChallenge(), "non-tencent verifyUrl rejected");

        check(QqAuthState.isSafeHttpsTencentUrl("https://txz.qq.com/p?k=yyDjcWEF4pZA4fwPsiHsB8"), "txz.qq.com accepted");
        check(!QqAuthState.isSafeHttpsTencentUrl("http://txz.qq.com/p?k=abc"), "http rejected");
        check(!QqAuthState.isSafeHttpsTencentUrl("javascript:alert(1)"), "javascript scheme rejected");

        String deep = QqAuthState.buildMobileQqDeepLink("https://txz.qq.com/p?k=test123");
        check(deep.startsWith("mqqapi://forward/url?url_prefix="), "mobile qq deeplink generated");
        check(QqAuthState.buildMobileQqDeepLink("https://evil.com/x").isEmpty(), "deeplink refuses evil host");
    }
}
