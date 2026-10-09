/* ============================================================
 * neterr.cjs —— 把「网络类错误」的根因抠出来，拼成一句人话
 * ------------------------------------------------------------
 * 为什么需要它：Node 内置的 fetch（undici）失败时只给
 *   e.message === 'fetch failed'
 * 真正的原因藏在 e.cause 里：
 *   ERR_TLS_CERT_ALTNAME_INVALID / ENOTFOUND / ECONNREFUSED / ETIMEDOUT …
 * 只打 e.message 的话，界面和日志都只剩一句「连不上 xxx：fetch failed」，
 * 完全看不出是 DNS 解析错、证书不对、还是对方没开机。
 *
 * 2026-10-06 实际踩过：本地 DNS 把 api.agnes-ai.cn 解析到了一台
 * 「证书里只有 IP、没有域名」的服务器 → 报 ERR_TLS_CERT_ALTNAME_INVALID，
 * 但界面只显示 fetch failed，白查了两个小时。
 * ============================================================ */
'use strict';

/* 字符串错误码 → 人话。命中不了就原样返回码。 */
const HINTS = {
  ENOTFOUND:       '域名解析不到（DNS 问题）',
  EAI_AGAIN:       'DNS 查询超时或失败（DNS 服务器没响应）',
  ECONNREFUSED:    '对方拒绝连接（端口没开 / 被防火墙拦）',
  ECONNRESET:      '连接被重置（可能被中间设备掐断）',
  ETIMEDOUT:       '连接超时',
  EHOSTUNREACH:    '主机不可达',
  ENETUNREACH:     '网络不可达',
  ERR_TLS_CERT_ALTNAME_INVALID:
    'TLS 证书里的域名和访问的域名对不上 —— 常见于 DNS 把域名解析到了错误的服务器',
  ERR_TLS_CERT_ALTNAME_MISMATCH: 'TLS 证书域名不匹配',
  CERT_HAS_EXPIRED:                'TLS 证书已过期',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书无法验证（可能被中间人代理替换）',
  DEPTH_ZERO_SELF_SIGNED_CERT:     'TLS 证书是自签名的（可能被中间人代理替换）',
  SELF_SIGNED_CERT_IN_CHAIN:       'TLS 证书链里有自签名证书（可能被中间人代理替换）',
  ERR_SSL_WRONG_VERSION_NUMBER:    'TLS 握手失败（对方不是 HTTPS，或代理插了一手）',
};

/* DOMException 的 code 是数字，不是字符串错误码。
 * 注意别把它当字符串码拼进文案里 —— 否则会输出 "23：The operation was aborted…" 这种噪音。 */
const DOM_HINTS = {
  20: '请求被取消（AbortError）',
  23: '请求超时（TimeoutError）',
};

/* 取错误里最有用的一句话。
 * · undici 的 fetch：真因在 .cause，而且 cause 自己还可能有 cause
 * · 某些场景会包一层 AggregateError（.errors[]），取第一个 */
function rootCause(err){
  if (!err) return '未知错误';

  let cur = err, depth = 0;
  while (depth++ < 6){
    if (Array.isArray(cur.errors) && cur.errors.length){ cur = cur.errors[0]; continue; }
    if (cur.cause){ cur = cur.cause; continue; }
    break;
  }

  const rawCode = (cur && cur.code) || (err && err.code);
  const msg = String((cur && cur.message) || (err && err.message) || err || '');
  /* 只认「字母开头的字符串错误码」（ERR_* / E*）—— 数字码（DOMException）另走 DOM_HINTS */
  const code = (typeof rawCode === 'string' && /^[A-Z]/.test(rawCode)) ? rawCode : '';

  const hint = (code && HINTS[code]) || DOM_HINTS[rawCode];
  if (hint){
    /* 有中文解释时，英文细节只当补充；DOM 那几个通用文案就不要再重复一遍了 */
    const generic = /aborted due to timeout|operation was aborted|The user aborted a request/i.test(msg);
    const extra = (msg && msg !== code && !generic && msg.indexOf(code) < 0) ? ' · ' + msg.slice(0, 120) : '';
    return (code ? code + '（' + hint + '）' : hint) + extra;
  }
  if (code && msg.indexOf(code) < 0) return code + '：' + msg.slice(0, 160);
  return (msg || code || '未知错误').slice(0, 200);
}

module.exports = { rootCause };
