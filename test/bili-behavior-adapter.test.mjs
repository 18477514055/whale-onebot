import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBiliAdapter } from '../input/agent-app/src/features/bili-behavior/adapter.mjs';
import { recommendActions } from '../src/platforms/bilibili/actions/community.mjs';
import { startBiliService } from '../src/platforms/bilibili/service.mjs';

function createFakeCall(handler) {
  const calls = [];
  const call = async (action, params) => {
    calls.push({ action, params });
    return handler(action, params, calls.length);
  };
  return { call, calls };
}

describe('B 站行为层适配层（离线单测）', () => {
  it('1. 7 个抽象方法 + videoInfo 各自映射到正确的真实动作名与参数', async () => {
    const { call, calls } = createFakeCall(async (action) => {
      switch (action) {
        case 'bili_video_info':
          return {
            aid: 10086,
            bvid: 'BV1xx411c7mD',
            title: '测试视频',
            owner: { mid: 42, name: 'UP主' },
            duration: 185,
            desc: '视频简介',
          };
        case 'bili_recommend':
          return {
            videos: [
              { bvid: 'BV1aa1111111', title: '推荐1', authorId: '1', author: 'A', durationSec: 60, desc: 'd1', partition: 'tech' },
            ],
          };
        case 'bili_dynamic_feed':
          return {
            items: [
              {
                modules: {
                  module_author: { mid: 88, name: '关注UP' },
                  module_dynamic: {
                    major: {
                      archive: { bvid: 'BV1bb2222222', title: '动态视频', desc: 'd2', duration_text: '02:30' },
                    },
                  },
                },
              },
            ],
          };
        case 'bili_search':
          return {
            data: {
              result: [
                {
                  result_type: 'video',
                  data: [
                    { bvid: 'BV1cc3333333', title: '搜索视频', author: 'S', mid: 99, duration: '01:15', description: 'd3', typename: '知识' },
                  ],
                },
              ],
            },
          };
        case 'bili_favorite_folders':
          return { data: { list: [{ id: 777, title: '默认收藏夹' }] } };
        case 'bili_favorite_items':
          return { data: { medias: [{ bvid: 'BV1dd4444444', title: '收藏视频', upper: { mid: 55, name: 'FavUP' }, duration: 90, intro: 'd4' }] } };
        case 'bili_comments':
          return {
            data: {
              replies: [
                { rpid_str: '123456', content: { message: '热评' }, member: { uname: '路人', mid: 33 }, like: 10, ctime: 1700000000, parent: 0 },
              ],
            },
          };
        case 'bili_send_comment':
          return { rpid: '999888777' };
        case 'bili_comment_replies':
          return {
            data: {
              replies: [
                { rpid_str: '654321', content: { message: '楼中楼' }, member: { uname: '回复者', mid: 44 }, ctime: 1700000010 },
              ],
            },
          };
        default:
          throw new Error(`Unexpected action: ${action}`);
      }
    });

    const warnings = [];
    const adapter = createBiliAdapter({
      call,
      selfUid: '12345',
      logger: { warn: (m) => warnings.push(m) },
    });

    const rec = await adapter.recommend({ partition: 'tech', count: 5 });
    assert.equal(rec.videos.length, 1);
    assert.equal(rec.videos[0].bvid, 'BV1aa1111111');

    const feed = await adapter.followFeed({ count: 3 });
    assert.equal(feed.videos.length, 1);
    assert.equal(feed.videos[0].durationSec, 150);
    assert.equal(feed.videos[0].authorId, '88');
    assert.equal(warnings.length, 0);

    const sr = await adapter.search({ keyword: 'Nodejs', count: 5 });
    assert.equal(sr.videos.length, 1);
    assert.equal(sr.videos[0].durationSec, 75);

    const fav = await adapter.favorites({ count: 4 });
    assert.equal(fav.videos.length, 1);
    assert.equal(fav.videos[0].author, 'FavUP');

    const cmts = await adapter.comments({ bvid: 'BV1xx411c7mD', count: 10, order: 'hot' });
    assert.equal(cmts.comments.length, 1);
    assert.equal(cmts.comments[0].rpid, '123456');
    assert.equal(cmts.comments[0].parentRpid, '');

    const sent = await adapter.sendComment({
      bvid: 'BV1xx411c7mD',
      text: '写得不错',
      rootRpid: '123456',
      parentRpid: '123456',
    });
    assert.deepEqual(sent, { ok: true, rpid: '999888777' });

    const rep = await adapter.replyList({ bvid: 'BV1xx411c7mD', rootRpid: '123456', count: 5 });
    assert.equal(rep.replies.length, 1);
    assert.equal(rep.replies[0].rpid, '654321');

    assert.deepEqual(
      calls.map((c) => c.action),
      [
        'bili_recommend',
        'bili_dynamic_feed',
        'bili_search',
        'bili_favorite_folders',
        'bili_favorite_items',
        'bili_video_info',
        'bili_comments',
        'bili_send_comment',
        'bili_comment_replies',
      ]
    );
    assert.deepEqual(calls[0].params, { partition: 'tech', count: 5 });
    // ★ 真机实测（23049RAD8C）：offset:'' / offset:'0' 都被判 1400，只有**省略 offset** 才拿到首页。
    assert.deepEqual(calls[1].params, { host_mid: '12345' });
    assert.deepEqual(calls[2].params, { keyword: 'Nodejs', page: 1 });
    assert.deepEqual(calls[3].params, { mid: '12345' });
    assert.deepEqual(calls[4].params, { media_id: 777, pn: 1, ps: 4 });
    assert.deepEqual(calls[5].params, { bvid: 'BV1xx411c7mD' });
    assert.deepEqual(calls[6].params, { aid: '10086', mode: 3, offset: '' });
    assert.deepEqual(calls[7].params, { oid: '10086', message: '写得不错', root: '123456', parent: '123456' });
    assert.deepEqual(calls[8].params, { aid: '10086', root: '123456', pn: 1, ps: 5 });
  });

  it('1b. followFeed 无 selfUid 时 host_mid 用 0 并记 warn；search 大于 20 条按分页换算', async () => {
    const warnings = [];
    const { call, calls } = createFakeCall(async (action, params) => {
      if (action === 'bili_dynamic_feed') return { items: [] };
      if (action === 'bili_search') {
        const start = (params.page - 1) * 20;
        const size = params.page === 1 ? 20 : 10;
        return Array.from({ length: size }, (_, i) => ({
          bvid: `BV1page${params.page}_${start + i}`,
          title: `V${start + i}`,
          author: 'A',
          mid: 1,
          duration: 10,
        }));
      }
      return {};
    });

    const adapter = createBiliAdapter({ call, logger: { warn: (m) => warnings.push(m) } });
    await adapter.followFeed({ count: 5 });
    assert.equal(calls[0].params.host_mid, 0);
    assert.equal(warnings.length, 1);

    const sr = await adapter.search({ keyword: 'test', count: 25 });
    assert.equal(sr.videos.length, 25);
    assert.deepEqual(
      calls.slice(1).map((c) => c.params),
      [
        { keyword: 'test', page: 1 },
        { keyword: 'test', page: 2 },
      ]
    );
  });

  it('2. bvid→aid 只查一次（第二次命中缓存）', async () => {
    let infoCalls = 0;
    const { call } = createFakeCall(async (action) => {
      if (action === 'bili_video_info') {
        infoCalls += 1;
        return { aid: 556677, bvid: 'BV1cache00001', title: 'T', owner: { mid: 1, name: 'U' }, duration: 30, desc: '' };
      }
      if (action === 'bili_comments') return { replies: [] };
      if (action === 'bili_comment_replies') return { replies: [] };
      if (action === 'bili_send_comment') return { rpid: '101' };
      return {};
    });

    const adapter = createBiliAdapter({ call });
    const info1 = await adapter.videoInfo({ bvid: 'BV1cache00001' });
    const info2 = await adapter.videoInfo({ bvid: 'BV1cache00001' });
    await adapter.comments({ bvid: 'BV1cache00001', count: 5, order: 'hot' });
    await adapter.replyList({ bvid: 'BV1cache00001', rootRpid: '999', count: 5 });
    await adapter.sendComment({ bvid: 'BV1cache00001', text: 'hello' });

    assert.equal(infoCalls, 1);
    assert.equal(info1.aid, '556677');
    assert.strictEqual(info1, info2);
  });

  it('3. rpid 返回字符串且大于 2^53 的 64 位整数不丢精度', async () => {
    const hugeRpid = '9007199254740993123'; // > Number.MAX_SAFE_INTEGER (9007199254740991)
    const hugeParent = '9007199254740999876';
    const { call } = createFakeCall(async (action) => {
      if (action === 'bili_video_info') return { aid: 1, bvid: 'BV1rpid000001' };
      if (action === 'bili_comments') {
        return {
          data: {
            replies: [
              { rpid_str: hugeRpid, parent_str: hugeParent, content: { message: 'hi' }, member: { uname: 'u', mid: 2 }, like: 1, ctime: 10 },
            ],
          },
        };
      }
      if (action === 'bili_comment_replies') {
        return {
          replies: [{ rpid_str: hugeRpid, content: { message: 'sub' }, member: { uname: 'u2', mid: 3 }, ctime: 11 }],
        };
      }
      if (action === 'bili_send_comment') {
        return { rpid_str: hugeRpid };
      }
      return {};
    });

    const adapter = createBiliAdapter({ call });
    const cmts = await adapter.comments({ bvid: 'BV1rpid000001', count: 5, order: 'hot' });
    assert.equal(typeof cmts.comments[0].rpid, 'string');
    assert.equal(cmts.comments[0].rpid, hugeRpid);
    assert.equal(cmts.comments[0].parentRpid, hugeParent);

    const reps = await adapter.replyList({ bvid: 'BV1rpid000001', rootRpid: hugeRpid, count: 5 });
    assert.equal(typeof reps.replies[0].rpid, 'string');
    assert.equal(reps.replies[0].rpid, hugeRpid);

    const sent = await adapter.sendComment({ bvid: 'BV1rpid000001', text: 'ok' });
    assert.equal(typeof sent.rpid, 'string');
    assert.equal(sent.rpid, hugeRpid);
  });

  it('4. 热门/最新两种 order 映射到不同 mode', async () => {
    const { call, calls } = createFakeCall(async (action) => {
      if (action === 'bili_video_info') return { aid: 42, bvid: 'BV1mode000001' };
      return { replies: [] };
    });

    const adapter = createBiliAdapter({ call });
    await adapter.comments({ bvid: 'BV1mode000001', count: 5, order: 'hot' });
    await adapter.comments({ bvid: 'BV1mode000001', count: 5, order: 'new' });

    const commentCalls = calls.filter((c) => c.action === 'bili_comments');
    assert.equal(commentCalls.length, 2);
    assert.notEqual(commentCalls[0].params.mode, commentCalls[1].params.mode);
    assert.equal(commentCalls[0].params.mode, 3);
    assert.equal(commentCalls[1].params.mode, 2);
  });

  it('5. 协议返回三种不同外形（{data:{list}} / 裸数组 / {data:{replies}}）都能归一出正确条数', async () => {
    let shapeIndex = 0;
    const shapes = [
      { data: { list: [{ rpid_str: '11', text: 'a' }, { rpid_str: '12', text: 'b' }] } },
      [{ rpid_str: '21', text: 'c' }, { rpid_str: '22', text: 'd' }, { rpid_str: '23', text: 'e' }],
      { data: { replies: [{ rpid_str: '31', content: { message: 'f' } }] } },
    ];
    const { call } = createFakeCall(async (action) => {
      if (action === 'bili_video_info') return { aid: 77, bvid: 'BV1shape00001' };
      if (action === 'bili_comments') return shapes[shapeIndex++];
      return {};
    });

    const adapter = createBiliAdapter({ call });
    const r1 = await adapter.comments({ bvid: 'BV1shape00001', count: 10, order: 'hot' });
    const r2 = await adapter.comments({ bvid: 'BV1shape00001', count: 10, order: 'hot' });
    const r3 = await adapter.comments({ bvid: 'BV1shape00001', count: 10, order: 'hot' });

    assert.equal(r1.comments.length, 2);
    assert.equal(r2.comments.length, 3);
    assert.equal(r3.comments.length, 1);
  });

  it('6. 失败时抛出的错误带 action 名与原始 cause', async () => {
    const rootErr = Object.assign(new Error('风控验证'), { code: 'BILI_API_-352', isVerify: true });
    const { call } = createFakeCall(async (action) => {
      if (action === 'bili_video_info') return { aid: 88, bvid: 'BV1err0000001' };
      if (action === 'bili_comments') throw rootErr;
      return {};
    });

    const adapter = createBiliAdapter({ call });
    await assert.rejects(
      () => adapter.comments({ bvid: 'BV1err0000001', count: 5, order: 'hot' }),
      (err) => {
        assert.equal(err.action, 'bili_comments');
        assert.strictEqual(err.cause, rootErr);
        assert.equal(err.isVerify, true);
        assert.equal(err.code, 'BILI_API_-352');
        return true;
      }
    );
  });

  it('7. 协议端新增 bili_recommend 走 WBI 签名并注册进 service 动作表', async () => {
    const requests = [];
    const res = await recommendActions.bili_recommend.run(
      {
        selfId: '100',
        request: async (req) => {
          requests.push(req);
          return {
            item: [
              { bvid: 'BV1rcmd000001', title: 'WBI推荐', owner: { mid: 9, name: 'UP9' }, duration: 120, desc: '简介', tname: '科技' },
              { goto: 'ad', title: '广告无bvid' },
            ],
          };
        },
      },
      { partition: 'tech', count: 5 }
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd');
    assert.equal(requests[0].wbi, true);
    assert.equal(res.videos.length, 1);
    assert.equal(res.videos[0].bvid, 'BV1rcmd000001');

    // 验证 service.mjs 的动作表包含 bili_recommend
    const client = {
      identity: async () => ({ user_id: '123', nickname: 'bot' }),
      messages: async () => [],
      sendText: async () => ({ msg_key: '1' }),
      request: async () => ({
        item: [{ bvid: 'BV1svc0000001', title: 'Service推荐', owner: { mid: 1, name: 'U' }, duration: 60 }],
      }),
    };
    const service = await startBiliService({
      selfId: '123',
      port: 0,
      client,
      token: '0123456789abcdef',
      accountActions: true,
    });
    try {
      const supported = await service.bridge.dispatch({ action: 'get_supported_actions', params: {} });
      assert.ok(supported.data.includes('bili_recommend'));
    } finally {
      await service.close();
    }
  });
});
