@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "HELPER=native\audio-helper\build\Release\screenlink-audio-helper.exe"
set "TRAY_ICON=apps\desktop\assets\tray-icon.png"
set "DESKTOP=apps\desktop"
set "BUILD_OUTPUT=release"
set "PACKAGED_HELPER=%BUILD_OUTPUT%\win-unpacked\resources\screenlink-audio-helper.exe"
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

echo [1/6] Configuring native audio helper (CMake)...
if not exist "native\audio-helper\build" (
    call pnpm audio-helper:configure
    if errorlevel 1 goto :fail
) else (
    echo CMake build directory already exists, skipping configure.
)

echo [2/6] Building native audio helper...
call pnpm audio-helper:build
if errorlevel 1 goto :fail

if not exist "%HELPER%" (
    echo ERROR: Audio helper was not created:
    echo        %HELPER%
    goto :fail
)

echo [3/6] Running audio helper self-test...
call pnpm audio-helper:self-test
if errorlevel 1 goto :fail

echo [4/6] Building ScreenLink packages...
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

echo [5/6] Cleaning previous release output...
if exist "%BUILD_OUTPUT%" (
    echo Removing previous release output...
    rmdir /s /q "%BUILD_OUTPUT%"
    if exist "%BUILD_OUTPUT%" (
        echo ERROR: Could not remove the previous release directory.
        echo Close all running packaged ScreenLink instances and try again.
        goto :fail
    )
)

echo [6/6] Building Windows x64 installer...
pushd "%DESKTOP%"
call npx electron-builder --win --x64 --config electron-builder.config.cjs --publish never
set "BUILD_RESULT=%ERRORLEVEL%"
popd

if not "%BUILD_RESULT%"=="0" goto :fail

if not exist "%PACKAGED_HELPER%" (
    echo ERROR: Build completed, but the packaged audio helper is missing:
    echo        %PACKAGED_HELPER%
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
echo   %PACKAGED_HELPER%
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
