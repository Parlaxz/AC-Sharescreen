use Subagent driven implementation and programming

# ScreenLink — Evidence-Locked Implementation Specification

**Document purpose:** Give an implementation agent a complete, evidence-driven specification for building a Windows tray screen-sharing application and browser viewer from an empty folder.

**Date audited:** 2026-06-20  
**Primary environment:** Windows 10/11 x64  
**Primary low-bandwidth target:** 854×480, 15 FPS, 650 Kbps configured video ceiling  
**Media foundation:** Official unmodified VDO.Ninja SDK 1.3.18  
**Desktop runtime:** Electron 42.4.1  
**Viewer:** Static browser application  
**Rendezvous backend:** Cloudflare Worker + one Durable Object per share  
**Trust model:** Private sharing with trusted friends who possess the permanent viewer link

---

# 0. Mandatory Operating Rules

Do not stop at planning. Build, test, package, and document the complete product.

Do not invent APIs, methods, event fields, endpoints, security guarantees, or browser behavior.

Every implementation decision must be classified as one of:

- **VERIFIED:** Directly supported by official documentation or pinned source.
- **SCREENLINK DESIGN:** A custom contract defined by this specification.
- **RUNTIME-VERIFIED:** Not safely guaranteed by documentation and therefore must be proven by automated or real-machine tests before enabling it.
- **UNSUPPORTED:** Must not appear as a working control.

When source code and prose documentation differ, the pinned source code is authoritative for SDK 1.3.18, but undocumented internals must remain isolated behind a compatibility adapter.

When a runtime capability cannot be proven:

1. Disable the affected feature.
2. Show an accurate compatibility message.
3. Continue with unaffected features.
4. Never create a placebo control.
5. Never silently pretend a requested value was achieved.

Do not declare the project finished until:

- A packaged Windows app publishes a real monitor.
- A browser on another physical computer receives it.
- The browser automatically reconnects after the host restarts sharing.
- 854×480 at 15 FPS has been measured using WebRTC statistics.
- Bitrate and hourly data use have been measured rather than inferred only from configuration.
- Two simultaneous viewers have been tested.
- All generated artifacts are listed in the final report.

---

# 1. Product Definition

Build a product named **ScreenLink**.

ScreenLink is a Windows notification-area application that lets the host select a monitor or application window, start sharing, and give trusted friends one permanent browser link.

The browser link remains the same across:

- Application restarts
- Windows restarts
- Start/stop cycles
- VDO.Ninja stream credential rotation
- Codec-triggered republishing

When the host is offline or not sharing, the browser displays a waiting page and automatically connects later.

The product must prioritize:

- Low bandwidth
- Low latency
- Reliable reconnects
- 480p at 15 FPS
- Clear actual-vs-requested statistics
- Simple use for nontechnical viewers
- Explicit control over video bitrate ceiling, frame-rate ceiling, and downscaling
- No remote desktop controls

The product must never provide:

- Remote mouse input
- Remote keyboard input
- Clipboard synchronization
- File transfer
- Shell access
- Arbitrary URL execution
- Camera publishing from the viewer
- Microphone publishing from the viewer

---

# 2. Security Model and Non-Negotiable Limitation

## 2.1 Chosen architecture

Use the direct VDO.Ninja SDK architecture because it exposes WebRTC connections and data channels needed for advanced per-peer controls.

This architecture is for **trusted friends**.

## 2.2 Explicit limitation

The permanent browser link authorizes the holder to retrieve the current ephemeral VDO stream ID and VDO password from the ScreenLink rendezvous service.

The standard SDK password is not documented as a role-specific “viewer-only” credential. Therefore, a technically capable person who possesses current session credentials may be able to attempt publisher impersonation.

Do not claim:

- Viewer-only cryptographic authorization
- Public broadcast security
- Protection against a malicious viewer who extracts credentials
- That rotating credentials creates role separation

Credential rotation reduces credential lifetime. It does not make the viewer credential publisher-proof.

The UI and documentation must state:

> This link is intended for people you trust. Anyone with the link can watch while sharing is active. Do not post it publicly.

## 2.3 Audience-token feature

VDO.Ninja documents a separate `&audience` token system for its website/URL workflow. It provides publisher/viewer role separation.

Do not integrate that system into this SDK architecture unless a later official SDK release documents direct audience-token support and the integration is separately audited.

Do not assume the endpoint below is compatible with SDK 1.3.18:

```text
GET https://audience.vdo.ninja/publish/{streamID}/token
```

It may be documented in ScreenLink’s research notes, but it must not be used in production code for this version.

---

# 3. Evidence Baseline

The implementation agent must read these sources before coding.

## 3.1 VDO.Ninja SDK

- API reference:  
  https://sdk.vdo.ninja/docs/api-reference.html

- Repository:  
  https://github.com/steveseguin/ninjasdk

- Pinned package metadata:  
  https://raw.githubusercontent.com/steveseguin/ninjasdk/v1.3.18/package.json

- Pinned browser SDK source:  
  https://github.com/steveseguin/ninjasdk/blob/v1.3.18/vdoninja-sdk.js

- SDK exception:  
  https://raw.githubusercontent.com/steveseguin/ninjasdk/v1.3.18/LICENSE-SDK-EXCEPTION

Verified facts:

- Package name: `@vdoninja/sdk`
- Pinned version: `1.3.18`
- Package license: `AGPL-3.0-only`
- Official signaling host default: `wss://wss.vdo.ninja`
- Official public methods include `connect`, `disconnect`, `publish`, `stopPublishing`, `view`, `stopViewing`, `sendData`, and `getStats`.
- The source identifies the SDK as still in development and potentially containing bugs.
- The source prohibits custom direct access to the VDO.Ninja WebSocket API.
- The source prohibits sending non-handshake application data through the signaling WebSocket.
- The source uses a nested connection map shaped as UUID → `{ viewer, publisher }`.
- The SDK exception applies only to unmodified official `vdoninja-sdk.js` and `vdoninja-sdk.min.js`.

## 3.2 Electron

- Electron 42.4.1 release:  
  https://releases.electronjs.org/release/v42.4.1

- Desktop capture:  
  https://www.electronjs.org/docs/latest/api/desktop-capturer

- Session/display media handler:  
  https://www.electronjs.org/docs/latest/api/session

- Tray:  
  https://www.electronjs.org/docs/latest/api/tray

- Application lifecycle/login items:  
  https://www.electronjs.org/docs/latest/api/app

- Custom protocols:  
  https://www.electronjs.org/docs/latest/api/protocol

- Security guide:  
  https://www.electronjs.org/docs/latest/tutorial/security

- Context isolation:  
  https://www.electronjs.org/docs/latest/tutorial/context-isolation

Verified facts:

- Electron 42.4.1 is an official stable release.
- Electron provides `desktopCapturer.getSources()`.
- Electron provides `session.setDisplayMediaRequestHandler()`.
- Windows loopback audio can be granted using `audio: "loopback"`.
- Electron provides `Tray`.
- Electron provides login-item settings.
- Privileged schemes must be registered before `app.ready`.

## 3.3 WebRTC

- Sender parameters:  
  https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters

- Codec preferences:  
  https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver/setCodecPreferences

- Peer statistics:  
  https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats

- Track constraints:  
  https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/applyConstraints

Verified facts:

- `maxBitrate` is a maximum media bitrate the browser may grant, excluding protocol overhead.
- `maxFramerate` is a sender encoding ceiling.
- `scaleResolutionDownBy` is a uniform scale and must be at least `1.0`.
- The parameters object must come from the same sender’s `getParameters()`.
- The number and order of encoding entries cannot be changed.
- Codec preference is negotiated and is not equivalent to changing bitrate.
- Actual performance must be measured through statistics.

## 3.4 Cloudflare

- Durable Objects:  
  https://developers.cloudflare.com/durable-objects/

- Durable Object storage:  
  https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/

- Durable Object alarms:  
  https://developers.cloudflare.com/durable-objects/api/alarms/

- Worker secrets:  
  https://developers.cloudflare.com/workers/configuration/secrets/

Verified facts:

- A Durable Object is appropriate for one logical coordinated session.
- Persistent state must be written to storage rather than relying only on memory.
- A Durable Object has one scheduled alarm at a time.
- Alarm execution is at least once and retries on failure.
- Alarm handlers must therefore be idempotent.
- Administrative secrets must be Worker secrets, not source-code constants.

---

# 4. Locked Technology Stack

Use:

- Node.js 24.x
- pnpm workspaces
- Electron `42.4.1`
- React 19
- TypeScript strict mode
- Vite
- electron-builder
- Zod
- Zustand
- Vitest
- Playwright
- Cloudflare Workers
- Cloudflare Durable Objects
- Wrangler
- Web Crypto API
- Electron `safeStorage`

The VDO.Ninja package entry must be exactly:

```json
"@vdoninja/sdk": "1.3.18"
```

Do not use:

- `latest`
- caret or tilde ranges for production dependencies
- the VDO.Ninja develop branch
- a custom VDO signaling protocol
- raw WebSocket access to `wss://wss.vdo.ninja`
- VDO.Ninja website iframe integration
- Socket.IO
- Firebase
- Supabase
- a ScreenLink media relay
- Electron remote module
- `nodeIntegration: true`
- `<webview>`
- arbitrary `ipcRenderer` exposure

For dependencies other than the explicitly pinned Electron and VDO.Ninja versions:

1. Resolve the stable version with `pnpm view PACKAGE version`.
2. Pin the exact returned version without ranges.
3. Commit `pnpm-lock.yaml`.
4. Record the versions and resolution date in `docs/dependency-baseline.md`.
5. Do not upgrade during implementation unless a blocking issue is documented.

---

# 5. Repository Structure

Create:

```text
apps/
  desktop/
    public/
      vendor/
        vdoninja-sdk-1.3.18.min.js
        LICENSE-SDK-EXCEPTION
        AGPL-3.0.txt
    src/
      main/
        main.ts
        protocol.ts
        app-lifecycle.ts
        window-manager.ts
        tray-manager.ts
        capture-source-manager.ts
        display-media-handler.ts
        login-item-manager.ts
        host-session-manager.ts
        rendezvous-client.ts
        secure-store.ts
        settings-store.ts
        log-manager.ts
        ipc-handlers.ts
        permissions.ts
      preload/
        index.ts
        api-types.ts
      renderer/
        main.tsx
        App.tsx
        routes/
          Dashboard.tsx
          SourcePicker.tsx
          Quality.tsx
          Viewers.tsx
          Friends.tsx
          Settings.tsx
          Diagnostics.tsx
          About.tsx
        components/
        stores/
        services/
          host-publisher.ts
          control-protocol.ts
          viewer-registry.ts
          statistics.ts
        hooks/
        styles/
    assets/
    electron-builder.yml
    package.json

  viewer/
    public/
      vendor/
        vdoninja-sdk-1.3.18.min.js
        LICENSE-SDK-EXCEPTION
        AGPL-3.0.txt
    src/
      main.tsx
      App.tsx
      components/
      stores/
      services/
        rendezvous-client.ts
        vdo-viewer.ts
        control-protocol.ts
        quality-client.ts
        statistics.ts
        reconnect-controller.ts
      styles/
    package.json
    vite.config.ts

  control-worker/
    src/
      index.ts
      routes.ts
      share-durable-object.ts
      auth.ts
      encryption.ts
      validation.ts
      cors.ts
      rate-limit.ts
      responses.ts
      environment.ts
    migrations/
    wrangler.toml
    package.json

packages/
  shared/
    src/
      ids.ts
      schemas.ts
      settings.ts
      presets.ts
      control-protocol.ts
      stats.ts
      bitrate.ts
      urls.ts
      errors.ts
    package.json

  vdo-adapter/
    src/
      index.ts
      sdk-global.ts
      sdk-types.ts
      sdk-version.ts
      host-publisher.ts
      viewer-client.ts
      connection-access.ts
      send-data.ts
      sender-parameters.ts
      codec-capabilities.ts
      media-stats.ts
    package.json

  ui/
    src/
    package.json

docs/
  architecture.md
  evidence-register.md
  dependency-baseline.md
  vdo-sdk-integration.md
  control-api.md
  quality-control-matrix.md
  security.md
  privacy.md
  licensing.md
  deployment.md
  windows-testing.md
  troubleshooting.md
  known-limitations.md

scripts/
  copy-vdo-sdk.mjs
  verify-vdo-sdk.mjs
  provision-share.mjs
  package-release.mjs
```

Do not place business logic in React components.

---

# 6. VDO.Ninja SDK Licensing and Loading

## 6.1 Do not bundle or transform the SDK

Do not import the SDK through Vite with:

```ts
import VDONinjaSDK from "@vdoninja/sdk";
```

Instead:

1. Install `@vdoninja/sdk@1.3.18`.
2. Copy the official package’s `vdoninja-sdk.min.js` byte-for-byte into each app’s `public/vendor` folder.
3. Load it as a static script.
4. Exclude it from Vite transformation, minification, and rewriting.
5. Verify SHA-256 equality between:
   - `node_modules/@vdoninja/sdk/vdoninja-sdk.min.js`
   - desktop emitted public asset
   - viewer emitted public asset
6. Fail CI if any differ.
7. Preserve the file header.
8. Ship the SDK exception and AGPL license.
9. Never modify the SDK file.

HTML:

```html
<script src="/vendor/vdoninja-sdk-1.3.18.min.js"></script>
```

Type declaration:

```ts
declare global {
  interface Window {
    VDONinjaSDK: VDONinjaSDKConstructor;
    VDONinja: VDONinjaSDKConstructor;
  }
}
```

## 6.2 Version assertion

At runtime:

```ts
const ctor = window.VDONinjaSDK;

if (!ctor || ctor.VERSION !== "1.3.18") {
  throw new Error("VDONINJA_SDK_VERSION_MISMATCH");
}
```

Do not publish or view after a version mismatch.

---

# 7. Permanent Link and Credential Design

## 7.1 Permanent browser link

Use:

```text
https://VIEWER_DOMAIN/#v=1&share=SHARE_ID&token=VIEWER_TOKEN
```

The token is in the fragment to reduce accidental HTTP access-log exposure.

Do not claim the fragment is hidden from:

- Page JavaScript
- Browser extensions
- DevTools
- Browser history
- Clipboard history
- Screenshots

## 7.2 IDs

Generate with `crypto.getRandomValues`.

`SHARE_ID`:

- 16 random bytes
- base64url
- no padding

`HOST_TOKEN`:

- 32 random bytes
- base64url
- no padding

`VIEWER_TOKEN`:

- 32 random bytes
- base64url
- no padding

`VDO_STREAM_ID`:

- 32 random bytes
- base64url
- replace any unsupported characters if necessary
- final identifier restricted to letters, digits, and underscore
- maximum 64 characters
- regenerated for every host sharing session

`VDO_PASSWORD`:

- 32 random bytes
- base64url
- regenerated for every host sharing session

`SESSION_ID`:

- UUID v4

Never derive any credential from:

- Usernames
- Computer names
- Timestamps
- `Math.random`
- Sequential counters
- Room names

## 7.3 Persistence

Persist:

- share ID
- viewer token
- encrypted host token
- viewer base URL
- Worker base URL

Do not persist:

- current VDO stream ID
- current VDO password
- current session ID
- peer UUIDs
- raw WebRTC statistics

Use Electron `safeStorage` for the host token.

If secure storage is unavailable, fail enrollment rather than silently writing a plaintext host token.

---

# 8. ScreenLink Rendezvous API

Everything in this section is a **SCREENLINK DESIGN**. These are not VDO.Ninja endpoints.

Base path:

```text
/api/v1
```

All JSON responses include:

```json
{
  "version": 1,
  "requestId": "UUID"
}
```

All error responses:

```json
{
  "version": 1,
  "requestId": "UUID",
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable message"
  }
}
```

All responses:

```http
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Never log:

- Authorization header
- host token
- viewer token
- VDO password
- full viewer link
- plaintext session payload

## 8.1 Public health

```http
GET /api/v1/health
```

Response:

```json
{
  "version": 1,
  "requestId": "UUID",
  "status": "ok",
  "serverTime": 1780000000000
}
```

## 8.2 Administrative provisioning

```http
POST /admin/v1/shares
Authorization: Bearer PROVISIONING_SECRET
Content-Type: application/json
```

This endpoint is called only by `scripts/provision-share.mjs`.

Never put `PROVISIONING_SECRET` in:

- Desktop code
- Viewer code
- Installer
- Portable EXE
- Static assets
- Git repository

Request:

```json
{
  "shareId": "base64url",
  "hostToken": "base64url",
  "viewerToken": "base64url",
  "displayName": "Ahmed"
}
```

Response `201`:

```json
{
  "version": 1,
  "requestId": "UUID",
  "shareId": "base64url",
  "createdAt": 1780000000000
}
```

Store only:

- SHA-256 host-token hash
- SHA-256 viewer-token hash
- display name
- timestamps
- encrypted current session, when online

Reject duplicate share IDs with `409 SHARE_ALREADY_EXISTS`.

Rate limit:

- 5 requests/minute/IP

## 8.3 Read current session

```http
GET /api/v1/shares/:shareId/session
Authorization: Bearer VIEWER_TOKEN
```

Offline response:

```json
{
  "version": 1,
  "requestId": "UUID",
  "status": "offline",
  "serverTime": 1780000000000,
  "retryAfterMs": 5000
}
```

Online response:

```json
{
  "version": 1,
  "requestId": "UUID",
  "status": "online",
  "serverTime": 1780000000000,
  "session": {
    "generation": 12,
    "sessionId": "UUID",
    "streamId": "ephemeral-stream-id",
    "password": "ephemeral-vdo-password",
    "startedAt": 1780000000000,
    "expiresAt": 1780000045000,
    "hostName": "Ahmed",
    "capture": {
      "width": 854,
      "height": 480,
      "fps": 15,
      "systemAudio": false,
      "contentHint": "detail"
    },
    "policy": {
      "allowViewerGlobalChanges": true,
      "allowViewerSystemAudioChanges": false,
      "maxVideoCeilingPerViewerKbps": 800,
      "maxConfiguredMediaBudgetKbps": 2400,
      "maxCaptureWidth": 1280,
      "maxCaptureHeight": 720,
      "maxCaptureFps": 30,
      "allowedCodecs": ["h264", "vp8", "vp9"]
    }
  }
}
```

Rate limit:

- 30 requests/minute/IP/share

Use constant-time hash comparison.

## 8.4 Start or replace current session

```http
PUT /api/v1/shares/:shareId/session
Authorization: Bearer HOST_TOKEN
Content-Type: application/json
```

Request:

```json
{
  "sessionId": "UUID",
  "streamId": "ephemeral-stream-id",
  "password": "ephemeral-vdo-password",
  "startedAt": 1780000000000,
  "capture": {
    "width": 854,
    "height": 480,
    "fps": 15,
    "systemAudio": false,
    "contentHint": "detail"
  },
  "policy": {
    "allowViewerGlobalChanges": true,
    "allowViewerSystemAudioChanges": false,
    "maxVideoCeilingPerViewerKbps": 800,
    "maxConfiguredMediaBudgetKbps": 2400,
    "maxCaptureWidth": 1280,
    "maxCaptureHeight": 720,
    "maxCaptureFps": 30,
    "allowedCodecs": ["h264", "vp8", "vp9"]
  }
}
```

Behavior:

1. Validate host token.
2. Increment generation atomically.
3. Encrypt session payload at application level.
4. Store it.
5. Set `lastHeartbeatAt = now`.
6. Set `expiresAt = now + 45_000`.
7. Schedule the Durable Object alarm for `expiresAt`.

Response:

```json
{
  "version": 1,
  "requestId": "UUID",
  "status": "online",
  "generation": 12,
  "expiresAt": 1780000045000
}
```

## 8.5 Heartbeat

```http
POST /api/v1/shares/:shareId/session/heartbeat
Authorization: Bearer HOST_TOKEN
Content-Type: application/json
```

Request:

```json
{
  "sessionId": "UUID",
  "generation": 12
}
```

Behavior:

- Reject session/generation mismatch with `409 STALE_SESSION`.
- Update heartbeat time.
- Set expiration to now + 45 seconds.
- Replace the one scheduled alarm.

Desktop sends every 15 seconds while sharing.

Desktop retry schedule:

- 1 second
- 2 seconds
- 4 seconds
- 8 seconds

Use only one retry chain.

Do not stop media after one failed heartbeat.

Show warning after 30 seconds without a successful heartbeat.

## 8.6 Stop session

```http
DELETE /api/v1/shares/:shareId/session
Authorization: Bearer HOST_TOKEN
Content-Type: application/json
```

Optional body:

```json
{
  "sessionId": "UUID",
  "generation": 12
}
```

Response:

```text
204 No Content
```

Call when:

- Host presses Stop
- Host quits gracefully
- A source ends
- A codec/system-audio restart replaces the session
- Publishing fails after rendezvous was marked online

## 8.7 Rotate permanent viewer token

```http
POST /api/v1/shares/:shareId/viewer-token
Authorization: Bearer HOST_TOKEN
Content-Type: application/json
```

Request:

```json
{
  "newViewerToken": "base64url"
}
```

Behavior:

- Replace viewer token hash atomically.
- Old link loses future rendezvous access.
- Existing already-connected WebRTC sessions may remain connected until disconnected.
- UI must state this limitation.

## 8.8 Delete share

```http
DELETE /api/v1/shares/:shareId
Authorization: Bearer HOST_TOKEN
```

Response:

```text
204 No Content
```

Delete all share state and alarm state.

## 8.9 Durable Object alarm

Alarm handler must be idempotent:

```ts
async alarm(): Promise<void> {
  const session = await this.ctx.storage.get<StoredSession>("session");

  if (!session) {
    return;
  }

  if (Date.now() < session.expiresAt) {
    await this.ctx.storage.setAlarm(session.expiresAt);
    return;
  }

  await this.ctx.storage.delete("session");
}
```

Do not assume exactly-once alarm execution.

## 8.10 Session encryption

Worker secret:

```text
SESSION_MASTER_KEY_B64
```

Requirements:

- Decodes to exactly 32 bytes.
- Stored as a Cloudflare secret.
- Never committed.

Per-share key:

```text
HKDF-SHA-256
salt = UTF-8 shareId
info = UTF-8 "screenlink-session-v1"
length = 32 bytes
```

Session payload encryption:

```text
AES-256-GCM
12-byte random IV
128-bit authentication tag
```

Store:

- schema version
- IV
- ciphertext

## 8.11 CORS

Environment:

```text
ALLOWED_VIEWER_ORIGINS
```

Use exact origins.

For viewer GET and OPTIONS:

- allow only configured viewer origin
- allow `Authorization`
- allow `Content-Type`
- do not use wildcard origin

Host requests originate from Electron main process.

---

# 9. Electron Main Process

## 9.1 Application protocol

Before `app.ready`:

```ts
protocol.registerSchemesAsPrivileged([
  {
    scheme: "screenlink",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);
```

After readiness, register:

```text
screenlink://app/
```

Production renderer loads only from that origin.

Development may load the explicit Vite localhost origin.

## 9.2 BrowserWindow security

```ts
webPreferences: {
  preload: PRELOAD_PATH,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false
}
```

Use:

- `contextBridge`
- narrow typed methods
- Zod validation in preload and main process
- no generic arbitrary channel API

Block:

- unexpected navigation
- unapproved window creation
- file URLs
- custom protocol escapes
- non-HTTPS external links except explicit `mailto`

## 9.3 Single instance

Use:

```ts
const hasLock = app.requestSingleInstanceLock();
```

If false, quit.

On `second-instance`:

- show existing window
- restore it
- focus it
- never create a second publisher

## 9.4 Source enumeration

Use:

```ts
desktopCapturer.getSources({
  types: ["screen", "window"],
  thumbnailSize: {
    width: 320,
    height: 180
  },
  fetchWindowIcons: true
});
```

Return only plain serialized fields:

```ts
type CaptureSourceDTO = {
  id: string;
  name: string;
  displayId: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
};
```

Classify IDs only for UI grouping:

- `screen:` → screen
- `window:` → window

Do not treat a source ID as permanently stable across Windows restarts.

Refresh:

- when picker opens
- on explicit refresh
- every 5 seconds only while picker remains open

## 9.5 Display media handler

Register on the exact renderer session:

```ts
window.webContents.session.setDisplayMediaRequestHandler(
  async (request, callback) => {
    // Validate requesting origin.
    // Look up approved source ID.
    // Re-enumerate sources.
    // Match exact source.
    // Reject if missing.
  },
  { useSystemPicker: false }
);
```

Success:

```ts
callback({
  video: selectedSource,
  audio: systemAudioEnabled ? "loopback" : undefined
});
```

If source is gone:

- do not choose the first result
- do not switch to another monitor
- reject the request
- notify renderer

System audio label must be:

```text
Share system audio
```

Do not claim per-application audio isolation.

## 9.6 Startup

Use Electron login-item settings.

Use `--hidden` for launch-at-login.

Keep separate settings:

- Launch ScreenLink at Windows login
- Automatically resume last monitor share

Defaults:

- false
- false

Auto-resume rules:

- only whole-monitor source
- never application window
- compare a display fingerprint
- require exactly one unambiguous match
- otherwise remain idle and notify user

Fingerprint:

```ts
type DisplayFingerprint = {
  displayId: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  size: { width: number; height: number };
  scaleFactor: number;
  internal: boolean;
};
```

Display IDs alone are not a permanent identity guarantee.

---

# 10. Tray Behavior

Keep the `Tray` instance in module scope.

Tray menu:

1. Open ScreenLink
2. Disabled current-status line
3. Separator
4. Start sharing or Stop sharing
5. Change screen or window
6. Copy viewer link
7. Disabled connected-viewer count
8. Separator
9. Saved Friends submenu
10. Quality Preset submenu
11. Separator
12. Allow viewer global changes checkbox
13. Launch at Windows startup checkbox
14. Auto-resume last monitor share checkbox
15. Separator
16. Diagnostics
17. Check for updates
18. Quit completely

Window close:

- prevent default
- hide
- keep process and share active

Double-click tray:

- show
- restore
- focus

Quit completely:

1. Set `isQuitting`.
2. Stop heartbeat.
3. Mark rendezvous offline.
4. Stop SDK publishing.
5. Stop tracks.
6. Destroy tray.
7. Quit app.

Tray states:

- idle
- sharing
- degraded
- error

---

# 11. Capture Pipeline

## 11.1 Acquire selected source

Renderer asks main process to approve the selected source ID.

Then:

```ts
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  audio: systemAudioEnabled
});
```

Do not depend on exact initial `getDisplayMedia` width or FPS constraints.

After acquisition:

```ts
const videoTrack = stream.getVideoTracks()[0];

videoTrack.contentHint =
  contentMode === "motion"
    ? "motion"
    : "detail";
```

Apply:

```ts
await videoTrack.applyConstraints({
  width: {
    ideal: requestedWidth,
    max: requestedWidth
  },
  height: {
    ideal: requestedHeight,
    max: requestedHeight
  },
  frameRate: {
    ideal: requestedFps,
    max: requestedFps
  }
});
```

If `OverconstrainedError`:

1. Retry with `ideal` only.
2. Read `getSettings()`.
3. Report actual values.
4. Never silently call it exact.

## 11.2 Actual capture values

Read:

```ts
videoTrack.getSettings()
```

Display:

- actual width
- actual height
- actual frame rate
- display surface
- source name

## 11.3 Source ending

Handle:

```ts
videoTrack.addEventListener("ended", handler);
```

On end:

- stop publish
- mark rendezvous offline
- clear credentials
- show notification
- require explicit reselection
- never silently switch source

---

# 12. SDK Construction and Public Operations

## 12.1 Host constructor

```ts
const sdk = new window.VDONinjaSDK({
  host: "wss://wss.vdo.ninja",
  password: sessionPassword,
  salt: "vdo.ninja",
  debug: false,
  turnServers: null,
  forceTURN: false,
  maxReconnectAttempts: 10,
  reconnectDelay: 1000,
  autoPingViewer: false
});
```

Then:

```ts
await sdk.connect();
```

Publish using documented core fields plus source-supported media preferences:

```ts
await sdk.publish(captureStream, {
  streamID: streamId,
  label: hostDisplayName,
  password: sessionPassword,
  videoCodec: selectedCodec,
  videoBitrate: configuredVideoCeilingKbps,
  videoResolution: {
    width: requestedWidth,
    height: requestedHeight,
    frameRate: requestedFps
  },
  audioBitrate: systemAudioEnabled ? 32 : undefined
});
```

Requirements:

- The adapter must test this exact option behavior against SDK 1.3.18.
- If source-supported media options fail, publish with only documented core fields and apply per-sender settings after peer connection.
- Do not set `broadcast: true` as a scalability mechanism.
- Do not join a room.
- Use direct publish/view by stream ID.

## 12.2 Viewer constructor

```ts
const sdk = new window.VDONinjaSDK({
  host: "wss://wss.vdo.ninja",
  password: session.password,
  salt: "vdo.ninja",
  debug: false,
  turnServers: null,
  forceTURN: false,
  maxReconnectAttempts: 10,
  reconnectDelay: 1000,
  autoPingViewer: true,
  autoPingInterval: 10000
});
```

Register listeners before viewing.

Then:

```ts
await sdk.connect();

await sdk.view(session.streamId, {
  audio: true,
  video: true,
  label: viewerDisplayName
});
```

Do not join a room.

## 12.3 Required events

Handle:

- `connected`
- `disconnected`
- `reconnecting`
- `reconnected`
- `reconnectFailed`
- `publishing`
- `publishingStopped`
- `peerConnected`
- `peerDisconnected`
- `dataChannelOpen`
- `dataChannelClose`
- `dataReceived`
- `peerInfo`
- `peerLatency`
- `track`
- `trackAdded`
- `trackRemoved`
- `trackReplaced`
- `connectionFailed`
- `iceRestart`
- `error`
- `alert`

Validate event detail at runtime.

Do not assume undocumented event fields without a contract test.

## 12.4 Viewer track attachment

On track:

```ts
const detail = event.detail;
```

Validate:

- `detail.track` is a `MediaStreamTrack`
- `detail.streams` is an array if present

Use `streams[0]` when available.

Otherwise create and maintain a local `MediaStream`.

Video element:

```ts
video.autoplay = true;
video.playsInline = true;
```

If autoplay with audio fails, show a user-gesture playback button.

---

# 13. Internal SDK Compatibility Adapter

The connection map is undocumented internal state.

Only `packages/vdo-adapter/src/connection-access.ts` may read it.

Expected pinned source shape:

```ts
sdk.connections: Map<
  string,
  {
    viewer?: {
      pc: RTCPeerConnection;
      dataChannel?: RTCDataChannel;
      uuid?: string;
      streamID?: string;
    };
    publisher?: {
      pc: RTCPeerConnection;
      dataChannel?: RTCDataChannel;
      uuid?: string;
      streamID?: string;
    };
  }
>
```

Host outbound media to a viewer is expected under the peer group’s `publisher` connection.

Viewer inbound media from host is expected under the peer group’s `viewer` connection.

This expectation must be confirmed by an integration test with a real host and viewer.

Adapter behavior:

1. Assert SDK version `1.3.18`.
2. Confirm `connections instanceof Map`.
3. Confirm peer group exists.
4. Confirm requested role exists.
5. Confirm `.pc instanceof RTCPeerConnection`.
6. Fail with a typed compatibility error if any condition fails.
7. Never guess another connection.
8. Never expose the map to React code.

Do not rely on `sdk.getStats()` until a runtime test proves it returns expected per-peer reports for 1.3.18.

Use direct `pc.getStats()` through the compatibility adapter.

---

# 14. Data-Channel Control Protocol

Use VDO.Ninja `sendData` only after a WebRTC data channel is open.

Explicitly disable signaling fallback.

Host-to-viewer target:

```ts
sdk.sendData(payload, {
  uuid: peerUuid,
  type: "publisher",
  allowFallback: false
});
```

Viewer-to-host target:

```ts
sdk.sendData(payload, {
  uuid: hostUuid,
  type: "viewer",
  allowFallback: false
});
```

These target roles must be contract-tested against SDK 1.3.18.

If the target form does not deliver on the expected open data channel:

- fail the feature
- record compatibility error
- do not fall back to signaling
- do not send control data through the ScreenLink Worker

Maximum serialized control message:

```text
16 KiB
```

Envelope:

```json
{
  "screenlink": {
    "version": 1,
    "type": "viewer.hello",
    "messageId": "UUID",
    "sentAt": 1780000000000,
    "payload": {}
  }
}
```

Reject:

- unknown version
- unknown type
- invalid schema
- payload over 16 KiB
- timestamps over 60 seconds old/future
- duplicate message IDs seen within 10 minutes
- rate-limit violations

Messages:

- `viewer.hello`
- `host.hello`
- `quality.request`
- `quality.applied`
- `quality.rejected`
- `quality.current`
- `policy.updated`
- `global-change.started`
- `global-change.completed`
- `global-change.failed`
- `host.stopping`
- `ping`
- `pong`

## 14.1 Viewer hello

```json
{
  "screenlink": {
    "version": 1,
    "type": "viewer.hello",
    "messageId": "UUID",
    "sentAt": 1780000000000,
    "payload": {
      "viewerId": "persistent-local-UUID",
      "name": "Friend",
      "requestedPresetId": "egypt-data-saver",
      "capabilities": {
        "videoCodecs": ["h264", "vp8", "vp9"],
        "supportsSenderParameters": true,
        "supportsPictureInPicture": true
      }
    }
  }
}
```

Viewer ID is not authorization.

Peer UUID from the SDK connection is authoritative for routing.

## 14.2 Host hello

```json
{
  "screenlink": {
    "version": 1,
    "type": "host.hello",
    "messageId": "UUID",
    "sentAt": 1780000000000,
    "payload": {
      "hostName": "Ahmed",
      "capture": {
        "width": 854,
        "height": 480,
        "fps": 15,
        "systemAudio": false,
        "contentHint": "detail"
      },
      "policy": {
        "allowViewerGlobalChanges": true,
        "allowViewerSystemAudioChanges": false,
        "maxVideoCeilingPerViewerKbps": 800,
        "maxConfiguredMediaBudgetKbps": 2400,
        "maxCaptureWidth": 1280,
        "maxCaptureHeight": 720,
        "maxCaptureFps": 30,
        "allowedCodecs": ["h264", "vp8", "vp9"]
      }
    }
  }
}
```

## 14.3 Quality request

```json
{
  "screenlink": {
    "version": 1,
    "type": "quality.request",
    "messageId": "UUID",
    "sentAt": 1780000000000,
    "payload": {
      "requestId": "UUID",
      "perViewer": {
        "videoCeilingKbps": 650,
        "maxFps": 15,
        "targetWidth": 854,
        "targetHeight": 480,
        "receiveAudio": false,
        "degradationPreference": "maintain-resolution"
      },
      "global": null
    }
  }
}
```

Optional global:

```json
{
  "codec": "vp9",
  "captureWidth": 854,
  "captureHeight": 480,
  "captureFps": 15,
  "systemAudio": false,
  "contentHint": "detail"
}
```

Rate limits per peer:

- one quality request every 2 seconds
- 10 quality requests/minute
- one global request every 10 seconds

---

# 15. Per-Viewer Quality Controls

## 15.1 Control classification

Per-viewer, best effort:

- Video encoding ceiling
- Maximum sender FPS
- Uniform downscale target
- Audio track transmission on/off, if runtime-proven

Local viewer only:

- Volume
- Mute
- Fullscreen
- Picture-in-picture
- Fit/fill

Global:

- Capture constraints
- Content hint
- System audio acquisition
- Codec preference
- Capture source

## 15.2 Sender parameter algorithm

Use host peer’s `publisher.pc`.

Find:

```ts
const sender = pc
  .getSenders()
  .find(candidate => candidate.track?.kind === "video");
```

Read:

```ts
const parameters = sender.getParameters();
```

Do not manufacture an encoding array.

If:

```ts
!Array.isArray(parameters.encodings) ||
parameters.encodings.length === 0
```

return:

```text
ENCODING_PARAMETERS_UNAVAILABLE
```

Do not call `setParameters`.

For existing first encoding:

```ts
encoding.maxBitrate = effectiveKbps * 1000;
encoding.maxFramerate = effectiveMaxFps;
encoding.scaleResolutionDownBy = scale;
parameters.degradationPreference = requestedPreference;
```

Scale:

```ts
const settings = sender.track?.getSettings();

const widthScale =
  settings.width && targetWidth
    ? settings.width / targetWidth
    : 1;

const heightScale =
  settings.height && targetHeight
    ? settings.height / targetHeight
    : 1;

const scale = Math.max(1, widthScale, heightScale);
```

Then:

```ts
await sender.setParameters(parameters);
```

Read parameters again.

Report configured values.

Measure actual results after at least two stats intervals.

## 15.3 Accurate language

Use:

- Configured video encoding ceiling
- Target receive resolution
- Configured maximum FPS
- Actual bitrate
- Actual encoded resolution
- Actual decoded resolution

Do not use:

- Hard network cap
- Guaranteed 480p
- Guaranteed 15 FPS
- Guaranteed 650 Kbps

## 15.4 Configured upload budget

Track configured ceilings per peer.

```ts
available =
  maxConfiguredMediaBudgetKbps -
  sum(otherPeerConfiguredCeilings);
```

```ts
effective =
  Math.min(
    requested,
    maxVideoCeilingPerViewerKbps,
    available
  );
```

Minimum configurable video ceiling:

```text
100 Kbps
```

This is a policy budget, not an operating-system traffic limiter.

UI warning:

> Actual network traffic can exceed configured media ceilings because of audio, retransmissions, RTP/RTCP, ICE, TURN, packet headers, and data-channel traffic.

## 15.5 Per-viewer audio

First test:

```ts
await audioSender.replaceTrack(null);
```

Restore:

```ts
await audioSender.replaceTrack(hostAudioTrack);
```

Enable this as “Stop sending audio to this viewer” only after a two-peer integration test proves:

- outbound audio bytes stop increasing for that peer
- another viewer’s audio continues
- restoration works
- no renegotiation failure occurs

If the test fails, expose only local viewer mute and mark network-saving per-viewer audio as unsupported.

---

# 16. Global Changes

## 16.1 Capture resolution and FPS

Global track update:

```ts
await videoTrack.applyConstraints({
  width: {
    ideal: requestedWidth,
    max: requestedWidth
  },
  height: {
    ideal: requestedHeight,
    max: requestedHeight
  },
  frameRate: {
    ideal: requestedFps,
    max: requestedFps
  }
});
```

Read actual `getSettings()` afterward.

Notify every viewer of:

- requested values
- actual values
- whether any reconnect occurred

## 16.2 Codec

Field name:

```text
Codec preference
```

Never expose:

- NVENC
- AMF
- Quick Sync
- software encoder

Build codec options from actual browser capabilities.

Normalize:

- `video/H264` → `h264`
- `video/VP8` → `vp8`
- `video/VP9` → `vp9`
- `video/AV1` → `av1`
- `video/H265` or `video/HEVC` → `h265`

Defaults:

1. H.264 if host prefers compatibility/hardware efficiency and every connected viewer reports support.
2. Otherwise VP9 if common.
3. Otherwise H.264 if common.
4. Otherwise VP8.
5. AV1 requires explicit selection.
6. H.265 remains hidden unless both sides advertise it and a real interoperability test passes.

Treat codec change as global and reconnect-required.

Procedure:

1. Validate policy.
2. Send `global-change.started`.
3. Generate new VDO stream ID/password/session ID.
4. Stop heartbeat.
5. Mark previous rendezvous session offline.
6. Stop publishing and disconnect SDK.
7. Create new SDK.
8. Connect.
9. Publish existing capture stream with new codec preference.
10. Publish new rendezvous generation.
11. Restart heartbeat.
12. Viewers reconnect after generation change.
13. Confirm negotiated codec from stats.
14. Send `global-change.completed`.

Permanent viewer link remains unchanged.

## 16.3 System audio

Treat enabling/disabling system audio as reacquire and republish.

Never state success until:

- an audio track exists when enabling
- track ready state is live
- outbound audio bytes increase
- viewer receives inbound audio

Default low-bandwidth presets have audio off.

---

# 17. Presets

Built-ins are immutable.

## Egypt Ultra Saver

```yaml
id: egypt-ultra-saver
width: 640
height: 360
captureFps: 10
videoCeilingKbps: 300
policyMaximumKbps: 400
audio: false
contentHint: detail
degradationPreference: maintain-resolution
```

## Egypt Data Saver

```yaml
id: egypt-data-saver
default: true
width: 854
height: 480
captureFps: 15
videoCeilingKbps: 650
policyMaximumKbps: 800
audio: false
contentHint: detail
degradationPreference: maintain-resolution
```

## Text and Coding

```yaml
id: text-and-coding
width: 854
height: 480
captureFps: 10
videoCeilingKbps: 450
policyMaximumKbps: 600
audio: false
contentHint: detail
degradationPreference: maintain-resolution
```

## Balanced

```yaml
id: balanced
width: 1280
height: 720
captureFps: 30
videoCeilingKbps: 1800
policyMaximumKbps: 2500
audio: true
contentHint: detail
degradationPreference: balanced
```

## Smooth Motion

```yaml
id: smooth-motion
width: 1280
height: 720
captureFps: 60
videoCeilingKbps: 5000
policyMaximumKbps: 7000
audio: true
contentHint: motion
degradationPreference: maintain-framerate
```

Custom ranges:

- width: 320–3840
- height: 180–2160
- capture FPS: 1–60
- per-viewer max FPS: 1–60
- video ceiling: 100–20000 Kbps
- audio bitrate preference: 16–256 Kbps

Validate with Zod.

---

# 18. Viewer Reconnect State Machine

States:

- `INVALID_LINK`
- `CHECKING`
- `OFFLINE`
- `CONNECTING`
- `CONNECTED`
- `RECONNECTING`
- `ERROR`

Startup:

1. Parse fragment.
2. Validate version/share/token.
3. GET session.
4. If offline, show waiting state.
5. If online, create SDK and view.

Offline polling:

- 5 seconds
- 5 seconds
- 10 seconds
- 15 seconds
- 30 seconds thereafter

Add ±10% jitter.

While connected:

- poll rendezvous every 15 seconds
- if generation changes, reconnect
- if status is offline, disconnect and wait

SDK retry schedule:

- 1 second
- 2 seconds
- 4 seconds
- 8 seconds
- 15 seconds
- 30 seconds maximum

Only one retry chain may exist.

Offline message:

> Ahmed is not currently sharing. This page will connect automatically when the stream becomes available.

---

# 19. WebRTC Statistics

Poll selected peer connection every 2 seconds while active.

Parse:

## outbound-rtp

- bytesSent
- packetsSent
- framesEncoded
- framesSent
- frameWidth
- frameHeight
- framesPerSecond
- qualityLimitationReason
- qualityLimitationDurations
- retransmittedBytesSent
- nackCount
- pliCount
- firCount
- qpSum

## inbound-rtp

- bytesReceived
- packetsReceived
- packetsLost
- jitter
- framesDecoded
- framesDropped
- frameWidth
- frameHeight
- framesPerSecond
- freezeCount
- totalFreezesDuration
- keyFramesDecoded
- nackCount
- pliCount

## remote-inbound-rtp

- roundTripTime
- totalRoundTripTime
- fractionLost
- jitter

## candidate-pair

- state
- nominated
- selected
- currentRoundTripTime
- availableOutgoingBitrate
- availableIncomingBitrate
- bytesSent
- bytesReceived

## candidates

- candidateType
- protocol
- networkType
- relayProtocol

## codec

- mimeType
- clockRate
- channels
- sdpFmtpLine

Bitrate:

```ts
deltaBytes = currentBytes - previousBytes;
deltaSeconds = (currentTimestamp - previousTimestamp) / 1000;
bitsPerSecond = deltaBytes * 8 / deltaSeconds;
```

Reject:

- negative delta
- zero/negative elapsed time
- counter reset
- stale sample

Hourly bytes:

```ts
bytesPerHour = bitsPerSecond * 3600 / 8;
```

Show:

- decimal GB
- binary GiB
- video/audio/total separately

Relay detection:

- find selected/nominated candidate pair
- resolve local/remote candidates
- if either selected candidate type is `relay`, show TURN relay
- otherwise show direct/STUN path
- never infer relay from latency alone

Hardware encoder:

- show only when an explicit standard stat provides the implementation
- otherwise show `Unknown`
- never infer from GPU model

---

# 20. Viewer UI

Display:

- host name
- connection state
- video
- fullscreen
- picture-in-picture
- local volume
- local mute
- reconnect
- current preset
- configured video ceiling
- per-viewer maximum FPS
- target receive resolution
- receive-audio network toggle when proven
- advanced global controls
- actual bitrate
- actual decoded FPS
- actual decoded dimensions
- negotiated codec
- packet loss
- RTT
- jitter
- dropped frames
- session data
- estimated data/hour
- direct/relay status

Separate sections:

## My connection

Per-viewer controls.

## Host stream

Global controls with warning:

> This changes the host stream and may temporarily reconnect everyone.

Remember local settings in `localStorage`.

Do not store session credentials beyond the active page lifecycle.

---

# 21. Desktop UI

Pages:

- Dashboard
- Source Picker
- Quality
- Viewers
- Friends
- Settings
- Diagnostics
- About and Licenses

Dashboard:

- current status
- source
- requested capture settings
- actual capture settings
- preview toggle
- start/stop
- permanent link
- copy link
- QR code
- open locally
- viewer count
- total configured media budget
- actual measured upload
- session duration
- Worker status
- VDO signaling status

Viewer table:

- display name
- shortened peer UUID
- connected duration
- requested values
- configured sender values
- actual outbound statistics
- RTT
- packet loss
- direct/relay
- sent data
- last request
- compatibility errors

Never display complete secrets.

---

# 22. Saved Friends

Record:

```json
{
  "id": "UUID",
  "displayName": "Name",
  "note": "",
  "preferredPresetId": "egypt-data-saver",
  "createdAt": 1780000000000,
  "updatedAt": 1780000000000
}
```

Friend-specific link:

```text
https://VIEWER_DOMAIN/#v=1&share=SHARE_ID&token=VIEWER_TOKEN&name=URL_ENCODED_NAME&preset=PRESET_ID
```

Tray submenu:

- Copy link
- Open viewer
- Edit
- Remove

Do not claim the application sends Discord, email, or SMS messages.

---

# 23. Persistence

Settings file:

- versioned JSON
- atomic temporary write
- fsync where practical
- rename
- retain previous valid backup
- recover from malformed latest file
- schema migrations

Persist:

- share ID
- encrypted host token
- viewer token
- URLs
- host display name
- startup preferences
- monitor fingerprint
- presets
- friends
- host policy
- window bounds
- preview setting

Never persist current VDO session credentials.

---

# 24. Logging and Diagnostics

Structured log:

```json
{
  "timestamp": "ISO-8601",
  "level": "info",
  "component": "host-session",
  "event": "publisher_connected",
  "generation": 12,
  "peerIdShort": "abcd1234",
  "details": {}
}
```

Redact keys containing:

- token
- password
- authorization
- secret
- streamId
- viewerUrl

Rotate:

- 5 files
- 5 MiB each

Diagnostics export:

- app version
- Electron/Chromium version
- Windows version
- GPU feature status
- displays without thumbnails
- codec capabilities
- requested/configured/actual settings
- sanitized stats
- state transitions
- redacted logs
- SDK version
- SDK SHA-256
- lockfile SHA-256

Do not export local/remote IP addresses by default.

---

# 25. Packaging

Build:

- Windows x64 NSIS installer
- Windows x64 portable EXE
- Viewer static ZIP
- Worker deployment bundle
- SHA-256 checksums
- third-party notices

Names:

```text
ScreenLink-Setup-VERSION-x64.exe
ScreenLink-VERSION-x64-portable.exe
screenlink-viewer-VERSION.zip
screenlink-worker-VERSION.zip
SHA256SUMS.txt
THIRD_PARTY_NOTICES.txt
```

No administrator privileges for normal operation.

Signing support may use CI secrets, but unsigned development builds must work.

---

# 26. Testing Requirements

## 26.1 Unit

Test:

- ID generation
- URL parsing
- token hashing
- bitrate math
- data/hour math
- presets
- policy budget
- scale computation
- control schemas
- replay rejection
- rate limiting
- settings migrations
- log redaction
- AES-GCM
- alarm expiration
- codec normalization
- SDK version assertion

## 26.2 Integration

Test:

- source enumeration
- exact source selection
- missing source rejection
- offline/online session
- heartbeat
- expiration
- viewer-token rotation
- SDK global loading
- SDK hash verification
- connection-map shape
- host publisher connection access
- viewer connection access
- data-channel target role
- fallback disabled
- existing encoding requirement
- bitrate ceiling application
- max FPS application
- downscale application
- audio replace/remove
- global constraints
- codec republish
- generation reconnect
- tray close behavior
- single instance
- startup

## 26.3 Real Windows tests

Test:

- Windows 10
- Windows 11
- one monitor
- two monitors
- 100%, 125%, 150% scaling
- monitor capture
- window capture
- system audio on/off
- close-to-tray
- login startup
- sleep/resume
- monitor disconnect
- source close
- network interruption
- host restart
- viewer restart
- two viewers
- three viewers
- direct path
- TURN relay

## 26.4 Network shaping

Test:

- 250 Kbps
- 400 Kbps
- 650 Kbps
- 800 Kbps
- 1.5 Mbps
- 100 ms RTT
- 200 ms RTT
- 1%, 3%, 5% loss
- 20 ms and 50 ms jitter

Record:

- request
- configured sender parameters
- actual outbound bitrate
- actual inbound bitrate
- actual encoded FPS/dimensions
- actual decoded FPS/dimensions
- data/hour
- CPU
- memory
- dropped frames
- reconnect count

## 26.5 Long run

Run at least 8 hours.

Pass conditions:

- no unbounded memory growth
- no orphan tracks
- no repeated reconnection storm
- no repeated capture prompts
- no unbounded logs
- no stale viewer registry entries

---

# 27. Acceptance Checklist

## Repository

- [ ] pnpm monorepo created
- [ ] strict TypeScript
- [ ] exact dependency pins
- [ ] lockfile committed
- [ ] SDK 1.3.18 static file copied byte-for-byte
- [ ] SDK SHA-256 verified
- [ ] SDK not bundled/transformed
- [ ] SDK licenses included
- [ ] no raw VDO WebSocket client
- [ ] no iframe integration
- [ ] no media through Worker

## Desktop

- [ ] installer
- [ ] portable EXE
- [ ] tray
- [ ] close hides
- [ ] quit exits
- [ ] single instance
- [ ] login startup
- [ ] separate auto-resume
- [ ] source thumbnails
- [ ] monitor capture
- [ ] window capture
- [ ] missing source rejection
- [ ] system audio
- [ ] ended-track handling

## Static link

- [ ] link persists
- [ ] token in fragment
- [ ] ephemeral VDO credentials absent from permanent URL
- [ ] session credentials rotate
- [ ] offline page
- [ ] automatic connection
- [ ] generation reconnect
- [ ] viewer-token rotation

## Quality

- [ ] 854×480 selectable
- [ ] 15 FPS selectable
- [ ] 650 Kbps configured ceiling selectable
- [ ] 800 Kbps policy maximum
- [ ] per-viewer bitrate tested
- [ ] per-viewer FPS tested
- [ ] per-viewer downscale tested
- [ ] per-viewer audio either proven or clearly disabled
- [ ] global constraints tested
- [ ] codec republish tested
- [ ] permanent URL unchanged

## Statistics

- [ ] requested shown
- [ ] configured shown
- [ ] actual outbound shown
- [ ] actual inbound shown
- [ ] codec shown
- [ ] packet loss
- [ ] RTT
- [ ] jitter
- [ ] dropped frames
- [ ] session bytes
- [ ] hourly estimate
- [ ] direct/relay
- [ ] no hardware encoder guessing

## Security

- [ ] trusted-link warning
- [ ] no false viewer-only role claim
- [ ] context isolation
- [ ] no Node renderer integration
- [ ] sandbox
- [ ] typed IPC
- [ ] runtime validation
- [ ] safeStorage
- [ ] exact CORS
- [ ] Worker token hashes
- [ ] session encryption
- [ ] secrets redacted
- [ ] no remote desktop controls

## Tests

- [ ] units pass
- [ ] integrations pass
- [ ] Playwright passes
- [ ] two-computer test
- [ ] two-viewer test
- [ ] three-viewer test
- [ ] 480p15 measured
- [ ] 650-Kbps ceiling measured
- [ ] 8-hour run documented

---

# 28. Required Final Report

The agent’s final response must include:

1. What was implemented
2. Repository structure
3. Exact dependencies
4. Exact SDK version
5. SDK SHA-256
6. Confirmation that SDK is byte-identical
7. Confirmation that SDK was not transformed
8. VDO methods used
9. Undocumented SDK internals used
10. Compatibility safeguards
11. Custom ScreenLink endpoints
12. Worker deployment
13. Viewer deployment
14. Installer paths
15. Portable EXE path
16. Test results
17. Real-machine results
18. 480p15 requested/configured/actual comparison
19. Actual data/hour
20. CPU and memory
21. Two/three-viewer upload behavior
22. Direct/TURN behavior
23. Per-viewer features
24. Global features
25. Reconnect-required features
26. Unsupported features
27. Security limitations
28. License findings
29. Remaining risks
30. Exact build/run/deploy commands

Do not report success based only on mocked media.

---

# 29. Mandatory Final Engineering Rules

- Do not invent VDO.Ninja endpoints.
- Do not call ScreenLink endpoints VDO.Ninja endpoints.
- Do not connect directly to the VDO signaling WebSocket.
- Do not send application data through signaling fallback.
- Do not modify the official SDK.
- Do not transform the SDK through Vite.
- Do not manufacture missing RTP encoding entries.
- Do not assume `sdk.getStats()` is correct.
- Do not expose `sdk.connections` outside the compatibility adapter.
- Do not call bitrate a whole-network hard cap.
- Do not guarantee exact FPS or resolution before measurement.
- Do not offer hardware encoder selection.
- Do not claim viewer-only cryptographic authorization.
- Do not embed an administrative provisioning secret in the EXE.
- Do not silently switch capture source.
- Do not silently enable audio.
- Do not silently exceed host policy.
- Do not hide TURN use.
- Do not leave placeholder controls.
- Do not declare success until real cross-computer testing is complete.
