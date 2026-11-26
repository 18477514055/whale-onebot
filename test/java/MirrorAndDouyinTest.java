import com.whaleonebot.douyin.mobile.Desk;
import com.whaleonebot.net.MirrorFetch;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 纯 Java 逻辑回归测试：验证统一无 VPN 国内镜像路由（MirrorFetch）与抖音审核台（Desk）。
 */
public final class MirrorAndDouyinTest {

    private static int passed = 0;

    private static void check(boolean cond, String msg) {
        if (!cond) throw new AssertionError("FAIL: " + msg);
        passed++;
    }

    public static void main(String[] args) {
        testMirrorDefaultsAndRawRewrite();
        testMirrorStoreAndBackoff();
        testDouyinDeskFlow();
        System.out.println("MirrorAndDouyinTest OK (" + passed + " checks passed)");
    }

    private static void testMirrorDefaultsAndRawRewrite() {
        MirrorFetch.resetForTest();
        String[] mirrors = MirrorFetch.mirrorPrefixes();
        check(mirrors.length >= 6, "default mirror pool has >=6 nodes");
        for (String m : mirrors) {
            check(!m.contains("ghproxy.net"), "dead ghproxy.net removed");
        }
        check(MirrorFetch.isMirrorHost("gh-proxy.com"), "gh-proxy.com whitelisted");
        check(MirrorFetch.isMirrorHost("gh-proxy.org"), "gh-proxy.org whitelisted");
        check(MirrorFetch.isMirrorHost("cdn.jsdelivr.net"), "jsdelivr whitelisted");
        check(!MirrorFetch.isMirrorHost("evil.example.com"), "unknown host rejected");

        List<String> rawCands = MirrorFetch.candidateUrls(MirrorFetch.APP_RELEASES_RAW_URL);
        check(rawCands.size() >= 9, "raw url expands to official + jsDelivr + mirrors");
        check(rawCands.contains("https://cdn.jsdelivr.net/gh/18477514055/whale-onebot@main/runtime-index/app-releases.json"),
                "raw url rewrites to cdn.jsdelivr.net");
        check(rawCands.contains("https://fastly.jsdelivr.net/gh/18477514055/whale-onebot@main/runtime-index/app-releases.json"),
                "raw url rewrites to fastly.jsdelivr.net");
    }

    private static void testMirrorStoreAndBackoff() {
        MirrorFetch.resetForTest();
        final Map<String, String> mem = new HashMap<String, String>();
        MirrorFetch.attachStore(new MirrorFetch.Store() {
            @Override
            public String read(String key, String def) {
                return mem.containsKey(key) ? mem.get(key) : def;
            }

            @Override
            public void write(String key, String value) {
                mem.put(key, value);
            }
        });

        List<String> saved = MirrorFetch.setCustomPrefixesFromText("https://custom.mirror.cn\nftp://bad.host\nhttps://m2.cn/");
        check(saved.size() == 2, "only valid http(s) custom prefixes saved");
        check("https://custom.mirror.cn/".equals(saved.get(0)), "trailing slash normalized");
        check(MirrorFetch.isMirrorHost("custom.mirror.cn"), "custom mirror host whitelisted");

        MirrorFetch.recordSuccessPrefix("https://ghfast.top/");
        check("https://ghfast.top/".equals(MirrorFetch.preferredPrefix()), "preferred prefix persisted");

        // 正常状态官方排第一；标记官方失败后，自定义与国内镜像排前面、官方退到末尾
        String asset = "https://github.com/18477514055/whale-onebot/releases/download/v1.2.7/whale.apk";
        List<String> before = MirrorFetch.candidateUrls(asset);
        check(asset.equals(before.get(0)), "official tried first before backoff");
        check(("https://custom.mirror.cn/" + asset).equals(before.get(1)), "custom mirror right after official");

        MirrorFetch.markOfficialFailed();
        check(MirrorFetch.isOfficialBackedOff(), "official backed off after failure");
        List<String> after = MirrorFetch.candidateUrls(asset);
        check(("https://custom.mirror.cn/" + asset).equals(after.get(0)), "custom mirror promoted to #1 during backoff");
        check(asset.equals(after.get(after.size() - 1)), "official demoted to last fallback during backoff");
    }

    private static void testDouyinDeskFlow() {
        final long[] now = {1000L};
        Desk desk = new Desk(() -> now[0]);
        Desk.Slot slot = desk.bind("bot-dy-1", "dy-acc-1");
        check(desk.current(slot), "slot bound");
        Desk.Request req = desk.issue(slot, "req-1", "comment", "video-123", "写一条友好评论", 5000L);
        check(desk.pending(slot) == req, "request pending");
        check(desk.decide(slot, req, true), "owner approves request");
        check(desk.await(req), "await returns true once approved");
        check(desk.pending(slot) == null, "cleared after consume");

        check("https://v.douyin.com/abc123/".equals(Desk.candidate("看这个视频 https://v.douyin.com/abc123/ 哈哈")),
                "valid douyin share link extracted");
        check(Desk.candidate("https://evil.com/video/1") == null, "non-douyin url rejected");
    }
}
