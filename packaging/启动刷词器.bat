@echo off
rem CetVocab Trainer - one-click launcher (Windows web version)
rem Pure ASCII on purpose: a .bat containing non-ASCII text can break cmd parsing
rem (see workspace memory/11). Requires Node.js 18+.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js not found.
  echo       Please install Node.js 18 or newer: https://nodejs.org/
  echo       Then double-click this file again.
  echo.
  pause
  exit /b 1
)
echo.
echo   CetVocab Trainer is starting; your browser will open automatically...
echo   Close this window to stop the server.
echo.
node server.mjs
pause
