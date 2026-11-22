import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanDraft,
  createCommentGenerator,
  createDmReply,
  createSummarizer,
} from '../input/agent-app/src/features/bili-behavior/comment-generator.mjs';

const quiet = { log: () => {}, warn: () => {} };
const video = { bvid: 'BV1xx411c7mD', title: '神秘的南极水域', author: 'Alan阿伦说', durationSec: 1484, desc: '冰层之下的水域' };
const comments = [{ author: '观众甲', text: '画面太震撼了' }];

describe('B 站评论生成器（离线单测，模型用桩）', () => {
  it('1. cleanDraft 只收敛格式，不改意思', () => {
    assert.equal(cleanDraft('  评论：冰盖底下那一段看得我屏住呼吸  '), '冰盖底下那一段看得我屏住呼吸');
    assert.equal(cleanDraft('"好片，收藏了"'), '好片，收藏了');
    assert.equal(cleanDraft('```\n第一行\n第二行\n```'), '第一行 第二行');
    assert.equal(cleanDraft('「南极的画面永远看不腻」'), '南极的画面永远看不腻');
    assert.equal(cleanDraft(null), '');
    assert.equal(cleanDraft('   '), '');
  });

  it('2. 生成器把视频上下文交给模型，并带上「chat」这个 purpose 与足够的 maxTokens', async () => {
    let seen = null;
    const gen = createCommentGenerator({
      ...quiet, minChars: 15, maxChars: 80,
      chat: async (args) => { seen = args; return { message: { content: ' 冰盖底下那段太震撼，二十五分钟不够看 ' } }; },
    });
    const draft = await gen(video, comments, { replyOnly: false });
    assert.equal(draft.text, '冰盖底下那段太震撼，二十五分钟不够看');
    assert.equal(seen.purpose, 'chat', '短句写作必须标 chat：否则思考会吃光 maxTokens');
    assert.ok(seen.maxTokens >= 800, 'maxTokens 太小会只剩 reasoning_content');
    const user = seen.messages.find((m) => m.role === 'user').content;
    assert.match(user, /神秘的南极水域/);
    assert.match(user, /Alan阿伦说/);
    assert.match(user, /画面太震撼了/);
    const system = seen.messages.find((m) => m.role === 'system').content;
    assert.match(system, /15–80/);
    assert.match(system, /不提问/);
  });

  it('3. 模型返回空正文 / 只有 reasoning 时返回 null（不发空评论）', async () => {
    const empty = createCommentGenerator({ ...quiet, chat: async () => ({ message: { content: '   ' } }) });
    assert.equal(await empty(video, comments, {}), null);
    const noMessage = createCommentGenerator({ ...quiet, chat: async () => ({}) });
    assert.equal(await noMessage(video, comments, {}), null);
  });

  it('4. 模型调用失败不抛给 engine，返回 null 并留一条 warn', async () => {
    const warns = [];
    const gen = createCommentGenerator({
      log: { log: () => {}, warn: (m) => warns.push(String(m)) },
      chat: async () => { throw new Error('模型 API HTTP 500'); },
    });
    assert.equal(await gen(video, comments, {}), null);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /生成评论失败/);
  });

  it('5. replyOnly 时提示模型「要和别人的评论接得上」', async () => {
    let system = '';
    let user = '';
    const gen = createCommentGenerator({
      ...quiet,
      chat: async (args) => {
        system = args.messages[0].content;
        user = args.messages[1].content;
        return { message: { content: '同意楼上，那段水下原片确实太少' } };
      },
    });
    await gen(video, comments, { replyOnly: true });
    assert.match(user, /回复/);
    void system;
  });

  // ★ 这条是补一个真踩过的坑（2026-11-22 16:4x）：`createDmReply` 曾读 `res.content`，
  //   而 chatCompletion 的真实返回是 `{ message: { content } }` ⇒ 每条私信都被当成「模型只给了思考」，
  //   dmReplies 恒 0。**桩必须用真实返回形状**，否则测的就是桩不是实现。
  it('6. 私信回复：按 model 的真实返回形状取正文（message.content），空正文返 null', async () => {
    let seen = null;
    const gen = createDmReply({
      ...quiet, minChars: 2, maxChars: 60,
      chat: async (args) => { seen = args; return { message: { content: ' 在的，你说 ' }, finishReason: 'stop' }; },
    });
    const draft = await gen({ talker: '1680813704', text: '现在在吗', isAdmin: true });
    assert.deepEqual(draft, { text: '在的，你说' });
    assert.equal(seen.purpose, 'chat');
    assert.ok(seen.maxTokens >= 800, 'private 回复与评论同源，maxTokens 小了正文会被思考吃空');
    const user = seen.messages.find((m) => m.role === 'user').content;
    assert.match(user, /现在在吗/);
    assert.match(user, /管理员/, 'admin.uid 命中要按管理员对待');

    const blank = createDmReply({ ...quiet, chat: async () => ({ message: { content: '' }, finishReason: 'stop' }) });
    assert.equal(await blank({ talker: '1', text: 'hi' }), null);

    const boom = createDmReply({ ...quiet, chat: async () => { throw new Error('502'); } });
    assert.equal(await boom({ talker: '1', text: 'hi' }), null, '模型挂了不发，但不许炸整轮');
  });

  it('7. 归纳器：返回摘要字符串；空结果抛错（engine 据此保留原文）', async () => {
    const ok = createSummarizer({ ...quiet, chat: async () => ({ message: { content: '整体是夸画面；争议在时长太短。' } }) });
    assert.equal(await ok([{ author: 'a', text: 't' }], { bvid: 'BV1' }), '整体是夸画面；争议在时长太短。');

    const blank = createSummarizer({ ...quiet, chat: async () => ({ message: { content: '' } }) });
    await assert.rejects(() => blank([{ author: 'a', text: 't' }], {}), /归纳结果为空/);

    const boom = createSummarizer({ ...quiet, chat: async () => { throw new Error('500'); } });
    await assert.rejects(() => boom([], {}), /500/);
  });
});
