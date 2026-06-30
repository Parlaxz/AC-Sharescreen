@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0" || exit /b 1

REM -- NVIDIA VFX SDK detection --
REM Check environment variable first, then default install path.
set "NVIDIA_VFX_SDK_ROOT_DEFAULT=C:\Program Files\NVIDIA Corporation\NVIDIA Video Effects"
set "VIDEO_VFX_ENABLED=0"

if defined NVIDIA_VFX_SDK_ROOT (
    echo [ScreenLink] Using NVIDIA_VFX_SDK_ROOT from environment.
) else if exist "%NVIDIA_VFX_SDK_ROOT_DEFAULT%" (
    set "NVIDIA_VFX_SDK_ROOT=%NVIDIA_VFX_SDK_ROOT_DEFAULT%"
    echo [ScreenLink] NVIDIA VFX SDK detected at default path.
) else (
    echo [ScreenLink] NVIDIA VFX SDK not found. Video enhancer will be built without GPU acceleration.
    echo   Set NVIDIA_VFX_SDK_ROOT environment variable to enable NVIDIA VFX features.
)

if defined NVIDIA_VFX_SDK_ROOT (
    set "NVIDIA_VFX_MODEL_DIR=%NVIDIA_VFX_SDK_ROOT%\bin\models"
    set "NVIDIA_VFX_RUNTIME_BIN=%NVIDIA_VFX_SDK_ROOT%\bin"
    set "NVIDIA_VFX_FEATURE_BIN=%NVIDIA_VFX_SDK_ROOT%\features\nvvfxvideosuperres\bin"

    if exist "!NVIDIA_VFX_SDK_ROOT!\bin\NVVideoEffects.dll" (
        if exist "!NVIDIA_VFX_FEATURE_BIN!\nvVFXVideoSuperRes.dll" (
            set "PATH=!NVIDIA_VFX_FEATURE_BIN!;!NVIDIA_VFX_RUNTIME_BIN!;!PATH!"
            set "VIDEO_VFX_ENABLED=1"
        ) else (
            echo [ScreenLink] WARNING: nvVFXVideoSuperRes.dll not found in:
            echo   !NVIDIA_VFX_FEATURE_BIN!
        )
    ) else (
        echo [ScreenLink] WARNING: NVVideoEffects.dll not found in:
        echo   !NVIDIA_VFX_SDK_ROOT!\bin
    )
)

set "VIDEO_SOURCE=native\video-enhancer"
set "VIDEO_BUILD=native\video-enhancer\build"
set "VIDEO_EXE=%VIDEO_BUILD%\Release\screenlink-video-enhancer.exe"
set "CAP_FILE=%TEMP%\screenlink-vfx-capabilities-%RANDOM%.json"

REM -- Configure and build video enhancer --

echo [ScreenLink] Configuring video enhancer...

if "%VIDEO_VFX_ENABLED%"=="1" (
    cmake ^
      -S "%VIDEO_SOURCE%" ^
      -B "%VIDEO_BUILD%" ^
      -G "Visual Studio 17 2022" ^
      -A x64 ^
      -DSCREENLINK_ENABLE_NVIDIA_VFX=ON ^
      "-DNVIDIA_VFX_SDK_ROOT=%NVIDIA_VFX_SDK_ROOT%" ^
      "-DNVIDIA_VFX_MODEL_DIR=%NVIDIA_VFX_MODEL_DIR%"
) else (
    REM Build without NVIDIA VFX -- binary still provides capability probing
    cmake ^
      -S "%VIDEO_SOURCE%" ^
      -B "%VIDEO_BUILD%" ^
      -G "Visual Studio 17 2022" ^
      -A x64
)

if errorlevel 1 (
    set "FAIL_CODE=!ERRORLEVEL!"
    goto :fail
)

echo [ScreenLink] Building video enhancer...

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

REM -- Capability verification (VFX builds only) --

if not "%VIDEO_VFX_ENABLED%"=="1" goto :skip_video_vfx_verify

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
goto :after_video_vfx_verify

:skip_video_vfx_verify
echo [ScreenLink] Video enhancer built without NVIDIA VFX (--capabilities skipped).

:after_video_vfx_verify

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
