@echo off
rem Reverts ScreenLink to the STABLE update channel and immediately
rem installs the latest stable version (downgrade from beta).
rem Safe to run even when the beta app cannot render its UI.
setlocal
set "APP_EXE=%~dp0ScreenLink.exe"
if not exist "%APP_EXE%" (
    echo [ScreenLink] ScreenLink.exe not found next to this script: %APP_EXE%
    pause
    exit /b 1
)
echo [ScreenLink] Switching to the STABLE channel and installing the latest stable version...
start "" "%APP_EXE%" --update-channel=stable
echo [ScreenLink] The app will download and install the stable version automatically, then restart.
exit /b 0
