#!/usr/bin/env node
/* ============================================================
 * RedBuddy 本地代理
 * ------------------------------------------------------------
 * 为什么需要它：RedFox / Agnes 都不适合浏览器直连（CORS、密钥暴露），
 * 这个零依赖 Node 服务把两件事收口到本机：
 *
 *   A. 小红书内容获取（「短链 → 笔记原文 / 视频口播」）—— 见 collector.cjs
 *   B. Agnes 大模型调用（「笔记拆解」页的结构化拆解，OpenAI 兼容）
 *   C. Agnes 出图（「封面制作」的文生图，agnes-image-2.5-flash）
 *
 * 路由：
 *   POST /api/note/decompose   笔记（标题/正文/口播）→ Agnes 结构化拆解
 *   POST /api/title/generate   主题 / 原标题 → Agnes 批量出小红书标题（带评分与合规）
 *   POST /api/image/generate   文生图（小红书封面）→ Agnes 出图
 *   GET  /api/image/proxy      图片直链代理（出图结果兜底显示）
 *   GET  /api/xhs/providers    小红书数据源列表
 *   GET  /api/xhs/env          数据源自检
 *   POST /api/xhs/extract      短链 → RedFox 取回笔记原文
 *   POST /api/xhs/transcribe   视频 → 文案描述（RedFox 服务端转写）
 *   GET  /api/xhs/media        媒体直链代理（视频播放兜底，绕开 CDN 的 Referer 检查）
 *   GET  /healthz              自检
 *   GET  /                     直接托管 index.html
 *
 * ★ 密钥：这个服务**不持有任何密钥**。
 *   RedFox / Agnes 的 Key 全部在前端「设置」页里配（存浏览器 localStorage），
 *   随每次请求放在 body 里传上来（RedFox → body.keys；Agnes → body.llm.keys）。
 *   服务端只转发，不读环境变量、不读 config.local.json、不落盘。
 *   没配就返回明确的 400，提示去「设置」里填。
 *   （历史包袱：以前支持 config.local.json / 环境变量兜底，结果被 stale 的 Key
 *    静默带偏过好几次 —— 比如一个已失效的旧 REDFOX_API_KEY 一直盖住新 Key。
 *    2026-10-06 整体移除，只留「设置页」一条路。）
 *
 * Base 取值：
 *   RedFox → config.local.json 的 redfoxBase（默认 https://redfox.hk）
 *   Agnes  → 固定 https://api.agnes-ai.cn/v1（中国大陆线路），不可覆盖
 *
 * 启动：node server.js      （或 npm start）
 * 自检：curl http://127.0.0.1:8090/healthz
 * ============================================================ */
'use strict';

const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { Readable } = require('stream');         // 图片代理：把上游响应体转成流直接转发
const Collector = require('./collector.cjs');   // 小红书内容获取：数据源取原文 + RedFox 服务端转写
const { rootCause } = require('./neterr.cjs');  // 把 fetch 的「fetch failed」还原成真因（DNS / TLS / 拒绝连接…）

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(level, msg){
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  process.stdout.write('[' + t + '] ' + level.toUpperCase() + '  ' + msg + '\n');
}

/* ---------- 配置 ---------- */

/* ★ 这里刻意**不读任何密钥**（不读环境变量、不读 config.local.json）。
 *   Key 只有一条来源：前端「设置」页 → 请求体。少一条来源 = 少一种「静默用错 Key」。 */
function loadConfig(){
  const file = path.join(__dirname, 'config.local.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
  catch (e){ if (e.code !== 'ENOENT') log('warn', 'config.local.json 解析失败，已忽略：' + e.message); }
  const trim = v => String(v || '').trim().replace(/\/+$/, '');

  const redfoxBase = trim(process.env.REDFOX_BASE || cfg.redfoxBase || 'https://redfox.hk');

  /* 小红书数据源：只有一个来源 —— config.local.json / 环境变量，**默认 redfox**。
   * 前端不再参与选择（「设置」页那张数据源卡片已于 2026-10-08 移除），只会把这里读到的值原样带回来。
   * 另有一个隐藏的 mock（本地假数据、离线自检），只能在 config.local.json 里手动指定。
   *
   * ★ 默认值必须是 'redfox'，不能留空 —— 现在只有一家厂商，要求用户显式配一遍没有任何收益，
   *   反而会让「拷走文件夹直接跑」的人第一次提取就撞上「还没配置小红书数据源」。
   *   （2026-10-09 修：原来写的是 `cfg.xhsProvider || ''`，与本节注释、config.example.json、
   *     README、install.sh 四处都写的「默认 redfox」不一致。） */
  const xhsProvider = String(process.env.XHS_PROVIDER || cfg.xhsProvider || 'redfox').trim().toLowerCase();
  const isRedfox = xhsProvider === 'redfox';
  const xhsBase = trim(process.env.XHS_API_BASE || cfg.xhsBase || '') || (isRedfox ? redfoxBase : '');
  /* 隐藏的 mock 数据源用的「假视频」地址：配了就能离线跑通「短链 → 视频 → RedFox 转写」整条链路 */
  const mockVideoUrl = String(process.env.MOCK_VIDEO_URL || cfg.mockVideoUrl || '').trim();

  return {
    port:       Number(process.env.PORT || cfg.port || 8090),
    host:       process.env.HOST || cfg.host || '127.0.0.1',
    redfoxBase,
    agnesBase:  'https://api.agnes-ai.cn/v1',   // 固定：Agnes 只走中国大陆线路，不接受环境变量/配置覆盖
    agnesModel: String(process.env.AGNES_MODEL || cfg.agnesModel || 'agnes-2.5-flash').trim(),
    xhsProvider, xhsBase, mockVideoUrl,
  };
}
const CONFIG = loadConfig();

/* ---------- 小工具 ---------- */
function httpError(status, message){
  const e = new Error(message);
  e.status = status;
  return e;
}
function sendJson(res, status, obj){
  const body = JSON.stringify(obj);
  if (!res.headersSent){
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  res.end(body);
}
function setCors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-RedFox-Key, X-RedFox-Base, X-Agnes-Base, X-Agnes-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function readBody(req, limit){
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit){ reject(httpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit){
  const raw = await readBody(req, limit || 1024 * 1024);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch (e){ throw httpError(400, '请求体不是合法 JSON'); }
}
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clampStr(s, n){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
/* 保留换行的版本 —— 只给「仿写正文」（rewrites.body）用。
 * clampStr 会把 \n 压成空格，多段正文压平后变成一大坨，必须用这个。 */
function clampText(s, n){
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, n);
}

/* ---------- 上游请求 ---------- */
async function fetchJson(url, opts){
  let r;
  try { r = await fetch(url, opts); }
  catch (e){ throw httpError(502, '连不上 ' + new URL(url).host + '：' + rootCause(e)); }
  const txt = await r.text();
  let json;
  try { json = JSON.parse(txt); }
  catch (e){ throw httpError(502, '上游返回非 JSON（HTTP ' + r.status + '）：' + txt.slice(0, 200)); }
  return { status: r.status, json };
}

/* ---------- Agnes（OpenAI 兼容）---------- */
let rotateIdx = -1;
function pickKey(keys, strategy){
  const list = keys.filter(Boolean);
  if (!list.length) return '';
  if (strategy === 'random') return list[Math.floor(Math.random() * list.length)];
  if (strategy === 'rotate'){ rotateIdx = (rotateIdx + 1) % list.length; return list[rotateIdx]; }
  return list[0];
}
async function agnesChatOnce(opts){
  const url = opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const { status, json } = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + opts.key, 'User-Agent': UA },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature == null ? 0.3 : opts.temperature,
      max_tokens: opts.maxTokens || 2000,
      /* Agnes 推理模型：关掉思考过程，否则 reasoning_tokens 会吃掉预算。
       * 注意必须是 chat_template_kwargs.enable_thinking —— 官方参数表里没有顶层 enable_thinking，
       * 写成顶层等于没传（之前就是这么写的，等于没生效）。 */
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (status >= 400){
    const msg = (json && json.error && json.error.message) || (json && json.message) || ('HTTP ' + status);
    const e = httpError(status === 401 ? 401 : 502, 'Agnes 调用失败：' + msg);
    e.retryable = status === 429 || status >= 500;
    throw e;
  }
  const ch = (json && json.choices && json.choices[0]) || {};
  const content = ch.message && ch.message.content;
  const u = (json && json.usage) || {};
  /* 把用量打出来：一是方便对账（Agnes 2.5 Flash 官方文档写当前 $0/1M tokens，但以账户为准），
   * 二是 finish_reason=length 时能立刻看出是被 max_tokens 截断而不是模型写坏了。 */
  log('info', 'Agnes 用量：prompt=' + (u.prompt_tokens == null ? '?' : u.prompt_tokens) +
    ' completion=' + (u.completion_tokens == null ? '?' : u.completion_tokens) +
    (u.total_tokens == null ? '' : ' total=' + u.total_tokens) +
    ' finish=' + (ch.finish_reason || '?'));
  if (ch.finish_reason === 'length') log('warn', '⚠ Agnes 输出被 max_tokens 截断，考虑调大 maxTokens');
  if (!content){
    const why = ch.finish_reason === 'length' ? '内容被 max_tokens 截断' : '返回为空';
    throw httpError(502, 'Agnes 未返回内容（' + why + '）：' + JSON.stringify(json).slice(0, 200));
  }
  return content;
}
/* 多密钥容错：priority 顺序试、rotate 从上次的下一个开始、random 打散；遇到可重试错误换下一个 */
async function agnesChat({ baseUrl, keys, strategy, model, messages, temperature, maxTokens }){
  const pool = (keys || []).filter(Boolean);
  if (!pool.length) throw httpError(400, '未配置 Agnes 密钥：请到「设置 → Agnes 密钥」里添加并启用（可以加多个，用轮换策略分摊）');
  const primary = pickKey(pool, strategy);
  const order = [primary].concat(pool.filter(k => k !== primary));
  const tries = order.slice(0, Math.min(3, order.length));   // 最多试 3 把，避免一把坏 Key 拖很久
  let lastErr;
  for (let i = 0; i < tries.length; i++){
    try { return await agnesChatOnce({ baseUrl, key: tries[i], model, messages, temperature, maxTokens }); }
    catch (e){
      lastErr = e;
      if (!e.retryable || i === tries.length - 1) throw e;
      log('warn', 'Agnes 密钥失败，换下一个重试：' + e.message);
    }
  }
  throw lastErr;
}
/* 扫一遍「像 JSON 的文本」：转义字符串里的裸控制字符，并记录括号有没有闭合。
 * 真模型（Agnes）实测会做几件让 JSON.parse 直接炸的事：
 *   ① 提示词里禁了代码块，它照样套一层 ```json；
 *   ② 多段正文（rewrites.body）里写**真实换行**，JSON 规范不允许；
 *   ③ 被 max_tokens 截断，尾部括号不闭合。
 * 所以解析不能只有一步 JSON.parse，要能自愈。 */
function sanitizeJsonish(t, loose){
  let out = '', inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < t.length; i++){
    const ch = t[i];
    if (inStr){
      if (esc){ out += ch; esc = false; continue; }
      if (ch === '\\'){ out += ch; esc = true; continue; }
      if (ch === '"'){
        if (loose){
          /* loose 模式：判断这个引号到底是「字符串结束」还是「字符串里的裸引号」。
           * 真正的结束引号后面一定紧跟结构符（, } ] :）或文本结束；
           * 否则就是模型手写的强调引号（实测：满足"我也想这样"的身份投射），转义掉。
           * 对本来就合法的 JSON，串内引号都已转义、走 esc 分支，不会走到这里 → 结果不变。 */
          let k = i + 1;
          while (k < t.length && (t[k] === ' ' || t[k] === '\t' || t[k] === '\n' || t[k] === '\r')) k++;
          const nx = t[k];
          if (nx === ',' || nx === '}' || nx === ']' || nx === ':' || nx === undefined){ inStr = false; out += ch; }
          else { out += '\\"'; }
          continue;
        }
        out += ch; inStr = false; continue;
      }
      if (ch === '\n'){ out += '\\n'; continue; }        // 裸换行 → \n
      if (ch === '\r'){ out += '\\r'; continue; }
      if (ch === '\t'){ out += '\\t'; continue; }
      if (ch.charCodeAt(0) < 0x20){ out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      out += ch; continue;
    }
    if (ch === '"'){ inStr = true; out += ch; continue; }
    if (ch === '{' || ch === '['){ stack.push(ch === '{' ? '}' : ']'); out += ch; continue; }
    if (ch === '}' || ch === ']'){
      if (stack[stack.length - 1] === ch){
        if (loose && stack.length === 1){
          /* 只剩根这一层了 —— 看后面还有没有兄弟成员。
           * 真模型实测会写成 `..."rewrites":{...}}, "demand":{...}}`：
           * 多一个 } 把根对象提前闭合，后面却还跟着 , "demand"。
           * 判定：这个 } 后面紧跟 , → 它是多余的，丢掉（不 pop、不输出）。 */
          let k = i + 1;
          while (k < t.length && (t[k] === ' ' || t[k] === '\t' || t[k] === '\n' || t[k] === '\r')) k++;
          if (t[k] === ',') continue;
        }
        stack.pop(); out += ch; continue;
      }
      if (loose){
        /* 对不上时先看栈里更深处有没有同类型的括号：
         *   有 → 模型漏写了中间层的闭合符（实测：risks 数组少一个 ]），
         *        把中间层补上，再闭合它；
         *   没有 → 这个括号纯属多余，丢掉。 */
        const idx = stack.lastIndexOf(ch);
        if (idx >= 0){
          for (let j = stack.length - 1; j > idx; j--) out += stack[j];   // 补上漏掉的闭合符
          stack.length = idx;                                            // 连同匹配层一起弹出
          out += ch; continue;
        }
        continue;
      }
      out += ch; continue;
    }
    out += ch;
  }
  return { text: out, inStr, stack };
}
function extractJson(s){
  let t = String(s || '').trim();
  t = t.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '').replace(/\r?\n?```[ \t]*$/, '').trim();
  const a = t.indexOf('{');
  if (a > 0) t = t.slice(a);
  /* 真模型实测会写成 [keyPoints]: [...] —— 键名被方括号包住了，JSON 不允许。
   * 只修「方括号里是一个合法标识符、且后面紧跟冒号」的情况，不会碰坏正文里的方括号。 */
  t = t.replace(/\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*:/g, '"$1":');

  const cands = [];
  const push = x => { if (x && cands.indexOf(x) < 0) cands.push(x); };
  let truncated = false;

  /* 两轮扫描：strict 只转义控制字符；loose 额外修「字符串里的裸引号」。
   * 合法的 JSON 两轮结果完全一样，所以不会把本来正确的输出改坏。 */
  for (const loose of [false, true]){
    const san = sanitizeJsonish(t, loose);
    let base = san.text;
    const cut = san.inStr || san.stack.length > 0;
    if (cut) truncated = true;
    /* 只有「括号已经闭合」才允许按最后一个 } 截尾；截断的不能截，否则会切掉有效内容 */
    if (!cut){
      const b = base.lastIndexOf('}');
      if (b >= 0) base = base.slice(0, b + 1);
    }
    const noTrail = base.replace(/,(\s*[}\]])/g, '$1');     // 去掉 } / ] 前多余逗号
    push(base); push(noTrail);
    if (cut){
      /* 真被截断：给没写完的字符串补个引号，再按栈把括号补齐 —— 残缺但可用，
       * 比整条链路 502 好；归一化那层本来就会把缺的字段兜成默认值。 */
      let closed = noTrail;
      if (san.inStr) closed += '"';
      for (let i = san.stack.length - 1; i >= 0; i--) closed += san.stack[i];
      push(closed); push(closed.replace(/,(\s*[}\]])/g, '$1'));
    }
  }
  for (const cand of cands){
    try { return JSON.parse(cand); } catch (e) { /* 换下一种修法 */ }
  }
  const err = new Error('Agnes 返回的拆解不是合法 JSON' +
    (truncated ? '（像是被 max_tokens 截断，尾部没闭合）' : '（语法错误）') +
    '。开头：' + t.slice(0, 180) + ' …… 结尾：' + t.slice(-180));
  err.raw = t;
  throw err;
}

/* ---------- 笔记拆解：Agnes ----------
 * 输出字段对齐 SKILL LZ.docx（XHS-Note-Analyst）的 7 步流程，并拆成前端报告的 8 个分节：
 *   01封面分析 02标题拆解 03正文结构 04标签策略 05互动率判断 06爆款因子 07风险点 08需求与任务
 * （仿写不在报告里，是独立一页，用 rewrites 字段。原文逐句诊断 / marks 已按用户要求移除，
 *   原先模型要输出一大堆「逐字照抄原文」的中文长文本，前端根本不渲染 —— 纯浪费。）
 */
const DECOMPOSE_SCHEMA = [
  '{"summary":"一句话总评，40 字内",',
  '"scores":{"cover":86,"title":72,"structure":88,"tag":60,"engagement":91},',
  '"coverAnalysis":{"hookType":"封面钩子类型（反常识型/数字型/对比型/痛点型…）","subject":"画面主体","text":"画面文字","tone":"色调","composition":"构图","emotion":"情绪","reusable":["可复用元素1","可复用元素2"]},',
  '"titleFormula":"标题配方（拆成可复用的公式）",',
  '"titleParts":[{"seg":"标题里的一段原文","role":"这段的作用（如：数字锚点）"}],',
  '"titleChecks":{"formulas":"命中的公式","tension":"张力元素几个、达不达标","length":"字数评价（小红书标题上限 20 字）","audience":"人群 / 场景词","template":"可套用的模板"},',
  '"hook":"开头钩子分析",',
  '"structure":[{"name":"段落 / 环节名","desc":"这一段在做什么"}],',
  '"rhythm":"段落节奏（段数、长短、信息密度）",',
  '"keyPoints":["核心干货点"],',
  '"tagPlan":{"existing":["笔记现有的标签"],"categories":"覆盖了哪几类、缺哪几类","missing":["建议补的标签"]},',
  '"engagement":"互动率判断（收藏率 / 评论率说明什么、短板在哪）",',
  '"interaction":"互动引导设计（结尾怎么引导的）",',
  '"visual":"封面与配图 / 画面与节奏",',
  '"hotFactors":["命中的爆款要素"],',
  '"formula":"可复用的创作公式",',
  '"risks":[{"level":"高|中|低","text":"风险点是什么","fix":"怎么改"}],',
  '"rewrites":{"titles":["仿写标题1","仿写标题2","仿写标题3"],"body":"仿写正文","tags":["建议标签"],"cover":"封面设计建议"},',
  '"demand":{"needs":[{"name":"情感共鸣|见证成长|获得新知|学习提升|身份表达","level":"强|中|弱","why":"为什么"}],"task":"拉新|建立信任|强化标签","taskWhy":"为什么"}}',
].join('');

const SYS_COMMON = [
  '要求：结论要具体、可复用，能落到写作动作上；不要空话、不要"建议优化标题"这种没信息量的话。',
  'scores 的五个分是 0-100 的整数，按"这篇笔记在这个维度做得好不好"打分，不要都给高分。',
  'risks 给 2-4 条，每条必须能被作者直接照着改。',
  '严格只输出一个 JSON 对象，不要 markdown 代码块，不要任何额外文字。',
  '数组元素之间只用逗号分隔：不要写序号、不要写注释、不要写多余的 { 或 }（例如不能出现 {7,"level":"高"} 这种把序号塞进对象里的写法）。',
].join('\n');

const SYS_NORMAL = [
  '你是资深小红书图文笔记拆解师。基于给定的笔记（标题+正文+互动数据）输出结构化拆解。',
  SYS_COMMON,
].join('\n');

const SYS_VIDEO = [
  '你是资深小红书视频笔记拆解师。基于给定的笔记（标题+描述+口播逐字稿+互动数据）输出结构化拆解。',
  '重点关注：前3秒钩子、口播节奏与转折、信息密度、情绪起伏、结尾互动引导。',
  SYS_COMMON,
].join('\n');

function buildDecomposePrompt(info, schema){
  return [
    '今天是 ' + new Date().toISOString().slice(0, 10) + '。',
    '',
    '【笔记信息】',
    info,
    '',
    '【输出 JSON 结构】',
    schema,
    '',
    '字段说明：',
    '· summary / titleFormula / hook / rhythm / engagement / interaction / visual / formula 各一段文字；',
    '· structure 给 3-6 段；titleParts 给 2-5 段（按标题原文顺序切）；',
    '· keyPoints / hotFactors 各 3-5 条；risks 2-4 条；',
    '· rewrites.titles 给 3-5 个（每个 ≤20 字）；rewrites.tags 给 8-10 个；',
    '· rewrites.body 是完整的仿写正文，必须写成能直接发布的一整篇（分段、有开头结尾），字数 ≥ 原文正文 / 口播逐字稿字数的 80%；只给提纲、开头几句或半截正文不合格；',
    '· demand.needs 按"情感共鸣 / 见证成长 / 获得新知 / 学习提升 / 身份表达"这五类逐条给，缺的也要写（level 填"弱"）。',
  ].join('\n');
}

function pickLlm(body){
  const llm = body.llm || {};
  return {
    baseUrl:  CONFIG.agnesBase,   // 固定：只走 api.agnes-ai.cn，忽略前端传入
    model:    String(llm.model || CONFIG.agnesModel),
    keys:     Array.isArray(llm.keys) ? llm.keys : [],
    strategy: ['priority', 'rotate', 'random'].indexOf(llm.strategy) >= 0 ? llm.strategy : 'priority',
  };
}

async function handleDecompose(req, res){
  const body = await readJson(req, 2 * 1024 * 1024);
  const note = body.note || {};
  const transcript = String(body.transcript || '').trim();
  const fallbackText = String(body.text || '').trim();

  const isVideo = String(note.type || '').toLowerCase() === 'video' || !!transcript;
  const content = transcript || String(note.desc || '').trim() || fallbackText;
  if (!content && !note.title) throw httpError(400, '没有可拆解的内容');

  const llm = pickLlm(body);
  const lines = [
    '标题：' + (note.title || '（无）'),
    '类型：' + (isVideo ? '视频笔记' : '图文笔记'),
    note.author ? ('作者：' + note.author) : '',
    note.publishTime ? ('发布时间：' + note.publishTime) : '',
    (note.like != null ? ('互动数据：点赞 ' + note.like + ' / 收藏 ' + note.collect + ' / 评论 ' + note.comment + ' / 分享 ' + note.share) : ''),
    '',
    isVideo
      ? ('【口播逐字稿】\n' + (transcript || '（未取到口播，只有描述，请基于描述谨慎拆解）'))
      : ('【正文】\n' + content),
  ];
  if (isVideo && note.desc) lines.push('', '【笔记描述】', String(note.desc));
  else if (!isVideo && note.title && content && content !== note.desc) lines.push('', '【描述】', String(note.desc || ''));

  /* Agnes 没有 JSON 模式（官方参数表里没有 response_format），实测模型偶尔会写坏 JSON：
   * 代码块、字符串里裸换行/裸引号、漏一个 ] 、多一个 } …… extractJson 能自愈大部分，
   * 修不了的再给模型一次机会（把错在哪告诉它），比直接 502 有用得多。最多只重试 1 次。 */
  const messages = [
    { role: 'system', content: isVideo ? SYS_VIDEO : SYS_NORMAL },
    { role: 'user', content: buildDecomposePrompt(lines.filter(Boolean).join('\n'), DECOMPOSE_SCHEMA) },
  ];
  let out = '', parsed = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++){
    out = await agnesChat({
      baseUrl: llm.baseUrl, keys: llm.keys, strategy: llm.strategy, model: llm.model,
      temperature: attempt === 1 ? 0.3 : 0.1,      // 重试时降温度，减少乱写
      maxTokens: 8000,
      messages,
    });
    try { parsed = extractJson(out); lastErr = null; break; }
    catch (e){
      lastErr = e;
      log('warn', '第 ' + attempt + ' 次拆解 JSON 解析失败：' + (e && e.message));
      /* 每次失败都把原文落盘（文件名带 attempt），方便事后看模型到底写坏在哪。
       * 落在**系统临时目录**，不往项目里塞文件 —— 项目目录保持干净，也不怕目录被清掉后写失败。 */
      try { fs.writeFileSync(path.join(os.tmpdir(), 'redbuddy-decompose-raw-' + Date.now() + '-a' + attempt + '.txt'), String(out || '')); } catch (e2) {}
      if (attempt === 1){
        messages.push({ role: 'user', content:
          '你上一次的输出不是合法 JSON，无法解析：' + ((e && e.message) || '') + '\n' +
          '请重新输出**完整、合法**的 JSON：不要 ``` 代码块、不要任何多余文字；' +
          '字符串内部不能有真实换行（要写 \\n）；每个 { } [ ] 都必须闭合；最后一个成员后面不要逗号。' });
      }
    }
  }
  if (!parsed) throw httpError(502, (lastErr && lastErr.message) || ('Agnes 返回的拆解不是合法 JSON：' + clampStr(out, 200)));

  const arr = (v, n) => (Array.isArray(v) ? v : []).map(x => clampStr(x, 300)).filter(Boolean).slice(0, n || 6);
  const int01 = v => Math.max(0, Math.min(100, Math.round(num(v))));
  /* fields 默认裁到 60 字；需要更长的字段用 lim 单独指定（别再在外面补一次 map，那样只会二次截断） */
  const objArr = (v, fields, n, lim) => (Array.isArray(v) ? v : [])
    .map(x => { const o = {}; fields.forEach(f => { o[f] = clampStr(x && x[f], (lim && lim[f]) || 60); }); return o; })
    .filter(o => fields.some(f => o[f]))
    .slice(0, n || 8);

  const struct = objArr(parsed.structure, ['name', 'desc'], 8, { name: 40, desc: 240 })
    .filter(x => x.name || x.desc);

  /* scores：模型没给或给了非法值就置 0，前端会隐藏那个分数而不是显示 0 */
  const sc = parsed.scores || {};
  const scores = {
    cover:      int01(sc.cover),
    title:      int01(sc.title),
    structure:  int01(sc.structure),
    tag:        int01(sc.tag),
    engagement: int01(sc.engagement),
  };

  const ca = parsed.coverAnalysis || {};
  const coverAnalysis = {
    hookType:    clampStr(ca.hookType, 40),
    subject:     clampStr(ca.subject, 200),
    text:        clampStr(ca.text, 200),
    tone:        clampStr(ca.tone, 200),
    composition: clampStr(ca.composition, 200),
    emotion:     clampStr(ca.emotion, 200),
    reusable:    arr(ca.reusable, 5),
  };

  const tc = parsed.titleChecks || {};
  const titleChecks = {
    formulas: clampStr(tc.formulas, 200),
    tension:  clampStr(tc.tension, 200),
    length:   clampStr(tc.length, 200),
    audience: clampStr(tc.audience, 200),
    template: clampStr(tc.template, 300),
  };

  const tp = parsed.tagPlan || {};
  const tagPlan = {
    existing:   arr(tp.existing, 12),
    categories: clampStr(tp.categories, 240),
    missing:    arr(tp.missing, 12),
  };

  const rw = parsed.rewrites || {};
  const rewrites = {
    titles: arr(rw.titles, 6),
    body:   clampText(rw.body, 4000),          // 保留换行：正文是多段的
    tags:   arr(rw.tags, 14),
    cover:  clampStr(rw.cover, 400),
  };

  const dm = parsed.demand || {};
  const demand = {
    needs: (Array.isArray(dm.needs) ? dm.needs : []).map(x => ({
      name:  clampStr(x && x.name, 20),
      level: clampStr(x && x.level, 4),
      why:   clampStr(x && x.why, 200),
    })).filter(x => x.name).slice(0, 6),
    task:    clampStr(dm.task, 20),
    taskWhy: clampStr(dm.taskWhy, 240),
  };

  log('info', '笔记拆解  类型=' + (isVideo ? '视频' : '图文') +
      '  正文=' + content.length + ' 字  模型=' + llm.model);

  sendJson(res, 200, {
    ok: true,
    type: isVideo ? 'video' : 'normal',
    analysis: {
      summary:      clampStr(parsed.summary, 300),
      scores,
      coverAnalysis,
      titleFormula: clampStr(parsed.titleFormula, 300),
      titleParts:   objArr(parsed.titleParts, ['seg', 'role'], 8),
      titleChecks,
      hook:         clampStr(parsed.hook, 400),
      structure:    struct,
      rhythm:       clampStr(parsed.rhythm, 400),
      keyPoints:    arr(parsed.keyPoints, 6),
      tagPlan,
      engagement:   clampStr(parsed.engagement, 400),
      interaction:  clampStr(parsed.interaction, 400),
      visual:       clampStr(parsed.visual, 400),
      hotFactors:   arr(parsed.hotFactors, 6),
      formula:      clampStr(parsed.formula, 400),
      risks:        objArr(parsed.risks, ['level', 'text', 'fix'], 6, { level: 10, text: 300, fix: 400 }),
      rewrites,
      demand,
    },
  });
}

/* ---------- 图像生成：Agnes（agnes-image-2.5-flash）----------
 * 与「笔记拆解」共用同一把 Agnes 密钥（前端「设置 → Agnes 密钥」，随请求放在 body.llm.keys）。
 * 服务端同样不持有任何 Key —— 没带就明确报错让用户回设置页配。
 *
 * ★ 三个必须照抄的坑（来自 agnes-image skill 的实测结论，写错就 400 或静默失效）：
 *   ① response_format 必须放进 extra_body 里，放请求体顶层会被忽略或报错；
 *   ② 文生图要 base64 用顶层 return_base64:true，不是 extra_body.response_format；
 *   ③ 图生图不要传 tags:["img2img"]，只在 extra_body.image 里给输入图。
 *   （本接口目前只做文生图，②③ 先留着，接图生图时别踩。）
 *
 * ★ 模型名不能用 CONFIG.agnesModel（那是对话模型 agnes-2.5-flash），出图必须用
 *   agnes-image-2.5-flash —— 所以这里不复用 pickLlm 的 model 字段。
 *   （2026-10-08 由 agnes-image-2.1-flash 升到 2.5-flash；探针 + 真实出图都验过。
 *     回退只需把这一行改回 'agnes-image-2.1-flash'。）
 *
 * ★ 出图：走的是独立链路，和对话拆解是两次不同的调用。前端点一次「生成」就是一次真实出图。
 */
const IMG_MODEL  = 'agnes-image-2.5-flash';
const IMG_SIZES  = ['1K', '2K', '3K', '4K'];
const IMG_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

async function agnesImageOnce(opts){
  const url = opts.baseUrl.replace(/\/+$/, '') + '/images/generations';
  const payload = { model: opts.model, prompt: opts.prompt, size: opts.size };
  if (opts.ratio && opts.ratio !== '1:1') payload.ratio = opts.ratio;
  if (opts.images && opts.images.length){
    payload.extra_body = { image: opts.images, response_format: 'url' };   // 图生图
  } else if (opts.b64){
    payload.return_base64 = true;                                          // 文生图要 base64
  } else {
    payload.extra_body = { response_format: 'url' };
  }

  const { status, json } = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + opts.key, 'User-Agent': UA },
    body: JSON.stringify(payload),
  });
  if (status >= 400){
    const msg = (json && json.error && json.error.message) || (json && json.message) || ('HTTP ' + status);
    const e = httpError(status === 401 ? 401 : 502, 'Agnes 出图失败：' + msg);
    e.retryable = status === 429 || status >= 500;
    throw e;
  }
  const item = (json && json.data && json.data[0]) || {};
  if (!item.url && !item.b64_json){
    throw httpError(502, 'Agnes 没返回图片：' + JSON.stringify(json).slice(0, 200));
  }
  return item;
}

async function handleImageGenerate(req, res){
  const body   = await readJson(req, 2 * 1024 * 1024);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw httpError(400, '缺少 prompt：要生成什么画面，得先写一句');

  const size  = IMG_SIZES.indexOf(String(body.size))   >= 0 ? String(body.size)  : '2K';
  const ratio = IMG_RATIOS.indexOf(String(body.ratio)) >= 0 ? String(body.ratio) : '3:4';

  /* 密钥：与拆解同源（body.llm.keys），复用同一套「多 Key 容错 + 轮换策略」 */
  const llm   = pickLlm(body);
  const model = String(body.model || '').trim() || IMG_MODEL;
  const pool  = llm.keys.filter(Boolean);
  if (!pool.length) throw httpError(400, '未配置 Agnes 密钥：请到「设置 → Agnes 密钥」里添加并启用（出图和拆解共用这把 Key）');

  const primary = pickKey(pool, llm.strategy);
  const order   = [primary].concat(pool.filter(k => k !== primary));
  const tries   = order.slice(0, Math.min(3, order.length));   // 最多试 3 把，别让一把坏 Key 拖很久
  let lastErr = null, item = null;
  for (let i = 0; i < tries.length; i++){
    try {
      item = await agnesImageOnce({ baseUrl: llm.baseUrl, key: tries[i], model, prompt, size, ratio, b64: !!body.base64 });
      lastErr = null; break;
    } catch (e){
      lastErr = e;
      if (!e.retryable || i === tries.length - 1) throw e;
      log('warn', '出图密钥失败，换下一个重试：' + e.message);
    }
  }
  if (lastErr) throw lastErr;

  log('info', 'Agnes 出图  模型=' + model + '  尺寸=' + size + '  比例=' + ratio +
      '  ' + (item.url ? 'URL' : 'Base64') + '  prompt=' + prompt.length + ' 字');
  sendJson(res, 200, {
    ok: true, model, size, ratio,
    url: item.url || '',
    b64: item.b64_json || '',
  });
}

/* ---------- 标题生成：Agnes（space-xhs-title 的流程）----------
 * 与「笔记拆解」共用同一把 Agnes 密钥（body.llm.keys）。
 * 流程照抄 skill：建内容简报 → 按内容类型路由到不同标题方法 → 多方法批量生成
 *   → 逐条评分 / 去重 / 合规校验 → Top5 按用途分角色 → A/B 建议。
 *
 * ★ 关键约束（写进提示词，不靠模型自觉）：
 *   ① 硬上限 20 字符，最佳 13~18；超了要自己砍到 18 以内再进评分；
 *   ② 小红书是搜索型社区 —— 标题里必须有一个用户真会打进搜索框的名词，
 *      没有就要扣 15 分（这一条权重高于一切）；
 *   ③ 不许往标题里加正文没有的东西：可以留缺口，不能撒谎。
 *
 * ★ 模型：走对话模型（CONFIG.agnesModel），和拆解一样是对话调用。
 */
const TITLE_SYS = [
  '你是资深小红书标题策划。你只做一件事：给一条笔记起一批能被点开、也能被搜到的标题。',
  '',
  '【平台事实，先记住，别用公众号的直觉写小红书】',
  '· 硬上限 20 个字符（emoji 也占位），最佳区间 13~18 字。超过 20 字会被平台截断，句尾信息直接丢失。',
  '· 小红书是搜索型社区：笔记除了信息流分发，还持续吃搜索和「搜索后推荐」的流量。',
  '  标题里没有用户会打进搜索框的词 = 放弃长尾。这一条权重最高。',
  '· 一个押准的搜索词，胜过三个堆上去的关键词。20 字的预算里，与其塞满品类词，',
  '  不如把一个主搜索词写完整（「油皮粉底液」优于「美妆 好物 粉底 推荐」）。堆无关关键词会被判营销。',
  '· 强第一人称、强口语：我 / 姐妹们 / 谁懂啊 / 救命 / 真的会谢。书面腔在小红书是劝退信号。',
  '· emoji 是标配不是克制项：1~2 个，句首吸睛或句尾定情绪。别超过 3 个，堆满会被识别为营销号。',
  '· 人群标签前置：学生党 / i人 / 小个子 / 新手妈妈 / 油皮 / 通勤党 / 预算党 —— 让读者半秒确认「说的是我」。',
  '· 高收藏结构吃香：数字清单 + 建议收藏 / 码住 / 照抄就行。',
  '· 负向选题表现极强：踩雷 / 别买 / 劝退 / 后悔没早知道 —— 避雷类点击率长期高于种草类。',
  '· 符号习惯：｜（竖线）做分区最常见，其次感叹号、问号、括号补语。冒号不如公众号常用。',
  '',
  '【15 种标题方法，用下面的标准名，公式照着套】',
  '1 人群标签前置：[人群词]｜[他们的具体处境] + [结果]',
  '2 搜索词卡位：[核心搜索词] + [限定条件] + [差异化后缀]',
  '3 数字清单+收藏指令：[数字] + [品类/方法] + [建议收藏/码住/直接抄]',
  '4 避雷劝退：[品类/行为] + 别买/别踩/千万别 + [代价]，或 我踩过的[N]个坑',
  '5 后悔体：后悔/居然/竟然 + 没早知道 + [具体的事]',
  '6 情绪惊叹：救命/天呐/谁懂啊/真的会谢 + [对象] + [强反应]（必须配具体对象，不能单独用）',
  '7 亲测对比：[时长/动作] 后，[可观测的变化]，或 [A] vs [B]',
  '8 保姆级教程：零基础/新手/小白 + [目标] + 保姆级/N步搞定',
  '9 反常识纠错：原来/其实 + [常见做法] + 是错的，或 别再 [常见动作] 了',
  '10 悬念缺口：[人群] + [强评价] + 但不说明对象（慎用，必须至少保留 1 个可搜索词）',
  '11 场景具体化：[具体时间/地点/困境] + [依然做到了什么]',
  '12 平替省钱：[预算数字] + 搞定/买齐 + [目标]，或 [贵价对象] 的平替',
  '13 时间承诺：[时长] + [投入] + [结果]',
  '14 求助提问：[具体选择困境] + 在线等/求推荐/怎么选（互动高但搜索价值低，不宜当主力）',
  '15 节点热点：[节点词] + [人群/预算] + [具体产出]；变体：第一批 [做了某事] 的人，已经 [结果了]',
  '慎用型：绝对化拔高（最好用/第一/顶级）、焦虑制造、数据炫耀（月入X万）—— 非必要不用。',
  '',
  '【评分：百分制，逐维打分，别凭感觉报总分】',
  '内容兑现度 20（正文能否兑现标题承诺）｜搜索词覆盖 15（有没有至少 1 个用户真会搜的名词）｜',
  '人群指向性 15（目标人群能否半秒认领）｜情绪与钩子 12｜收藏动机 10｜具体性 10｜',
  '字数与节奏 8（≤20 字符、重点前置、一遍读懂）｜口语与平台感 5｜独特性 5。',
  '直接淘汰：超 20 字符 / 正文兑现不了 / 捏造数字价格亲测条目数排名 / 触碰下方红线任一条。',
  '扣分：一个可搜索名词都没有 −15｜夸大因果或「闭眼入不踩雷」−12｜人群词硬贴 −12｜',
  '主观感受写成客观效果 −12｜无依据的 最/第一/唯一/永久 −12｜纯情绪无对象 −10｜',
  '数字与正文条目数不一致 −10｜悬念过度把关键词全藏掉 −8｜emoji 超 3 个或无关 −5｜书面腔 −5。',
  '',
  '【平台违规红线，比「标题党」后果严重，逐条过】',
  '· 医疗与功效：禁用 治疗/祛痘/祛斑/美白/瘦身/排毒/抗炎/修复屏障/生发 等疗效断言。',
  '  → 改写成主观感受与可观测现象：「我用完的感受」「上脸没有闷痘」。',
  '· 绝对化用语：禁用 最好/第一/顶级/销量冠军/百分百/永久/国家级。→ 限定为个人视角或直接换成具体差异点。',
  '· 收益与投资承诺：禁用 稳赚/包过/月入X万 的承诺式表述。→ 写成个人经历且不承诺可复制。',
  '· 不捏造前后对比、亲测、价格、条目数；不对具体品牌做未经证实的负面指控。',
  '· 不出现 加V/私信领取/进群/关注领资料 等导流指令。',
  '· 不蹭软色情擦边、性别对立、地域攻击、社会灾难热点；不做涉及未成年人的容貌/身材评价。',
  '口诀：这句话如果被截图发到举报入口，站得住吗？站不住就改。',
  '',
  '【事实边界】不许往标题里加正文没有的东西。可以留缺口，不能撒谎。',
  '信息不足就出保守版，并在 brief.boundary 里写清「缺什么限制了标题强度」—— 不要靠编造补强度。',
  '严格只输出一个 JSON 对象，不要 markdown 代码块，不要任何额外文字。',
].join('\n');

const TITLE_SCHEMA = [
  '{"brief":{"audience":"目标人群及其自称词","keywords":["搜索词1","搜索词2","搜索词3"],',
  '"object":"核心对象（产品/地点/方法/工具）","hook":"最大爆点","evidence":["可用的真实证据"],',
  '"boundary":"事实与合规边界（缺什么、不能写什么）"},',
  '"candidates":[{"text":"候选标题","chars":18,"method":"方法名","hook":"押的搜索词或钩子","score":88,',
  '"risk":"低|中|高","riskWhy":"中高风险写明原因，低风险填空字符串","why":"一句话：主要得分项与实际扣分项"}],',
  '"top5":[{"role":"综合首选|搜索版|爆点版|收藏版|稳健版","text":"标题","why":"为什么适合这个角色"}],',
  '"ab":[{"name":"只改一个变量的名字","a":"版本A","b":"版本B","metric":"看哪个指标","hypothesis":"假设"}],',
  '"tip":"配套提示"}',
].join('');

function buildTitlePrompt(o, schema){
  const L = [];
  L.push('今天是 ' + new Date().toISOString().slice(0, 10) + '。');
  L.push('');
  if (o.mode === 'rewrite'){
    L.push('【任务类型】优化现有标题。');
    L.push('【原标题】' + o.oldTitle);
    L.push('先做诊断，再改写：');
    L.push('① 逐项看原标题：字符数是否超限 / 有没有可搜索的名词 / 有没有人群指向 / 有没有情绪或缺口 /');
    L.push('   有没有收藏理由 / 是否有公众号腔 / 是否触碰违规词。');
    L.push('② 保留资产：原标题里已经有效的部分（一个好搜索词、一个真实数字、一个准确人群词）改写时不要改掉。');
    L.push('③ 改写分三类：3 个稳健优化（只修字数/口语/搜索词，风格不变）、6 个换方法重写、3 个激进测试（情绪拉满，风险自标）。');
    L.push('不要把「更夸张」当成唯一优化手段 —— 很多标题的问题不是不够刺激，而是没有一个词能被搜到。');
  } else {
    L.push('【任务类型】给主题起标题。');
  }
  L.push('');
  if (o.type) L.push('【内容类型】' + o.type + '（按这个类型路由优先方法）');
  L.push('【笔记主题 / 草稿 / 要点】');
  L.push(o.draft || '（未提供）');
  if (o.audience)  L.push('【目标人群（用户填的）】' + o.audience);
  if (o.keywords)  L.push('【候选搜索词（用户填的）】' + o.keywords);
  L.push('');
  L.push('【输出 JSON 结构】');
  L.push(schema);
  L.push('');
  L.push('字段说明：');
  L.push('· brief.keywords 给 3~5 个用户真会打进搜索框的词；brief.evidence 只列正文里真实存在的证据；');
  L.push('· candidates 给 ' + o.count + ' 条，**至少覆盖 6 种不同方法**，别一个套路出 12 条；');
  L.push('  搜索型 / 清单型 / 避雷型 / 体验型 / 情绪型 / 场景型 各 1~3 条。每条优先用一个主方法，最多叠加一个辅助方法。');
  L.push('· candidates.chars 是这条标题的真实字符数（含 emoji，一个 emoji 算 1）；**超过 20 的直接砍到 18 以内再进评分**。');
  L.push('· candidates.hook 必须写清这条押的搜索词是哪个（没有搜索词的要扣分）。');
  L.push('· 只在正文支持时用对应方法：没真用过不写「亲测」，没有 N 条不写数字，没有价格凭据不写金额。');
  L.push('· top5 五个角色固定各一条：综合首选 / 搜索版 / 爆点版 / 收藏版 / 稳健版；');
  L.push('  若 5 条来自同一方法，换成方法不同、分数略低的候选。高风险不得做综合首选。');
  L.push('· ab 给 2~3 组，每组**只改一个变量**；metric 必须写清看哪个指标：');
  L.push('  情绪/emoji/反差类 → 点击率；搜索词/人群词类 → 搜索进入占比与 7 天后的长尾曝光；清单/收藏钩子类 → 收藏率。');
  L.push('· tip 一行：核心搜索词是否也进了正文首句和话题标签（三处一致，搜索权重才起得来）。');
  return L.join('\n');
}

async function handleTitleGenerate(req, res){
  const body = await readJson(req, 2 * 1024 * 1024);
  const mode   = String(body.mode || '').trim() === 'rewrite' ? 'rewrite' : 'new';
  const draft  = String(body.draft || '').trim();
  const oldTtl = String(body.oldTitle || '').trim();
  if (mode === 'rewrite' && !oldTtl) throw httpError(400, '缺少原标题：要优化哪条标题？');
  if (mode !== 'rewrite' && !draft)  throw httpError(400, '缺少内容：先把笔记主题或草稿写进来');
  if (!draft && !oldTtl)             throw httpError(400, '缺少内容');

  const count = Number(body.count) === 20 ? 20 : 12;
  const llm   = pickLlm(body);

  const messages = [
    { role: 'system', content: TITLE_SYS },
    { role: 'user', content: buildTitlePrompt({
        mode, oldTitle: oldTtl, draft,
        type:     String(body.type || '').trim(),
        audience: String(body.audience || '').trim(),
        keywords: String(body.keywords || '').trim(),
        count,
      }, TITLE_SCHEMA) },
  ];

  /* 和拆解同一套自愈：Agnes 没有 JSON 模式，偶尔写坏 JSON（代码块、裸换行、括号不闭合），
   * extractJson 能修大部分，修不了就把错在哪告诉它再给一次机会。最多重试 1 次。 */
  let out = '', parsed = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++){
    out = await agnesChat({
      baseUrl: llm.baseUrl, keys: llm.keys, strategy: llm.strategy, model: llm.model,
      temperature: attempt === 1 ? 0.9 : 0.4,     // 标题要多样性，首次温度高一点；重试时收敛
      maxTokens: 8000,
      messages,
    });
    try { parsed = extractJson(out); lastErr = null; break; }
    catch (e){
      lastErr = e;
      log('warn', '第 ' + attempt + ' 次标题生成 JSON 解析失败：' + (e && e.message));
      try { fs.writeFileSync(path.join(os.tmpdir(), 'redbuddy-title-raw-' + Date.now() + '-a' + attempt + '.txt'), String(out || '')); } catch (e2) {}
      if (attempt === 1){
        messages.push({ role: 'user', content:
          '你上一次的输出不是合法 JSON，无法解析：' + ((e && e.message) || '') + '\n' +
          '请重新输出**完整、合法**的 JSON：不要 ``` 代码块、不要任何多余文字；' +
          '字符串内部不能有真实换行（要写 \\n）；每个 { } [ ] 都必须闭合；最后一个成员后面不要逗号。' });
      }
    }
  }
  if (!parsed) throw httpError(502, (lastErr && lastErr.message) || ('Agnes 返回的标题不是合法 JSON：' + clampStr(out, 200)));

  const str   = (v, n) => clampStr(v, n || 60);
  const int01 = v => Math.max(0, Math.min(100, Math.round(num(v))));
  /* 标题是单行文本：clampStr 会把 \n 压成空格，正好。chars 以模型给的为准，
   * 但它经常数错 —— 用真实长度兜底（Array.from 按码点算，emoji 也算一个）。
   * 只有模型没给或给了非数字时才用真实长度。 */
  const realChars = s => Array.from(String(s || '')).length;

  const b = parsed.brief || {};
  const brief = {
    audience: str(b.audience, 120),
    keywords: (Array.isArray(b.keywords) ? b.keywords : []).map(x => str(x, 30)).filter(Boolean).slice(0, 6),
    object:   str(b.object, 120),
    hook:     str(b.hook, 160),
    evidence: (Array.isArray(b.evidence) ? b.evidence : []).map(x => str(x, 80)).filter(Boolean).slice(0, 6),
    boundary: str(b.boundary, 300),
  };

  const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
    .map(x => {
      const t = clampStr(x && x.text, 60);
      if (!t) return null;
      const c = Number(x && x.chars);
      return {
        text:     t,
        chars:    Number.isFinite(c) && c > 0 ? Math.round(c) : realChars(t),
        method:   str(x && x.method, 40),
        hook:     str(x && x.hook, 80),
        score:    int01(x && x.score),
        risk:     ['高', '中'].indexOf(str(x && x.risk, 4)) >= 0 ? str(x && x.risk, 4) : '低',
        riskWhy:  str(x && x.riskWhy, 200),
        why:      str(x && x.why, 200),
      };
    })
    .filter(Boolean)
    .slice(0, 20);

  /* 模型偶尔不听话给超 20 字的：前端会标红提醒，但不丢弃 ——
     丢掉会让 12 条变 8 条，用户宁可自己删也不想少一半候选。 */

  const ROLES = ['综合首选', '搜索版', '爆点版', '收藏版', '稳健版'];
  const top5 = (Array.isArray(parsed.top5) ? parsed.top5 : [])
    .map(x => {
      const t = clampStr(x && x.text, 60);
      if (!t) return null;
      const r = str(x && x.role, 20);
      return { role: ROLES.indexOf(r) >= 0 ? r : (r || '推荐'), text: t, why: str(x && x.why, 240) };
    })
    .filter(Boolean)
    .slice(0, 5);

  const ab = (Array.isArray(parsed.ab) ? parsed.ab : [])
    .map(x => {
      const a = clampStr(x && x.a, 60), bb = clampStr(x && x.b, 60);
      if (!a && !bb) return null;
      return { name: str(x && x.name, 40), a, b: bb, metric: str(x && x.metric, 60), hypothesis: str(x && x.hypothesis, 240) };
    })
    .filter(Boolean)
    .slice(0, 4);

  log('info', '标题生成  模式=' + (mode === 'rewrite' ? '改写' : '新写') +
      '  候选=' + candidates.length + '  模型=' + llm.model);

  sendJson(res, 200, {
    ok: true, mode, count,
    brief, candidates, top5, ab,
    tip: str(parsed.tip, 300),
  });
}

/* ---------- 图片直链代理（出图结果的兜底显示通道）----------
 * Agnes 返回的图挂在 storage.googleapis.com 上，正常 <img src> 直连就能显示。
 * 但和视频那条链路一个道理：不敢保证 CDN 不查 Referer。页面直连失败时前端自动
 * 改走这里重试（服务端去取，不带 Referer）。
 *
 * ⚠️ 白名单同样不是可选项：这个服务带 ACAO:*，不加白名单等于开了一个能打内网的本地代理（SSRF）。
 */
const IMG_HOSTS = /(^|\.)(agnes-ai\.cn|googleapis\.com|googleusercontent\.com)$/i;

async function proxyImage(req, res){
  const q = new URL(req.url, 'http://localhost');
  const target = q.searchParams.get('u') || '';
  let t;
  try { t = new URL(target); }
  catch (e){ throw httpError(400, 'u 参数不是合法 URL'); }
  if (t.protocol !== 'https:' && t.protocol !== 'http:') throw httpError(400, '只支持 http/https 直链');
  if (!IMG_HOSTS.test(t.hostname)) throw httpError(403, '不在图片代理白名单里：' + t.hostname);

  let up;
  try {
    up = await fetch(t.toString(), {
      headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*' },
      signal: AbortSignal.timeout(60000),
    });
  } catch (e){ throw httpError(502, '取图片失败：' + rootCause(e)); }
  if (!up.ok) throw httpError(502, '上游返回 HTTP ' + up.status);

  const hdr = { 'Content-Type': up.headers.get('content-type') || 'image/png', 'Cache-Control': 'no-store' };
  const cl = up.headers.get('content-length'); if (cl) hdr['Content-Length'] = cl;
  res.writeHead(200, hdr);
  if (!up.body){ res.end(); return; }
  Readable.fromWeb(up.body).pipe(res);
}

/* ---------- 静态页 ---------- */
function serveIndex(res){
  fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
    if (err){ sendJson(res, 500, { error: '读不到 index.html：' + err.message }); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  try {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    if (req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }

    // 小红书采集模块自己处理 /api/xhs/*，处理了就直接返回
    if (u.pathname.startsWith('/api/xhs/')) {
      const handled = await Collector.handle(req, res, u.pathname, {
        readJSON: readJson, sendJSON: sendJson, httpErr: httpError,
        /* ★ 这里**不传 key / presets**：Key 只认前端请求体里的 body.keys，服务端没有兜底 */
        xhs: { provider: CONFIG.xhsProvider, base: CONFIG.xhsBase,
               mockVideoUrl: CONFIG.mockVideoUrl, log },
      });
      if (handled) return;
    }
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return serveIndex(res);
    /* 内置封面模板库。只认这一个文件名，不开通用静态目录 —— 免得把 config.local.json 之类的也端出去 */
    if (req.method === 'GET' && u.pathname === '/cover-samples.js'){
      return fs.readFile(path.join(__dirname, 'cover-samples.js'), (err, buf) => {
        if (err){ sendJson(res, 404, { error: '读不到 cover-samples.js：' + err.message }); return; }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    }

    if (req.method === 'GET' && u.pathname === '/healthz'){
      return sendJson(res, 200, {
        ok: true,
        redfoxBase: CONFIG.redfoxBase,
        agnesBase: CONFIG.agnesBase,
        agnesModel: CONFIG.agnesModel,
        agnesImageModel: IMG_MODEL,
        /* 服务端不持有任何 Key：keySource 恒为 frontend-settings，具体有没有 Key 由前端自己判断 */
        keySource: 'frontend-settings',
        xhsSource: {
          provider: CONFIG.xhsProvider || '',
          base: CONFIG.xhsBase || '',
        },
        xhs: { ok: true },   // 内容获取全走数据源接口，没有登录态/本地模型要自检
        routes: [
          'POST /api/note/decompose',
          'POST /api/title/generate',
          'POST /api/image/generate',
          'GET  /api/image/proxy',
          'GET  /api/xhs/providers',
          'GET  /api/xhs/env',
          'GET  /api/xhs/media',
          'POST /api/xhs/extract',
          'POST /api/xhs/transcribe',
        ],
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/note/decompose')  return await handleDecompose(req, res);
    if (req.method === 'POST' && u.pathname === '/api/title/generate')  return await handleTitleGenerate(req, res);
    if (req.method === 'POST' && u.pathname === '/api/image/generate')  return await handleImageGenerate(req, res);
    if (req.method === 'GET'  && u.pathname === '/api/image/proxy')     return await proxyImage(req, res);

    sendJson(res, 404, { error: '未知路由：' + req.method + ' ' + u.pathname });
  } catch (e){
    const status = e.status || 500;
    log(status >= 500 ? 'error' : 'warn', req.method + ' ' + req.url + ' → ' + status + '  ' + (e.message || e));
    if (!res.headersSent) sendJson(res, status, { error: e.message || String(e) });
    else try { res.end(); } catch (_){}
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  log('info', 'RedBuddy 代理已启动 → http://' + CONFIG.host + ':' + CONFIG.port);
  log('info', 'RedFox base = ' + CONFIG.redfoxBase + '　密钥：由「设置 → RedFox 红狐密钥」提供（服务端不持有）');
  log('info', 'Agnes  base = ' + CONFIG.agnesBase + '　模型：' + CONFIG.agnesModel + '　密钥：由「设置 → Agnes 密钥」提供（服务端不持有）');
  /* xhsProvider 现在恒有值（默认 redfox），所以这里不再需要「未配置」分支 —— 原来的 warn 已不可达。 */
  log('info', '小红书数据源 = ' + CONFIG.xhsProvider + '　地址：' + (CONFIG.xhsBase || '（用厂商默认）'));
});

function bye(){ log('info', '收到退出信号，关闭中…'); server.close(() => process.exit(0)); setTimeout(()=>process.exit(0), 3000); }
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
