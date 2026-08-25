@echo off
rem ============================================================================
rem revert-to-stable.bat - HEADLESS differential rollback to latest STABLE.
rem
rem Runs the installed app's updater in main-process-only mode: NO renderer is
rem loaded, so a broken beta build cannot interfere. The updater downloads only
rem the byte ranges that differ from the already-cached beta installer
rem (differential update), silently installs the stable version over it, and
rem relaunches ScreenLink on the stable channel.
rem
rem Requires an internet connection. Detailed progress is logged to
rem   %APPDATA%\ScreenLink\logs
rem Last-resort alternative (full offline download): revert-to-stable.ps1
rem ============================================================================
setlocal
set "APP_EXE=%~dp0ScreenLink.exe"
if not exist "%APP_EXE%" (
    echo [ScreenLink] ScreenLink.exe not found next to this script: %APP_EXE%
    pause
    exit /b 1
)
echo [ScreenLink] Rolling back to the latest STABLE release...
echo [ScreenLink] Differential download - only the changed parts are fetched.
echo [ScreenLink] This runs without any UI. The app relaunches automatically
echo [ScreenLink] when the stable version has been applied.
start "" /wait "%APP_EXE%" --revert-to-stable --update-channel=stable
echo.
echo [ScreenLink] Rollback finished. If ScreenLink did not reopen on its own,
echo [ScreenLink] start it from the Start Menu - it is now on the stable channel.
pause
