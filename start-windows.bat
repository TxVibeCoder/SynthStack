@echo off
rem SynthStack launcher (Windows). Builds if needed, serves, opens browser.
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
if not exist dist (
  echo Building...
  call npm run build || (pause & exit /b 1)
)
start "" http://localhost:4173/
call npm run preview
