@echo off
REM Always-On Monitoring V1 - MONITORING ONLY, NO ACCOUNT EXECUTION, NATIVE EXECUTION HARD-DISABLED.
REM
REM Double-click this file to run the monitoring supervisor in this window. It
REM owns the generic backend (non-watch), the Native live-shadow scanner, the
REM Native multi-symbol emitter (COMMIT, follow: dashboard writes only) and the
REM Native planner (planning only). It never starts Account A or Account B.
REM
REM Ctrl+C stops the monitoring stack gracefully. Closing the window leaves the
REM children running; the next start adopts the ones it can still prove it owns.
REM Extra arguments are passed to "monitoring:always-on run".
setlocal
cd /d "%~dp0"
call pnpm --filter @trading-alert-dashboard/backend monitoring:always-on run %*
echo.
pause
