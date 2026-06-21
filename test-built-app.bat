@echo off
cd /d "%~dp0"

if not exist "built\ScreenLink\ScreenLink.exe" (
    echo ERROR: built\ScreenLink\ScreenLink.exe not found.
    echo Run build-distributable.bat first.
    pause
    exit /b 1
)

echo [ScreenLink] Launching production build (no dev server)...
start "" "built\ScreenLink\ScreenLink.exe"

echo [ScreenLink] App launched from built\ScreenLink\ScreenLink.exe
echo The app runs independently without Node.js, pnpm, or a dev server.
