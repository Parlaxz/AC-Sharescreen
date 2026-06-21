# scripts/dev-launcher.ps1 - ScreenLink Development Launcher
# 
# Manages a shared Vite dev server + independent Alice/Bob Electron instances.
# Tracks processes by project-owned PID files under .screenlink/.
# Returns promptly after starting - does NOT wait on child processes.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-launcher.ps1
# (Usually invoked via run-desktop.bat)

$ErrorActionPreference = "Stop"

# --- Paths ---------------------------------------------------------------------
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$StateDir    = Join-Path $ProjectRoot ".screenlink"
$DesktopDir  = Join-Path (Join-Path $ProjectRoot "apps") "desktop"

$VitePidFile   = Join-Path $StateDir "vite.pid"
$AlicePidFile  = Join-Path $StateDir "alice.pid"
$BobPidFile    = Join-Path $StateDir "bob.pid"
$ViteLogFile   = Join-Path $StateDir "vite.log"
$ViteErrFile   = Join-Path $StateDir "vite.err"

# Ensure state directory exists
if (-not (Test-Path $StateDir)) {
    $null = New-Item -ItemType Directory -Path $StateDir -Force
}

# --- Utility functions ---------------------------------------------------------

function Write-Log {
    param([string]$Message)
    Write-Host "[ScreenLink] $Message"
}

function Get-LivePid {
    <#
    .SYNOPSIS
        Reads a PID file and returns the PID if the process is alive.
        Cleans up stale PID files automatically.
    #>
    param([string]$PidFile)
    if (Test-Path $PidFile) {
        $content = Get-Content $PidFile -Raw -ErrorAction SilentlyContinue
        if ($content) {
            $pidValue = $content.Trim()
            if ($pidValue -match '^\d+$') {
                $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
                if ($proc) {
                    return $pidValue
                }
            }
        }
        # Stale or invalid PID file - remove it
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    return $null
}

function Write-PidFile {
    <#
    .SYNOPSIS
        Writes a PID to a project-owned PID file.
    #>
    param([string]$Path, [int]$ProcessId)
    $ProcessId.ToString() | Out-File -LiteralPath $Path -Encoding ASCII -Force
}

function Wait-ForPort {
    <#
    .SYNOPSIS
        Polls 127.0.0.1:$Port until the TCP port is open or timeout expires.
    #>
    param(
        [int]$Port = 5173,
        [int]$TimeoutSeconds = 30
    )
    $end = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $end) {
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $async = $tcp.BeginConnect("127.0.0.1", $Port, $null, $null)
            $null = $async.AsyncWaitHandle.WaitOne(2000)
            if ($tcp.Connected) {
                $tcp.EndConnect($async)
                $tcp.Close()
                return $true
            }
            $tcp.Close()
        } catch {
            # Not ready yet
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-ElectronPath {
    <#
    .SYNOPSIS
        Resolves the electron.exe path, preferring the direct binary (no cmd nesting).
    #>
    $direct = Join-Path (Join-Path (Join-Path (Join-Path $DesktopDir "node_modules") "electron") "dist") "electron.exe"
    if (Test-Path $direct) {
        return $direct
    }
    # Fallback (shouldn't happen with proper pnpm install)
    return "pnpm.cmd"
}

function Start-ViteDevServer {
    <#
    .SYNOPSIS
        Builds workspace packages, compiles TypeScript, starts Vite dev server.
        Retuses existing Vite if its PID file shows a live process.
    #>
    # Check for existing live Vite
    $existingPid = Get-LivePid $VitePidFile
    if ($existingPid) {
        Write-Log "Vite dev server already running (PID: $existingPid)"
        return $true
    }

    Write-Log "Building workspace packages..."

    # Build @screenlink/shared
    Push-Location $ProjectRoot
    try {
        $proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList @("build:shared") -NoNewWindow -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Log "ERROR: build:shared failed (exit: $($proc.ExitCode))"
            return $false
        }

        $proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList @("build:vdo-adapter") -NoNewWindow -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Log "ERROR: build:vdo-adapter failed (exit: $($proc.ExitCode))"
            return $false
        }
    } finally {
        Pop-Location
    }

    # Compile TypeScript (main + preload)
    Write-Log "Compiling TypeScript..."
    Push-Location $DesktopDir
    try {
        $proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList @("exec", "tsc", "-p", "tsconfig.main.json", "--outDir", "dist/main") -NoNewWindow -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Log "ERROR: tsc (main) failed (exit: $($proc.ExitCode))"
            return $false
        }

        $proc = Start-Process -FilePath "pnpm.cmd" -ArgumentList @("exec", "tsc", "-p", "tsconfig.preload.json", "--outDir", "dist/preload") -NoNewWindow -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Log "ERROR: tsc (preload) failed (exit: $($proc.ExitCode))"
            return $false
        }
    } finally {
        Pop-Location
    }

    # Start Vite dev server (background, no wait)
    Write-Log "Starting Vite dev server on port 5173..."

    $viteArgs = @(
        "--filter", "@screenlink/desktop",
        "exec", "vite",
        "--port", "5173",
        "--host"
    )

    try {
        # Redirect output to files (avoids Vite noise in console; -WindowStyle Hidden
        # is incompatible with -RedirectStandardOutput in PS 5.1, so we omit it here)
        $viteProcess = Start-Process -FilePath "pnpm.cmd" `
            -ArgumentList $viteArgs `
            -PassThru `
            -RedirectStandardOutput $ViteLogFile `
            -RedirectStandardError $ViteErrFile
    } catch {
        Write-Log "ERROR: Failed to start Vite: $_"
        return $false
    }

    Write-PidFile $VitePidFile $viteProcess.Id
    Write-Log "Vite starting (PID: $($viteProcess.Id))"

    # Poll for Vite readiness (TCP connect to port 5173)
    Write-Log "Waiting for Vite to be ready..."
    if (Wait-ForPort -Port 5173 -TimeoutSeconds 30) {
        Write-Log "Vite is ready at http://localhost:5173"
        return $true
    } else {
        Write-Log "ERROR: Vite failed to start within 30 seconds (check $ViteLogFile)"
        return $false
    }
}

function Start-ElectronInstance {
    <#
    .SYNOPSIS
        Launches an Electron instance for the given dev profile.
        Returns immediately after the process starts.
    #>
    param(
        [string]$Profile,
        [int]$DebugPort,
        [string]$PidFile
    )

    # Check for existing live instance
    $existingPid = Get-LivePid $PidFile
    if ($existingPid) {
        Write-Log "$Profile already running (PID: $existingPid)"
        return $true
    }

    $electronPath = Get-ElectronPath
    $mainJs = Join-Path (Join-Path (Join-Path $DesktopDir "dist") "main") "main.js"

    if (-not (Test-Path $mainJs)) {
        Write-Log "ERROR: Compiled main.js not found at $mainJs - run build first"
        return $false
    }

    Write-Log "$Profile - Launching Electron..."

    if ($electronPath -eq "pnpm.cmd") {
        # Fallback: go through pnpm exec
        $electronArgs = @(
            "exec", "electron",
            "dist/main/main.js",
            "--dev-profile=$Profile",
            "--multi-instance",
            "--remote-debugging-port=$DebugPort"
        )
    } else {
        $electronArgs = @(
            $mainJs,
            "--dev-profile=$Profile",
            "--multi-instance",
            "--remote-debugging-port=$DebugPort"
        )
    }

    # Set environment for the Electron process
    $env:VITE_DEV_SERVER_URL = "http://localhost:5173"
    $env:NODE_ENV = "development"

    try {
        if ($electronPath -eq "pnpm.cmd") {
            $proc = Start-Process -FilePath "pnpm.cmd" `
                -ArgumentList $electronArgs `
                -PassThru `
                -WorkingDirectory $DesktopDir
        } else {
            $proc = Start-Process -FilePath $electronPath `
                -ArgumentList $electronArgs `
                -PassThru `
                -WorkingDirectory $DesktopDir
        }
    } catch {
        Write-Log "ERROR: Failed to start Electron ($Profile): $_"
        return $false
    }

    # Brief wait to detect immediate crash
    Start-Sleep -Milliseconds 1500
    $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $alive) {
        Write-Log "ERROR: $Profile Electron process exited immediately"
        return $false
    }

    Write-PidFile $PidFile $proc.Id
    Write-Log "$Profile started (PID: $($proc.Id))"
    return $true
}

# --- Main logic ----------------------------------------------------------------

Write-Log "ScreenLink Development Launcher"

$aliveAlicePid = Get-LivePid $AlicePidFile
$aliveBobPid   = Get-LivePid $BobPidFile

if (-not $aliveAlicePid -and -not $aliveBobPid) {
    # -- First run: build + Vite + Alice --
    Write-Log "No instances running - starting Vite and Alice..."
    if (-not (Start-ViteDevServer)) { exit 1 }
    if (-not (Start-ElectronInstance -Profile "alice" -DebugPort 9222 -PidFile $AlicePidFile)) { exit 1 }
    Write-Log "Alice launched. Run this script again to launch Bob."

} elseif ($aliveAlicePid -and -not $aliveBobPid) {
    # -- Second run: reuse Vite, launch Bob --
    Write-Log "Alice is running - reusing Vite, launching Bob..."
    if (-not (Start-ElectronInstance -Profile "bob" -DebugPort 9223 -PidFile $BobPidFile)) { exit 1 }
    Write-Log "Bob launched. Alice (PID: $aliveAlicePid) and Bob are running."

} elseif ($aliveAlicePid -and $aliveBobPid) {
    # -- Both already running --
    Write-Log "Both Alice (PID: $aliveAlicePid) and Bob (PID: $aliveBobPid) are already running."
    Write-Log "Close one first, or run reset-screenlink-dev.ps1 to stop all instances."

} else {
    # -- Inconsistent state: Bob alive, Alice dead --
    Write-Log "Inconsistent state detected (Bob running without Alice). Resetting..."
    $null = Get-LivePid $BobPidFile  # cleans stale if needed
    if (-not (Start-ViteDevServer)) { exit 1 }
    if (-not (Start-ElectronInstance -Profile "alice" -DebugPort 9222 -PidFile $AlicePidFile)) { exit 1 }
    Write-Log "Alice launched. Run this script again to launch Bob."
}
