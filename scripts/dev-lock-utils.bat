@echo off
:: dev-lock-utils.bat — Ensure lock file directory exists
:: Used by run-desktop.bat for PID-based instance tracking
set LOCK_DIR=%USERPROFILE%\.screenlink-dev
if not exist "%LOCK_DIR%" mkdir "%LOCK_DIR%"
exit /b 0
