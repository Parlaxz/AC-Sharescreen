@echo off
cd /d "%~dp0"

echo ============================================================
echo  ScreenLink - Build Distributable
echo ============================================================
echo.

:: Verify required tools
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not on PATH.
    pause
    exit /b 1
)

where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: pnpm is not installed or not on PATH.
    pause
    exit /b 1
)

where cmake >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: CMake was not found on PATH. Native helpers will not be built.
    set "NO_NATIVE_BUILD=1"
)

echo [1/9] Node version:
node --version
echo [1/9] pnpm version:
pnpm --version
echo.

:: Install dependencies if needed
echo [2/9] Installing dependencies...
if not exist "node_modules" (
    call pnpm install
    if %errorlevel% neq 0 (
        echo ERROR: pnpm install failed.
        pause
        exit /b 1
    )
) else (
    echo      Already installed, skipping.
)
echo.

:: Clean previous output
echo [3/9] Cleaning previous output...
if exist "built" rmdir /s /q built
call pnpm -r clean
echo.

:: ── Native helper builds ────────────────────────────────────────────────

if not defined NO_NATIVE_BUILD (
    :: Audio helper
    echo [4/9] Building native audio helper...
    if not exist "native\audio-helper\build" (
        call pnpm audio-helper:configure
        if %errorlevel% neq 0 (
            echo WARNING: audio-helper configure failed — will skip.
            set "AUDIO_HELPER_FAILED=1"
        )
    )
    if not defined AUDIO_HELPER_FAILED (
        call pnpm audio-helper:build
        if %errorlevel% neq 0 (
            echo WARNING: audio-helper build failed.
            set "AUDIO_HELPER_FAILED=1"
        )
    )
    if not defined AUDIO_HELPER_FAILED (
        if not exist "native\audio-helper\build\Release\screenlink-audio-helper.exe" (
            echo WARNING: audio-helper artifact missing — packaging may fail.
            set "AUDIO_HELPER_FAILED=1"
        ) else (
            echo   Audio helper built OK.
        )
    )

    :: Video enhancer
    echo [5/9] Building native video enhancer...
    if not exist "native\video-enhancer\build" (
        cmake ^
            -S native/video-enhancer ^
            -B native/video-enhancer/build ^
            -G "Visual Studio 17 2022" ^
            -A x64
        if %errorlevel% neq 0 (
            echo WARNING: video-enhancer configure failed — will skip.
            set "VIDEO_ENHANCER_FAILED=1"
        )
    )
    if not defined VIDEO_ENHANCER_FAILED (
        cmake --build native/video-enhancer/build --config Release
        if %errorlevel% neq 0 (
            echo WARNING: video-enhancer build failed.
            set "VIDEO_ENHANCER_FAILED=1"
        )
    )
    if not defined VIDEO_ENHANCER_FAILED (
        if not exist "native\video-enhancer\build\Release\screenlink-video-enhancer.exe" (
            echo WARNING: video-enhancer artifact missing — packaging may fail.
            set "VIDEO_ENHANCER_FAILED=1"
        ) else (
            echo   Video enhancer built OK.
        )
    )
) else (
    echo [4/9] Skipping native helpers (cmake not found)...
    echo [5/9] Skipping native helpers (cmake not found)...
)

:: ── TypeScript packages ─────────────────────────────────────────────────

:: Build shared package
echo [6/9] Building shared package...
call pnpm --filter @screenlink/shared build
if %errorlevel% neq 0 (
    echo ERROR: shared package build failed.
    pause
    exit /b 1
)
echo.

:: Build vdo-adapter package
echo [7/9] Building vdo-adapter package...
call pnpm --filter @screenlink/vdo-adapter build
if %errorlevel% neq 0 (
    echo ERROR: vdo-adapter package build failed.
    pause
    exit /b 1
)
echo.

:: Build Electron main process
echo [8/9] Building Electron main and preload...
cd /d "%~dp0apps\desktop"
call npx tsc -p tsconfig.main.json --outDir dist/main
if %errorlevel% neq 0 (
    echo ERROR: Main process build failed.
    pause
    exit /b 1
)

call npx tsc -p tsconfig.preload.json --outDir dist/preload
if %errorlevel% neq 0 (
    echo ERROR: Preload build failed.
    pause
    exit /b 1
)

call npx vite build
if %errorlevel% neq 0 (
    echo ERROR: Renderer build failed.
    pause
    exit /b 1
)
echo.

:: ── Verify helper artifacts before packaging ────────────────────────────
cd /d "%~dp0"

if not defined NO_NATIVE_BUILD (
    :: Fail clearly if expected helper is missing for a packaged build
    if exist "apps\desktop\electron-builder.config.cjs" (
        if not exist "native\audio-helper\build\Release\screenlink-audio-helper.exe" (
            echo ERROR: audio-helper artifact missing before packaging.
            echo     Build it first or set NO_NATIVE_BUILD=1 to skip.
            pause
            exit /b 1
        )
        if not exist "native\video-enhancer\build\Release\screenlink-video-enhancer.exe" (
            echo ERROR: video-enhancer artifact missing before packaging.
            echo     Build it first or set NO_NATIVE_BUILD=1 to skip.
            pause
            exit /b 1
        )
    )
)

:: Package with electron-builder (using committed config)
echo [9/9] Packaging Windows application...
cd /d "%~dp0apps\desktop"
call npx electron-builder --win --x64 --config electron-builder.config.cjs --publish never
if %errorlevel% neq 0 (
    echo ERROR: Packaging failed.
    pause
    exit /b 1
)
echo.

:: Copy artifacts to top-level built folder
cd /d "%~dp0"
echo.
echo Copying artifacts to built\...

if not exist "built" mkdir built

:: Copy unpacked app (from release/ output directory set in config)
if exist "release\win-unpacked" (
    if exist "built\ScreenLink" rmdir /s /q "built\ScreenLink"
    xcopy /e /i /q "release\win-unpacked" "built\ScreenLink" >nul
    echo   OK - built\ScreenLink\ScreenLink.exe
) else if exist "apps\desktop\out\win-unpacked" (
    if exist "built\ScreenLink" rmdir /s /q "built\ScreenLink"
    xcopy /e /i /q "apps\desktop\out\win-unpacked" "built\ScreenLink" >nul
    echo   OK - built\ScreenLink\ScreenLink.exe
)

:: Copy installer
for %%f in ("release\ScreenLink Setup *.exe") do (
    copy "%%f" "built\" >nul
    echo   OK - built\%%~nxf
)
for %%f in ("apps\desktop\out\ScreenLink Setup *.exe") do (
    copy "%%f" "built\" >nul
    echo   OK - built\%%~nxf
)

:: Copy portable
for %%f in ("release\ScreenLink *-portable.exe") do (
    copy "%%f" "built\" >nul
    echo   OK - built\%%~nxf
)
for %%f in ("apps\desktop\out\ScreenLink *-portable.exe") do (
    copy "%%f" "built\" >nul
    echo   OK - built\%%~nxf
)

:: Copy SDK licenses
if exist "apps\desktop\public\vendor\LICENSE-SDK-EXCEPTION" copy "apps\desktop\public\vendor\LICENSE-SDK-EXCEPTION" "built\" >nul
if exist "apps\desktop\public\vendor\AGPL-3.0.txt" copy "apps\desktop\public\vendor\AGPL-3.0.txt" "built\" >nul

echo.
echo ============================================================
echo  Build Complete!
echo ============================================================
echo.
echo  built\ScreenLink\ScreenLink.exe  (unpacked, no install needed)
echo  built\ScreenLink-Setup-x64.exe   (NSIS installer)
echo  built\ScreenLink-Portable-x64.exe (portable single EXE)
echo.
echo  To test the unpacked build: double-click test-built-app.bat
echo  To install: run the Setup exe
echo  To distribute: zip the built\ScreenLink folder
echo.
pause
