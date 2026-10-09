#!/bin/bash
# 停止 RedBuddy 本机服务。用法： bash stop.sh [应用目录]   默认 ~/RedBuddy
DIR="${1:-$HOME/RedBuddy}"
PIDFILE="$DIR/.logs/redbuddy.pid"
PORT="$(node -e 'try{console.log(Number(require(process.argv[1]).port)||8090)}catch(e){console.log(8090)}' "$DIR/config.local.json" 2>/dev/null || echo 8090)"

STOPPED=0
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && echo "已停止（PID ${PID}）"
    STOPPED=1
  fi
  rm -f "$PIDFILE"
fi

# pid 文件丢了（或进程不是脚本起的）就按端口找
if [ "$STOPPED" = "0" ] && command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti:"$PORT" 2>/dev/null)"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null && echo "已停止占用 $PORT 端口的进程：$PIDS"
    STOPPED=1
  fi
fi

[ "$STOPPED" = "1" ] || echo "没有在跑的服务（端口 $PORT 空闲）"
