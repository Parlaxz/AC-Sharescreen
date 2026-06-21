@echo off
cd /d "%~dp0apps\desktop"

echo [ScreenLink] Building renderer (Vite)...
call npx vite build

echo [ScreenLink] Compiling main process...
call npx tsc -p tsconfig.main.json --outDir dist/main

echo [ScreenLink] Compiling preload...
call npx tsc -p tsconfig.preload.json --outDir dist/preload

echo [ScreenLink] Packaging with electron-builder...
call npx electron-builder --win --x64

echo.
echo [ScreenLink] Done! Check the "out" folder for:
echo   - ScreenLink Setup *.exe  (NSIS installer)
echo   - ScreenLink *-portable.exe
pause
