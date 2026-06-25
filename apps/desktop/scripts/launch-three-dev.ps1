$ErrorActionPreference = 'Stop'

# Launches three isolated ScreenLink desktop dev instances.
# Each instance uses a distinct --dev-profile value, so Electron userData paths
# do not overlap:
#   - alice   -> <userData>-alice
#   - bob     -> <userData>-bob
#   - charlie -> <userData>-charlie
#
# Usage:
#   pnpm desktop:dev:all

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$commands = @(
  'pnpm desktop:dev:alice',
  'pnpm desktop:dev:bob',
  'pnpm desktop:dev:charlie'
)

foreach ($command in $commands) {
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-NoExit', '-Command', "Set-Location -LiteralPath '$root'; $command") `
    -WorkingDirectory $root
}

"Launched Alice, Bob, and Charlie in separate terminals."
