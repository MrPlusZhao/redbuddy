@echo off
chcp 65001 >nul
title RedBuddy 环境校验
cd /d "%~dp0"

rem ============================================================
rem  RedBuddy 环境校验（Windows）
rem  首次使用前跑一次即可。本项目零第三方依赖，这里只校验 Node 版本。
rem  内容获取与视频转写都走数据源（RedFox）服务端接口，
rem  不需要 Playwright / ffmpeg / 本地 Whisper。
rem ============================================================

echo.
echo   == 校验 Node 环境
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 没找到 Node.js
  echo.
  echo       请先到 https://nodejs.org 下载并安装 LTS 版（18 或更高）。
  echo       装完**重开这个窗口**再双击一次。
  echo.
  pause
  exit /b 1
)

node -v
node -e "const m=+process.versions.node.split('.')[0]; if(m<18){console.error('  [X] Node 版本太低，需要 18 或更高（内置 fetch 从 18 才有）'); process.exit(1)}"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
echo   == 校验项目依赖（当前无第三方依赖，跳过 npm install）
echo.
echo   [OK] 环境就绪。以后双击「启动.bat」即可。
echo.
echo   密钥在页面左侧「设置」里填（RedFox 红狐密钥 / Agnes 密钥），不写进任何配置文件。
echo   小红书数据源只能改 config.local.json 里的 xhsProvider（默认 redfox），改完要重启。
echo.
pause
