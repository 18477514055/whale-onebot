// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
/**
 * 自己的动态（self-moments）—— 让机器人**看到自己发过的 QQ 空间说说**。
 *
 * ★ 为什么需要（2026-10-26 用户要求）：
 *   「给模型加一个工具——让她能看到自己发过的动态，或者把动态加进记忆库」
 *
 *   `daily-moments.js` 每天 23:30 自动生成并发布一条说说，记录写在
 *   `data/daily-moments.json` 的 `records[]` 里 —— 但**那份东西从来不进模型的视野**。
 *   后果：群友说「你昨天那条说说挺好笑的」，她一脸茫然；或者反过来，
 *   她把「我打算发」的内容当成「已经发出去了」讲出来。
 *
 * ★ 设计选择：**只读工具，不改默认注入**（与 get_intimacy / get_cross_chat_memory 同一模式）
 *   - 塞进提示词 = 每轮都占 token，而且必然过期；
 *   - 给工具 = 平时零成本，被问到才查，数据必然准确。
 *   ⇒ 默认注入一个字都不加，只在 prompt 里告诉她「有这么个工具」。
 *
 * ★★ 状态语义必须分清（这是本模块最容易做错的地方，务必保留）：
 *   - `published`（有 tid）      → **真的发出去了**，可以说"我发过"。
 *   - `publish-unknown`（无 tid） → 调过发送但结果不明（实测踩到过 `socket hang up`）。
 *                                  **不能说"我发过"，也不能说"我没发"** —— 得说"我写了但不确定有没有发出去"。
 *   - 其它（running / failed / skipped）→ 根本没发，是草稿或放弃。
 *   混为一谈就会让她编造自己没说过的话（这正是记忆污染最危险的那种）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 状态 → 人话。用于给模型看时不能只丢一个英文字段。 */
const STATUS_LABEL = {
  published: '已发布',
  'publish-unknown': '发送结果未知',
  publishing: '正在发布',
  failed: '发布失败',
  skipped: '当天没发（没有合适内容）',
  running: '生成中'
};

const clean = (v, n = 600) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);

/** 上海时区的日期显示（项目里所有时间都是 UTC+8 口径，别在这里引入本地时区漂移）。 */
function shanghaiDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) + 8 * 60 * 60 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 读出全部动态记录（新的在前）。
 * @returns {{records: Array, path: string, ok: boolean, notFound?: boolean, error?: string}}
 */
export function readMomentRecords({ dataDir = '', limit = 90 } = {}) {
  const dir = dataDir || process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');
  const file = path.join(dir, 'daily-moments.json');
  // ★ 区分「文件不存在」和「文件坏了」：
  //   不存在 = 这个功能从没跑过 ⇒ 她**确实**没发过任何动态，应该说"还没发过"；
  //   坏了     = 有数据但读不出来 ⇒ 只能说"读不到"，绝不能顺口说成"我没发过"。
  if (!fs.existsSync(file)) return { records: [], path: file, ok: false, notFound: true, error: '文件不存在' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { records: [], path: file, ok: false, notFound: false, error: `解析失败：${error?.message ?? error}` };
  }
  const all = Array.isArray(raw?.records) ? raw.records : [];
  // records 本身是 unshift 存的（新的在前）；这里再排一次，防止将来改成 push 后顺序翻转。
  const sorted = [...all].sort((a, b) => (Number(b?.startedAt) || 0) - (Number(a?.startedAt) || 0));
  return { records: sorted.slice(0, Math.min(200, Math.max(1, Number(limit) || 90))), path: file, ok: true };
}

/**
 * 只保留"真的可能发出去过"的记录。
 * @param {boolean} includeFailed 是否也带上失败/草稿（默认不带 —— 她不该把草稿当历史讲）
 */
export function publishedMoments({ dataDir = '', limit = 10, includeFailed = false } = {}) {
  const { records, ok, notFound, error } = readMomentRecords({ dataDir, limit: 200 });
  const keep = includeFailed
    ? records.filter((r) => clean(r?.content))
    : records.filter((r) => clean(r?.content) && ['published', 'publish-unknown'].includes(String(r?.status || '')));
  return {
    ok,
    notFound: Boolean(notFound),
    error,
    moments: keep.slice(0, Math.min(50, Math.max(1, Number(limit) || 10))).map((r) => ({
      id: String(r?.id || ''),
      dayKey: String(r?.dayKey || ''),
      content: clean(r?.content),
      status: String(r?.status || ''),
      statusLabel: STATUS_LABEL[String(r?.status || '')] || String(r?.status || '未知'),
      // ★ 只有真有 tid 才算"确实发出去了"。这个字段决定模型能说"我发过"还是只能说"我写了"。
      reallyPosted: Boolean(r?.tid) && String(r?.status) === 'published',
      tid: String(r?.tid || ''),
      reason: clean(r?.reason, 200),
      imageCount: Number(r?.imageCount) || 0,
      startedAt: Number(r?.startedAt) || 0,
      startedAtText: shanghaiDate(r?.startedAt),
      error: clean(r?.error, 200)
    }))
  };
}

/**
 * 渲染成给模型看的文本。
 * ★ 措辞要点：明确区分"已发布"和"发送结果未知"，并提醒别把草稿当历史。
 */
export function formatMomentsForModel({ dataDir = '', limit = 8, includeFailed = false } = {}) {
  const { ok, notFound, error, moments } = publishedMoments({ dataDir, limit, includeFailed });
  if (!ok) {
    // ★ 两种"没有"必须分开说（这里做错她就会谎称自己没发过）：
    if (notFound) return '你还没有发过任何空间动态（一条都没有）。别编自己发过什么。';
    return `读不到自己的动态记录（${error || '未知原因'}）—— 那就别编自己发过什么，也别断言自己没发过。`;
  }
  if (!moments.length) {
    return '你还没有发过任何空间动态（一条已发布的都没有）。别编自己发过什么。';
  }

  const lines = [`你发过的空间动态（共 ${moments.length} 条，新的在上）：`];
  for (const [i, m] of moments.entries()) {
    const when = m.dayKey || m.startedAtText || '日期未知';
    const state = m.reallyPosted
      ? '已发布'
      : (m.status === 'publish-unknown' ? '⚠ 发送结果未知（写了但不确定发出去没有）' : m.statusLabel);
    lines.push(`${i + 1}. [${when}]（${state}）`);
    for (const para of m.content.split('\n')) {
      const t = para.trim();
      if (t) lines.push(`   ${t}`);
    }
    if (m.imageCount > 0) lines.push(`   （配了 ${m.imageCount} 张图）`);
  }
  lines.push('用法：这些是**你自己**写过的内容。别人问起你可以顺着聊、可以吐槽自己以前写得幼稚，但**不要逐字复述整段**；标「发送结果未知」的绝对不能说成"我发过"——只能说"我写过但不确定发出去没有"。');
  return lines.join('\n');
}
