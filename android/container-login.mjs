// 容器内最小登录入口：加载 wrapper → 初始化 → 快速登录（有存档）→ 否则出二维码。
// 只做登录与出码，不碰业务；状态全部写 /opt/whale/qq-state/login.log。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE = '/opt/whale/qq-state';
// 账号标识不在本文件里写死：优先环境变量，其次读容器的 src/config/account.mjs（唯一来源）。
// 账号标识不在本文件里写死：①环境变量 → ②容器的 src/config/account.mjs → ③上次登录留下的 identity.json。
const BOT_UIN = await (async () => {
  const fromEnv = (process.env.QQ_BOT_UIN || '').trim();
  if (fromEnv) return fromEnv;
  const fromConfig = await import('/qq-onebot/src/config/account.mjs').then(m => String(m.BOT_UIN || '')).catch(() => '');
  if (fromConfig) return fromConfig;
  try { return String(JSON.parse(fs.readFileSync(path.join(STATE, 'identity.json'), 'utf8')).uin || ''); } catch { return ''; }
})();
const GLOBAL = path.join(STATE, 'global');
fs.mkdirSync(GLOBAL, { recursive: true });

// 上一轮留下的登录地址一律作废：App 只认本次新写出来的那一张。
try { fs.unlinkSync(path.join(STATE, 'qr.url')); } catch {}

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  fs.appendFileSync(path.join(STATE, 'login.log'), line);
  process.stdout.write(line);
}

try {
  const loader = { exports: {} };
  process.dlopen(loader, '/opt/whale/native/loader.node', os.constants.dlopen.RTLD_NOW | os.constants.dlopen.RTLD_LOCAL);
  log('loader ok ' + JSON.stringify(loader.exports));

  const mod = { exports: {} };
  process.dlopen(mod, '/opt/QQ/resources/app/wrapper.node', os.constants.dlopen.RTLD_LAZY | os.constants.dlopen.RTLD_LOCAL);
  const w = mod.exports;
  log('wrapper ok exports=' + Object.getOwnPropertyNames(w).length);

  const misc = w.NodeIO3MiscService.get();
  misc.addO3MiscListener({ getOnAmgomDataPiece() {} });

  const engine = w.NodeIQQNTWrapperEngine.get();
  const callbacks = {};
  for (const n of ['onLog', 'onGetSrvCalTime', 'onShowErrUITips', 'onInstallFinished', 'onUpdateGeneralFlag', 'onGetOfflineMsg']) callbacks[n] = () => {};
  for (const n of ['fixPicImgType', 'getAppSetting']) callbacks[n] = () => {};
  engine.initWithDeskTopConfig({
    base_path_prefix: '', platform_type: 5, app_type: 4,
    app_version: '3.2.35-54395', os_version: os.version(), use_xlog: true,
    qua: 'V1_LNX_NQ_3.2.35_54395_GW_B',
    global_path_config: { desktopGlobalPath: GLOBAL },
    thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
  }, callbacks);
  log('engine init ok');

  const startup = w.NodeIQQNTStartupSessionWrapper.create();
  const session = w.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
  log('startup/session ok');

  const login = w.NodeIKernelLoginService.get();
  login.initConfig({
    machineId: '', appid: '537403759', platVer: 'Linux ' + os.release(),
    commonPath: GLOBAL, clientVer: '3.2.35-54395', hostName: os.hostname(),
  });
  log('login service init ok');

  let state = 'starting';
  const listener = {
    onQRCodeGetPicture(value) {
      try {
        log('qr picture: type=' + typeof value + ' ctor=' + (value?.constructor?.name) + ' keys=' + (value && typeof value === 'object' ? Object.keys(value).join(',') : '-'));

        // ★ 把二维码地址交给 App —— 它正是 App 用来拉起手机 QQ 授权的东西（不用摄像头、不用 adb）。
        //   日志里只记 scheme 与长度；完整地址单独写 600 权限文件，因为它是一次性登录凭据。
        const qrUrl = value && typeof value === 'object' && typeof value.qrcodeUrl === 'string'
          ? value.qrcodeUrl.trim() : '';
        if (qrUrl) {
          try {
            const next = path.join(STATE, 'qr.url.next');
            fs.writeFileSync(next, qrUrl, { mode: 0o600 });
            fs.renameSync(next, path.join(STATE, 'qr.url'));
            log('qr-url scheme=' + String(qrUrl.split(':')[0] || '?') + ' len=' + qrUrl.length);
          } catch (e) { log('qr-url write fail ' + e.message); }
        } else {
          log('qr-url missing: 回调里没有 qrcodeUrl');
        }

        let bytes = null;
        if (Buffer.isBuffer(value)) bytes = value;
        else if (value instanceof Uint8Array) bytes = Buffer.from(value);
        else if (value instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(value));
        else if (typeof value === 'string') {
          const b64 = value.startsWith('data:') ? value.split(',')[1] : value;
          bytes = Buffer.from(b64, 'base64');
        } else if (value && typeof value === 'object') {
          for (const k of ['pngBase64QrcodeData', 'qrcode', 'data', 'buffer', 'png', 'image', 'base64']) {
            const v = value[k];
            if (Buffer.isBuffer(v)) { bytes = v; break; }
            if (v instanceof Uint8Array) { bytes = Buffer.from(v); break; }
            if (v instanceof ArrayBuffer) { bytes = Buffer.from(new Uint8Array(v)); break; }
            if (typeof v === 'string' && v.length > 100) { bytes = Buffer.from(v.startsWith('data:') ? v.split(',')[1] : v, 'base64'); break; }
          }
        }
        if (!bytes) { log('qr decode unsupported; dump=' + JSON.stringify(value).slice(0, 300)); return; }
        const tmp = path.join(STATE, 'qr.next');
        fs.writeFileSync(tmp, bytes, { mode: 0o600 });
        fs.renameSync(tmp, path.join(STATE, 'qr.png'));
        state = 'qr-ready';
        log('qr-ready bytes=' + bytes.length);
      } catch (e) { log('qr write fail ' + e.message); }
    },
    onQRCodeLoginPollingStarted() { log('qr-polling'); },
    onQRCodeSessionUserScaned() {
      state = 'scanned';
      log('scanned');
      // 这张地址已经被用掉了：删掉，别让 App 再拿它去拉起 QQ。
      try { fs.unlinkSync(path.join(STATE, 'qr.url')); } catch {}
    },
    onQRCodeSessionFailed(t, c) {
      log('qr-session-failed type=' + t + ' code=' + c);
      if (!qrTimes) qrTimes = 0;
      qrTimes++;
      if (qrTimes <= 50 && state !== 'authenticated') {
        log('qr expired -> re-request #' + qrTimes);
        setTimeout(() => { try { qr = false; state = 'requesting-qr'; login.getQRCodePicture(); } catch (e) { log('re-request threw ' + e.message); } }, 1000);
      } else { state = 'qr-failed'; }
    },
    onQRCodeLoginSucceed(v) {
      state = 'authenticated';
      log('LOGIN_OK uin=' + (v?.uin ?? '?') + ' source=' + (qr ? 'qr' : 'quick'));
      fs.writeFileSync(path.join(STATE, 'identity.json'), JSON.stringify({ uin: String(v?.uin ?? ''), at: new Date().toISOString() }));
    },
    onQRCodeSessionQuickLoginFailed() { log('quick-login-failed -> fallback to qr'); },
    onLoginConnected() {
      connected = true;
      log('login-connected');
      // ★ 快速登录必须在 login-connected 之后试：在那之前本地登录列表还是空的
      //   （实测 6 秒就抢跑 → 「login list size=0 / no saved quick-login entry」→ 明明有登录态却只能出码）。
      if (!qr && state !== 'authenticated') attemptQuickThenQr();
    },
    onLoginDisconnected() { log('login-disconnected'); },
    onLoginFailed(e) { log('login-failed ' + JSON.stringify(e ?? null)); },
  };
  login.addKernelLoginListener(listener);
  log('listener registered');
  log('connecting');
  try { login.connect(); log('connect returned'); } catch (e) { log('connect threw ' + e.message); }

  let qr = false;
  let qrTimes = 0;
  let connected = false;
  const requestQr = () => {
    qr = true;
    state = 'requesting-qr';
    log('requesting-qr');
    try { login.getQRCodePicture(); } catch (e) { log('getQRCodePicture threw ' + e.message); }
  };

  const tryQuick = async () => {
    if (typeof login.getLoginList !== 'function' || typeof login.quickLoginWithUin !== 'function') {
      log('quick login api unavailable');
      return false;
    }
    let list;
    try { list = await login.getLoginList(); } catch (e) { log('getLoginList threw ' + e.message); return false; }
    // 把原始返回打出来：login list size=0 时唯一能分清「真的没有」还是「形状不对」的办法。
    let raw = '';
    try { raw = JSON.stringify(list)?.slice(0, 400) ?? String(list); } catch { raw = '(unserializable)'; }
    log('getLoginList raw type=' + typeof list
      + ' keys=' + (list && typeof list === 'object' ? Object.keys(list).join(',') : '-')
      + ' json=' + raw);
    // ★ 真实字段名是 LocalLoginInfoList（大写 L）—— 之前只认 list/localLoginInfoList，
    //   于是明明有登录态也读成空，快速登录永远不走。实测返回：
    //   {"result":0,"LocalLoginInfoList":[{"uin":"<BOT_UIN>","isQuickLogin":true,...}]}
    const arr = Array.isArray(list) ? list
      : (list?.LocalLoginInfoList || list?.localLoginInfoList || list?.list || []);
    log('login list size=' + (arr?.length ?? 0));
    const hit = (arr || []).find((x) => x && x.isQuickLogin === true && String(x.uin ?? '') === BOT_UIN);
    if (!hit) { log('no saved quick-login entry'); return false; }
    log('quick-login-attempting uin=' + hit.uin);
    try {
      const r = await login.quickLoginWithUin(String(hit.uin));
      log('quickLoginWithUin result=' + JSON.stringify(r?.result ?? r?.retCode ?? r ?? null));
      return String(r?.result ?? '') === '0';
    } catch (e) { log('quickLoginWithUin threw ' + e.message); return false; }
  };

  // 一次性的「先试快速登录，失败才出码」。由 onLoginConnected（或 50s 看门狗）触发。
  let quickTried = false;
  const attemptQuickThenQr = async () => {
    if (quickTried) return;
    quickTried = true;
    if (state === 'authenticated') return;
    const ok = await tryQuick();
    if (!ok && !qr && state !== 'authenticated') requestQr();
  };

  setTimeout(async () => {
    if (state === 'authenticated') return;
    if (!connected) {
      // 只提示，不抢跑出码：登录列表要等 login-connected 之后才读得到。
      log('WARN: 6s 内未 login-connected，继续等（不提前出码）state=' + state);
    }
  }, 6000);

  // 看门狗：50 秒还没连上，才退回「强行试快速登录 → 出码」。
  setTimeout(() => {
    if (state === 'authenticated' || qr || connected) return;
    log('WARN: 50s 仍未 login-connected，强制尝试快速登录/出码');
    attemptQuickThenQr();
  }, 50000);

  // 手动刷新：只要 /opt/whale/qq-state/refresh.request 出现，就立刻换一张新码。
  // （不按定时器自动刷新——每次 getQRCodePicture() 都会换码、让上一张立刻作废。）
  setInterval(() => {
    if (state === 'authenticated') return;
    const req = path.join(STATE, 'refresh.request');
    if (fs.existsSync(req)) {
      try { fs.unlinkSync(req); } catch {}
      try { log('qr-refresh (manual)'); login.getQRCodePicture(); } catch (e) { log('qr-refresh threw ' + e.message); }
    }
  }, 1000);

  // 保持进程存活，直到登录成功或超时（二维码 2 分钟过期）
  const started = Date.now();
  let authenticatedAt = 0;
  const timer = setInterval(() => {
    if (state === 'authenticated') {
      // ★ 登录成功后不要立刻退出：原生还要把登录态写进 login.db（之前 1 秒内 exit 很可能把 WAL 里的
      //   账号信息一起丢了 —— 这正是之后 getLoginList 一直返回空、快速登录用不了的嫌疑）。
      if (!authenticatedAt) {
        authenticatedAt = Date.now();
        log('DONE authenticated（保持 20 秒让原生落盘，再退出）');
      } else if (Date.now() - authenticatedAt > 20000) {
        clearInterval(timer);
        log('exit after 20s grace');
        process.exit(0);
      }
      return;
    }
    if (state === 'qr-failed') { log('DONE qr-failed'); clearInterval(timer); process.exit(3); }
    if (Date.now() - started > 10 * 60 * 1000) { log('DONE timeout state=' + state); clearInterval(timer); process.exit(4); }
  }, 1000);
} catch (e) {
  log('FATAL ' + (e?.stack || e?.message || e));
  process.exit(1);
}
