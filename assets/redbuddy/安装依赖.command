#!/bin/bash
# 首次使用前跑一次。本工具零第三方依赖，这里只做一次环境校验。
# 内容获取与视频转写都走数据源（RedFox）服务端接口，不需要 Playwright / ffmpeg / 本地 Whisper。
cd "$(dirname "$0")" || exit 1
set -e
echo "==> 校验 Node 环境"
node -v || { echo "❌ 没找到 node，请先装 Node 18+"; exit 1; }
echo "==> 校验项目依赖（当前无第三方依赖）"
npm install || echo "（跳过：npm install 失败不影响本地运行）"
echo
echo "✅ 环境就绪。以后双击「启动.command」即可。"
echo
echo "   密钥在页面「设置」里配（RedFox 红狐密钥 / Agnes 密钥），不写进任何配置文件。"
echo "   小红书数据源在 config.local.json 里配 xhsProvider（默认 redfox），改完要重启服务。"
