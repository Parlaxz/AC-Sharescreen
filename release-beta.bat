@echo off
setlocal
if "%~1"=="" (
    echo Usage: release-beta.bat ^<baseVersion^> [betaNumber]    e.g. release-beta.bat 0.8.2
    exit /b 1
)
set "BASE=%~1"
set "N=%~2"
cd /d "%~dp0"

rem Auto-increment: pick the first beta number whose tag does not exist yet.
rem An explicit second argument overrides the auto-detection.
if not "%N%"=="" goto :havenum
set /a N=1
:findn
git rev-parse -q --verify refs/tags/v%BASE%-beta.%N% >nul 2>&1
if errorlevel 1 goto :havenum
set /a N+=1
goto :findn
:havenum

set "VERSION=%BASE%-beta.%N%"

echo [release-beta] Setting version to %VERSION%...
node scripts/set-release-version.mjs %VERSION% || goto :fail

echo [release-beta] Committing version bump...
git add package.json apps/desktop/package.json || goto :fail
git commit -m "v%VERSION%" || goto :fail

echo [release-beta] Pushing main...
git push origin main || goto :fail

echo [release-beta] Tagging v%VERSION%...
git tag v%VERSION% || goto :fail
git push origin v%VERSION% || goto :fail

echo [release-beta] Dispatching prerelease workflow...
gh workflow run release.yml -f tag=v%VERSION% -f release_type=prerelease -R Parlaxz/AC-Sharescreen || goto :fail

echo.
echo [release-beta] Workflow dispatched for v%VERSION%.
echo [release-beta] Monitor: https://github.com/Parlaxz/AC-Sharescreen/actions
echo [release-beta] Release appears at: https://github.com/Parlaxz/AC-Sharescreen/releases/tag/v%VERSION%
echo [release-beta] Beta users receive this build by switching to the Beta channel in Settings ^> Updates.
exit /b 0

:fail
echo.
echo [release-beta] FAILED at previous step.
exit /b 1
