@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "AUDIO_HELPER=native\audio-helper\build\Release\screenlink-audio-helper.exe"
set "VIDEO_HELPER=native\video-enhancer\build\Release\screenlink-video-enhancer.exe"
set "TRAY_ICON=apps\desktop\assets\tray-icon.png"
set "DESKTOP=apps\desktop"
set "BUILD_OUTPUT=release"
set "PACKAGED_AUDIO_HELPER=%BUILD_OUTPUT%\win-unpacked\resources\screenlink-audio-helper.exe"
set "PACKAGED_VIDEO_HELPER=%BUILD_OUTPUT%\win-unpacked\resources\screenlink-video-enhancer.exe"
set "PACKAGED_TRAY_ICON=%BUILD_OUTPUT%\win-unpacked\resources\tray-icon.png"

echo.
echo === ScreenLink Windows x64 build ===
echo.

where pnpm >nul 2>&1 || (
    echo ERROR: pnpm was not found in PATH.
    exit /b 1
)

where node >nul 2>&1 || (
    echo ERROR: Node.js was not found in PATH.
    exit /b 1
)

where cmake >nul 2>&1 || (
    echo ERROR: CMake was not found in PATH.
    exit /b 1
)

if not exist "%TRAY_ICON%" (
    echo ERROR: Tray icon was not found:
    echo        %TRAY_ICON%
    exit /b 1
)

:: ── Audio helper ────────────────────────────────────────────────────────────

echo [1/9] Configuring native audio helper (CMake)...
if not exist "native\audio-helper\build" (
    call pnpm audio-helper:configure
    if errorlevel 1 goto :fail
) else (
    echo CMake build directory already exists, skipping configure.
)

echo [2/9] Building native audio helper...
call pnpm audio-helper:build
if errorlevel 1 goto :fail

if not exist "%AUDIO_HELPER%" (
    echo ERROR: Audio helper was not created:
    echo        %AUDIO_HELPER%
    goto :fail
)

echo [3/9] Running audio helper self-test...
call pnpm audio-helper:self-test
if errorlevel 1 goto :fail

:: ── Video enhancer (NVIDIA VFX) ─────────────────────────────────────────────

echo [4/9] Configuring native video enhancer (CMake)...

:: Detect NVIDIA VFX SDK: check env var first, then default Program Files path
if not defined NVIDIA_VFX_SDK_ROOT (
    if exist "C:\Program Files\NVIDIA Corporation\NVIDIA Video Effects" (
        set "NVIDIA_VFX_SDK_ROOT=C:\Program Files\NVIDIA Corporation\NVIDIA Video Effects"
    )
)

if defined NVIDIA_VFX_SDK_ROOT (
    echo   NVIDIA VFX SDK found at: %NVIDIA_VFX_SDK_ROOT%

    if not exist "native\video-enhancer\build" (
        call pnpm video-enhancer:configure
        if errorlevel 1 goto :fail
    ) else (
        echo CMake build directory already exists, skipping configure.
    )
) else (
    echo   NVIDIA VFX SDK not found, building video enhancer without NVIDIA VFX.
    echo   Set NVIDIA_VFX_SDK_ROOT environment variable to enable GPU-enhanced encoding.

    if not exist "native\video-enhancer\build" (
        cmake ^
            -S native/video-enhancer ^
            -B native/video-enhancer/build ^
            -G "Visual Studio 17 2022" ^
            -A x64
        if errorlevel 1 goto :fail
    ) else (
        echo CMake build directory already exists, skipping configure.
    )
)

echo [5/9] Building native video enhancer...
cmake --build native/video-enhancer/build --config Release
if errorlevel 1 goto :fail

if not exist "%VIDEO_HELPER%" (
    echo ERROR: Video enhancer was not created:
    echo        %VIDEO_HELPER%
    goto :fail
)

echo [6/9] Running video enhancer self-test...
"%VIDEO_HELPER%" --self-test
if errorlevel 1 goto :fail

:: ── TypeScript packages ─────────────────────────────────────────────────────

echo [7/9] Building ScreenLink packages...
if exist "%DESKTOP%\dist\win-unpacked" (
    rmdir /s /q "%DESKTOP%\dist\win-unpacked"
)

call pnpm build
if errorlevel 1 goto :fail

if not exist "%DESKTOP%\dist\main\main.js" (
    echo ERROR: Desktop main process was not built:
    echo        %DESKTOP%\dist\main\main.js
    goto :fail
)

if not exist "%DESKTOP%\dist\preload\index.js" (
    echo ERROR: Desktop preload output was not built:
    echo        %DESKTOP%\dist\preload\index.js
    goto :fail
)

if not exist "%DESKTOP%\dist\renderer\index.html" (
    echo ERROR: Desktop renderer was not built:
    echo        %DESKTOP%\dist\renderer\index.html
    goto :fail
)

echo [8/9] Cleaning previous release output...
if exist "%BUILD_OUTPUT%" (
    echo Removing previous release output...
    rmdir /s /q "%BUILD_OUTPUT%"
    if exist "%BUILD_OUTPUT%" (
        echo ERROR: Could not remove the previous release directory.
        echo Close all running packaged ScreenLink instances and try again.
        goto :fail
    )
)

echo [9/9] Building Windows x64 installer...
pushd "%DESKTOP%"
call npx electron-builder --win --x64 --config electron-builder.config.cjs --publish never
set "BUILD_RESULT=%ERRORLEVEL%"
popd

if not "%BUILD_RESULT%"=="0" goto :fail

:: ── Post-package validation ─────────────────────────────────────────────────

if not exist "%PACKAGED_AUDIO_HELPER%" (
    echo ERROR: Build completed, but the packaged audio helper is missing:
    echo        %PACKAGED_AUDIO_HELPER%
    goto :fail
)

if not exist "%PACKAGED_VIDEO_HELPER%" (
    echo ERROR: Build completed, but the packaged video enhancer is missing:
    echo        %PACKAGED_VIDEO_HELPER%
    goto :fail
)

if not exist "%PACKAGED_TRAY_ICON%" (
    echo ERROR: Build completed, but the packaged tray icon is missing:
    echo        %PACKAGED_TRAY_ICON%
    goto :fail
)

if not exist "%BUILD_OUTPUT%\win-unpacked\resources\app-update.yml" (
    echo ERROR: Build completed, but app-update.yml is missing:
    echo        %BUILD_OUTPUT%\win-unpacked\resources\app-update.yml
    goto :fail
)

echo.
echo === BUILD SUCCEEDED ===
echo.
echo Packaged audio helper:
echo   %PACKAGED_AUDIO_HELPER%
echo.
echo Packaged video enhancer:
echo   %PACKAGED_VIDEO_HELPER%
echo.
echo Packaged tray icon:
echo   %PACKAGED_TRAY_ICON%
echo.
echo app-update.yml:
echo   %BUILD_OUTPUT%\win-unpacked\resources\app-update.yml
echo.
echo Unpacked application:
echo   %BUILD_OUTPUT%\win-unpacked
echo.

echo Installer and updater files:
set "FOUND_INSTALLER="

for /f "delims=" %%F in ('dir /b /a-d "%BUILD_OUTPUT%\*.exe" 2^>nul') do (
    echo   %BUILD_OUTPUT%\%%F
    set "FOUND_INSTALLER=1"
)

if not defined FOUND_INSTALLER (
    echo   No top-level installer EXE was found.
    echo   Check: %BUILD_OUTPUT%
)

for /f "delims=" %%F in ('dir /b /a-d "%BUILD_OUTPUT%\*.yml" 2^>nul') do (
    echo   %BUILD_OUTPUT%\%%F
)

for /f "delims=" %%F in ('dir /b /a-d "%BUILD_OUTPUT%\*.blockmap" 2^>nul') do (
    echo   %BUILD_OUTPUT%\%%F
)

echo.
exit /b 0

:fail
echo.
echo === BUILD FAILED ===
exit /b 1
