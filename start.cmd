@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24.15 or newer in the 24.x series is required. Install Node.js and try again.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\start.mjs" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
