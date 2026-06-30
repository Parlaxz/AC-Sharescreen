@echo off
cd /d "%~dp0apps\desktop"

:: ── Native helpers (if cmake is available) ──────────────────────────────────
where cmake >nul 2>&1
if %errorlevel% equ 0 (
    echo [ScreenLink] Building audio helper...
    cmake --build "%~dp0native\audio-helper\build" --config Release 2>nul
    if %errorlevel% neq 0 (
        echo [ScreenLink] WARNING: audio-helper build failed — may be stale.
    )

    echo [ScreenLink] Building video enhancer...
    cmake --build "%~dp0native\video-enhancer\build" --config Release 2>nul
    if %errorlevel% neq 0 (
        echo [ScreenLink] WARNING: video-enhancer build failed — may be stale.
    )
) else (
    echo [ScreenLink] WARNING: cmake not found — skipping native helper builds.
)

echo [ScreenLink] Building renderer (Vite)...
call npx vite build

echo [ScreenLink] Compiling main process...
call npx tsc -p tsconfig.main.json --outDir dist/main

echo [ScreenLink] Compiling preload...
call npx tsc -p tsconfig.preload.json --outDir dist/preload

echo [ScreenLink] Packaging with electron-builder...
call npx electron-builder --win --x64 --config electron-builder.config.cjs --publish never

echo.
echo [ScreenLink] Done! Check the "release" folder for:
echo   - ScreenLink Setup *.exe  (NSIS installer)
echo   - ScreenLink *-portable.exe
pause
