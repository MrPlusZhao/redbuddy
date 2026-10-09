#!/bin/bash
# 启动 RedBuddy 本机服务，等它就绪后打开浏览器。
# 用法： bash start.sh [应用目录]     默认 ~/RedBuddy
DIR="${1:-$HOME/RedBuddy}"

if [ ! -f "$DIR/server.js" ]; then
  echo "❌ $DIR 里没有 server.js。先跑 install.sh 安装。"
  exit 1
fi

PORT="$(node -e '
  try { const c = require(process.argv[1]); console.log(Number(c.port) || 8090); }
  catch (e) { console.log(8090); }
' "$DIR/config.local.json" 2>/dev/null || echo 8090)"

open_url(){
  # REDBUDDY_NO_OPEN=1 → 只打印地址不开浏览器（无头 / 服务器 / 自动化场景）
  if [ "$REDBUDDY_NO_OPEN" = "1" ]; then echo "   地址：$1"; return; fi
  if command -v open >/dev/null 2>&1;      then open "$1"                                  # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1             # Linux
  elif command -v cmd.exe >/dev/null 2>&1;  then cmd.exe /c start "" "$1" >/dev/null 2>&1  # Windows (Git Bash)
  else echo "   请手动打开：$1"; fi
}

# ★ 清掉代理变量的原因：Node 的 fetch 会走 HTTP(S)_PROXY，经代理访问
#   api.agnes-ai.cn 会 TLS 证书校验失败，症状是「连不上：fetch failed」。
NO_PROXY_ENV="env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy"

# 端口已经有人监听 = 服务可能已经在跑
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  端口 $PORT 已被占用 —— 服务可能已经在跑了。"
  open_url "http://127.0.0.1:$PORT/"
  exit 0
fi

cd "$DIR" || exit 1
mkdir -p "$DIR/.logs"
$NO_PROXY_ENV node server.js > "$DIR/.logs/redbuddy.log" 2>&1 &
echo $! > "$DIR/.logs/redbuddy.pid"

# 轮询就绪（用 node 而不是 curl，跨平台都稳）
for _ in $(seq 1 40); do
  if $NO_PROXY_ENV node -e "
    fetch('http://127.0.0.1:$PORT/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  " >/dev/null 2>&1; then
    echo "✅ RedBuddy 已就绪 → http://127.0.0.1:$PORT/"
    open_url "http://127.0.0.1:$PORT/"
    echo "   日志：$DIR/.logs/redbuddy.log"
    echo "   停止：bash \"$(dirname "$0")/stop.sh\" \"$DIR\""
    exit 0
  fi
  sleep 0.5
done

echo "❌ 启动超时（20 秒）。日志末尾："
tail -20 "$DIR/.logs/redbuddy.log" 2>/dev/null
exit 1
