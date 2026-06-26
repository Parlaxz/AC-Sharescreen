param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("0.2.3","0.2.4")]
    [string]$Version
)

<#
.SYNOPSIS
    Repair a ScreenLink GitHub release by uploading installers and blockmaps with
    hypenated names matching latest.yml metadata.

.DESCRIPTION
    The electron-builder was previously configured to produce filenames with spaces
    ("ScreenLink Setup X.Y.Z.exe"), but latest.yml references hypenated names
    ("ScreenLink-Setup-X.Y.Z.exe"). This script:
    
    1. Renames the local installer and blockmap to the hypenated convention
    2. Uploads them to the existing GitHub release
    3. Downloads and verifies the uploaded files return HTTP 200
    
    Requires: gh CLI (https://cli.github.com) authenticated with write access to Parlaxz/AC-Sharescreen

.PARAMETER Version
    The release version to repair (e.g. "0.2.4")

.EXAMPLE
    .\scripts\repair-release-upload.ps1 -Version 0.2.4
#>

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $repoRoot "release"
$tag = "v$Version"

Write-Host "=== ScreenLink Release Repair: $tag ===" -ForegroundColor Cyan
Write-Host ""

# ── Verify local artifacts ─────────────────────────────────────────
Write-Host "Checking local artifacts..." -ForegroundColor Yellow

$localSetup = Join-Path $releaseDir "ScreenLink Setup $Version.exe"
$localBlockmap = Join-Path $releaseDir "ScreenLink Setup $Version.exe.blockmap"
$localPortable = Join-Path $releaseDir "ScreenLink $Version.exe"

$newSetup = Join-Path $releaseDir "ScreenLink-Setup-$Version.exe"
$newBlockmap = Join-Path $releaseDir "ScreenLink-Setup-$Version.exe.blockmap"
$newPortable = Join-Path $releaseDir "ScreenLink-Portable-$Version.exe"

$missing = @()
if (-not (Test-Path $localSetup)) { $missing += "ScreenLink Setup $Version.exe" }
if (-not (Test-Path $localBlockmap)) { $missing += "ScreenLink Setup $Version.exe.blockmap" }

if ($missing.Count -gt 0) {
    Write-Host "::error::Missing local artifacts: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Build the artifacts first with: pnpm build && cd apps/desktop && npx electron-builder --win --x64 --config electron-builder.config.cjs --publish never"
    exit 1
}

# ── Create hypenated copies ────────────────────────────────────────
Write-Host "Creating hypenated copies..." -ForegroundColor Yellow

Copy-Item -Path $localSetup -Destination $newSetup -Force
Copy-Item -Path $localBlockmap -Destination $newBlockmap -Force
if (Test-Path $localPortable) {
    Copy-Item -Path $localPortable -Destination $newPortable -Force
    Write-Host "  Copied: ScreenLink-Portable-$Version.exe"
} else {
    Write-Host "  Skipping: portable (not found)"
}

Write-Host "  Copied: ScreenLink-Setup-$Version.exe"
Write-Host "  Copied: ScreenLink-Setup-$Version.exe.blockmap"

# ── Verify gh CLI authentication ───────────────────────────────────
Write-Host ""
Write-Host "Checking gh CLI..." -ForegroundColor Yellow

$ghStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "::error::gh CLI is not authenticated." -ForegroundColor Red
    Write-Host "Run: gh auth login"
    Write-Host "Then re-run this script."
    exit 1
}
Write-Host "gh CLI authenticated."

# ── Check release exists ───────────────────────────────────────────
Write-Host ""
Write-Host "Checking GitHub release $tag..." -ForegroundColor Yellow

$releaseInfo = gh release view "$tag" --json isDraft,isPrerelease 2>$null
if (-not $releaseInfo) {
    Write-Host "::error::Release $tag does not exist on GitHub." -ForegroundColor Red
    Write-Host "Create it first: gh release create $tag --title $tag --notes ''''"
    exit 1
}
Write-Host "Release $tag found."

# ── Upload assets ─────────────────────────────────────────────────
Write-Host ""
Write-Host "Uploading assets..." -ForegroundColor Yellow

$uploads = @(
    @{ Path = $newSetup; Name = "ScreenLink-Setup-$Version.exe" },
    @{ Path = $newBlockmap; Name = "ScreenLink-Setup-$Version.exe.blockmap" }
)
if (Test-Path $newPortable) {
    $uploads += @{ Path = $newPortable; Name = "ScreenLink-Portable-$Version.exe" }
}

$uploadErrors = @()
foreach ($item in $uploads) {
    Write-Host "  Uploading $($item.Name)..."
    gh release upload "$tag" "$($item.Path)" --clobber
    if ($LASTEXITCODE -ne 0) {
        $uploadErrors += "Failed to upload $($item.Name)"
    } else {
        Write-Host "    OK"
    }
}

if ($uploadErrors.Count -gt 0) {
    Write-Host "::error::Upload errors: $($uploadErrors -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "All uploads complete."

# ── Verify download URLs ──────────────────────────────────────────
Write-Host ""
Write-Host "Verifying download URLs..." -ForegroundColor Yellow

$baseUrl = "https://github.com/Parlaxz/AC-Sharescreen/releases/download/$tag"
$urls = @(
    "$baseUrl/ScreenLink-Setup-$Version.exe",
    "$baseUrl/ScreenLink-Setup-$Version.exe.blockmap",
    "$baseUrl/latest.yml"
)

$urlErrors = @()
foreach ($url in $urls) {
    try {
        $response = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 30
        if ($response.StatusCode -eq 200) {
            Write-Host "  OK: $url"
        } else {
            $urlErrors += "HTTP $($response.StatusCode) for $url"
            Write-Host "  FAIL: $url (HTTP $($response.StatusCode))" -ForegroundColor Red
        }
    } catch {
        $urlErrors += "Failed to check $url"
        Write-Host "  ERROR: $url - $_" -ForegroundColor Red
    }
}

if ($urlErrors.Count -gt 0) {
    Write-Host "::error::URL verification errors: $($urlErrors -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Repair complete for $tag ===" -ForegroundColor Green
Write-Host ""
Write-Host "The release now has hypenated filenames matching latest.yml."
Write-Host "If this is the latest release, the updater should find the correct artifact."
