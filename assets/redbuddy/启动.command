#!/bin/bash
# 双击即可启动（macOS）。首次请先跑「安装依赖.command」
cd "$(dirname "$0")" || exit 1
echo "启动 redbuddy …（Ctrl+C 停止）"
echo
exec node server.js
