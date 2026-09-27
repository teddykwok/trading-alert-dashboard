@echo off
REM Local operator entry point for the trading runtime launcher.
REM
REM Double-click this file. It opens a menu for starting, inspecting and
REM shutting down the local dual-account runtime: the generic backend and
REM analysis worker, plus a control plane and execution worker for each account.
REM
REM THIS TOOL CANNOT ARM TRADING. It writes no environment file and holds no
REM deployment gate. Arming is account-scoped and lives on the authenticated
REM Trading Control page of that account's own control plane.
setlocal
cd /d "%~dp0"
call pnpm --filter @trading-alert-dashboard/backend runtime:launcher
echo.
pause
