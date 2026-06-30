@echo off
setlocal enabledelayedexpansion

:: Bump version helper
:: Reads current version from package.json and prompts for bump type.

for /f "tokens=*" %%a in ('node -p "require('./package.json').version"') do set "CURRENT_VERSION=%%a"

if "%CURRENT_VERSION%"=="" (
    echo ERROR: Could not read version from package.json
    exit /b 1
)

echo Current version: %CURRENT_VERSION%
echo.
echo Select bump type:
echo   [1] Patch  (e.g. %CURRENT_VERSION% -^> patch bump)
echo   [2] Minor  (e.g. %CURRENT_VERSION% -^> minor bump)
echo   [3] Major  (e.g. %CURRENT_VERSION% -^> major bump)
echo   [4] Custom
echo.
set /p CHOICE="Enter choice (1-4): "

if "%CHOICE%"=="1" (
    for /f "tokens=*" %%a in ('node -p "const v='%CURRENT_VERSION%'.split('.').map(Number); v[2]++; v.join('.')"') do set "NEW_VERSION=%%a"
    goto update
)
if "%CHOICE%"=="2" (
    for /f "tokens=*" %%a in ('node -p "const v='%CURRENT_VERSION%'.split('.').map(Number); v[1]++; v[2]=0; v.join('.')"') do set "NEW_VERSION=%%a"
    goto update
)
if "%CHOICE%"=="3" (
    for /f "tokens=*" %%a in ('node -p "const v='%CURRENT_VERSION%'.split('.').map(Number); v[0]++; v[1]=0; v[2]=0; v.join('.')"') do set "NEW_VERSION=%%a"
    goto update
)
if "%CHOICE%"=="4" (
    set /p NEW_VERSION="Enter new version (current: %CURRENT_VERSION%): "
    if "!NEW_VERSION!"=="" (
        echo Version cannot be empty.
        exit /b 1
    )
    goto update
)

echo Invalid choice. Exiting.
exit /b 1

:update
echo.
echo Setting version to: !NEW_VERSION!
node scripts/set-release-version.mjs !NEW_VERSION!
if %ERRORLEVEL% neq 0 (
    echo Failed to set version.
    exit /b %ERRORLEVEL%
)

for /f "tokens=*" %%a in ('node -p "require('./package.json').version"') do set "CONFIRMED=%%a"
echo Confirmed: version is now !CONFIRMED!
echo Done.
