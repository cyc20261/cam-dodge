@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [!] 未检测到 Node.js
  echo       请到 https://nodejs.org 安装 Node 18+ 后重试，
  echo       或手动执行:  node server.js
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 Cam-Dodge ...
start "" http://localhost:8080
"%NODE_EXE%" server.js 8080
pause
