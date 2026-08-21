@echo off
REM Local operator entry point for the trading runtime launcher.
REM
REM Double-click this file. It opens a menu for starting the local dashboard in
REM SAFE or LIVE-READY mode and for shutting it back down.
REM
REM LIVE-READY DOES NOT ARM TRADING. It only loads the runtime prerequisites
REM that let the authenticated Trading Control page arm later.
setlocal
cd /d "%~dp0"
call pnpm --filter @trading-alert-dashboard/backend runtime:launcher
echo.
pause
