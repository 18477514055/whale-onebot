import com.whaleonebot.ui.WhitelistModel;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * 纯 JVM 断言：覆盖群列表解析（get_group_list）、群与最近会话合并、群名回补过滤、以及协议能力非敏感摘要。
 */
public final class WhitelistModelTest {

    private WhitelistModelTest() {
    }

    public static void main(String[] args) {
        testParseGroupsAndMerge();
        testFormatReadinessSummaryRedactsSecrets();
        System.out.println("PASS: WhitelistModelTest (all assertions)");
    }

    private static void check(boolean cond, String msg) {
        if (!cond) {
            throw new AssertionError("Assertion failed: " + msg);
        }
    }

    private static void testParseGroupsAndMerge() {
        String groupsJson = "{\"status\":\"ok\",\"retcode\":0,\"data\":["
                + "{\"group_id\":100001,\"group_name\":\"开源核心群\",\"member_count\":42},"
                + "{\"group_id\":100002,\"group_name\":\"测试群二\",\"member_count\":10}"
                + "]}";
        List<WhitelistModel.Chat> groups = WhitelistModel.parseGroups(groupsJson);
        check(groups != null && groups.size() == 2, "parseGroups should return 2 groups");
        check("开源核心群".equals(groups.get(0).name), "first group name should match");

        String knownJson = "{\"status\":\"ok\",\"retcode\":0,\"data\":{\"chats\":["
                + "{\"type\":\"group\",\"id\":\"100002\",\"last\":1700000000,\"count\":9},"
                + "{\"type\":\"group\",\"id\":\"100003\",\"last\":1600000000,\"count\":4}"
                + "]}}";
        List<WhitelistModel.Chat> known = WhitelistModel.parse(knownJson, WhitelistModel.KIND_GROUP);
        List<WhitelistModel.Chat> merged = WhitelistModel.mergeSources(groups, known);
        check(merged != null && merged.size() == 3, "merged group list should include all 3 unique groups");
        check("100001".equals(merged.get(0).id) && "开源核心群".equals(merged.get(0).name), "primary group preserved");
        check("100002".equals(merged.get(1).id) && merged.get(1).count == 9, "overlapping group inherits known count");
        check("100003".equals(merged.get(2).id) && merged.get(2).name == null, "extra known group preserved without name");

        // groupsRequest 只向缺少群名的条目（100003）查询，不再重复查已知群名
        String req = WhitelistModel.groupsRequest(merged);
        check(req.contains("\"100003\"") && !req.contains("\"100001\""), "only unnamed groups queried via get_chat_names");

        Map<String, String> names = WhitelistModel.parseNames("{\"data\":{\"names\":{\"100003\":\"新补充群名\"}}}");
        List<WhitelistModel.Chat> finalList = WhitelistModel.withNames(merged, names);
        check("新补充群名".equals(finalList.get(2).name), "withNames fills missing group name");
    }

    private static void testFormatReadinessSummaryRedactsSecrets() {
        String raw = "{\"status\":\"ok\",\"retcode\":0,\"data\":{\"supportedCount\":92,"
                + "\"webAuthReady\":true,\"qzoneReady\":true,\"ocrReady\":true,\"fileUploadReady\":true,"
                + "\"secretLeakGuard\":\"DO_NOT_SHOW\"}}";
        String summary = WhitelistModel.formatReadinessSummary(raw);
        check(summary.contains("可用 92 项"), "summary includes supportedCount");
        check(summary.contains("Web鉴权") && summary.contains("Qzone") || summary.contains("说说"), "summary includes web/qzone readiness");
        check(!summary.contains("DO_NOT_SHOW"), "summary never leaks unrelated fields");
        check(WhitelistModel.formatReadinessSummary(null).length() > 0, "null readiness returns safe fallback");
    }
}
