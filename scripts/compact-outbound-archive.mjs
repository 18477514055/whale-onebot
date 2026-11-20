// 把「机器人原话」归档整理成摘要：按会话按天让模型浓缩 → 写进 digest → **校验后才删原话**。
//
// 用户 2026-11-19 的要求：所有发送都落库，过一段时间用大模型整理，整理完删掉原话、
// 只留浓缩内容 + 时间 + 群聊名称之类关键信息。
//
// 用法：
//   node scripts/compact-outbound-archive.mjs                  # 干跑：只报会整理哪些、会删多少
//   node scripts/compact-outbound-archive.mjs --apply          # 真跑（需要模型凭据）
//   node scripts/compact-outbound-archive.mjs --keep-days 7 --apply
//
// 模型凭据（环境变量，绝不落盘、绝不打印）：
//   WHALE_SUMMARY_ENDPOINT   OpenAI 兼容的 base URL，例如 https://api.deepseek.com/v1
//   WHALE_SUMMARY_MODEL      模型名，例如 deepseek-chat
//   WHALE_SUMMARY_KEY        API Key
//
// 安全线（缺一不可）：
//   ① 只有**成功写进 digest 并读回校验**的那些原话才会被删；
//   ② 删除前把原归档另存为 `<归档>.before-compact-<时间>`；
//   ③ 任何一条摘要失败 ⇒ 整批不删（宁可留着，不丢原话）。
import fs from 'node:fs';
import path from 'node:path';
import { readArchive, flattenSegments } from '../src/archive/outbound-archive.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const value = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = path.resolve(import.meta.dirname, '..');
const archiveFile = path.resolve(value('archive', path.join(root, 'runtime/outbound-archive.jsonl')));
const digestFile = path.resolve(value('digest', path.join(root, 'runtime/outbound-digest.jsonl')));
const namesFile = path.resolve(value('names', path.join(root, 'runtime/chat-names.json')));
const keepDays = Number(value('keep-days', '3'));
const minEntries = Number(value('min-entries', '40'));
const apply = flag('apply');
const DAY = 24 * 60 * 60 * 1000;

/** 读可选的群名映射（拿不到群名时用群号，这是既有事实，不要伪造）。 */
function readChatNames() {
  try {
    const parsed = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/**
 * 选出「够老、可以整理掉」的那些行。按会话+天分组，每组至少 minEntries 条才整理，
 * 免得把两三句话也送去模型（又慢又贵）。
 */
export function planCompaction(rows, { now = Date.now(), keepDays: keep = 3, min = 40 } = {}) {
  const cutoff = now - keep * DAY;
  const groups = new Map();
  for (const row of rows) {
    const at = Number(row.at_ms ?? Date.parse(row.at ?? ''));
    if (!Number.isFinite(at) || at > cutoff) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const key = (row.chat ?? 'unknown') + '|' + day;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const planned = [];
  for (const [key, list] of groups) {
    if (list.length < min) continue;
    const [chat, day] = key.split('|');
    planned.push({
      chat, day,
      rows: list.sort((a, b) => Number(a.at_ms) - Number(b.at_ms)),
      from: list[0].at, to: list[list.length - 1].at,
    });
  }
  return planned.sort((a, b) => (a.from < b.from ? -1 : 1));
}

function promptFor(group, names) {
  const name = names[group.chat] ? names[group.chat] + '（' + group.chat + '）' : group.chat;
  const lines = group.rows.map(r => {
    const t = typeof r.text === 'string' && r.text ? r.text : flattenSegments(r.segments ?? '');
    return (r.at ?? '').slice(11, 19) + ' ' + t;
  });
  return [
    '下面是一个 QQ 机器人在「' + name + '」里 ' + group.day + ' 全天发出的原话（每条前面的时间是时分秒）。',
    '请把它整理成 1–6 条要点：保留说了什么实质内容（观点、结论、做过的事、承诺），',
    '丢掉重复与寒暄；不要编造原话里没有的信息；不要评价；用中文；一行一条，不加序号。',
    '',
    ...lines,
  ].join('\n');
}

async function summarize(group, names) {
  const endpoint = process.env.WHALE_SUMMARY_ENDPOINT;
  const model = process.env.WHALE_SUMMARY_MODEL;
  const key = process.env.WHALE_SUMMARY_KEY;
  if (!endpoint || !model || !key) throw new Error('缺少模型凭据（WHALE_SUMMARY_ENDPOINT / MODEL / KEY）');
  const response = await fetch(endpoint.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: promptFor(group, names) }],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error('模型接口 HTTP ' + response.status);
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回内容');
  return text.trim().split('\n').map(line => line.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean);
}

/** 原子重写归档：先写临时文件再 rename；原来的另存一份，出事能回退。 */
export function rewriteArchive(file, remaining, { stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  fs.copyFileSync(file, file + '.before-compact-' + stamp);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, remaining.map(r => JSON.stringify(r) + '\n').join(''), 'utf8');
  fs.renameSync(tmp, file);
  return file + '.before-compact-' + stamp;
}

async function main() {
  const rows = readArchive(archiveFile);
  const plan = planCompaction(rows, { keepDays, min: minEntries });
  const total = plan.reduce((n, g) => n + g.rows.length, 0);
  console.log('归档 ' + archiveFile);
  console.log('总行数 ' + rows.length + '，计划整理 ' + plan.length + ' 组 / ' + total + ' 条'
    + '（保留最近 ' + keepDays + ' 天，每组至少 ' + minEntries + ' 条）');
  for (const g of plan) console.log('  ' + g.chat + ' ' + g.day + '  ' + g.rows.length + ' 条  ' + g.from + ' → ' + g.to);
  if (!plan.length) { console.log('没有需要整理的（都是新的）。'); return; }
  if (!apply) { console.log('\n干跑结束：加 --apply 才会调模型并删原话。'); return; }

  const names = readChatNames();
  const digests = [];
  for (const group of plan) {
    const points = await summarize(group, names);
    digests.push({
      at: new Date().toISOString(),
      kind: 'outbound-digest',
      chat: group.chat,
      chat_name: names[group.chat] ?? null,
      day: group.day,
      from: group.from,
      to: group.to,
      count: group.rows.length,
      points,
    });
    console.log('已摘要 ' + group.chat + ' ' + group.day + ' → ' + points.length + ' 条要点');
  }

  // ① 先写 digest；② 读回校验；③ 校验通过才删原话。
  fs.mkdirSync(path.dirname(digestFile), { recursive: true });
  fs.appendFileSync(digestFile, digests.map(d => JSON.stringify(d) + '\n').join(''), 'utf8');
  const written = readArchive(digestFile).filter(d => d.kind === 'outbound-digest').length;
  if (written < digests.length) throw new Error('digest 读回校验失败，未删除任何原话');

  const summarized = new Set(plan.flatMap(g => g.rows));
  const remaining = rows.filter(r => !summarized.has(r));
  const backup = rewriteArchive(archiveFile, remaining);
  console.log('已删原话 ' + summarized.size + ' 条；归档剩 ' + remaining.length + ' 条；备份 ' + backup);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
