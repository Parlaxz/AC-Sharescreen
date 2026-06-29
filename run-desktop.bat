@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0" || exit /b 1

set "NVIDIA_VFX_SDK_ROOT=C:\Users\parla\Downloads\NVDA VFX SDK\VideoFX"
set "NVIDIA_VFX_MODEL_DIR=%NVIDIA_VFX_SDK_ROOT%\bin\models"

set "NVIDIA_VFX_RUNTIME_BIN=%NVIDIA_VFX_SDK_ROOT%\bin"
set "NVIDIA_VFX_FEATURE_BIN=%NVIDIA_VFX_SDK_ROOT%\features\nvvfxvideosuperres\bin"

set "PATH=%NVIDIA_VFX_FEATURE_BIN%;%NVIDIA_VFX_RUNTIME_BIN%;%PATH%"

set "VIDEO_SOURCE=native\video-enhancer"
set "VIDEO_BUILD=native\video-enhancer\build"
set "VIDEO_EXE=%VIDEO_BUILD%\Release\screenlink-video-enhancer.exe"
set "CAP_FILE=%TEMP%\screenlink-vfx-capabilities-%RANDOM%.json"

if not exist "%NVIDIA_VFX_SDK_ROOT%\bin\NVVideoEffects.dll" (
    echo [ScreenLink] NVIDIA VFX runtime was not found:
    echo   %NVIDIA_VFX_SDK_ROOT%\bin\NVVideoEffects.dll
    set "FAIL_CODE=1"
    goto :fail
)

if not exist "%NVIDIA_VFX_FEATURE_BIN%\nvVFXVideoSuperRes.dll" (
    echo [ScreenLink] NVIDIA Video Super Resolution feature was not found:
    echo   %NVIDIA_VFX_FEATURE_BIN%\nvVFXVideoSuperRes.dll
    set "FAIL_CODE=1"
    goto :fail
)

echo [ScreenLink] Configuring NVIDIA VFX video enhancer...

cmake ^
  -S "%VIDEO_SOURCE%" ^
  -B "%VIDEO_BUILD%" ^
  -G "Visual Studio 17 2022" ^
  -A x64 ^
  -DSCREENLINK_ENABLE_NVIDIA_VFX=ON ^
  "-DNVIDIA_VFX_SDK_ROOT=%NVIDIA_VFX_SDK_ROOT%" ^
  "-DNVIDIA_VFX_MODEL_DIR=%NVIDIA_VFX_MODEL_DIR%"

if errorlevel 1 (
    set "FAIL_CODE=!ERRORLEVEL!"
    goto :fail
)

echo [ScreenLink] Building NVIDIA VFX video enhancer...

cmake ^
  --build "%VIDEO_BUILD%" ^
  --config Release

if errorlevel 1 (
    set "FAIL_CODE=!ERRORLEVEL!"
    goto :fail
)

if not exist "%VIDEO_EXE%" (
    echo [ScreenLink] Video enhancer executable was not produced:
    echo   %VIDEO_EXE%
    set "FAIL_CODE=1"
    goto :fail
)

echo [ScreenLink] Verifying NVIDIA VFX capability...

"%VIDEO_EXE%" --capabilities > "%CAP_FILE%"

if errorlevel 1 (
    set "FAIL_CODE=!ERRORLEVEL!"
    type "%CAP_FILE%" 2>nul
    del /q "%CAP_FILE%" 2>nul
    goto :fail
)

type "%CAP_FILE%"

findstr /C:"available" "%CAP_FILE%" | findstr /C:"true" >nul

if errorlevel 1 (
    echo [ScreenLink] NVIDIA VFX helper did not report available=true.
    del /q "%CAP_FILE%" 2>nul
    set "FAIL_CODE=1"
    goto :fail
)

del /q "%CAP_FILE%" 2>nul

echo [ScreenLink] NVIDIA VFX video enhancer verified successfully.

powershell ^
  -NoProfile ^
  -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\dev-launcher.ps1"

if errorlevel 1 (
    set "FAIL_CODE=!ERRORLEVEL!"
    goto :fail
)

exit /b 0

:fail
if not defined FAIL_CODE set "FAIL_CODE=1"
echo.
echo [ScreenLink] Launch failed (exit code: !FAIL_CODE!)
pause
exit /b !FAIL_CODE!