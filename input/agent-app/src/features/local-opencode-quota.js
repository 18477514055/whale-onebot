// [LOCAL-ONLY] ============================================================
// ★ 这是**我们自己写的模块**，不属于作者仓库。
//   · 作者升级时会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// [LOCAL-ONLY] ============================================================
// OpenCode Go 额度查询（作者的成本估算是"按 token 单价×倍数"的通用算法，
// 但 Go 的真实约束是**订阅额度百分比**：rolling 5 小时 / weekly / monthly 三条闸门。
// 只看作者那套估算，会出现"显示花了 $24，其实额度已经用掉 90%"这种误判。）
//
// ★ 端点（本机实测 2026-10-29，返回 200）：
//     GET https://opencode.ai/inference/go/v1/usage
//     Authorization: Bearer <同一个 Go key>
//   返回：
//     { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
//   percent 是 0~100 的整数（四舍五入），status 目前只见到 "ok"。
//   ★ 注意路径：是 /inference/go/v1/usage（**不是** /inference/go/openai/v1/usage，那个 404）。
//
// ★ 为什么不做缓存：这个接口很轻（一个 GET、约 20ms），而额度是"随时可能变"的东西，
//   缓存只会让用户看到过期数字。控制台按需拉即可。

const USAGE_PATH = '/inference/go/v1/usage';
const TIMEOUT_MS = 12000;

/** 是不是 OpenCode 的地址（与 llm.js 的 authHeaders 同一套判定）。 */
export function isOpencodeBaseUrl(url) {
  return /opencode\.ai/i.test(String(url || ''));
}

/**
 * 查 OpenCode Go 的额度。**不做任何写入**，只发一个 GET。
 *
 * @param {{ baseUrl?: string, apiKey?: string }} options
 * @returns {Promise<{ ok: boolean, supported: boolean, error?: string,
 *   buckets?: Record<string, {percent:number,status:string,resetsAt:string,resetInMs:number}>,
 *   plan?: string, fetchedAt: number }>}
 */
export async function fetchOpencodeUsage({ baseUrl = '', apiKey = '' } = {}) {
  const now = Date.now();
  if (!isOpencodeBaseUrl(baseUrl)) {
    return { ok: false, supported: false, error: '当前渠道不是 OpenCode，不需要查 Go 额度', fetchedAt: now };
  }
  if (!String(apiKey || '').trim()) {
    return { ok: false, supported: true, error: '没有可用的 API Key（Key 由服务端解析，不会下发到浏览器）', fetchedAt: now };
  }

  // baseUrl 可能是 /inference/go/openai/v1（我们当前的接入形态），也可能是别的变体：
  // 一律回退到 origin 再拼固定路径 —— 免得把 openai/v1 带到 usage 路径上（那会 404）。
  let origin = 'https://opencode.ai';
  try { origin = new URL(String(baseUrl)).origin; } catch { /* 用默认 */ }
  const url = origin + USAGE_PATH;

  const headers = {
    authorization: `Bearer ${apiKey}`,
    'user-agent': 'qq-agent/0.3',
    // 与推理请求用同一个会话头，避免被当成"来源不明的流量"
    'x-opencode-session': `qqagent-usage-${process.pid}`
  };

  let res;
  // ★ 一次短重试（2026-10-29 实测踩到）：偶发 `fetch failed` 会让整张卡片变红，
  //   而额度这种东西晚 1 秒拿到没有任何影响 —— 所以重试一次比报错更合适。
  //   只在**网络层失败**时重试；HTTP 4xx/5xx 不重试（那是明确的答案，重试没意义）。
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      lastErr = null;
      break;
    } catch (error) {
      lastErr = error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (!res) {
    const msg = lastErr?.name === 'TimeoutError'
      ? `查询超时（${TIMEOUT_MS}ms）`
      : `网络错误：${lastErr?.message ?? lastErr}`;
    return { ok: false, supported: true, error: msg, fetchedAt: now };
  }

  let body = {};
  const text = await res.text().catch(() => '');
  try { body = JSON.parse(text); } catch { /* 非 JSON，下面按状态码判 */ }

  if (!res.ok) {
    // 401/403 说明 Key 不对；404 说明这个账号/端点不支持（比如还没订阅 Go）
    const hint = res.status === 401 || res.status === 403
      ? 'Key 无效或没有权限'
      : res.status === 404
        ? '这个账号没有 Go 订阅，或端点不适用'
        : `HTTP ${res.status}`;
    return {
      ok: false, supported: true, error: hint,
      httpStatus: res.status,
      detail: String(text).replace(/Bearer\s+\S+/g, '[REDACTED]').slice(0, 200),
      fetchedAt: now
    };
  }

  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') {
    return { ok: false, supported: true, error: '响应里没有 usage 字段', fetchedAt: now };
  }

  // 归一成固定三个桶（顺序也是 UI 展示顺序：越短周期越先看）
  const ORDER = ['rolling', 'weekly', 'monthly'];
  const LABEL = { rolling: '5 小时', weekly: '本周', monthly: '本月' };
  const buckets = {};
  for (const key of ORDER) {
    const b = usage[key];
    if (!b || typeof b !== 'object') continue;
    const percent = Number(b.percent);
    const resetsAt = String(b.resetsAt || '');
    let resetInMs = 0;
    if (resetsAt) {
      const t = Date.parse(resetsAt);
      if (Number.isFinite(t)) resetInMs = Math.max(0, t - now);
    }
    buckets[key] = {
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
      status: String(b.status || 'unknown'),
      resetsAt,
      resetInMs,
      label: LABEL[key] || key
    };
  }
  if (!Object.keys(buckets).length) {
    return { ok: false, supported: true, error: '响应里的额度桶全为空', fetchedAt: now };
  }

  return { ok: true, supported: true, buckets, order: ORDER, fetchedAt: now };
}

/** 把 0~100 的百分比说成人话（给 UI 直接用，前后端口径一致）。 */
export function describeUsagePercent(percent) {
  const p = Number(percent) || 0;
  if (p >= 95) return '快满了';
  if (p >= 80) return '偏高';
  if (p >= 50) return '过半';
  return '充裕';
}
