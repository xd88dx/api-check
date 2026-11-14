@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [api-check] building...
call pnpm install
if errorlevel 1 exit /b 1
call pnpm build
if errorlevel 1 exit /b 1
echo [api-check] starting server on http://localhost:3000
node server/dist/index.js
