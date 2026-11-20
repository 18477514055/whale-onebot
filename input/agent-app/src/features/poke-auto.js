// [LOCAL-ONLY] ============================================================
// ★ 这是**我们自己写的**，作者原仓库从来没有过。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// poke-auto.js —— 被拍时**直接反拍回去**，不经过模型思考。
//
// ★★★ 用户要求（原话，2026-10-29）：
//   「他现在被别人拍的时候是直接回实体消息，而不是反拍回去的，我认为这不好，
//     因为回实体消息的话容易导致他刷屏…而且还会花大量的钱，今天有个群疯狂的拍他，
//     然后他就疯狂的回消息，甚至导致后面开始出错了…
//     最好就是拍回去可以拉高，拍回去的概率也就是被拍一次就反拍回去。但是不要回实体消息。
//     或者如果能够做到的话，把被拍然后反拍回去，这个过程不要经过他的思考，
//     而是直接像固定回复一样，这样也是比较省钱。」
//
// ★★★ 为什么必须放在「固定回复」那个位置而不是提示词里：
//   被拍会触发一轮**完整的模型回合**（写进 prompt、调付费 LLM、可能多轮工具调用）。
//   一天被拍几十次 = 几十次完整推理，这就是"花大量的钱"的来源；
//   而模型回了文字之后，那些文字本身又成了群里的新消息 ⇒ "疯狂回消息"。
//   ⇒ 唯一的根治办法是**在消息进模型之前就把它处理掉并 return**，
//     与 cannedReplies 同一个拦截点（消息已入库 → 直接发 → 不再 onIncoming）。
//
// ★ 三条硬边界（改之前必读）：
//   ① **只处理 eventKind==='poke' 且是拍机器人的**。普通消息一个字都不碰。
//   ② **反拍失败绝不挡路**：任何异常都 return { handled:false }，让消息照常交给模型
//      —— 宁可退回旧行为，也不能让拍一拍变成"消息被吞掉"。
//   ③ **必须限流**：同一群短时间内只反拍一次（见 cooldownMs）。
//      否则一群人连拍会变成"机器人疯狂反拍"，那和刷屏一样糟。

/**
 * @param {object} deps
 * @param {Function} deps.sendPoke  (chatKey, userId) => Promise<void>   真正发拍一拍的函数
 * @param {Function} deps.getConfig () => config
 * @param {Function} [deps.log]
 * @param {Function} [deps.now]     注入时钟，便于测试
 */
export function createPokeAutoReply({ sendPoke, getConfig, log = () => {}, now = () => Date.now() } = {}) {
  // chatKey → 上次反拍时间戳。★ 按群记（不是按人），因为要防的是"这个群被刷屏"。
  const lastAt = new Map();

  const cfgOf = () => {
    try { return getConfig()?.pokeAuto || {}; } catch { return {}; }
  };

  /**
   * 试着自动反拍。返回 { handled:true, poked:userId } 表示"已处理，别再唤醒模型"。
   * 返回 { handled:false, reason } 表示"不管，交给模型照常走"。
   */
  async function maybeAutoPoke({ chatKey, kind, eventKind, senderId, selfId, pokeTargetId } = {}) {
    const cfg = cfgOf();
    // 总开关：默认开（用户明确要求"被拍一次就反拍回去"）
    if (cfg.enabled === false) return { handled: false, reason: 'disabled' };

    // ① 只认 poke 事件
    if (String(eventKind || '') !== 'poke') return { handled: false, reason: 'not-poke' };

    // ② 只认「拍的是机器人」。pokeTargetId 是事件里的被拍对象。
    //    ★ 有些上报不带 target，这时用 selfId 兜底判断不了就放行给模型（宁可不做也不乱拍）。
    const me = String(selfId || '').trim();
    const target = String(pokeTargetId || '').trim();
    if (target && me && target !== me) return { handled: false, reason: 'not-me' };

    // ③ 拍的人必须是个有效 QQ 号（没有就不拍回去）
    const who = String(senderId || '').trim();
    if (!/^\d{4,15}$/.test(who)) return { handled: false, reason: 'no-sender' };
    // 自己拍自己这种别理
    if (who === me) return { handled: false, reason: 'self-poke' };

    // ④ 群/私聊范围
    const key = String(chatKey || '');
    if (!key) return { handled: false, reason: 'no-chat' };
    const inGroup = key.startsWith('group:');
    if (inGroup && cfg.groups === false) return { handled: false, reason: 'group-off' };
    if (!inGroup && cfg.privateChat === false) return { handled: false, reason: 'private-off' };

    // ⑤ 限流：同一个群/会话在冷却期内只反拍一次
    //    ★ 冷却键是 chatKey ⇒ 一群人连拍时，第一下反拍之后就停手（正是用户要的"不要刷屏"）。
    const cooldown = Math.max(0, Number(cfg.cooldownMs) || 0);
    const t = now();
    const prev = lastAt.get(key) || 0;
    if (cooldown > 0 && prev && t - prev < cooldown) {
      return { handled: false, reason: 'cooldown' };
    }

    // ⑥ 真正去拍
    try {
      await sendPoke(key, who);
      lastAt.set(key, t);
      log(`[poke-auto] ${key} 反拍 ${who}（不经过模型）`);
      return { handled: true, poked: who };
    } catch (error) {
      // ★ 失败必须放行给模型：绝不能让"反拍失败"变成"这条消息被吞掉"。
      log(`[poke-auto] 反拍失败，交给模型处理：${error?.message ?? error}`);
      return { handled: false, reason: 'send-failed' };
    }
  }

  /** 供验收与调试：清空冷却（测试用）。 */
  function reset() { lastAt.clear(); }

  /** 供验收与调试：看某会话上次反拍时间。 */
  function lastPokeAt(chatKey) { return lastAt.get(String(chatKey || '')) || 0; }

  return { maybeAutoPoke, reset, lastPokeAt };
}
