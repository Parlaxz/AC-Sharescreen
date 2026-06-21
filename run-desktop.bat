@echo off
cd /d "%~dp0" || exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-launcher.ps1"
if %errorlevel% neq 0 (
    echo [ScreenLink] Launch failed (exit code: %errorlevel%)
    pause
    exit /b %errorlevel%
)
