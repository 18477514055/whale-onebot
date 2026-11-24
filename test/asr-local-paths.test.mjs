// 本机转写（whisper.cpp）的路径解析：迁移残留的 Termux 老路径不能把功能锁死。
// 2026-11-23 真机事故：设备 config.json 里 asr.localBin / asr.localModel 仍指向
// `/data/data/com.termux/files/home/qqagent/...`（容器里没这个目录），
// 而 `resolveWhisperBin` 的语义是「显式指定了却跑不起来就报错、不偷偷换」，
// 于是语音/视频音轨转文字在手机上**永远是不可用**，用户只看到一句失败。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { asrLocalModel } from '../input/agent-app/src/core/config.js';

const TERMUX = '/data/data/com.termux/files/home/qqagent/data/asr/models/ggml-small.bin';

describe('本机转写路径解析', () => {
  it('1. 配置里的模型文件不存在时不再采信（迁移残留不该锁死功能）', () => {
    const got = asrLocalModel({ asr: { localModel: TERMUX } });
    assert.notEqual(got, TERMUX, '不存在的路径不能被当成"要用的模型"');
    assert.equal(got, '', '本机也没有可用模型时返回空串，让调用方给出装模型的指引');
  });

  it('2. 配置里的模型文件存在时照旧优先用它（不抢用户明确指定的）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'asr-'));
    const file = path.join(dir, 'ggml-tiny.bin');
    try {
      writeFileSync(file, Buffer.alloc(8));
      assert.equal(asrLocalModel({ asr: { localModel: file } }), file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
