// 「@别人」处理口径（用户 2026-11-22 澄清）：
//   · 插嘴不是不行 —— 不在这里把话堵死；
//   · 怕的是**把"叫别人"当成"叫我"**、以及**把别人的经历当成自己的** ⇒ 靠标签与诚实边界治。
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.QQ_BOT_UIN = process.env.QQ_BOT_UIN || '100000001';
process.env.QQ_OWNER_UIN = process.env.QQ_OWNER_UIN || '100000002';

const { resolveContextTier, buildTriggerBlock, buildSystemPrompt } = await import('../input/agent-app/src/llm/prompt.js');

const cfg = (over = {}) => ({
  atCount: 1, keywordCount: 2, randomCount: 3, allCount: 4,
  randomPercent: 100, keywords: [], ...over,
});
const SELF = { selfId: '100000001', selfNickname: '小鲸', botName: '小鲸' };

test('@了别人不算"被艾特"：不会跳到必回档', () => {
  const r = resolveContextTier({
    triggerEntries: [{ text: '@同事 你看这个', mentionsSelf: false, mentionsOther: true }],
    ...SELF, cfg: cfg({ randomPercent: 0 }), roll: 1,
  });
  assert.equal(r.shouldRespond, false);
  assert.equal(r.reason, '未触发');
});

test('@了别人也允许插嘴：全部响应档照常开口', () => {
  const r = resolveContextTier({
    triggerEntries: [{ text: '@同事 你看这个', mentionsSelf: false, mentionsOther: true }],
    ...SELF, cfg: cfg({ randomPercent: 100 }), roll: 1,
  });
  assert.equal(r.shouldRespond, true);
  assert.equal(r.reason, '全部响应');
});

test('被 @ 自己时仍是必回档', () => {
  const r = resolveContextTier({
    triggerEntries: [{ text: '@小鲸 你说呢', mentionsSelf: true, mentionsOther: false }],
    ...SELF, cfg: cfg({ randomPercent: 0 }), roll: 1,
  });
  assert.equal(r.reason, '被艾特');
  assert.equal(r.shouldRespond, true);
});

test('逐行标签把三种 @ 分开，并明确"不是你"', () => {
  const ctx = { ...SELF, persona: { botName: '小鲸' }, selfNickname: '小鲸' };
  const mine = buildTriggerBlock([{ senderName: '甲', text: '@小鲸 你好', mentionsSelf: true }], ctx);
  const other = buildTriggerBlock([{ senderName: '甲', text: '@同事 你好', mentionsOther: true }], ctx);
  const all = buildTriggerBlock([{ senderName: '甲', text: '@全体成员 开会', mentionsOther: false }], ctx);
  assert.ok(mine.includes('@我'));
  assert.ok(other.includes('艾特别人·不是你'), '叫别人必须写清楚"不是你"');
  assert.ok(all.includes('艾特全体'));
  assert.ok(!other.includes('@我'));
});

test('批次级提醒：这一批里有 @ 别人时明确说"被叫的不是你"', () => {
  const ctx = { ...SELF, persona: { botName: '小鲸' }, selfNickname: '小鲸' };
  const withOther = buildTriggerBlock([{ senderName: '甲', text: '@同事 你好', mentionsOther: true }], ctx);
  const plain = buildTriggerBlock([{ senderName: '甲', text: '今天吃什么', mentionsOther: false }], ctx);
  assert.ok(withOther.includes('被叫的不是你'));
  assert.ok(!plain.includes('被叫的不是你'), '没人被叫时不该刷这句话');
});

test('诚实边界里写明：别把别人的经历当成自己的', () => {
  const text = buildSystemPrompt({ selfNickname: '小鲸', persona: { botName: '小鲸' } });
  const body = typeof text === 'string' ? text : JSON.stringify(text);
  assert.ok(body.includes('被叫的**不是你**'), '要有"被叫的不是你"的约束');
  assert.ok(body.includes('别人的经历是别人的'), '要有"别人的经历不是我的"的约束');
});
