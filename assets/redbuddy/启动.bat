@echo off
chcp 65001 >nul
title RedBuddy
cd /d "%~dp0"

rem ============================================================
rem  RedBuddy 启动（Windows）
rem  ★ 这个窗口就是服务本身 —— 关掉窗口 = 停止服务。
rem  以后想再启动，双击本文件即可；不需要重复跑「安装依赖.bat」。
rem ============================================================

rem 清掉代理变量：Node 的 fetch 会走 HTTP(S)_PROXY，
rem 经代理访问 api.agnes-ai.cn 会 TLS 证书校验失败，症状是「连不上：fetch failed」。
set HTTP_PROXY=
set HTTPS_PROXY=
set http_proxy=
set https_proxy=
set ALL_PROXY=
set all_proxy=

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 没找到 Node.js
  echo.
  echo       请先到 https://nodejs.org 下载并安装 LTS 版（18 或更高），
  echo       装完**重开这个窗口**再双击一次。
  echo.
  pause
  exit /b 1
)

echo.
echo   RedBuddy 启动中……
echo.
echo   地址：http://127.0.0.1:8090/
echo.
echo   密钥在页面左侧「设置」里填，不写进任何配置文件。
echo   关掉这个窗口就是停止服务。
echo.

rem 2 秒后自动打开浏览器（独立的最小化窗口，开完自己关掉，不占用本窗口）
rem 用 ping 而不是 timeout 做延时：timeout 在 stdin 被重定向时会直接报错退出。
start "RedBuddy 打开浏览器" /min cmd /c "ping -n 3 127.0.0.1 >nul && start http://127.0.0.1:8090/"

node server.js

echo.
echo   服务已停止。
pause
