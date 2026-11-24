// 视频本地落地 → 抽帧：不依赖 ffmpeg 的那一半（路径与文件前置校验）必须是真的在拦。
// 背景（2026-11-23 真机）：QQ 的视频地址带 rkey 会过期，运行端要抽帧只能让协议端把视频
// 原生落到磁盘（get_message_videos），两端同一个容器文件系统，直接读路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const core = await import('../input/agent-app/src/tools/tools-core.js');

test('framesFromLocalVideo 拒绝相对路径与不存在的文件（不猜、不静默）', async () => {
  assert.equal(typeof core.framesFromLocalVideo, 'function');
  await assert.rejects(() => core.framesFromLocalVideo('relative/clip.mp4'), /本地视频路径不合法/);
  await assert.rejects(() => core.framesFromLocalVideo(''), /本地视频路径不合法/);
  const missing = path.join(os.tmpdir(), 'whale-not-a-video-' + process.pid + '.mp4');
  fs.rmSync(missing, { force: true });
  await assert.rejects(() => core.framesFromLocalVideo(missing), /本地视频文件不存在/);
});

test('framesFromLocalVideo 拒绝空文件与超大文件（不会把 0 字节当视频送进 ffmpeg）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-video-'));
  const empty = path.join(dir, 'empty.mp4');
  fs.writeFileSync(empty, Buffer.alloc(0));
  await assert.rejects(() => core.framesFromLocalVideo(empty), /本地视频内容为空/);
  const huge = path.join(dir, 'huge.mp4');
  fs.writeFileSync(huge, Buffer.alloc(65 * 1024 * 1024));
  await assert.rejects(() => core.framesFromLocalVideo(huge), /超过 64MB/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('没有视频落地动作时，媒体兜底只记录原因、不影响图片结果', async () => {
  // 旧协议端没有 get_message_videos：call 直接抛「动作不存在」，不能因此丢掉已取到的图片。
  const calls = [];
  const ctx = {
    signal: undefined,
    onebot: {
      async call(action) {
        calls.push(action);
        if (action === 'get_message_videos') throw new Error('onebot get_message_videos 失败: retcode=1404 动作不存在');
        return [{ type: 'image', data: { file: 'synthetic.jpg', url: 'base64://AAAA' } }];
      },
    },
  };
  const out = await core.retryMediaViaProtocol(ctx, { mid: 12345 }, true).catch((error) => ({ threw: String(error) }));
  assert.equal(out.threw, undefined, '兜底本身不应该抛错');
  assert.deepEqual(calls, ['get_message_images', 'get_message_videos']);
  assert.equal(out.videoCount, 0);
  // 动作不存在属于「这台机型暂时没有」，不该记成用户可见的失败原因。
  assert.deepEqual(out.failed.filter((line) => /视频落地失败/.test(line)), []);
});
