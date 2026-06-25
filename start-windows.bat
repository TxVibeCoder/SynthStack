@echo off
rem SynthStack launcher (Windows). Runs the dev server (hot reload, always current
rem source) and opens the browser at the right URL once the server is ready.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required but was not found on PATH.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-fund --no-audit || (pause & exit /b 1)
)
rem --open lets Vite launch the browser AFTER it is listening (no connect-refused
rem race, and it uses the dev base '/' so assets resolve — unlike a preview of the
rem '/SynthStack/' Pages build, which 404s its scripts at localhost root).
call npm run dev -- --open
