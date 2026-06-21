# ScreenLink Architecture

## Overview

ScreenLink is a Windows tray screen-sharing application that uses VDO.Ninja SDK 1.3.18 
for P2P WebRTC-based streaming. There is no server-side backend — the desktop app connects 
viewers directly via VDO.Ninja signaling (wss://wss.vdo.ninja).

## System Components

```
┌─────────────────┐                        ┌──────────────────┐
│  Desktop App    │◀─── P2P WebRTC ───────▶│  Desktop App     │
│  (Alice/Host)   │                        │  (Bob/Viewer)    │
│                 │                        │                  │
│  Publishes via  │                        │  Views via       │
│  VDO.Ninja SDK  │                        │  VDO.Ninja SDK   │
└────────┬────────┘                        └────────┬─────────┘
         │                                          │
         └────────── wss://wss.vdo.ninja ──────────┘
                     (VDO.Ninja Signaling)
```

## Data Flow

1. **Host starts sharing**: Desktop app generates ephemeral VDO stream credentials, publishes via SDK
2. **Viewer connects**: Second desktop instance (or external client) parses the share link and connects as viewer via SDK
3. **Reconnection**: On generation change (codec/settings update or re-publish), viewer detects new generation via VDO SDK and reconnects

## Development Profiles

For local testing, two dev profiles are available to simulate separate users:
- `desktop:dev:alice` — starts the app with `--dev-profile=alice --multi-instance` (isolated userData)
- `desktop:dev:bob` — starts the app with `--dev-profile=bob --multi-instance` (isolated userData)

Each profile gets its own `userData` directory (e.g., `...-alice`, `...-bob`) so credentials and settings don't collide.

## Tech Stack

- **Runtime**: Node.js 24+, Electron 42.4.1
- **UI**: React 19, Zustand, CSS
- **Build**: Vite, TypeScript strict, pnpm workspaces
- **Testing**: Vitest, Playwright
- **Media**: VDO.Ninja SDK 1.3.18 (static, unmodified)
- **Crypto**: Web Crypto API, Electron safeStorage
- **Validation**: Zod
