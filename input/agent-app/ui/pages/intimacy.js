// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 亲密度管理页（2026-10-29）
//
// ★ 为什么要有这一页：
//   亲密度原来是个"黑盒" —— 分数由五个统计维度算出来，用户只能看结果、看不到来源，
//   也没法知道"我记的那些事件到底有没有生效"。
//   这一页把三套数字并排摊开：**基础分（纯统计）/ 事件影响 / 最终分**，
//   再加一个事件流，让人能看出"这个人的分是为什么高/低"。
//
// ★ 三个交互：
//   ① 全站榜（可按档位筛选）—— 一眼看谁最熟
//   ② 点某个人 → 右侧明细（三套分数 + 五维 + 事件清单）
//   ③ 手工补记事件（模型漏记/记错时人工纠正）
//
// ★ 只读 + 一个写口（补记事件）。不提供"直接改分数"—— 分数必须由事件推出来，
//   否则"分数可解释"这个前提就破了（改分之后没人知道为什么是这个分）。

import { api } from '../core/api.js';
import { esc } from '../core/dom.js';

const state = {
  ready: false,
  rows: [],
  stats: null,
  kinds: {},
  influence: 0.35,
  halfLifeDays: 60,
  scoring: null,        // 打分时机配置
  profiles: null,       // 三档默认值
  gates: [],            // 各群上次提示状态
  selected: '',          // 当前选中的人
  detail: null,
  filterTier: '',        // 空 = 全部
  query: '',             // 搜索 QQ
  // ★ 2026-10-30：心情（双层）—— 用户要求「控制台也可以展现当前心情卡片」
  mood: null,            // /api/local/mood/overview 的返回
  moodMeta: null,        // /api/local/mood/meta
  moodLog: [],           // 最近情绪流水
  moodOpen: true         // 心情卡片是否展开
};

const TIERS = [
  ['', '全部'],
  ['close', '很熟（≥70）'],
  ['warm', '熟（45-69）'],
  ['known', '认识（25-44）'],
  ['met', '见过（10-24）'],
  ['stranger', '陌生（<10）']
];

function tierOf(score) {
  const s = Number(score) || 0;
  if (s >= 70) return 'close';
  if (s >= 45) return 'warm';
  if (s >= 25) return 'known';
  if (s >= 10) return 'met';
  return 'stranger';
}

function fmtTs(ts) {
  const n = Number(ts) || 0;
  if (!n) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 事件影响的可视化：正=绿色向上，负=红色向下，0=灰。 */
function deltaChip(delta) {
  const d = Number(delta) || 0;
  if (!d) return '<span class="muted">—</span>';
  const cls = d > 0 ? 'ok' : 'bad';
  return `<span class="chip ${cls}">${d > 0 ? '+' : ''}${d}</span>`;
}

function toneClass(tone) {
  return tone === 'good' ? 'ok' : tone === 'bad' ? 'bad' : '';
}

async function loadIntimacyPage({ force = false } = {}) {
  const box = document.getElementById('intimacy-page');
  if (!box) return;
  if (state.ready && !force) return;

  box.innerHTML = '<div class="hint" style="padding:24px">正在读取亲密度…</div>';

  const [list, meta] = await Promise.all([
    api('/api/local/intimacy/list?limit=800').catch((e) => ({ ok: false, error: String(e?.message || e) })),
    api('/api/local/intimacy/meta').catch(() => null)
  ]);

  // ★ 2026-10-30：心情三件套（双层 / 权重说明 / 流水）。任一失败都不影响亲密度主体。
  const [mood, moodMeta, moodLog] = await Promise.all([
    api('/api/local/mood/overview').catch(() => null),
    api('/api/local/mood/meta').catch(() => null),
    api('/api/local/mood/log?limit=12').catch(() => null)
  ]);
  state.mood = mood?.ok ? mood : null;
  state.moodMeta = moodMeta?.ok ? moodMeta : null;
  state.moodLog = Array.isArray(moodLog?.rows) ? moodLog.rows : [];

  if (!list?.ok) {
    box.innerHTML = `<div class="hint error" style="padding:24px">读取失败：${esc(list?.error || '接口不可用')}</div>`;
    return;
  }

  state.rows = Array.isArray(list.rows) ? list.rows : [];
  state.stats = list.stats || null;
  if (meta?.ok) {
    state.kinds = meta.kinds || {};
    state.influence = Number(meta.influence) || 0.35;
    state.halfLifeDays = Number(meta.halfLifeDays) || 60;
    state.scoring = meta.scoring || null;
    state.profiles = meta.profiles || null;
    state.gates = Array.isArray(meta.gates) ? meta.gates : [];
  }
  state.ready = true;
  render();
}

function visibleRows() {
  let rows = state.rows;
  if (state.filterTier) rows = rows.filter((r) => tierOf(r.score) === state.filterTier);
  const q = state.query.trim();
  if (q) rows = rows.filter((r) => String(r.uin).includes(q));
  return rows;
}

/**
 * 心情卡片（2026-10-30）
 *
 * ★ 用户要求：「控制台也可以展现当前心情卡片。」
 * ★ 用户还要求双层：「同时被多个群影响、同时反馈到多个群，但每个群又有相对的独立性」
 *   ⇒ 这一页必须把**全局基础**和**各群局部偏移**分开显示，否则看不出双层结构。
 * ★ 归因只显示到群粒度（与提示词口径一致）—— 控制台看得到的信息不能比模型多，
 *   否则模型会说得出它不该知道的东西。
 */
function moodCardHtml() {
  const m = state.mood;
  if (!m) {
    return `
      <div class="mood-card">
        <div class="mood-head"><b>当前心情</b><span class="muted">接口未就绪（可能是进程还没重启）</span></div>
      </div>`;
  }
  const g = m.global || {};
  const scopes = Array.isArray(m.scopes) ? m.scopes : [];
  const w = m.weights || {};

  // 心情/精力档位 → 一句话 + 色块
  const moodTierOf = (v) => (v < 25 ? ['bad', '很不痛快'] : v < 40 ? ['low', '偏低'] : v < 65 ? ['ok', '一般'] : ['good', '不错']);
  const energyTierOf = (v) => (v < 20 ? ['bad', '快没力气'] : v < 40 ? ['warn', '有点累'] : v < 70 ? ['ok', '还行'] : ['good', '精神不错']);
  const [mCls, mTxt] = moodTierOf(Number(g.mood) || 0);
  const [eCls, eTxt] = energyTierOf(Number(g.energy) || 0);

  const bar = (v, cls) => `<div class="mood-bar"><i class="${cls}" style="width:${Math.max(0, Math.min(100, Number(v) || 0))}%"></i></div>`;

  const rows = scopes.length
    ? scopes.map((s) => {
      const l = s.local || {};
      const f = s.final || {};
      const lv = Number(l.mood) || 0;
      const lcls = lv > 1 ? 'good' : lv < -1 ? 'bad' : '';
      const ago = Number(s.updatedAt) ? (() => {
        const min = Math.round((Date.now() - Number(s.updatedAt)) / 60000);
        return min < 1 ? '刚刚' : min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
      })() : '—';
      return `<tr>
        <td><code>${esc(s.scope)}</code></td>
        <td class="r">${Number(f.mood).toFixed(1)}</td>
        <td class="r ${lcls}">${lv > 0 ? '+' : ''}${lv.toFixed(1)}</td>
        <td class="r">${Number(f.energy).toFixed(1)}</td>
        <td class="r muted">${esc(ago)}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="5" class="muted" style="padding:10px">还没有任何群产生过情绪事件（记一条事件后这里就会出现）</td></tr>';

  const logRows = state.moodLog.length
    ? state.moodLog.slice(0, 8).map((l) => {
      const d = Number(l.dMood) || 0;
      const cls = d > 0 ? 'good' : d < 0 ? 'bad' : '';
      const scopeTxt = String(l.scope) === 'global' ? '全局' : String(l.scope);
      const min = Math.round((Date.now() - Number(l.ts)) / 60000);
      const ago = min < 1 ? '刚刚' : min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
      return `<li><span class="muted">${esc(ago)}</span> · <code>${esc(scopeTxt)}</code>
        · ${esc(l.note || l.kind)} <b class="${cls}">${d > 0 ? '+' : ''}${d.toFixed(1)}</b></li>`;
    }).join('')
    : '<li class="muted">还没有情绪流水</li>';

  return `
    <div class="mood-card">
      <div class="mood-head">
        <b>当前心情</b>
        <span class="muted">全局基础 + 各群局部偏移（局部权重 ${esc(String(w.localWeight ?? 0.6))}，单群上限 ±${esc(String(w.localCap ?? 25))}）</span>
        <button type="button" class="btn btn-small" id="mood-toggle">${state.moodOpen ? '收起' : '展开'}</button>
      </div>
      <div class="mood-global">
        <div class="mood-stat">
          <span class="mood-k">心情</span>
          <span class="mood-v ${mCls}">${(Number(g.mood) || 0).toFixed(1)}</span>
          <span class="muted">${mTxt}（基线 50）</span>
          ${bar(g.mood, mCls)}
        </div>
        <div class="mood-stat">
          <span class="mood-k">精力</span>
          <span class="mood-v ${eCls}">${(Number(g.energy) || 0).toFixed(1)}</span>
          <span class="muted">${eTxt}（基线 65）</span>
          ${bar(g.energy, eCls)}
        </div>
        <div class="mood-stat">
          <span class="mood-k">状态</span>
          <span class="muted">${g.sleeping ? '这个点在睡' : '醒着'} · 共 ${scopes.length} 个群有独立偏移</span>
        </div>
      </div>
      ${state.moodOpen ? `
      <div class="mood-body">
        <div class="mood-sub">各群（局部偏移 ≠ 最终值：最终 = 全局 + 局部×权重）</div>
        <table class="mood-table">
          <thead><tr><th>群</th><th class="r">最终心情</th><th class="r">局部偏移</th><th class="r">最终精力</th><th class="r">更新</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="mood-sub" style="margin-top:12px">最近情绪来源（只到群粒度，不含人名与原话）</div>
        <ul class="mood-log">${logRows}</ul>
      </div>` : ''}
    </div>`;
}

/** 绑定心情卡片上的交互。 */
function bindMoodCard(box) {
  box.querySelector('#mood-toggle')?.addEventListener('click', () => {
    state.moodOpen = !state.moodOpen;
    render();
  });
}
function scoringPanelHtml() {
  const s = state.scoring;
  if (!s) return '';
  const h = (ms) => {
    const n = Number(ms) || 0;
    if (n >= 3600e3) return `${(n / 3600e3).toFixed(n % 3600e3 ? 1 : 0)} 小时`;
    return `${Math.round(n / 60000)} 分钟`;
  };
  const ago = (ts) => {
    const n = Number(ts) || 0;
    if (!n) return '从未提示过';
    const d = Date.now() - n;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return `${Math.round(d / 60000)} 分钟前`;
    if (d < 86400e3) return `${(d / 3600e3).toFixed(1)} 小时前`;
    return `${Math.round(d / 86400e3)} 天前`;
  };
  const rows = ['light', 'normal', 'deep'].map((k) => {
    const p = s[k];
    const label = { light: '轻量', normal: '标准（默认）', deep: '深度' }[k];
    return `<div class="im-bd-row">
      <span>${label}</span>
      <span class="muted">攒够 <b>${p.minNewMessages}</b> 条 · 且距上次 ≥ <b>${h(p.minIntervalMs)}</b></span>
    </div>`;
  }).join('');

  return `
    <details class="im-scoring" ${state.gates.length ? '' : 'open'}>
      <summary>打分时机（${s.enabled ? '已启用' : '★ 已关闭'}）—— 不是定时，是「攒够量 + 拉开间隔」</summary>
      <div style="padding:8px 0 0">
        <div class="hint" style="margin-bottom:8px">
          电脑不常开、在线时段不固定 ⇒ 不用定时器。判据是「自上次提示以来累计攒了多少条消息」+
          「距上次提示过了多久」，两条都满足才提示一次。提示搭在正常对话里，<b>不额外发起模型调用</b>。
        </div>
        ${rows}
        <div class="hint" style="margin-top:8px">
          实测频率：小群一天 40 条 ⇒ <b>最多 1 次</b>；大群一天 500 条 ⇒ <b>约 5 次</b>；
          刷屏群一天 2000 条 ⇒ <b>约 6 次</b>（<b>不随消息量线性增长</b>）。
        </div>
        <div class="im-sub-title" style="margin-top:12px">各群上次提示</div>
        ${state.gates.length ? `<ul class="im-events">
          ${state.gates.map((gItem) => `<li>
            <span class="mono">${esc(gItem.chatKey)}</span>
            <span class="muted">${esc(ago(gItem.lastPromptAt))}</span>
            <span class="muted">累计提示 ${gItem.prompts} 次</span>
            <button class="btn btn-small" data-reset-gate="${esc(gItem.chatKey)}" type="button" style="margin-left:auto">允许立刻再提示</button>
          </li>`).join('')}
        </ul>` : '<div class="hint">还没有任何群触发过打分提示。</div>'}
      </div>
    </details>
  `;
}

function render() {
  const box = document.getElementById('intimacy-page');
  if (!box) return;
  const rows = visibleRows();
  const st = state.stats || {};

  const totals = rows.length
    ? `显示 ${rows.length} / ${state.rows.length} 人`
    : '没有匹配的人';

  box.innerHTML = `
    <div class="pane-head">
      <div>
        <h2>亲密度</h2>
        <div class="pane-sub">
          最终分 = 基础分 × (1 + ${state.influence} × 事件分)；事件半衰期 ${state.halfLifeDays} 天 ·
          ${totals}${st.total ? ` · 全库 ${st.total} 条事件 / ${st.people} 人` : ' · 还没有任何事件'}
        </div>
      </div>
      <button class="btn btn-small" id="im-refresh" type="button">刷新</button>
    </div>

    <div class="im-toolbar">
      <div class="seg" id="im-tier-seg" role="group" aria-label="按档位筛选">
        ${TIERS.map(([v, label]) => `<button type="button" class="seg-item${v === state.filterTier ? ' selected' : ''}" data-v="${esc(v)}">${esc(label)}</button>`).join('')}
      </div>
      <input type="search" id="im-search" placeholder="搜 QQ 号…" value="${esc(state.query)}" />
    </div>

    ${moodCardHtml()}

    ${scoringPanelHtml()}

    <div class="im-body">
      <div class="im-list">
        <table class="im-table">
          <thead><tr>
            <th style="width:44px">#</th>
            <th>QQ</th>
            <th style="width:64px">最终</th>
            <th style="width:64px">基础</th>
            <th style="width:60px">事件</th>
            <th style="width:56px">事件数</th>
            <th style="width:56px">发言</th>
          </tr></thead>
          <tbody>
            ${rows.length ? rows.map((r) => `
              <tr data-uin="${esc(r.uin)}" class="${String(r.uin) === state.selected ? 'sel' : ''}">
                <td class="muted">${r.rank}</td>
                <td class="mono">${esc(r.uin)}</td>
                <td><b>${r.score}</b></td>
                <td class="muted">${r.baseScore}</td>
                <td>${deltaChip(r.eventDelta)}</td>
                <td class="muted">${r.eventCount || 0}</td>
                <td class="muted">${r.messageCount}</td>
              </tr>`).join('')
              : '<tr><td colspan="7" class="muted" style="padding:16px">没有匹配的人。</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="im-detail" id="im-detail">
        ${state.detail ? detailHtml(state.detail) : '<div class="hint" style="padding:16px">点左边任意一行看这个人的明细与事件。</div>'}
      </div>
    </div>
  `;

  bind();
  // ★ 2026-10-30：心情卡片自己的交互（展开/收起）
  bindMoodCard(box);
}

function detailHtml(d) {
  const info = d.info || {};
  const events = Array.isArray(d.events) ? d.events : [];
  return `
    <div class="im-detail-head">
      <div>
        <div class="im-uin mono">${esc(info.uin)}</div>
        <div class="muted">${esc(info.tier || '')}${info.rank ? ` · 全站第 ${info.rank}/${info.total}` : ''}</div>
      </div>
      <div class="im-score-big">
        <b>${info.score}</b>
        <span class="muted">/100</span>
      </div>
    </div>

    <div class="im-breakdown">
      <div class="im-bd-row"><span>基础分（纯统计）</span><b>${info.baseScore}</b></div>
      <div class="im-bd-row"><span>事件影响</span>${deltaChip(info.eventDelta)}</div>
      <div class="im-bd-row"><span>事件分（−1…1）</span><b>${info.eventScore}</b></div>
      <div class="im-bd-row"><span>最终分</span><b>${info.score}</b></div>
    </div>

    <div class="im-dims">
      <div class="im-dim"><span class="muted">发言</span><b>${info.messageCount}</b></div>
      <div class="im-dim"><span class="muted">活跃天</span><b>${info.activeDays}</b></div>
      <div class="im-dim"><span class="muted">@ 次数</span><b>${info.mentions}</b></div>
      <div class="im-dim"><span class="muted">会话数</span><b>${info.chatCount}</b></div>
      <div class="im-dim"><span class="muted">互动回合</span><b>${info.rounds}</b></div>
    </div>

    <div class="im-sub-title">
      事件记录（最近 ${events.length} 条）
      <button class="btn btn-small" id="im-add-event" type="button" style="float:right">补记一条</button>
    </div>

    <div id="im-add-form" class="im-add-form" style="display:none">
      <select id="im-kind">
        ${Object.entries(state.kinds).map(([k, m]) => `<option value="${esc(k)}">${esc(m.label)}（${m.tone === 'good' ? '正面' : m.tone === 'bad' ? '负面' : '中性'} ${m.weight > 0 ? '+' : ''}${m.weight}）</option>`).join('')}
      </select>
      <input type="text" id="im-note" placeholder="一句话说明（可空）" maxlength="200" />
      <input type="text" id="im-chatkey" placeholder="发生地 group:群号" />
      <button class="btn btn-small btn-primary" id="im-add-submit" type="button">记下</button>
      <div class="hint" id="im-add-msg" style="display:none"></div>
    </div>

    <ul class="im-events">
      ${events.length ? events.map((e) => `
        <li>
          <span class="chip ${toneClass(e.tone)}">${esc(e.label)}</span>
          <span class="im-ev-note">${esc(e.note || '（没写说明）')}</span>
          <span class="muted im-ev-meta">${esc(e.chatKey)} · ${fmtTs(e.ts)}</span>
        </li>`).join('')
        : '<li class="muted" style="padding:10px">还没有任何事件。你可以在群里观察，或手工补记一条。</li>'}
    </ul>
  `;
}

function bind() {
  const box = document.getElementById('intimacy-page');
  if (!box) return;

  document.getElementById('im-refresh')?.addEventListener('click', () => {
    state.ready = false;
    loadIntimacyPage({ force: true });
  });

  document.getElementById('im-search')?.addEventListener('input', (e) => {
    state.query = e.target.value || '';
    render();
  });

  box.querySelectorAll('#im-tier-seg .seg-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filterTier = btn.dataset.v || '';
      state.selected = '';
      state.detail = null;
      render();
    });
  });

  // 重置某个群的「刚提示过」记录（排查"为什么它一直不打分"用）
  box.querySelectorAll('[data-reset-gate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const chatKey = btn.dataset.resetGate;
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        await api('/api/local/intimacy/reset-gate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        state.ready = false;
        await loadIntimacyPage({ force: true });
      } catch (error) {
        btn.disabled = false;
        btn.textContent = '允许立刻再提示';
      }
    });
  });

  box.querySelectorAll('.im-table tbody tr[data-uin]').forEach((tr) => {
    tr.addEventListener('click', () => openPerson(tr.dataset.uin));
  });

  document.getElementById('im-add-event')?.addEventListener('click', () => {
    const f = document.getElementById('im-add-form');
    if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
  });

  document.getElementById('im-add-submit')?.addEventListener('click', submitEvent);
}

async function openPerson(uin) {
  state.selected = String(uin);
  const box = document.getElementById('intimacy-page');
  const detail = document.getElementById('im-detail');
  if (detail) detail.innerHTML = '<div class="hint" style="padding:16px">读取中…</div>';
  try {
    const r = await api(`/api/local/intimacy/person?uin=${encodeURIComponent(uin)}`);
    state.detail = r?.ok ? { info: r.info, events: r.events } : null;
  } catch (error) {
    state.detail = null;
  }
  render();
  // 详情读完后滚到它
  document.getElementById('im-detail')?.scrollIntoView({ block: 'nearest' });
}

async function submitEvent() {
  const uin = state.selected;
  const kind = document.getElementById('im-kind')?.value || '';
  const note = document.getElementById('im-note')?.value || '';
  const chatKey = (document.getElementById('im-chatkey')?.value || '').trim();
  const msg = document.getElementById('im-add-msg');
  const show = (text, isErr) => {
    if (!msg) return;
    msg.style.display = '';
    msg.className = isErr ? 'hint error' : 'hint';
    msg.textContent = text;
  };
  if (!uin) return show('先选一个人', true);
  if (!/^(group|private):\d+$/.test(chatKey)) return show('发生地要写成 group:群号 或 private:QQ号', true);
  try {
    const r = await api('/api/local/intimacy/event', {
      method: 'POST',
      body: JSON.stringify({ uin, kind, note, chatKey })
    });
    if (!r?.ok) return show(`失败：${r?.error || '未知错误'}`, true);
    show(r.duplicate ? '这条今天已经记过了（不重复计分）' : '已记下', false);
    // 重新拉这个人 + 全站（分数会变）
    state.ready = false;
    await loadIntimacyPage({ force: true });
    await openPerson(uin);
  } catch (error) {
    show(`失败：${String(error?.message || error)}`, true);
  }
}

export { loadIntimacyPage };
