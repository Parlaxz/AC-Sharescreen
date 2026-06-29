<#
.SYNOPSIS
  Captures live diagnostics for the NVIDIA VSR video-enhancer helper process.

.DESCRIPTION
  Records timestamped helper PID stability, CPU, private working set,
  NVIDIA GPU utilization/memory/power/temp/clocks (via nvidia-smi when
  available) into a timestamped folder under $env:TEMP and zips it.
  Default duration is 60 seconds; finishes in <90s for any duration up
  to 300s.

  Unavailable metrics are recorded as "unavailable" (never blank).

.PARAMETER Seconds
  Duration to capture (default: 60, max recommended: 300).

.EXAMPLE
  .\capture-nvidia-vsr-live.ps1
  .\capture-nvidia-vsr-live.ps1 -Seconds 120
#>

param(
    [int]$Seconds = 60
)

$startTime = Get-Date
$timestamp = $startTime.ToString("yyyyMMdd-HHmmss")
$outDir = Join-Path $env:TEMP "nvidia-vsr-capture-$timestamp"
$null = New-Item -ItemType Directory -Path $outDir -Force

# ── Environment metadata ──────────────────────────────────────────────
$gitHead = & git rev-parse HEAD 2>$null
$gitStatus = & git status --short 2>$null

$metaLines = @(
    "capture_started: $($startTime.ToString('o'))",
    "duration_seconds: $Seconds",
    "git_head: $gitHead",
    "git_status:"
)
if ($gitStatus) {
    $metaLines += $gitStatus
} else {
    $metaLines += "  (clean)"
}
$metaLines | Out-File (Join-Path $outDir "metadata.txt") -Encoding utf8

# ── Helper PID tracking ──────────────────────────────────────────────
$lastHelperPid = $null
$pidChanged = "false"

# ── Sampling ─────────────────────────────────────────────────────────
$logFile = Join-Path $outDir "samples.csv"
# CSV header matching field order
$header = "Timestamp,HelperPID,PID_Changed,HelperCPU,HelperWS_MB,GPU_Util_Pct,GPU_Mem_MB,GPU_MemCtrl_Pct,GPU_Clock_MHz,GPU_Power_W,GPU_Temp_C"
$header | Out-File $logFile -Encoding utf8

$endTime = $startTime.AddSeconds($Seconds)
$sampleInterval = 2  # seconds between samples
$remainingOverhead = 5  # safety margin (seconds)

# Pre-warm nvidia-smi once if available
$nvsmiAvailable = $null -ne (Get-Command "nvidia-smi.exe" -ErrorAction SilentlyContinue)
if ($nvsmiAvailable) {
    & "nvidia-smi" --query-gpu=name --format=csv,noheader 2>$null | Out-Null
}

while ((Get-Date) -lt $endTime) {
    $now = Get-Date -Format "HH:mm:ss"

    # Helper process info
    $helper = Get-Process -Name "screenlink-video-enhancer" -ErrorAction SilentlyContinue
    if ($helper) {
        $pidVal = $helper.Id
        $pidChanged = if ($lastHelperPid -and $lastHelperPid -ne $pidVal) { "true" } else { "false" }
        $lastHelperPid = $pidVal
        $cpuVal = "{0:N1}" -f $helper.CPU
        $wsVal = "{0:N1}" -f ($helper.WorkingSet64 / 1MB)
    } else {
        $pidVal = "unavailable"
        $pidChanged = "false"
        $cpuVal = "unavailable"
        $wsVal = "unavailable"
        $lastHelperPid = $null
    }

    # NVIDIA GPU stats
    $gpuUtil = "unavailable"
    $gpuMem = "unavailable"
    $gpuMemCtrl = "unavailable"
    $gpuClock = "unavailable"
    $gpuPower = "unavailable"
    $gpuTemp = "unavailable"

    if ($nvsmiAvailable) {
        $smiOut = & "nvidia-smi" --query-gpu=utilization.gpu,memory.used,utilization.memory,clocks.current.graphics,power.draw,temperature.gpu --format=csv,noheader,nounits 2>$null
        if ($smiOut) {
            $parts = $smiOut.Trim() -split ",\s*"
            if ($parts.Count -ge 6) {
                $gpuUtil = $parts[0]
                $gpuMem = $parts[1]
                $gpuMemCtrl = $parts[2]
                $gpuClock = $parts[3]
                $gpuPower = $parts[4]
                $gpuTemp = $parts[5]
            }
        }
    }

    # Append sample — all metrics recorded, blank never used
    "$now,$pidVal,$pidChanged,$cpuVal,$wsVal,$gpuUtil,$gpuMem,$gpuMemCtrl,$gpuClock,$gpuPower,$gpuTemp" | Out-File $logFile -Encoding utf8 -Append

    # Check if we're close to the deadline
    $remaining = ($endTime - (Get-Date)).TotalSeconds
    if ($remaining -le 1) { break }

    $actualSleep = [Math]::Min($sampleInterval, [Math]::Max(0.5, $remaining - 1))
    Start-Sleep -Seconds $actualSleep
}

# ── Compress results ─────────────────────────────────────────────────
$zipPath = Join-Path $env:TEMP "nvidia-vsr-capture-$timestamp.zip"
Remove-Item -LiteralPath $zipPath -ErrorAction SilentlyContinue
Compress-Archive -Path $outDir -DestinationPath $zipPath -Force

Write-Host "Capture complete"
Write-Host "  Duration: $([math]::Round(((Get-Date) - $startTime).TotalSeconds, 1))s"
Write-Host "  Samples:  $((Get-Content $logFile).Count - 1)"
Write-Host "  Zip:      $zipPath"
Write-Host "  Raw:      $outDir"
