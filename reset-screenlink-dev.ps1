# reset-screenlink-dev.ps1 — ScreenLink Dev Reset
#
# Stops only ScreenLink-owned processes tracked by project PID files.
# Never scans for generic cmd.exe, node.exe, or electron.exe.
# Only deletes Alice/Bob profiles when -DeleteProfiles is specified.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File reset-screenlink-dev.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File reset-screenlink-dev.ps1 -DeleteProfiles

param(
    [switch]$DeleteProfiles
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSCommandPath
$StateDir    = Join-Path $ProjectRoot ".screenlink"

function Write-Log {
    param([string]$Msg)
    Write-Host "[ScreenLink-Reset] $Msg"
}

# ─── Stop processes by PID file ────────────────────────────────────────────────

if (-not (Test-Path $StateDir)) {
    Write-Log "No .screenlink/ state directory — nothing to clean."
    exit 0
}

$pidFiles = Get-ChildItem (Join-Path $StateDir "*.pid") -ErrorAction SilentlyContinue
if (-not $pidFiles) {
    Write-Log "No PID files found in $StateDir — nothing to clean."
}

$stoppedCount = 0
foreach ($file in $pidFiles) {
    $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if ($content) {
        $pid = $content.Trim()
        if ($pid -match '^\d+$') {
            $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Log "Stopping $($file.BaseName) (PID: $pid)..."
                Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                $stoppedCount++
            } else {
                Write-Log "PID $pid from $($file.Name) not running (stale)"
            }
        }
    }
    Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
}

if ($stoppedCount -eq 0) {
    Write-Log "No running ScreenLink processes found."
}

# ─── Optionally delete Alice/Bob profile directories ──────────────────────────

if ($DeleteProfiles) {
    Write-Log "Deleting Alice/Bob profile directories..."
    $appData = [Environment]::GetFolderPath("ApplicationData")
    $baseDir = Join-Path $appData "ScreenLink"

    foreach ($profile in @("alice", "bob")) {
        $profilePath = "$baseDir-$profile"
        if (Test-Path $profilePath) {
            Write-Log "  Deleting $profile data at: $profilePath"
            Remove-Item $profilePath -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            Write-Log "  $profile data directory not found (skipped)"
        }
    }
}

Write-Log "Done."
