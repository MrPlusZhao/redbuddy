#!/bin/bash
# 前台启动 RedBuddy 服务（不 fork、不退出，一直占着终端）。
#
# ★ 为什么要有这个脚本（和 start.sh 的区别）：
#   start.sh 用 `node server.js &` 把服务甩到后台就退出。这对**人**是对的
#   （双击一次就能关窗口走人），但**从 agent 的终端里跑，后台进程会随这一轮结束被回收**
#   —— 表现是「刚说启动成功，用户打开浏览器就是空的」。
#   所以 agent 要用「受管后台任务」的方式起服务：前台跑这个脚本，让任务管理器托管它。
#
# 用法：
#   bash serve.sh [应用目录]        # 默认 ~/RedBuddy
set -e

DIR="${1:-$HOME/RedBuddy}"

if [ ! -f "$DIR/server.js" ]; then
  echo "❌ $DIR 里没有 server.js。先跑 install.sh 安装。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没找到 node。请先装 Node 18+（https://nodejs.org）。"
  exit 1
fi

PORT="$(node -e '
  try { const c = require(process.argv[1]); console.log(Number(c.port) || 8090); }
  catch (e) { console.log(8090); }
' "$DIR/config.local.json" 2>/dev/null || echo 8090)"

cd "$DIR"
mkdir -p "$DIR/.logs"
echo "$$" > "$DIR/.logs/redbuddy.pid"

echo "RedBuddy 启动中…  目录=$DIR  端口=$PORT"
echo "（这个进程要一直活着；停服务用 stop.sh 或直接结束本进程）"

# ★ 必须清掉代理变量：Node 的 fetch 会走 HTTP(S)_PROXY，
#   经代理访问 api.agnes-ai.cn 会 TLS 证书校验失败，症状是「连不上：fetch failed」。
#   exec 让 node 顶替当前 shell，这样写进 pid 文件的 $$ 就是真正的服务进程号。
exec env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
         -u ALL_PROXY -u all_proxy -u NODE_OPTIONS \
     node server.js
