@echo off
rem Double-click to start Pit Wall with live F1 data. Add "--demo" for the demo race.
cd /d "%~dp0"
rem --background (used by tools/schedule-sessions.ps1): no browser window, no pause at the end.
set "PW_BG="
if /i "%~1"=="--background" set "PW_BG=1"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
rem Installs anything new after an update (takes a few seconds when nothing changed).
echo Checking dependencies...
call npm install --omit=dev --no-audit --no-fund --loglevel=error || (pause & exit /b 1)
if not defined PW_BG start "" http://localhost:3000
node server/index.js %*
if not defined PW_BG pause
