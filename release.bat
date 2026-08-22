@echo off
setlocal
if "%~1"=="" (
    echo Usage: release.bat ^<version^>    e.g. release.bat 0.8.2
    exit /b 1
)
set "VERSION=%~1"
cd /d "%~dp0"

echo [release] Setting version to %VERSION%...
node scripts/set-release-version.mjs %VERSION% || goto :fail

echo [release] Committing version bump...
git add package.json apps/desktop/package.json || goto :fail
git commit -m "v%VERSION%" || goto :fail

echo [release] Pushing main...
git push origin main || goto :fail

echo [release] Tagging v%VERSION%...
git tag v%VERSION% || goto :fail
git push origin v%VERSION% || goto :fail

echo [release] Dispatching release workflow...
gh workflow run release.yml -f tag=v%VERSION% -f release_type=stable -R Parlaxz/AC-Sharescreen || goto :fail

echo.
echo [release] Workflow dispatched for v%VERSION%.
echo [release] Monitor: https://github.com/Parlaxz/AC-Sharescreen/actions
echo [release] Release appears at: https://github.com/Parlaxz/AC-Sharescreen/releases/tag/v%VERSION%
exit /b 0

:fail
echo.
echo [release] FAILED at previous step.
exit /b 1
