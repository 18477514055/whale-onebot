// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 把模型写在正文里的「@昵称」变成真正的 at 消息段。
//
// 背景（实测）：OneBot 只有收到 {type:'at', data:{qq}} 段才会真的 @ 到人；
// 正文里写 "@张三" 在 QQ 里只是一串普通文字，对方收不到提醒、也不会变蓝。
// 实测 209 个 session、211 次 send_* 调用里，模型"想 @ 人"的行为有 4 次，
// 其中 2 次是直接把 "@昵称" 写进正文（QQ 里根本没 @ 到），1 次把昵称当成 QQ 号传给了 atUserId。
//
// 所以这里在发送前做一次解析：正文里的 @ 后面若是本会话已知成员的昵称（或已知成员的
// 数字 QQ 号），就换成真正的 at 段；认不出来就原样留着，绝不猜。

/**
 * 解析正文里的 @。
 *
 * @param {string} text 已经过 Markdown 转换的最终纯文本
 * @param {Array<{name:string,userId:string}>} members 本会话成员，**必须按 name 长度倒序**
 *        （store.memberNames 已保证），这样"最长匹配"才会先命中长昵称。
 * @returns {{parts: Array<{type:'text',text:string}|{type:'at',qq:string}>,
 *            resolved: Array<{name:string,userId:string}>,
 *            unresolved: string[]}}
 *   parts   —— 可直接交给 onebot.sendTextParts 的片段序列
 *   resolved —— 成功 @ 到的人（用于日志与留档）
 *   unresolved —— 有 @ 但没认出来的片段（提示模型改法，不阻断发送）
 */
export function resolveMentions(text, members = []) {
  const source = String(text ?? '');
  const list = Array.isArray(members)
    ? members
        .map((m) => ({ name: String(m?.name ?? ''), userId: String(m?.userId ?? '') }))
        .filter((m) => m.name && m.userId)
        .sort((a, b) => b.name.length - a.name.length)
    : [];

  const parts = [];
  const resolved = [];
  const unresolved = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (!buffer) return;
    parts.push({ type: 'text', text: buffer });
    buffer = '';
  };

  // 名字后面的下一个字符是不是"词边界"。用于短昵称（1 个字，本机真实存在一个叫「林」的成员），
  // 否则「@林黛玉」会被切成了「@林 + 黛玉」。长昵称不做这个限制，反而允许「@寒烽你这话」。
  const BOUNDARY = /[\s，。！？、,.!?~：:；;（）()【】\[\]"'“”…—]/;
  const boundaryOk = (rest, nameLen) => {
    if (nameLen >= 2) return true;
    const next = rest[nameLen];
    return next === undefined || BOUNDARY.test(next);
  };

  while (index < source.length) {
    if (source[index] !== '@') {
      buffer += source[index];
      index += 1;
      continue;
    }

    // 邮箱等"@ 前面紧挨着字母数字"的情况不当成点名（a@b.com 不是 @b）。
    const prev = index > 0 ? source[index - 1] : '';
    if (prev && /[A-Za-z0-9._%+-]/.test(prev)) {
      buffer += source[index];
      index += 1;
      continue;
    }

    const rest = source.slice(index + 1);

// Distribution source.
    const digits = /^(\d{5,15})/.exec(rest);
    if (digits) {
      const qq = digits[1];
      if (list.some((m) => m.userId === qq)) {
        flush();
        parts.push({ type: 'at', qq });
        resolved.push({ name: `@${qq}`, userId: qq });
        index += 1 + qq.length;
        continue;
      }
    }

    // ② 昵称最长匹配（list 已按长度倒序，find 命中的就是最长的那个）
    const hit = list.find((m) => rest.startsWith(m.name) && boundaryOk(rest, m.name.length));
    if (hit) {
      flush();
      parts.push({ type: 'at', qq: hit.userId });
      resolved.push({ name: hit.name, userId: hit.userId });
      index += 1 + hit.name.length;
      continue;
    }

    // ③ 认不出来：保留原样，只记下来（供发送结果提示模型）
    const tail = /^([^\s@，。！？、,.!?~]{1,32})/.exec(rest);
    if (tail) unresolved.push(`@${tail[1]}`);
    buffer += source[index];
    index += 1;
  }

  flush();
  if (!parts.length) parts.push({ type: 'text', text: source });
  return { parts, resolved, unresolved: [...new Set(unresolved)] };
}

/**
 * 模型同时"传了 atUserId"又"在正文里写了 @同一个人"时，去掉正文里那一段。
 *
 *
 * "@经验杂多向先验叙事归类的先验统觉机能 逗傻子？" ⇒ QQ 里显示成两个 @。
 * 这里把重复的那个去掉，并把因此留下的行首空格吞掉。
 *
 * @param {Array} parts resolveMentions 的产出
 * @param {string} qq 已经由 atUserId 单独发出去的那个 QQ 号
 */
export function dropDuplicateAt(parts, qq) {
  const target = String(qq ?? '').trim();
  if (!target) return Array.isArray(parts) ? parts : [];
  const kept = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part?.type === 'at' && String(part.qq) === target) continue;
    kept.push(part);
  }
  // 去掉被删掉的 at 留下的行首空白（"@某人 说话" → " 说话" → "说话"）
  if (kept.length && kept[0]?.type === 'text') {
    const trimmed = String(kept[0].text).replace(/^[ \t]+/, '');
    if (trimmed) kept[0] = { type: 'text', text: trimmed };
    else kept.shift();
  }
  return kept.length ? kept : [{ type: 'text', text: '' }];
}
