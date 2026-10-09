#!/bin/bash
# 把 RedBuddy 装到本机目录（默认 ~/RedBuddy），并做环境校验。
# 用法： bash install.sh [目标目录]
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../assets/redbuddy"
DST="${1:-$HOME/RedBuddy}"

if [ ! -f "$SRC/server.js" ]; then
  echo "❌ 找不到应用文件（${SRC}）。skill 包可能不完整。"
  exit 1
fi

# ---- 环境校验：只需要 Node 18+，无第三方依赖 ----
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没找到 node。请先装 Node 18 或更高版本："
  echo "   macOS:  brew install node      （或到 https://nodejs.org 下载）"
  echo "   Windows: https://nodejs.org 下载 LTS 版"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node 版本太低：$(node -v)。需要 18+（内置 fetch 从 18 才有）。"
  exit 1
fi
echo "==> Node $(node -v)  OK"

# ---- 复制应用 ----
mkdir -p "$DST"
cp -R "$SRC/." "$DST/"

# 配置只在首次生成，不覆盖用户已经改过的
if [ ! -f "$DST/config.local.json" ]; then
  cat > "$DST/config.local.json" <<'JSON'
{
  "port": 8090,
  "host": "127.0.0.1",
  "redfoxBase": "https://redfox.hk",
  "agnesModel": "agnes-2.5-flash",
  "xhsProvider": "redfox",
  "xhsBase": "",
  "mockVideoUrl": ""
}
JSON
  echo "==> 已生成 config.local.json（里面不含任何密钥）"
else
  echo "==> 已存在 config.local.json，保持不动"
fi

chmod +x "$DST/启动.command" "$DST/安装依赖.command" 2>/dev/null || true

echo
echo "✅ 安装完成：$DST"
echo "   启动：bash $HERE/start.sh \"$DST\""
echo "   macOS 也可以直接双击 $DST/启动.command"
echo
echo "   ★ 密钥不在配置文件里 —— 启动后在网页「设置」页里填。"
