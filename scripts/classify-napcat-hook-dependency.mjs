#!/usr/bin/env node
// 判定每个 NapCat 动作「要不要 hook」：只读本地探针副本 .tmp/napcat-src（固定 commit 9335843）。
// 判据（可复核）：
//   1) 引用了 PacketApi / pkt. / SendPacket / highway / napi2native / PacketSendAvailableDepends
//      ⇒ 依赖 raw SSO 包（= 依赖 initHook 注入的 send/recv 偏移）⇒ hook-required
//   2) 只调 this.core.apis.* 的 NodeIKernel* 服务方法 ⇒ service-only（不需 hook）
// 输出：evidence/napcat-hook-dependency.json（逐动作）+ 终端摘要。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '.tmp/napcat-src/packages/napcat-onebot/action';
const HOOK_PAT = /PacketApi|\bpkt\.|SendPacket|PacketSendAvailableDepends|[Hh]ighway|napi2native|NTMsgApi\.\w*[Pp]acket/;
const SERVICE_PAT = /this\.core\.apis\.(\w+)\.(\w+)/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

// 动作名 → 文件；一个文件可注册多个 actionName
const actions = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const names = [...src.matchAll(/actionName\s*=\s*ActionName\.(\w+)/g)].map(m => m[1]);
  if (!names.length) continue;
  const hookRefs = [...new Set([...src.matchAll(new RegExp(HOOK_PAT.source, 'g'))].map(m => m[0]))];
  const services = [...new Set([...src.matchAll(SERVICE_PAT)].map(m => `${m[1]}.${m[2]}`))];
  // 继承链也可能带 packet 依赖（Base 类在本文件外）
  const baseClass = (src.match(/class\s+\w+\s+extends\s+(\w+)/) || [])[1] || null;
  for (const name of names) {
    actions.push({
      action: name,
      file: file.replace(/\\/g, '/').replace(/^\.tmp\/napcat-src\//, ''),
      baseClass,
      hookDependency: hookRefs.length ? 'hook-required' : 'service-only',
      hookRefs,
      kernelServices: services,
    });
  }
}

// 继承自 packet 包里的基类（GetPacketStatus 里的 XXXDepends）= hook-required，做一次二轮修正
const packetBases = new Set();
for (const file of walk(path.join(ROOT, 'packet'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/export\s+(?:abstract\s+)?class\s+(\w+)/g)) packetBases.add(m[1]);
}
for (const a of actions) {
  if (a.baseClass && packetBases.has(a.baseClass)) {
    a.hookDependency = 'hook-required';
    a.hookRefs = [...new Set([...a.hookRefs, `extends ${a.baseClass}`])];
  }
}

actions.sort((x, y) => x.action.localeCompare(y.action));
const byKind = actions.reduce((m, a) => ((m[a.hookDependency] = (m[a.hookDependency] || 0) + 1), m), {});
const out = {
  at: new Date().toISOString(),
  source: 'NapCatQQ @9335843246e3b7a17944861f3ac8731a259732c2 (local probe copy)',
  note: 'hook-required = 动作实现走 raw SSO 包，依赖 napi2native initHook(send,recv) 注入的收发函数；service-only = 只用 wrapper.node 暴露的 NodeIKernel* 服务方法。',
  counts: { actions: actions.length, ...byKind },
  actions,
};
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/napcat-hook-dependency.json', JSON.stringify(out, null, 2) + '\n');

console.log('动作总数', actions.length, JSON.stringify(byKind));
const hook = actions.filter(a => a.hookDependency === 'hook-required');
console.log('\n=== hook-required（' + hook.length + '）===');
for (const a of hook) console.log(' ', a.action, '←', a.hookRefs.join(','));
const svc = actions.filter(a => a.hookDependency === 'service-only');
console.log('\n=== service-only（' + svc.length + '）===');
for (const a of svc) console.log(' ', a.action, '←', a.kernelServices.slice(0, 3).join(',') || a.file);
