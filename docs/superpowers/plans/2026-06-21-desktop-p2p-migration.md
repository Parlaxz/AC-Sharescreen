# ScreenLink Desktop P2P Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Replace Cloudflare Worker + browser viewer with pure desktop-to-desktop P2P using VDO.Ninja data channels.

**Architecture:** Three independent VDO.Ninja SDK roles per app: Control (persistent, data-only via `announce()`), Media Publisher (ephemeral), Media Viewer (ephemeral). Pairing via shared room secret. Credentials exchanged through control data channel.

**Tech Stack:** Electron 42.4.1, React 19, VDO.Ninja SDK 1.3.18, Zustand, Zod, safeStorage, Web Crypto API.

---

## Phase 1: Foundation — Pairing & Independent States

### Task 1.1: Add pairing types and helpers to shared package

**Files:** Create `packages/shared/src/pairing.ts`, Modify `packages/shared/src/index.ts`

Add:
- `generatePairId()` — 16 random bytes, base64url
- `generatePairSecret()` — 32 random bytes, base64url
- `generateDeviceId()` — UUID v4
- `PairingConfig` interface: `{ version, pairId, pairSecret, localDeviceId, localDisplayName, remoteDeviceId?, remoteDisplayName? }`
- `PairingExport` interface: for clipboard/file transfer
- `validatePairingConfig()` — Zod schema

### Task 1.2: Add independent state machine types to store

**Files:** Modify `apps/desktop/src/renderer/stores/main-store.ts`

Replace the old Host/View mode with:
- `localShareState: "idle" | "selecting-source" | "starting" | "sharing" | "stopping" | "error"`
- `remoteShareState: "remote-offline" | "remote-online-idle" | "remote-share-available" | "connecting" | "viewing" | "reconnecting" | "error"`
- `pairingState: "unpaired" | "pairing" | "paired" | "connecting" | "connected" | "error"`
- `friendDisplayName: string`
- `friendDeviceId: string`
- All the actions to update these states
- Remove `mode`, `isSharing`, `isViewing`, `viewStatus`, `shareId`, `viewerToken`, `hostToken`, `workerBaseUrl`, `viewerBaseUrl`, `viewerUrl`

### Task 1.3: Add pairing IPC to main process

**Files:** Modify `apps/desktop/src/main/ipc-handlers.ts`, Modify `apps/desktop/src/preload/api-types.ts`, Modify `apps/desktop/src/preload/index.ts`

Add IPC handlers:
- `create-pairing` — generates PairingConfig, stores pairSecret in safeStorage, returns PairingExport
- `import-pairing` — accepts PairingExport, validates, stores pairSecret in safeStorage, saves config
- `get-pairing-config` — returns current config
- `get-safe-storage-available` — returns boolean

### Task 1.4: Add pairing UI to Settings

**Files:** Modify `apps/desktop/src/renderer/routes/Settings.tsx`

Replace the old Share Setup section with:
- Pairing section showing current status (unpaired/paired)
- "Create Pairing" button → shows pairing code + file export
- "Import Pairing" button → accepts paste + file import
- "Reset Pairing" button
- Show friend name when paired

---

## Phase 2: Persistent Control Connection

### Task 2.1: Create control-connection service

**Files:** Create `apps/desktop/src/main/control-connection.ts`

A class that:
- Creates a VDO.Ninja SDK with pairing password
- Connects to signaling
- Joins the paired room (using pairId-derived room name)
- Calls `announce({ streamID: deviceId, room, label: displayName })`
- Listens for `dataChannelOpen`, `dataReceived`, `peerConnected`, `peerDisconnected`
- Sends/receives control protocol messages
- Handles reconnection
- Exposes event emitter for state changes

### Task 2.2: Create control protocol module

**Files:** Create `apps/desktop/src/main/control-protocol.ts`

Implement:
- `ControlEnvelope` type + Zod schema
- All message types (`peer.hello`, `state.request`, `state.response`, `share.started`, `share.stopped`, `quality.request`, `quality.applied`, `quality.rejected`, `ping`, `pong`)
- Message validation (version, type, timestamp, size, dedup)
- Message builder functions
- Rate limiting

### Task 2.3: Wire control connection to app lifecycle

**Files:** Modify `apps/desktop/src/main/main.ts`

- Start ControlConnection when app launches and pairing exists
- On dataChannelOpen: send peer.hello, state.request
- On peer.hello.response: validate device ID, record remote identity
- Forward state changes to renderer via IPC
- Keep control connection alive in tray

---

## Phase 3: Connect Sharing to Control Protocol

### Task 3.1: Refactor publisher to use control channel credentials

**Files:** Modify `apps/desktop/src/renderer/services/host-publisher.ts` (or equivalent in renderer)

When local share starts:
1. Generate ephemeral media session ID, stream ID, password
2. Create publisher SDK, connect, publish
3. Send `share.started` via control channel
4. On stop: send `share.stopped`, clean up

### Task 3.2: Refactor viewer to receive remote credentials

**Files:** Modify `apps/desktop/src/renderer/services/viewer-client.ts` (or equivalent)

When `share.started` or `state.response` indicates remote share:
1. Validate payload
2. Create viewer SDK with received password
3. Connect and view with received stream ID
4. Attach tracks to video element
5. On `share.stopped` or new session: clean up

### Task 3.3: Update Dashboard to remove old UI

**Files:** Modify `apps/desktop/src/renderer/routes/Dashboard.tsx`

- Remove Host/View mode toggle
- Remove old share/link/LAN sections
- Show independent local and remote sharing status
- Show Share Screen, Share Window, Stop Sharing, Watch Friend, Stop Watching buttons
- Show friend connection status

---

## Phase 4: Quality Controls, Fullscreen, Source Fingerprint

### Task 4.1: Fix fullscreen

**Files:** Modify `apps/desktop/src/renderer/routes/Dashboard.tsx`

- Add fullscreen ref on viewer container div
- Fullscreen button calls `container.requestFullscreen()`
- Double-click toggles fullscreen
- Listen to `fullscreenchange` for icon state
- CSS: `width: 100vw; height: 100vh; background: black; display: flex; align-items: center; justify-content: center; video { max-width: 100%; max-height: 100%; object-fit: contain; }`

### Task 4.2: Implement source fingerprint

**Files:** Modify `apps/desktop/src/main/capture-source-manager.ts`, Modify `apps/desktop/src/renderer/routes/SourcePicker.tsx`

- Add `getSourceFingerprint(source)` function returning structured fingerprint
- Persist last selected source fingerprint
- On SourcePicker open: try exact ID match, then fingerprint match
- Only auto-select if exactly one unambiguous match
- Auto-resume only for monitors, disabled by default

### Task 4.3: Quality request handling

**Files:** Modify `apps/desktop/src/renderer/services/control-protocol.ts`

- Wire quality.request → quality.applied/quality.rejected flow
- Apply sender parameter changes via vdo-adapter
- Handle global changes (codec, capture constraints) with republish

---

## Phase 5: Remove Old Architecture

### Task 5.1: Delete obsolete apps and scripts

- Delete `apps/viewer/` directory
- Delete `apps/control-worker/` directory
- Delete `scripts/provision-share.mjs`
- Delete `docs/control-api.md`, `docs/deployment.md`

### Task 5.2: Clean up dependencies and config

- Remove viewer, control-worker from pnpm-workspace.yaml
- Remove old Worker/URL settings from UI
- Remove `viewerBaseUrl`, `workerBaseUrl`, `shareId`, `hostToken`, `viewerToken` from all schemas and types
- Remove `run-viewer.bat`

### Task 5.3: Add Alice/Bob dev profiles

**Files:** Modify `apps/desktop/src/main/app-lifecycle.ts`

- Handle `--dev-profile=alice` and `--dev-profile=bob`
- Separate userData, settings namespace, lock namespace per profile
- Add root pnpm scripts: `desktop:dev:alice` and `desktop:dev:bob`

---

## Phase 6: Packaging & Testing

### Task 6.1: Fix build pipeline

- Ensure root `pnpm build` orders: shared → vdo-adapter → desktop
- Add cleanup script that only kills ScreenLink processes
- Verify `run-desktop.bat` works with new pipeline

### Task 6.2: Write unit and integration tests

- Protocol message validation tests
- State machine transition tests
- Pairing ID generation tests
- Source fingerprint tests
- Fullscreen DOM tests (Playwright)

### Task 6.3: Package and document

- Run `build-desktop.bat` and verify installer
- Update documentation
- Record final deliverable report
