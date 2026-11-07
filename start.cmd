@echo off
rem Double-click to start Pit Wall with live F1 data. Add "--demo" for the demo race.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev || (pause & exit /b 1)
)
start "" http://localhost:3000
node server/index.js %*
pause
