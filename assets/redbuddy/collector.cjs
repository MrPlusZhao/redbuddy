/* ============================================================
 * collector.cjs —— 小红书内容获取（数据源接口）+ 视频转写
 * ------------------------------------------------------------
 * 被 server.js 挂载，提供：
 *   GET  /api/xhs/env              环境自检
 *   GET  /api/xhs/providers        当前数据源 + 可选厂商列表
 *   POST /api/xhs/extract   {url}         短链 → 笔记内容（走数据源，无需登录）
 *   POST /api/xhs/transcribe{url}         视频 → 文案描述（RedFox 服务端转写）
 *   GET  /api/xhs/media?u=<直链>   媒体直链代理（视频播放兜底：绕开 CDN 的 Referer 检查）
 *
 * ★ 没有登录态这回事：内容一律由 providers.cjs 里配置的数据源返回（目前只有 redfox）。
 *   以前那套「本机 Playwright 扫码登录后打开笔记页」的采集方式已整体移除 ——
 *   它依赖浏览器登录态，稳定性差（小红书随时跳登录页），维护成本远高于接口。
 *
 * ★ 转写链路（2026-10 起）：只走 RedFox 服务端转写（submit → 轮询 result，
 *   不占本机算力）。本地 ffmpeg + Whisper 链路已按用户要求移除。
 * ============================================================ */
'use strict';

const Prov = require('./providers.cjs');          // 数据源适配层（redfox；另有隐藏的 mock 供离线自检）
const { MOBILE_UA } = require('./providers.cjs'); // 媒体代理取直链时用同一套 UA
const { rootCause } = require('./neterr.cjs');    // fetch 失败时还原真因（DNS / TLS / 拒绝连接…）
const { Readable } = require('stream');

function log(level, msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  process.stdout.write('[' + t + '] ' + level.toUpperCase() + '  ' + msg + '\n');
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const sleep = ms => new Promise(r => setTimeout(r, ms));


/* ---------------- RedFox 服务端转写（主链路） ----------------
 * 接口（实测通过）：
 *   ① submit  POST /story/api/parseWork/audioTextExtract/submit/xhs  {url} → {taskId}
 *   ② result  POST /story/api/parseWork/audioTextExtract/result/xhs  {taskId}
 *            → status: uploading → asr_processing → succeeded|failed
 *              text（完整文案）+ stampSents[{textSeg,start,end}]（毫秒分句）
 * 失败由调用方决定是否降级本地；这里只抛错。 */
async function redfoxTranscribe(url, key, base) {
  const b = String(base || 'https://redfox.hk').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', 'REDFOX_API_KEY': key };
  const short = s => (s || '').length > 40 ? s.slice(0, 40) + '…' : s;

  /* ① 提交任务 */
  let sj;
  try {
    const submit = await fetch(b + '/story/api/parseWork/audioTextExtract/submit/xhs', {
      method: 'POST', headers, body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30000),
    });
    sj = submit.ok ? (await submit.json().catch(() => ({}))) : {};
    if (!submit.ok) throw httpErr(502, 'RedFox 转写提交失败 HTTP ' + submit.status);
  } catch (e) {
    throw httpErr(502, 'RedFox 转写提交失败：' + rootCause(e));
  }
  if (sj.code !== 2000 || !(sj.data && sj.data.taskId)) {
    throw httpErr(502, 'RedFox 转写提交失败：' + (sj.msg || sj.message || JSON.stringify(sj).slice(0, 160)));
  }
  const taskId = sj.data.taskId;
  log('info', 'RedFox 转写任务已提交  taskId=' + taskId);

  /* ② 轮询结果（uploading → asr_processing → succeeded | failed） */
  const POLL_MS = 8000;
  const MAX_MS = 5 * 60 * 1000;
  const startAt = Date.now();
  for (;;) {
    if (Date.now() - startAt > MAX_MS) throw httpErr(504, 'RedFox 转写任务超时（5 分钟内未完成）');
    await sleep(POLL_MS);
    let rd = {};
    try {
      const rj = await fetch(b + '/story/api/parseWork/audioTextExtract/result/xhs', {
        method: 'POST', headers, body: JSON.stringify({ taskId }),
        signal: AbortSignal.timeout(30000),
      });
      rd = rj.ok ? (await rj.json().catch(() => ({}))) : {};
    } catch (e) {
      log('warn', 'RedFox 转写轮询请求异常，继续重试：' + rootCause(e));
      continue;
    }
    if (rd.code !== 2000 || !rd.data) {
      log('warn', 'RedFox 转写轮询返回异常：' + short(rd.msg || rd.message || JSON.stringify(rd)));
      continue;
    }
    const d = rd.data;
    const st = String(d.status || '');
    if (st === 'succeeded') {
      const segs = Array.isArray(d.stampSents)
        ? d.stampSents.map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.textSeg || '') }))
        : [];
      return { text: String(d.text || ''), backend: 'redfox', segments: segs };
    }
    if (st === 'failed') {
      throw httpErr(502, 'RedFox 转写失败：' + (d.failReason || '未知原因'));
    }
    /* uploading / asr_processing / 其他中间态 → 继续等 */
  }
}

/* ---------------- 媒体直链代理（视频播放的兜底通道） ----------------
 * 为什么需要它：小红书 CDN 会看 Referer。页面直连视频时浏览器会带上
 *   Referer: http://127.0.0.1:8090/
 * CDN 判成「外站引用」→ 403 → 播放器只给一块黑屏，且不告诉你为什么。
 * （封面图早先就是靠 `referrerpolicy="no-referrer"` 绕过的，视频这条路径当时漏了。）
 * 现在两层保险：
 *   ① 页面整体声明 `no-referrer`（治本，视频请求干脆不带 Referer）；
 *   ② 万一还不行，前端自动改走这个本机代理重试 —— 服务端去取，同样不带 Referer。
 * 转发 Range，所以进度条能拖。
 *
 * ⚠️ 域名白名单不是可选项：这个服务带 `Access-Control-Allow-Origin: *`，
 *    不加白名单就等于给任意网页开了一个能打内网的本地代理（SSRF）。
 */
const MEDIA_HOSTS = /(^|\.)(xhscdn\.com|xiaohongshu\.com|xhslink\.com|redfox\.hk)$/i;

async function proxyMedia(req, res, helpers) {
  const { httpErr: HE } = helpers;
  const q = new URL(req.url, 'http://localhost');
  const target = q.searchParams.get('u') || '';
  let t;
  try { t = new URL(target); }
  catch (e) { throw HE(400, 'u 参数不是合法 URL'); }
  if (t.protocol !== 'https:' && t.protocol !== 'http:') throw HE(400, '只支持 http/https 直链');
  if (!MEDIA_HOSTS.test(t.hostname)) throw HE(403, '不在媒体代理白名单里：' + t.hostname);

  /* 用户关掉弹窗时把上游下载也一起掐掉，别让它空跑 */
  const ac = new AbortController();
  const abort = () => { try { ac.abort(); } catch (e) {} };
  req.on('close', abort);

  const range = req.headers.range;
  let up;
  try {
    up = await fetch(t.toString(), {
      headers: Object.assign({ 'User-Agent': MOBILE_UA, 'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        range ? { 'Range': range } : {}),
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(60000)]),
    });
  } catch (e) {
    throw httpErr(502, '取视频失败：' + rootCause(e));
  }
  if (!up.ok && up.status !== 206) {
    const why = up.status === 403 ? '（多半是防盗链没绕过去，或这条直链已经过期）'
      : up.status === 404 ? '（这条直链已经失效）' : '';
    log('warn', '媒体代理上游 ' + up.status + '  ' + t.hostname + '  ' + why);
    throw httpErr(502, '上游返回 HTTP ' + up.status + why);
  }

  const hdr = {
    'Content-Type': up.headers.get('content-type') || 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
  const cl = up.headers.get('content-length'); if (cl) hdr['Content-Length'] = cl;
  const cr = up.headers.get('content-range');  if (cr) hdr['Content-Range'] = cr;
  res.writeHead(up.status, hdr);
  if (!up.body) { res.end(); return; }
  Readable.fromWeb(up.body).pipe(res);
}

/* ---------------- 对外：路由处理 ---------------- */
/* 返回 true 表示这个请求由本模块处理 */
async function handle(req, res, pathname, helpers) {
  const { readJSON, httpErr: HE } = helpers;
  const p = pathname;

  /* 内容获取全部走数据源接口、没有登录态、没有本地模型，所以这里没有可自检的东西 */
  if (p === '/api/xhs/env' && req.method === 'GET') {
    helpers.sendJSON(res, 200, { ok: true });
    return true;
  }
  if (p === '/api/xhs/media' && req.method === 'GET') {
    await proxyMedia(req, res, helpers);
    return true;
  }
  if (p === '/api/xhs/providers' && req.method === 'GET') {
    const hx = helpers.xhs || {};
    let cur = '';
    /* ignoreKey：这一步只问「选的是哪家数据源」，不该因为「这次请求没带 Key」就返回空。
     * （Key 在不在是前端自己的事，见下面 hasKey:false） */
    try { cur = Prov.getProvider(hx, { ignoreKey: true }).id; } catch (e) { cur = ''; }

    /* ★ 服务端不再持有 Key：前端据此提示「去设置里配」。
     *   Key 是否存在，只有前端自己知道（在浏览器 localStorage 里）。 */
    helpers.sendJSON(res, 200, {
      ok: true,
      current: cur,                                   // 空 = 还没配置数据源，提取会明确报错
      base: hx.base || '',
      hasKey: false,                                  // 恒 false：服务端无 Key，Key 只来自「设置」页
      keySource: 'frontend-settings',
      list: Prov.listProviders(),                     // 可选数据源
    });
    return true;
  }
  if (p === '/api/xhs/extract' && req.method === 'POST') {
    const body = await readJSON(req);
    const url = body.url;
    if (!url) throw HE(400, '缺少 url');

    /* ★ Key 只有一条来源：前端「设置」页（body.keys，存浏览器 localStorage）。
     *   服务端不读 config.local.json、不读环境变量 —— 没带就明确报错让用户去设置里配。 */
    const hx = helpers.xhs || {};
    const pid = body.provider || hx.provider || '';
    const cfg = Object.assign({}, hx, {
      provider: pid,
      strategy: body.strategy || '',
      keys: body.keys,                                   // 唯一的密钥来源
      base: body.base || hx.base || '',
    });

    /* 全部走数据源（无需登录、无需浏览器）。没配 / 配错 / 缺 Key 都在这里明确报错 */
    let prov = null;
    try { prov = Prov.getProvider(cfg); }
    catch (e) { throw HE(e.status || 400, e.message); }

    try {
      const data = await Prov.extractNote(cfg, { url, wantVideo: body.wantVideo });
      const media = data.videoUrl ? '视频直链已取到' : ('图 ' + (data.images || []).length + ' 张');
      log('info', '[' + prov.label + '] 提取完成  类型=' + data.type + '  正文=' + (data.desc || '').length +
        ' 字  图片=' + data.images.length + (data.videoUrl ? '  含视频' : ''));
      helpers.sendJSON(res, 200, {
        ok: true, source: prov.id,
        resolved: { id: data.id, type: data.type, hasToken: false },
        note: data,
        text: [data.title, data.desc].filter(Boolean).join('\n\n'),
      });
    } catch (e) {
      throw HE(e.status || 502, e.message || String(e));
    }
    return true;
  }
  if (p === '/api/xhs/transcribe' && req.method === 'POST') {
    const body = await readJSON(req);
    const url = String(body.url || '').trim();             // 完整笔记链接（含 token）→ RedFox 服务端转写
    if (!url) throw HE(400, '缺少 url');
    const hx = helpers.xhs || {};
    /* ★ Key 只有一条来源：前端「设置」页（body.keys）。服务端不兜底。 */
    const reqKeys = Array.isArray(body.keys) && body.keys.length ? body.keys.map(String).filter(Boolean) : [];
    const key = reqKeys[0] || '';
    const base = String(body.base || '') || hx.base || '';
    if (!key) throw HE(400, '未配置 RedFox Key：请到「设置 → RedFox 红狐密钥」里添加并启用（转写也走这把 Key）');
    const r = await redfoxTranscribe(url, key, base);
    log('info', 'RedFox 服务端转写完成  ' + r.text.length + ' 字 / ' + r.segments.length + ' 段');
    helpers.sendJSON(res, 200, { ok: true, transcript: r.text, backend: r.backend, segments: r.segments });
    return true;
  }
  return false;
}

module.exports = { handle };
