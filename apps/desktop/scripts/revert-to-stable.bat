@echo off
rem ============================================================================
rem revert-to-stable.bat - HEADLESS rollback to the latest STABLE ScreenLink.
rem
rem Safe to run when the installed beta cannot render or launch: this script
rem never executes the installed app. It flips the persisted update channel
rem back to stable, closes running instances, downloads the latest stable
rem installer from GitHub, and silently installs it over the existing copy.
rem
rem Options (forwarded to revert-to-stable.ps1):
rem   -NoLaunch   do not relaunch ScreenLink after installing
rem   -DryRun     print what would happen without changing anything
rem   -NoPause    do not wait for Enter at the end (for automation)
rem ============================================================================
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%revert-to-stable.ps1" %*
set "EXITCODE=%errorlevel%"
endlocal & exit /b %EXITCODE%
