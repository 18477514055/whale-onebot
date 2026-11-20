// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 关键词提取：把"你上次说的那个彩票还在吗"这种整句，抽成能搜到的实体词。
//
// ★ 为什么必须有它（生产里实测踩过，别删）：
//   整句拿去 SQL LIKE **必然 0 命中** —— "你上次说的那个彩票还在吗" 里的字
//   **从不连续出现在聊天记录里**。症状很迷惑：三句完全不同的问句返回同样的两条
//   （看着在工作，其实是"最近两条"兜底生效，等于没搜）。
//   ⇒ 抽不出实体词时返回空串（**不瞎搜**），让上层退化成"最近N条"而不是假装搜到了。

const clean = (v, n = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function extractSearchKeyword(text) {
  const raw = clean(text, 80);
  if (!raw) return { keyword: '', candidates: [] };

  // ① 功能词（这些词在聊天记录里出现得太泛，搜了也是噪声）
  const STOP = /(你|我|他|她|它|们|的|了|吗|呢|么|吧|啊|呀|是|在|有|没|不|就|都|也|还|又|这|那|个|些|什么|怎么|为什么|哪|谁|时候|上次|上回|之前|以前|早先|那次|那天|记得|记不记得|说过|说过吗|说过啥|聊过|聊到|答应|承诺|提过|说的|那个|这个|一下|帮我|给我|请问)/g;
  let s = raw.replace(STOP, ' ');
  // 去掉纯标点与空白
  s = s.replace(/[，。！？、；：""''（）()《》【】\[\]…—\-~@#%&*+=/\\|<>^`]/g, ' ');
  const tokens = s.split(/\s+/).map((x) => x.trim()).filter(Boolean);

  // ② 英文/数字词直接可用；中文取 2~8 字的片段（整段太长时切头）
  const candidates = [];
  for (const tk of tokens) {
    if (/^[A-Za-z0-9]{2,}$/.test(tk)) { candidates.push(tk); continue; }
    const cn = tk.replace(/[^\u4e00-\u9fff]/g, '');
    if (cn.length >= 2 && cn.length <= 12) candidates.push(cn);
    else if (cn.length > 12) candidates.push(cn.slice(0, 8));
  }
  // 去重 + 按长度降序（长词通常更有信息量）
  const uniq = [...new Set(candidates)].filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
  return { keyword: uniq[0] || '', candidates: uniq.slice(0, 3) };
}
