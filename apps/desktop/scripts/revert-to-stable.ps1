# revert-to-stable.ps1 - Headless rollback from a beta build to the latest
# STABLE ScreenLink release. Does NOT execute the installed (possibly
# broken) app at any point:
#
#   1. Flips the persisted update channel back to "stable" (settings.json).
#   2. Queries GitHub for the latest non-prerelease release.
#   3. Downloads its NSIS Setup installer.
#   4. Closes any running ScreenLink processes.
#   5. Clears any pending beta update cache.
#   6. Silent-installs the stable version over the existing installation.
#   7. Relaunches ScreenLink (unless -NoLaunch).
#
# Usage (from the install folder, via revert-to-stable.bat):
#   powershell -NoProfile -ExecutionPolicy Bypass ^
#     -File revert-to-stable.ps1 [-NoLaunch] [-DryRun] [-NoPause]
param(
    [switch]$NoLaunch,
    [switch]$DryRun,
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$RepoOwner = "Parlaxz"
$RepoName  = "AC-Sharescreen"

function Write-Step([string]$Message) { Write-Host "[revert] $Message" }
function Finish {
    param([int]$Code, [string]$Message)
    Write-Host "[revert] $Message"
    if (-not $NoPause) { Write-Host "[revert] Press Enter to close..."; Read-Host | Out-Null }
    exit $Code
}

try {
    # â”€â”€ 1. Flip persisted update channel to stable â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-Step "Setting update channel to 'stable'..."
    $candidates = @(
        (Join-Path $env:APPDATA "ScreenLink\settings.json"),
        (Join-Path $env:APPDATA "screenlink\settings.json")
    ) | Where-Object { $_ -and (Test-Path $_) }

    if ($DryRun) {
        Write-Step "DryRun: would update channel in [$($candidates -join ', ')]"
    } else {
        if ($candidates.Count -eq 0) {
            Write-Step "No settings file found (fresh install?) - nothing to flip."
        }
        foreach ($file in $candidates) {
            try {
                $json = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
                $json | Add-Member -NotePropertyName updateChannel -NotePropertyValue "stable" -Force
                ($json | ConvertTo-Json -Depth 64) | Out-File -FilePath $file -Encoding UTF8 -Force
                $bak = $file -replace '\.json$', '.json.bak'
                Copy-Item $file $bak -Force
                Write-Step "  updated: $file"
            } catch {
                Write-Step "  WARNING: could not update ${file}: $_"
            }
        }
    }

    # â”€â”€ 2. Find the latest stable release â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-Step "Querying latest stable release from GitHub..."
    $api = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
    if ($DryRun) {
        Write-Step "DryRun: would GET $api"
        $release = [pscustomobject]@{
            tag_name = "v0.0.0-dryrun"
            assets   = @([pscustomobject]@{ name = "ScreenLink-Setup-0.0.0-dryrun.exe"; browser_download_url = "https://example.invalid/setup.exe" })
        }
    } else {
        $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "ScreenLink-Revert" } -TimeoutSec 30
    }
    if ($release.prerelease) {
        Finish 1 "Latest release is marked prerelease - aborting (expected a stable release)."
    }
    $version  = $release.tag_name.TrimStart("v")
    $asset    = $release.assets | Where-Object { $_.name -match '^ScreenLink-Setup-.*\.exe$' } | Select-Object -First 1
    if (-not $asset) {
        Finish 1 "No ScreenLink-Setup-*.exe asset found on release $($release.tag_name)."
    }
    Write-Step "Latest stable: $($release.tag_name)"

    # â”€â”€ 3. Download the stable installer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $setupExe = Join-Path $env:TEMP $asset.name
    if ($DryRun) {
        Write-Step "DryRun: would download $($asset.browser_download_url) -> $setupExe"
    } else {
        Write-Step "Downloading $($asset.name)..."
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setupExe `
            -Headers @{ "User-Agent" = "ScreenLink-Revert" } -TimeoutSec 600
        if ((Get-Item $setupExe).Length -lt 10MB) {
            Finish 1 "Downloaded installer looks too small - download failed."
        }
        Write-Step ("Downloaded: {0} ({1})" -f $setupExe, [Math]::Round((Get-Item $setupExe).Length / 1MB, 1))
    }

    if ($DryRun) { Finish 0 "DryRun complete - no changes were made." }

    # â”€â”€ 4. Close running ScreenLink instances â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $procs = Get-Process -Name "ScreenLink" -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Step "Closing $($procs.Count) running ScreenLink process(es)..."
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        Write-Step "ScreenLink is not currently running."
    }

    # â”€â”€ 5. Clear pending beta update cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    foreach ($cache in @(
        (Join-Path $env:LOCALAPPDATA "@screenlink-desktop-updater\pending"),
        (Join-Path $env:LOCALAPPDATA "@ScreenLink-desktop-updater\pending")
    )) {
        if (Test-Path $cache) {
            Write-Step "Removing pending update cache: $cache"
            Remove-Item $cache -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # â”€â”€ 6. Silent-install the stable version â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    Write-Step "Installing stable $version silently (this can take a minute)..."
    $inst = Start-Process -FilePath $setupExe -ArgumentList "/S" -PassThru -Wait
    if ($inst.ExitCode -ne 0) {
        Finish 1 "Installer exited with code $($inst.ExitCode)."
    }
    Write-Step "Stable $version installed."

    # â”€â”€ 7. Relaunch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if ($NoLaunch) {
        Write-Step "Skipping launch (-NoLaunch)."
    } else {
        $launch = $null
        try {
            $uninstallKeys = @(
                "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
                "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
                "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
            )
            foreach ($root in $uninstallKeys) {
                $entry = Get-ItemProperty $root -ErrorAction SilentlyContinue |
                    Where-Object { $_.DisplayName -eq "ScreenLink" -and $_.InstallLocation } |
                    Select-Object -First 1
                if ($entry -and (Test-Path (Join-Path $entry.InstallLocation "ScreenLink.exe"))) {
                    $launch = Join-Path $entry.InstallLocation "ScreenLink.exe"
                    break
                }
            }
        } catch {
            Write-Step "  WARNING: could not read uninstall registry keys: $_"
        }
        if ($launch) {
            Write-Step "Launching stable ScreenLink..."
            Start-Process -FilePath $launch | Out-Null
        } else {
            Write-Step "Could not locate the installed ScreenLink.exe - start it manually."
        }
    }

    Finish 0 "Rollback to stable $version complete."
} catch {
    Finish 1 "Rollback FAILED: $_"
}

