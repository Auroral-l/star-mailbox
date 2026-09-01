@echo off
chcp 65001 >nul
title 星空信箱
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Please install Node.js first.
  echo [错误] 未找到 Node.js，请先安装 Node.js
  pause
  exit /b 1
)
node server.js
pause
