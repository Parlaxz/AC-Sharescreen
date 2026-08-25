@echo off
rem ============================================================================
rem revert-to-stable.bat - Rollback to the latest STABLE release.
rem
rem Official electron-updater channel-switch flow: launches the installed
rem app in main-process-only mode (--revert-to-stable). No renderer loads,
rem so a broken beta UI cannot interfere. The updater:
rem   - flips the channel to "latest" (stable),
rem   - accepts the lower stable version (allowDowngrade),
rem   - downloads it - differentially when the previously downloaded
rem     installer is still in the updater cache, otherwise in full,
rem   - silently installs and relaunches ScreenLink.
rem
rem Requires internet. Detailed log: %APPDATA%\ScreenLink\logs
rem Last-resort alternative (works fully offline once you have downloaded
rem the stable Setup manually): revert-to-stable.ps1
rem ============================================================================
setlocal

set "APP_EXE=%~dp0ScreenLink.exe"
if not exist "%APP_EXE%" (
    echo [ScreenLink] ScreenLink.exe not found next to this script: %APP_EXE%
    pause
    exit /b 1
)

echo [ScreenLink] Closing any running ScreenLink instances...
taskkill /IM ScreenLink.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo [ScreenLink] Rolling back to the latest STABLE release...
echo [ScreenLink] The updater runs without any UI. Do not close this window.
start "" /wait "%APP_EXE%" --revert-to-stable --update-channel=stable

echo.
echo [ScreenLink] Done. ScreenLink has been rolled back to the stable channel
echo [ScreenLink] and should reopen automatically. If it did not, start it
echo [ScreenLink] from the Start Menu.
pause
