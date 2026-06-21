@echo off
cd /d "%~dp0"

echo ============================================================
echo  ScreenLink - Build Distributable
echo ============================================================
echo.

:: Verify node and pnpm
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

echo [1/9] Node: 
node --version
echo [1/9] pnpm: 
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

:: Build shared package
echo [4/9] Building shared package...
call pnpm --filter @screenlink/shared build
if %errorlevel% neq 0 (
    echo ERROR: shared package build failed.
    pause
    exit /b 1
)
echo.

:: Build vdo-adapter package
echo [5/9] Building vdo-adapter package...
call pnpm --filter @screenlink/vdo-adapter build
if %errorlevel% neq 0 (
    echo ERROR: vdo-adapter package build failed.
    pause
    exit /b 1
)
echo.

:: Build Electron main process
echo [6/9] Building Electron main...
cd /d "%~dp0apps\desktop"
call npx tsc -p tsconfig.main.json --outDir dist/main
if %errorlevel% neq 0 (
    echo ERROR: Main process build failed.
    pause
    exit /b 1
)
echo.

:: Build preload
echo [7/9] Building preload...
call npx tsc -p tsconfig.preload.json --outDir dist/preload
if %errorlevel% neq 0 (
    echo ERROR: Preload build failed.
    pause
    exit /b 1
)
echo.

:: Build renderer
echo [8/9] Building renderer...
call npx vite build
if %errorlevel% neq 0 (
    echo ERROR: Renderer build failed.
    pause
    exit /b 1
)
echo.

:: Package with electron-builder
echo [9/9] Packaging Windows application...
call npx electron-builder --win --x64 --config.extraMetadata.main=dist/main/main.js
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

:: Copy unpacked app
if exist "apps\desktop\out\win-unpacked" (
    if exist "built\ScreenLink" rmdir /s /q "built\ScreenLink"
    xcopy /e /i /q "apps\desktop\out\win-unpacked" "built\ScreenLink" >nul
    echo   OK - built\ScreenLink\ScreenLink.exe
)

:: Copy installer
for %%f in ("apps\desktop\out\ScreenLink Setup *.exe") do (
    copy "%%f" "built\" >nul
    echo   OK - built\%%~nxf
)

:: Copy portable
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
