@echo off
chcp 65001 >nul
title CET Vocab Trainer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found in PATH.
  echo   Install Node.js 18+ and run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting CET Vocab Trainer...
echo   Keep this window open while you study.
echo.

node server.mjs %*

echo.
echo   Server stopped.
pause
