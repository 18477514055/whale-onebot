// 纯 Node 的发评论实现（不需要浏览器）。
//
// 为什么要有它：`bili_send_comment` 原来只挂在 `actions/browser.mjs`（`browser:true`），
// 而手机内置环境包**没有 chromium**（891 条目实测）⇒ 手机上这个动作永远不会被注册，
// 调用得到 1404（动作不存在）。2026-11-22 真机实测就卡在这里：待审草稿「通过」了却发不出去。
//
// 边界（与浏览器版并存但不重名冲突）：
//   · 浏览器版仍是首选（能过 B 站的设备指纹与风控）；
//   · 这里只在**没有浏览器**时作为回退，走官方 web 接口 `x/v2/reply/add`（cookie + csrf + wbi）。
//   · 任何失败都如实抛出带 code 的错误，不重试、不假装成功。
export const replyActions = {
  bili_send_comment: {
    params: ['oid', 'message', 'root', 'parent'],
    write: true,
    run: async (ctx, params) => {
      const oid = String(params.oid ?? '').trim();
      const message = String(params.message ?? '');
      if (!/^\d{1,20}$/.test(oid)) throw coded('invalid_oid', 'BAD_REQUEST');
      if (!message.trim() || message.length > 1000) throw coded('invalid_message', 'BAD_REQUEST');
      const form = { oid, type: 1, message, plat: 1 };
      if (params.root) form.root = String(params.root);
      if (params.parent) form.parent = String(params.parent);
      const data = await ctx.request({ url: 'https://api.bilibili.com/x/v2/reply/add', method: 'POST', form, wbi: true });
      const rpid = data?.rpid_str ?? data?.rpid;
      if (rpid === undefined || rpid === null || rpid === '') throw coded('missing_rpid', 'UNKNOWN');
      return {
        rpid: String(rpid),
        oid,
        root: form.root ?? '',
        parent: form.parent ?? '',
        message,
      };
    },
  },
};

function coded(code, outcome) {
  return Object.assign(new Error(`Bilibili reply: ${code}`), { code: `BILI_${code.toUpperCase()}`, outcome, safeError: true });
}
