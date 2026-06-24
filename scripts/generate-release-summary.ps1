param(
    [Parameter(Mandatory = $true)]
    [string]$Trigger,
    [Parameter(Mandatory = $true)]
    [string]$Tag,
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string]$Sha,
    [Parameter(Mandatory = $true)]
    [string]$SetupExe,
    [Parameter(Mandatory = $true)]
    [string]$Blockmap,
    [Parameter(Mandatory = $true)]
    [string]$PortableExe
)

$releaseUrl = "https://github.com/Parlaxz/AC-Sharescreen/releases/tag/$Tag"

$summary = @"
## ScreenLink Release Summary

| Item | Value |
|------|-------|
| Trigger | $Trigger |
| Tag | $Tag |
| Version | $Version |
| Commit | $Sha |
| Release URL | $releaseUrl |
| Helper self-test | PASSED |
| Tests | PASSED |

### Artifacts

| Artifact | Name |
|----------|------|
| Setup EXE | $SetupExe |
| Blockmap | $Blockmap |
| latest.yml | latest.yml |
| Portable | $PortableExe |

**Note:** The portable EXE cannot self-update. Users should install the Setup version for automatic updates.
"@

$summary | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8
