param(
    [switch]$DeleteProfiles
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$StateDir = Join-Path $ProjectRoot ".screenlink"

$PidFiles = @(
    (Join-Path $StateDir "alice.pid"),
    (Join-Path $StateDir "bob.pid"),
    (Join-Path $StateDir "vite.pid")
)

function Stop-TrackedProcess {
    param([string]$PidFile)

    if (-not (Test-Path -LiteralPath $PidFile)) {
        return
    }

    $content = Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue
    if ($content -and $content.Trim() -match '^\d+$') {
        $pidValue = [int]$content.Trim()
        $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        }
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

foreach ($pidFile in $PidFiles) {
    Stop-TrackedProcess -PidFile $pidFile
}

if ($DeleteProfiles) {
    Remove-Item -LiteralPath "C:\Users\parla\AppData\Roaming\Electron-alice" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "C:\Users\parla\AppData\Roaming\Electron-bob" -Recurse -Force -ErrorAction SilentlyContinue
}
