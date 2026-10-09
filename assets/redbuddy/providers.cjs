/**
 * providers.cjs —— 第三方小红书数据源适配层
 * ============================================================
 * 目的：把不同厂商的接口差异收敛成统一结构，上层（collector.cjs / server.js）不用关心用的哪家。
 * 好处：换厂商只改 config.local.json 一行；也能做多厂商降级兜底。
 *
 * ── 统一输出（与 collector.cjs 的 extractByState 完全对齐）──
 *   {
 *     source, id, type:'video'|'normal', title, desc, tags[],
 *     author, authorId, publishTime, ipLocation,
 *     interact: { liked, collected, comment, shared },   // number | null
 *     images: string[], videoUrl, cover
 *   }
 *
 * ── 已支持 ──
 *   redfox : redfox.hk   ✅ 元数据走 parseWork/parse + queryWorkDetail；视频文案转写也走 RedFox 服务端
 *
 *   TikHub / Rnote 的适配代码已于 2026-10-04 移除 —— 只留红狐一家，少一处要维护的分支。
 *
 *   mock   : 本地假数据，离线自检用。★ 不进 listProviders()，
 *            只能在 config.local.json 里手动写 "xhsProvider":"mock" 才会生效。
 *
 * ── 重要提醒 ──
 *   RedFox 每解析一条笔记要调 1~2 个接口，每次调用都消耗账号积分（邮箱注册送 200 积分）。
 *   所以调用前先校验输入（是不是链接、短链有没有展开），别把明显无效的内容直接送上去。
 */
'use strict';

const http  = require('http');
const https = require('https');
const { rootCause } = require('./neterr.cjs');   // 网络错误还原真因（DNS / TLS / 拒绝连接…）

/* ============================================================
 * HTTP：带重定向跟随
 * ============================================================ */
function rawReq(urlStr, opts) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 非法：' + urlStr)); }
    const lib = u.protocol === 'http:' ? http : https;
    const { method = 'GET', headers = {}, body = null, timeout = 45000 } = opts || {};
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({ Accept: 'application/json' }, headers);
    if (payload != null) {
      h['Content-Type']   = h['Content-Type'] || 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: h,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', err => {
      /* 统一带上根因：否则上层只会看到一句 "getaddrinfo ENOTFOUND xxx" /
       * "Hostname/IP does not match certificate's altnames"，
       * 分不清是 DNS、证书还是对方没开。err.code 原样保留，供上层判断。 */
      if (err && !err.rootCaused){
        try { err.message = rootCause(err); err.rootCaused = true; } catch (_){}
      }
      reject(err);
    });
    r.setTimeout(timeout, () => r.destroy(new Error('请求超时（' + timeout + 'ms）')));
    if (payload != null) r.write(payload);
    r.end();
  });
}

/** 自动跟随 3xx（短链解析要用），并记录最终 URL */
async function req(urlStr, opts = {}) {
  const max = opts.maxRedirects == null ? 6 : opts.maxRedirects;
  let cur = urlStr;
  for (let i = 0; i <= max; i++) {
    const res = await rawReq(cur, opts);
    const loc = res.headers && res.headers.location;
    if (loc && res.status >= 300 && res.status < 400) {
      cur = new URL(loc, cur).toString();
      continue;
    }
    res.finalUrl = cur;
    return res;
  }
  throw new Error('重定向次数过多（>' + max + '）：' + urlStr);
}

/* ============================================================
 * 取值工具
 * ============================================================ */
const txt = v => (v == null ? '' : String(v).trim());

/* 移动端浏览器 UA —— 两处都要用它：
 *   ① 展开短链（xhslink.cn）必须带浏览器 UA，不带会 404 / 不跳转；
 *   ② 笔记页 HTML 兜底抓取（pageFallback）也走同一套。
 *   （早先这里是两个常量，值完全一样，已合并成一个。） */
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* 互动数换算：支持原始整数、字符串、"1.2万" / "3.4w" / "1.1亿" 这类缩写。
 * 本地 __INITIAL_STATE__ 给的是原始整数，用不到；但第三方 API 可能返回缩写字符串。 */
function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,，\s]/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([万亿wWkK])?/);
  if (!m) return null;
  let n = Number(m[1]);
  const u = m[2];
  if (u === '万' || u === 'w' || u === 'W') n *= 1e4;
  else if (u === '亿') n *= 1e8;
  else if (u === 'k' || u === 'K') n *= 1e3;
  return n;
}

/** 取第一个能解析成数值的参数（互动字段别名兜底用） */
function firstNum(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

/** 互动数据：优先详情接口 d2；四项全缺时从解析接口 d1 按常见字段名兜底 */
function pickInteract(d2, d1) {
  const a = {
    liked:     num(d2.workLikedCount),
    collected: num(d2.workCollectedCount),
    comment:   num(d2.workCommentsCount),
    shared:    num(d2.workSharedCount),
  };
  if (a.liked != null || a.collected != null || a.comment != null || a.shared != null) return a;
  return {
    liked:     firstNum(d1.workLikedCount, d1.likeCount, d1.likedCount, d1.likes, d1.interactCount, d1.like),
    collected: firstNum(d1.workCollectedCount, d1.collectCount, d1.collectedCount, d1.collects, d1.collect),
    comment:   firstNum(d1.workCommentsCount, d1.commentCount, d1.commentsCount, d1.comments, d1.comment),
    shared:    firstNum(d1.workSharedCount, d1.shareCount, d1.sharesCount, d1.shares, d1.share),
  };
}

/* ---------------- 小红书笔记页抓取兜底（免费，不调 RedFox） ----------------
 * 详情接口（优质库）未收录时，从笔记页 HTML 的 window.__INITIAL_STATE__ 里
 * 拿作者昵称 / 互动数（赞藏评享）/ 正文 / 封面。任何一步失败都静默返回 {}，
 * 调用方照常降级，不抛错。 */
async function pageFallback(fullLink) {
  try {
    const r = await req(fullLink, {
      method: 'GET', timeout: 25000,
      headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const html = r.text || '';
    const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*<\/script>/s);
    if (!m) return {};
    const js = m[1];
    /* 锚定主体笔记：noteData.data.noteData 对象（括号配对截取，避免整体 JSON 解析被
     * __INITIAL_STATE__ 里的 undefined 等非法值破坏） */
    const a = js.indexOf('"data":{"noteData":{');
    if (a < 0) return {};
    let i = js.indexOf('{', a);
    let depth = 0;
    for (; i < js.length; i++) {
      if (js[i] === '{') depth++;
      else if (js[i] === '}') { depth--; if (!depth) break; }
    }
    const seg = js.slice(js.indexOf('{', a), i + 1);
    const g = pat => { const mm = seg.match(pat); return mm ? mm[1] : ''; };
    const num = pat => { const n = parseInt(g(pat), 10); return Number.isFinite(n) ? n : null; };
    const dec = v => { if (!v) return ''; try { return JSON.parse('"' + v.replace(/"/g, '\\"') + '"'); } catch (e) { return v.replace(/\\n/g, '\n'); } };
    return {
      nickname: g(/"nickname":"([^"]*)"/),
      desc: dec(g(/"desc":"([\s\S]*?)","/)),
      liked:     num(/"likedCount":"?(\d+)"/),
      collected: num(/"collectedCount":"?(\d+)"/),
      comment:   num(/"commentCount":"?(\d+)"/),
      shared:    num(/"shareCount":"?(\d+)"/),
      cover: (g(/"imageList":\[\{"[^{]*?"url":"([^"]*)"/) || '').replace(/\\u002F/g, '/'),
    };
  } catch (e) { return {}; }
}

/** 从一段分享文案里抠出 URL（用户可能直接粘贴整段分享文案） */
function extractUrl(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/https?:\/\/[^\s，,、"'<>）)】\]]+/);
  return m ? m[0] : s;
}

/** 从 URL / 分享文案里抠 24 位十六进制 note_id
 *  ★ 先 decodeURIComponent 再匹配：小红书把短链跳到登录页时，会把原地址塞进
 *    `redirectPath=%2Fexplore%2F<id>`，不先解码就会从 "%2Fexplore%2F" 里
 *    把 "2F" 当十六进制，抠出 "2F687df3a1…" 这种**错 id**。
 *  ★ 优先锚定 /explore/ 或 /discovery/item/，避免误匹配其它长十六进制串。 */
function pickNoteId(s) {
  const raw = String(s || '');
  let dec = raw;
  try { dec = decodeURIComponent(raw); } catch (e) { /* 非法转义就按原样匹配 */ }
  const m = dec.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)
         || dec.match(/([0-9a-f]{24})/i);
  return m ? m[1] : '';
}

/** 出错时给一小段返回摘要，方便排查 */
function brief(obj) {
  try { return JSON.stringify(obj).slice(0, 300); } catch (e) { return String(obj).slice(0, 300); }
}

/** 客户端错误（配置写错 / 输入非法），带 400 状态，区别于上游接口错误 */
function cerr(msg) { const e = new Error(msg); e.status = 400; return e; }

/* ============================================================
 * 厂商实现
 * ============================================================ */

/* ---------- RedFox 红狐 ----------
 * 分工：RedFox 负责「取元数据」（标题/正文/互动/作者/视频直链/图片直链），
 *       视频文案转写也走 RedFox 服务端接口（submit → 轮询 result）。
 *       ⚠️ 本地 ffmpeg + Whisper 转写链路已移除，不要照旧注释理解。
 *
 * 需要两个接口配合（各消耗一次调用）：
 *   ① POST /story/api/parseWork/parse        → awemeType / title / videoUrl / imageUrls
 *      （图文给**完整图片直链列表** imageUrls；视频给无水印直链，但实测视频的 imageUrls 为空、
 *        只回一个 cover —— 所以「配图」这一块只对图文笔记有意义）
 *   ② POST /story/api/xhsUser/queryWorkDetail → workTitle / workDesc / 互动数 / coverUrl / 作者
 *
 * ②是「优质库」，未收录返回 code 3203（不消耗积分）→ 降级为「只有①的数据」，不报错。
 */
const RF_PARSE = '/story/api/parseWork/parse';
const RF_DETAIL = '/story/api/xhsUser/queryWorkDetail';

/** RedFox 统一错误码 → 人话 */
function rfMsg(json, label) {
  const code = json && (json.code != null ? json.code : json.status);
  const msg = (json && (json.msg || json.message)) || '';
  /* 3201 是「账号额度」类问题。原文照带上，免得我们自己的措辞把方向带偏。 */
  if (code === 3201) return 'RedFox 这个账号的免费积分用完了' + (msg ? '（上游原文：' + msg + '）' : '') +
    '。RedFox 邮箱注册即送 200 积分，换个新邮箱再注册一个账号就行；也可以在「设置 → RedFox 红狐密钥」里换一个 Key。';
  if (code === 3103 || code === 3107) return 'RedFox API Key 无效或已失效，请核对密钥';
  if (code === 3105) return 'RedFox API Key 已被禁用，请到控制台启用或换一个';
  if (code === 4004) return 'RedFox 触发限流，请稍后重试';
  return 'RedFox ' + label + '失败（code ' + code + '）：' + msg;
}

const redfox = {
  id: 'redfox',
  label: 'RedFox 红狐',
  defaultBase: 'https://redfox.hk',
  needBase: true,
  needKey: true,
  keyHint: '在 redfox.hk 控制台「API 密钥管理」创建，然后填到「设置 → RedFox 红狐密钥」里（服务端不存 Key）',
  async extractNote(ctx) {
    if (!ctx.key) throw new Error('RedFox 未配置 API Key');
    const headers = { 'Content-Type': 'application/json', 'X-API-KEY': ctx.key, 'REDFOX_API_KEY': ctx.key };
    const post = async (path, body, label) => {
      const r = await req(ctx.base + path, { method: 'POST', headers, body });
      if (r.status === 401 || r.status === 403) throw new Error('RedFox 鉴权失败（HTTP ' + r.status + '）：密钥无效或无权限');
      if (r.status === 429) throw new Error('RedFox 触发限流，请稍后重试');
      if (r.status >= 400)  throw new Error('RedFox HTTP ' + r.status + '：' + brief(r.text));
      const j = r.json;
      const code = j && (j.code != null ? j.code : j.status);
      if (code == null || !String(code).startsWith('2')) {
        const e = new Error(rfMsg(j, label));
        e.rfCode = code;
        /* 账户/密钥/限流这类「不是网关故障」的错误码给对应的 HTTP 状态，
         * 别一律 502 —— 否则浏览器控制台会报 Bad Gateway，误导排查方向。 */
        if (code === 3201 || code === 3103 || code === 3107 || code === 3105) e.status = 400;
        else if (code === 4004) e.status = 429;
        throw e;
      }
      return j.data || {};
    };

    /* ⓪ ★ 必须先把短链展开成「完整的小红书链接」，再调任何接口。
     *   实测（2026-10-04）：直接拿 xhslink.cn 短链调 parseWork/parse 会被拒 ——
     *     {"code":3203,"msg":"接口执行异常，积分未扣除: 不支持的链接类型：
     *       该链接非支持平台页面分享链接。请输入支持平台的分享链接地址，例：https://v.douyin.com/xxxx"}
     *   展开成 https://www.xiaohongshu.com/discovery/item/<24位id>?xsec_token=... 后立刻返回 2000。
     *   → 所以「展开短链」不是可选优化，是**前置必需步骤**（早先只给第二个接口展开，第一个接口
     *     永远拿短链去打 → 永远失败，白花一次调用）。
     *   展开后的链接必须保留 xsec_token，否则会被判「解析小红书作品信息异常」。 */
    let noteId = ctx.noteId || pickNoteId(ctx.shareText);
    let fullLink = ctx.shareText;
    const isNoteUrl = /xiaohongshu\.com\/(?:explore|discovery\/item)\/[0-9a-f]{24}/i.test(fullLink);
    if (!isNoteUrl) {
      try {
        const r = await req(extractUrl(ctx.shareText), { method: 'GET',
          headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
        if (r.finalUrl) fullLink = r.finalUrl;
        noteId = pickNoteId(fullLink) || pickNoteId(r.text) || noteId;
        if (ctx.log) ctx.log('info', 'RedFox 短链已展开  id=' + (noteId || '?'));
      } catch (e) {
        if (ctx.log) ctx.log('warn', 'RedFox 短链展开失败，按原链接提交：' + rootCause(e));
      }
    }
    /* 只有 id、没有可用链接时，拼一个标准笔记页地址兜底 */
    if (noteId && !/xiaohongshu\.com/i.test(fullLink)) {
      fullLink = 'https://www.xiaohongshu.com/explore/' + noteId;
    }

    /* ① 解析作品：视频无水印直链 / 图片直链列表 / 标题 */
    const d1 = await post(RF_PARSE, { url: fullLink, source: 'RedBuddy' }, '解析作品');
    const aweme = txt(d1.awemeType).toLowerCase();
    const imageUrls = Array.isArray(d1.imageUrls) ? d1.imageUrls.map(txt).filter(Boolean) : [];
    const videoUrl = txt(d1.videoUrl);

    if (!videoUrl && !imageUrls.length) {
      throw new Error('RedFox 没解析出媒体地址（可能是笔记已删 / 链接失效 / 该类型暂不支持）。' +
        '⚠️ 注意：这次调用已消耗积分。原始返回：' + brief(d1));
    }

    /* ② 作品详情：正文 / 互动 / 作者 / 封面（优质库未收录 → 降级，不报错）
     * ⚠️ 官方文档：workId / workLink「二选一必填」—— 两个都传可能被判参数非法，所以只传一个。
     *    优先 workId；拿不到 id 才回退 workLink。 */
    let d2 = {};
    let fb = {};
    try {
      d2 = await post(RF_DETAIL, noteId ? { workId: noteId } : { workLink: fullLink }, '作品详情');
    } catch (e) {
      if (e.rfCode === 3203 || e.rfCode === 3204) {
        if (ctx.log) ctx.log('info', 'RedFox 优质库未收录该作品，仅用解析接口的数据（不消耗积分）');
        /* 优质库没收录 → 用笔记页 HTML 兜底补作者/互动/正文/封面（免费） */
        fb = await pageFallback(fullLink);
        if (ctx.log && (fb.nickname || fb.liked != null)) {
          ctx.log('info', '页面兜底补全：作者 ' + (fb.nickname || '?') +
            ' / 赞 ' + (fb.liked ?? '?') + ' 藏 ' + (fb.collected ?? '?') +
            ' 评 ' + (fb.comment ?? '?') + ' 享 ' + (fb.shared ?? '?'));
        }
      } else {
        if (ctx.log) ctx.log('warn', 'RedFox 作品详情获取失败（已降级，只有标题/媒体）：' + e.message);
      }
    }

    const type = (aweme === 'video' || videoUrl) ? 'video' : 'normal';
    /* 封面：详情接口 coverUrl → 解析接口 cover（实测 parseWork/parse 对视频返回 cover 字段，
     * 但 imageUrls 为空）→ 页面兜底首图 → 图片列表首图。四级兜底，别让封面/图片列表落空。 */
    const cover = txt(d2.coverUrl) || txt(d1.cover) || fb.cover || (imageUrls[0] || '');
    const images = imageUrls.length ? imageUrls : (cover ? [cover] : []);
    if (type === 'normal' && !imageUrls.length && cover && ctx.log) {
      ctx.log('warn', 'RedFox 没返回图片列表，图文笔记已退回封面 1 张，配图不完整');
    }

    const interact = pickInteract(d2, d1);
    /* 详情、解析都没给互动数，但页面兜底拿到了 → 补上 */
    if (interact.liked == null && interact.collected == null && interact.comment == null && interact.shared == null) {
      interact.liked     = fb.liked ?? interact.liked;
      interact.collected = fb.collected ?? interact.collected;
      interact.comment   = fb.comment ?? interact.comment;
      interact.shared    = fb.shared ?? interact.shared;
    }
    if (ctx.log) {
      const hit = interact.liked != null || interact.collected != null || interact.comment != null || interact.shared != null;
      ctx.log('info', 'RedFox 互动数据：' + (hit
        ? '点赞 ' + interact.liked + ' / 收藏 ' + interact.collected + ' / 评论 ' + interact.comment + ' / 分享 ' + interact.shared
        : '未取到（详情未收录、解析接口无互动字段、页面兜底也失败）'));
    }

    return {
      source: 'api(redfox)',
      id: txt(d2.workId) || noteId || pickNoteId(ctx.shareText),
      type,
      url: fullLink,                                  // 展开后的完整链接（含 xsec_token），服务端转写要用
      title: txt(d1.title || d2.workTitle),
      desc: txt(d2.workDesc) || fb.desc,
      tags: [],                                   // RedFox 不返回标签
      author: txt(d2.accountNickname) || fb.nickname,
      authorId: txt(d2.accountUserid),
      publishTime: txt(d2.workPublishTime),
      ipLocation: '',
      interact,
      images, videoUrl, cover,
    };
  },
};

/* ---------- Mock：离线验证链路 ----------
 * ★ hidden:true —— 不进 listProviders()（设置页那张「小红书数据源」卡片已于 2026-10-08 整体移除）。
 *   但 config.local.json 里手动写 "xhsProvider":"mock" 仍然生效：
 *   不联网就能跑通「请求 → 适配层 → 前端渲染」整条链路（验证用）。
 *   想彻底删掉的话，把下面这个对象、DEBUG_PROVIDERS 和 extractNote 里的 mockVideoUrl 一起删。 */
const mock = {
  id: 'mock',
  label: 'Mock（本地假数据，离线）',
  defaultBase: '',
  needBase: false,
  needKey: false,
  hidden: true,
  keyHint: '不需要 Key。仅用于验证链路是否打通，不访问任何外部接口。',
  async extractNote(ctx) {
    await new Promise(r => setTimeout(r, 500));   // 模拟网络延迟
    const id = ctx.noteId || pickNoteId(ctx.shareText) || '697c0eee000000000a03c308';
    const base = {
      source: 'api(mock)',
      id,
      url: '',                                    // mock 没有真实链接 → 转写会提示「没有取到完整链接」
      tags: ['Mock', '链路自检'],
      author: 'Mock 作者',
      authorId: 'mock_user_001',
      publishTime: String(Math.floor(Date.now() / 1000)),
      ipLocation: '上海',
      interact: { liked: 18400, collected: 7600, comment: 920, shared: 340 },
    };

    /* 配了 MOCK_VIDEO_URL（或 config 里 mockVideoUrl）就返回视频笔记 ——
     * 用来离线验证「短链 → 视频地址」这一段。没配就是普通的图文假数据。 */
    if (ctx.mockVideoUrl) {
      return Object.assign(base, {
        type: 'video',
        title: '【Mock】视频链路自检',
        desc: '这是 mock 数据源返回的**视频**笔记描述，用来验证「短链 → 取视频地址」这一段链路。\n\n'
            + '视频地址来自本机（MOCK_VIDEO_URL），不访问任何外部接口。',
        images: [],
        videoUrl: ctx.mockVideoUrl,
        cover: '',
      });
    }

    return Object.assign(base, {
      type: 'normal',
      title: '【Mock】链路自检笔记',
      desc: '这是 mock 数据源返回的正文，用来验证「请求 → 适配层 → 前端渲染」整条链路是否打通。\n\n'
          + '它不访问任何外部接口。把 config.local.json 里的 xhsProvider 改回 redfox，并在「设置 → RedFox 红狐密钥」里配好 Key，就会走真实数据。',
      images: [],
      videoUrl: '',
      cover: '',
    });
  },
};

/* ============================================================
 * 注册表
 * ============================================================ */
/** 正式厂商：会出现在 listProviders() 里 */
const PROVIDERS = { redfox };

/** 隐藏的调试数据源：不出现在 UI，但 config.local.json 里手动指定仍然生效 */
const DEBUG_PROVIDERS = { mock };

/** 两者合并 —— getProvider 认全量，listProviders 只认正式的 */
const ALL_PROVIDERS = Object.assign({}, PROVIDERS, DEBUG_PROVIDERS);

/** 列出可选厂商（给前端渲染按钮用）—— 隐藏的不算 */
function listProviders() {
  return Object.keys(PROVIDERS).map(k => ({
    id: PROVIDERS[k].id,
    label: PROVIDERS[k].label,
    defaultBase: PROVIDERS[k].defaultBase,
    needKey: !!PROVIDERS[k].needKey,
    keyHint: PROVIDERS[k].keyHint || '',
  }));
}

const PROVIDER_KEYS = Object.keys(PROVIDERS);

/** 归一化「多密钥」输入：接受数组，过滤空值，去重，保序 */
function normKeys(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const k of list) {
    const v = txt(typeof k === 'object' && k ? (k.value != null ? k.value : k.key) : k);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/* 轮换游标（按厂商分别记；本地单人使用，进程内计数够用） */
const _rr = {};
/**
 * 选一个可用的 Key。
 * ★ 唯一来源：请求里带来的 keys（前端「设置」页 → body.keys）。服务端没有任何兜底。
 * strategy：priority（总用第一个）/ rotate（每次换下一个）/ random（随机）
 */
function pickKey(cfg) {
  const keys = normKeys(cfg && cfg.keys);
  if (!keys.length) return '';
  const s = txt(cfg && cfg.strategy) || 'priority';
  if (s === 'rotate') {
    const p = txt(cfg && cfg.provider) || '_';
    _rr[p] = ((_rr[p] || 0) + 1) % keys.length;
    return keys[_rr[p]];
  }
  if (s === 'random') return keys[Math.floor(Math.random() * keys.length)];
  return keys[0];
}

/** 是否已配好 Key —— 只看请求里带来的 keys */
function hasKey(cfg) {
  return normKeys(cfg && cfg.keys).length > 0;
}

/**
 * 取当前生效的数据源厂商。
 * @param {object} cfg  { provider, base, keys, strategy, log }（server.js 的 helpers.xhs + 前端传的）
 * @param {object} [opt] { ignoreKey:true } —— 只想知道「选的是哪家」时用（如 /api/xhs/providers），
 *        不要因为「这次请求没带 Key」就判定数据源未配置。
 * @returns 厂商对象
 * @throws 没配 / 配错 / 配成了已移除的 local —— 一律抛 400，带人话提示，不静默回退
 */
function getProvider(cfg, opt) {
  const id = txt((cfg && cfg.provider) || '').toLowerCase();
  if (!id || id === 'none') {
    throw cerr('还没配置小红书数据源：请在 config.local.json 里设 "xhsProvider": "' +
      PROVIDER_KEYS[0] + '"，然后重启服务。');
  }
  if (id === 'local') {
    throw cerr('「本机浏览器采集」已移除 —— 它依赖扫码登录态，小红书随时跳登录页，不稳定。' +
      '现在只保留 RedFox 红狐：把 config.local.json 的 xhsProvider 改成 "' + PROVIDER_KEYS[0] + '"，然后重启服务。');
  }
  if (id === 'tikhub' || id === 'rnote') {
    throw cerr('数据源「' + id + '」已移除 —— 现在只保留 RedFox 红狐。' +
      '把 config.local.json 的 xhsProvider 改成 "' + PROVIDER_KEYS[0] + '"，然后重启服务。');
  }
  const p = ALL_PROVIDERS[id];
  if (!p) throw cerr('未知的数据源厂商：' + id + '（可选：' + PROVIDER_KEYS.join(' / ') + '）');
  if (!(opt && opt.ignoreKey) && p.needKey && !hasKey(cfg)) {
    throw cerr(p.label + ' 还没配 API Key：请到「设置 → ' + p.label + '密钥」里添加并启用（可以加多个，用轮换策略分摊）。');
  }
  return p;
}

/** 统一调用入口：把 ctx 补齐后交给厂商实现 */
async function extractNote(cfg, input) {
  const p = getProvider(cfg);
  const raw = txt(input && input.url);
  if (!raw) throw cerr('缺少 url');

  const shareUrl = extractUrl(raw);
  // 明显无效的输入提前拦下 —— 每次调用都会消耗红狐积分，别浪费
  if (!/^https?:\/\//.test(shareUrl)) {
    throw cerr('这看起来不是一个链接：' + raw.slice(0, 60));
  }

  const keys = normKeys(cfg && cfg.keys);
  const ctx = {
    base: txt((cfg && cfg.base) || p.defaultBase).replace(/\/+$/, ''),
    key: pickKey(cfg),                       // 本次调用实际用的那一个（多密钥时按策略挑）
    keys,                                    // 全部可用密钥（需要换 key 重试时用得上）
    keyCount: keys.length,
    strategy: txt(cfg && cfg.strategy) || 'priority',
    shareText: shareUrl,
    noteId: pickNoteId(shareUrl),
    wantVideo: input && input.wantVideo !== false,
    log: (cfg && cfg.log) || null,
    mockVideoUrl: txt(cfg && cfg.mockVideoUrl),
  };
  if (!ctx.base && p.needBase) throw cerr(p.label + ' 未配置接口地址（xhsBase）');

  return await p.extractNote(ctx);
}

/* 对外只暴露上层真正用到的东西：collector.cjs 用前三个，
 * MOBILE_UA 也被 collector.cjs 的媒体代理拿去用（小红书系域名只认移动端 UA）。
 * pickNoteId / extractUrl / req / pickKey / hasKey / normKeys / PROVIDERS 都是内部实现，
 * 不再导出 —— 少几个「以为有人用、其实没人用」的入口。 */
module.exports = { getProvider, extractNote, listProviders, MOBILE_UA };
