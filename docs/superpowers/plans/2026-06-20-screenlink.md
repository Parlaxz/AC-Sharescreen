# ScreenLink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ScreenLink — a Windows tray screen-sharing application with permanent browser viewer links, using VDO.Ninja SDK 1.3.18, Electron 42.4.1, and Cloudflare Workers.

**Architecture:** pnpm monorepo with 3 apps (Electron desktop, browser viewer, Cloudflare Worker) and 3 shared packages (shared types/schemas, VDO.Ninja SDK adapter, UI components). Host shares via WebRTC through VDO.Ninja signaling. Rendezvous state via Cloudflare Durable Objects. Permanent links via fragment-based tokens.

**Tech Stack:** Node 24+, pnpm, Electron 42.4.1, React 19, TypeScript strict, Vite, Zod, Zustand, Vitest, Playwright, Cloudflare Workers/DO, Wrangler, Web Crypto API, electron-builder.

**Reference:** Full spec at `SCREENLINK_IMPLEMENTATION_PROMPT.md` (2827 lines)

---

## Phase 1: Monorepo Foundation

### Task 1.1: Root Workspace Setup

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.npmrc`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "screenlink",
  "private": true,
  "version": "0.1.0",
  "description": "ScreenLink - Private screen sharing with permanent links",
  "scripts": {
    "dev:desktop": "pnpm --filter @screenlink/desktop dev",
    "dev:viewer": "pnpm --filter @screenlink/viewer dev",
    "dev:worker": "pnpm --filter @screenlink/control-worker dev",
    "build:desktop": "pnpm --filter @screenlink/desktop build",
    "build:viewer": "pnpm --filter @screenlink/viewer build",
    "build:worker": "pnpm --filter @screenlink/control-worker build",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:run": "pnpm vitest run",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "clean": "pnpm -r clean"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "packageManager": "pnpm@10.0.0"
}
```

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "scripts"
```

- [ ] **Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  }
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
out/
.vite/
*.tsbuildinfo
.env
.env.local
*.log
.DS_Store
Thumbs.db
```

- [ ] **Step 5: Create .npmrc**

```
shamefully-hoist=false
strict-peer-dependencies=true
```

- [ ] **Step 6: Run pnpm install to verify**

Run: `pnpm install`

### Task 1.2: Shared Package (`packages/shared`)

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/ids.ts`
- Create: `packages/shared/src/schemas.ts`
- Create: `packages/shared/src/settings.ts`
- Create: `packages/shared/src/presets.ts`
- Create: `packages/shared/src/control-protocol.ts`
- Create: `packages/shared/src/stats.ts`
- Create: `packages/shared/src/bitrate.ts`
- Create: `packages/shared/src/urls.ts`
- Create: `packages/shared/src/errors.ts`
- Create: `packages/shared/src/index.ts`

**Spec sections:** All of section 7 (IDs), section 14 (control protocol), section 17 (presets), and shared types throughout.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@screenlink/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Implement `ids.ts` — All ID generation (section 7.2)**

Functions: `generateShareId()`, `generateHostToken()`, `generateViewerToken()`, `generateVdoStreamId()`, `generateVdoPassword()`, `generateSessionId()`

All use `crypto.getRandomValues` as specified.

```typescript
import { webcrypto } from "node:crypto";

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  webcrypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateShareId(): string {
  return randomBase64Url(16);
}

export function generateHostToken(): string {
  return randomBase64Url(32);
}

export function generateViewerToken(): string {
  return randomBase64Url(32);
}

export function generateSessionId(): string {
  return webcrypto.randomUUID();
}

export function generateVdoStreamId(): string {
  // 32 random bytes, base64url, restricted to letters/digits/underscore, max 64 chars
  const raw = randomBase64Url(32);
  const sanitized = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  return sanitized.slice(0, 64);
}

export function generateVdoPassword(): string {
  return randomBase64Url(32);
}
```

- [ ] **Step 4: Implement `errors.ts` — Typed domain errors**

```typescript
export class ScreenLinkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ScreenLinkError";
  }
}

export class ValidationError extends ScreenLinkError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class CompatibilityError extends ScreenLinkError {
  constructor(message: string, details?: unknown) {
    super("COMPATIBILITY_ERROR", message, details);
    this.name = "CompatibilityError";
  }
}

export class ProtocolError extends ScreenLinkError {
  constructor(message: string, details?: unknown) {
    super("PROTOCOL_ERROR", message, details);
    this.name = "ProtocolError";
  }
}
```

- [ ] **Step 5: Implement `schemas.ts` — All Zod schemas**

Covering: share provisioning, session data, session response, control protocol messages, quality requests, presets, viewer hello, host hello, settings, friend record, display fingerprint, policy.

```typescript
import { z } from "zod";

export const ShareIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(10);
export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(20);
export const SessionIdSchema = z.string().uuid();
export const DisplayNameSchema = z.string().min(1).max(100);

export const ControlMessageVersionSchema = z.literal(1);
export const ControlMessageIdSchema = z.string().uuid();

export const CaptureInfoSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  systemAudio: z.boolean(),
  contentHint: z.enum(["detail", "motion"]),
});

export const PolicySchema = z.object({
  allowViewerGlobalChanges: z.boolean(),
  allowViewerSystemAudioChanges: z.boolean(),
  maxVideoCeilingPerViewerKbps: z.number().int().positive(),
  maxConfiguredMediaBudgetKbps: z.number().int().positive(),
  maxCaptureWidth: z.number().int().positive(),
  maxCaptureHeight: z.number().int().positive(),
  maxCaptureFps: z.number().int().positive(),
  allowedCodecs: z.array(z.enum(["h264", "vp8", "vp9", "av1", "h265"])),
});

export const ProvisionShareRequestSchema = z.object({
  shareId: ShareIdSchema,
  hostToken: TokenSchema,
  viewerToken: TokenSchema,
  displayName: DisplayNameSchema,
});

export const StartSessionRequestSchema = z.object({
  sessionId: SessionIdSchema,
  streamId: z.string().min(1).max(64),
  password: z.string().min(1),
  startedAt: z.number().positive(),
  capture: CaptureInfoSchema,
  policy: PolicySchema,
});

// ... continue with all schemas from spec
```

- [ ] **Step 6: Implement `presets.ts` — Built-in presets (section 17)**

All 5 presets: egypt-ultra-saver, egypt-data-saver, text-and-coding, balanced, smooth-motion.

- [ ] **Step 7: Implement `control-protocol.ts` — Message type definitions (section 14)**

All message types, envelope schema, rate limits.

- [ ] **Step 8: Implement `urls.ts` — Viewer URL parsing/construction (section 7.1)**

Parse and construct viewer URLs with fragment parameters.

- [ ] **Step 9: Implement `bitrate.ts` — Budget tracking (section 15.4)**

Budget math, effective ceiling computation.

- [ ] **Step 10: Implement `stats.ts` — Statistics types (section 19)**

All WebRTC stat types, bitrate calculation helpers.

- [ ] **Step 11: Implement `settings.ts` — Settings types**

Persisted settings schema, fingerprint type.

- [ ] **Step 12: Create `src/index.ts` — Re-export everything**

- [ ] **Step 13: Write tests**

Test: ID generation, URL parsing, budget math, presets validation, schemas, bitrate math, scale computation.

Run: `pnpm --filter @screenlink/shared test`

---

### Task 1.3: VDO Adapter Package (`packages/vdo-adapter`)

**Files:**
- Create: `packages/vdo-adapter/package.json`
- Create: `packages/vdo-adapter/tsconfig.json`
- Create: `packages/vdo-adapter/src/sdk-global.ts`
- Create: `packages/vdo-adapter/src/sdk-types.ts`
- Create: `packages/vdo-adapter/src/sdk-version.ts`
- Create: `packages/vdo-adapter/src/connection-access.ts`
- Create: `packages/vdo-adapter/src/host-publisher.ts`
- Create: `packages/vdo-adapter/src/viewer-client.ts`
- Create: `packages/vdo-adapter/src/send-data.ts`
- Create: `packages/vdo-adapter/src/sender-parameters.ts`
- Create: `packages/vdo-adapter/src/codec-capabilities.ts`
- Create: `packages/vdo-adapter/src/media-stats.ts`
- Create: `packages/vdo-adapter/src/index.ts`

**Spec sections:** Sections 6, 12, 13, 14, 15, 19.

- [ ] **Step 1: Create package.json**

Depends on `@screenlink/shared`.

- [ ] **Step 2: `sdk-types.ts` — Type declarations for VDONinjaSDK**

```typescript
export interface VDONinjaSDKConstructorOptions {
  host: string;
  password: string;
  salt: string;
  debug?: boolean;
  turnServers?: object[] | null;
  forceTURN?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  autoPingViewer?: boolean;
  autoPingInterval?: number;
}

export interface PublishOptions {
  streamID: string;
  label: string;
  password: string;
  videoCodec?: string;
  videoBitrate?: number;
  videoResolution?: {
    width: number;
    height: number;
    frameRate: number;
  };
  audioBitrate?: number;
}

export interface ViewOptions {
  audio?: boolean;
  video?: boolean;
  label?: string;
}

export interface SendDataOptions {
  uuid: string;
  type: "publisher" | "viewer";
  allowFallback: boolean;
}

export interface ConnectionEntry {
  pc: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  uuid?: string;
  streamID?: string;
}

export interface PeerGroup {
  viewer?: ConnectionEntry;
  publisher?: ConnectionEntry;
}

export interface VDONinjaSDK {
  VERSION: string;
  connections: Map<string, PeerGroup>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(stream: MediaStream, options?: PublishOptions): Promise<void>;
  stopPublishing(): Promise<void>;
  view(streamId: string, options?: ViewOptions): Promise<void>;
  stopViewing(): Promise<void>;
  sendData(payload: unknown, options: SendDataOptions): Promise<void>;
  getStats(): Promise<RTCStatsReport | undefined>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}
```

- [ ] **Step 3: `sdk-global.ts` — Window type augmentation and global assertion**

```typescript
declare global {
  interface Window {
    VDONinjaSDK: new (options: VDONinjaSDKConstructorOptions) => VDONinjaSDK;
    VDONinja: new (options: VDONinjaSDKConstructorOptions) => VDONinjaSDK;
  }
}
```

- [ ] **Step 4: `sdk-version.ts` — Version assertion and hash verification**

Assert `ctor.VERSION === "1.3.18"`. SHA-256 verification of the loaded script.

- [ ] **Step 5: `connection-access.ts` — Access undocumented connections map (section 13)**

Read-only accessor for `sdk.connections` with runtime shape validation.

- [ ] **Step 6: `host-publisher.ts` — Host/create SDK/publish/stopPublishing wrapper**

Constructor options, connect, publish with all spec fields, error handling.

- [ ] **Step 7: `viewer-client.ts` — Viewer create SDK/view/stopViewing wrapper**

Constructor, connect, view, event registration.

- [ ] **Step 8: `send-data.ts` — Typed sendData wrapper with fallback disabled**

- [ ] **Step 9: `sender-parameters.ts` — Read/modify sender parameters (section 15.2)**

`getVideoSender(pc)`, `readParameters(sender)`, `applyQualityRequest(...)`.

- [ ] **Step 10: `codec-capabilities.ts` — RTCRtpTransceiver codec probing**

`getSupportedVideoCodecs()`, codec name normalization.

- [ ] **Step 11: `media-stats.ts` — Poll peer connection stats**

`pollStats(pc)`, parse outbound/inbound/candidate-pair.

- [ ] **Step 12: `index.ts` — Re-export**

---

## Phase 2: Control Worker (Cloudflare)

### Task 2.1: Control Worker App

**Files:**
- Create: `apps/control-worker/package.json`
- Create: `apps/control-worker/tsconfig.json`
- Create: `apps/control-worker/wrangler.toml`
- Create: `apps/control-worker/migrations/migration-001.ts`
- Create: `apps/control-worker/src/index.ts`
- Create: `apps/control-worker/src/routes.ts`
- Create: `apps/control-worker/src/share-durable-object.ts`
- Create: `apps/control-worker/src/auth.ts`
- Create: `apps/control-worker/src/encryption.ts`
- Create: `apps/control-worker/src/validation.ts`
- Create: `apps/control-worker/src/cors.ts`
- Create: `apps/control-worker/src/rate-limit.ts`
- Create: `apps/control-worker/src/responses.ts`
- Create: `apps/control-worker/src/environment.ts`

**Spec sections:** Section 8 (full Rendezvous API).

- [ ] **Step 1: Create package.json, tsconfig, wrangler.toml**

- [ ] **Step 2: `environment.ts` — Typed env bindings**

- [ ] **Step 3: `responses.ts` — JSON response helpers with required headers**

- [ ] **Step 4: `cors.ts` — CORS middleware**

- [ ] **Step 5: `validation.ts` — Request body validation wrappers**

- [ ] **Step 6: `rate-limit.ts` — In-memory rate limiter per IP/share**

- [ ] **Step 7: `auth.ts` — Token verification with constant-time hash comparison**

- [ ] **Step 8: `encryption.ts` — AES-256-GCM session encryption/decryption (section 8.10)**

- [ ] **Step 9: `share-durable-object.ts` — Full DO implementation**

All endpoints: health, provision, read session, start/replace, heartbeat, stop, rotate token, delete share. Alarm for expiry.

- [ ] **Step 10: `routes.ts` — Router**

- [ ] **Step 11: `index.ts` — Worker entry**

- [ ] **Step 12: `migrations/migration-001.ts` — Initial migration**

---

## Phase 3: Desktop App

### Task 3.1: Desktop Package Setup

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.main.json`
- Create: `apps/desktop/tsconfig.preload.json`
- Create: `apps/desktop/tsconfig.renderer.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/index.html`

### Task 3.2: Main Process — Core

**Files:**
- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/main/protocol.ts`
- `apps/desktop/src/main/app-lifecycle.ts`
- `apps/desktop/src/main/window-manager.ts`

**Spec:** Sections 9.1, 9.2, 9.3

- [ ] **Step 1: `protocol.ts` — Register `screenlink://` privileged scheme before app.ready**

- [ ] **Step 2: `app-lifecycle.ts` — Single instance lock, second-instance handler**

- [ ] **Step 3: `window-manager.ts` — Create/manage BrowserWindow, security prefs, close-to-tray**

- [ ] **Step 4: `main.ts` — Orchestrate lifecycle, register protocol handler**

### Task 3.3: Main Process — Tray

**Files:**
- `apps/desktop/src/main/tray-manager.ts`

**Spec:** Section 10

### Task 3.4: Main Process — Capture

**Files:**
- `apps/desktop/src/main/capture-source-manager.ts`
- `apps/desktop/src/main/display-media-handler.ts`

**Spec:** Sections 9.4, 9.5

### Task 3.5: Main Process — Session and Storage

**Files:**
- `apps/desktop/src/main/host-session-manager.ts`
- `apps/desktop/src/main/rendezvous-client.ts`
- `apps/desktop/src/main/secure-store.ts`
- `apps/desktop/src/main/settings-store.ts`
- `apps/desktop/src/main/login-item-manager.ts`
- `apps/desktop/src/main/log-manager.ts`

**Spec:** Sections 7.3, 8.3-8.6, 23, 24

### Task 3.6: Main Process — IPC

**Files:**
- `apps/desktop/src/main/ipc-handlers.ts`
- `apps/desktop/src/main/permissions.ts`

**Spec:** Section 9.2

### Task 3.7: Preload

**Files:**
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/preload/api-types.ts`

**Spec:** Section 9.2 — contextBridge with narrow typed methods, Zod validation.

### Task 3.8: Renderer — Shell and Stores

**Files:**
- `apps/desktop/src/renderer/main.tsx`
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/stores/`

**Spec:** Section 21

### Task 3.9: Renderer — Pages

**Files:**
- `apps/desktop/src/renderer/routes/Dashboard.tsx`
- `apps/desktop/src/renderer/routes/SourcePicker.tsx`
- `apps/desktop/src/renderer/routes/Quality.tsx`
- `apps/desktop/src/renderer/routes/Viewers.tsx`
- `apps/desktop/src/renderer/routes/Friends.tsx`
- `apps/desktop/src/renderer/routes/Settings.tsx`
- `apps/desktop/src/renderer/routes/Diagnostics.tsx`
- `apps/desktop/src/renderer/routes/About.tsx`

### Task 3.10: Renderer — Services

**Files:**
- `apps/desktop/src/renderer/services/host-publisher.ts`
- `apps/desktop/src/renderer/services/control-protocol.ts`
- `apps/desktop/src/renderer/services/viewer-registry.ts`
- `apps/desktop/src/renderer/services/statistics.ts`

---

## Phase 4: Viewer Browser App

### Task 4.1: Viewer Package Setup

**Files:**
- Create: `apps/viewer/package.json`
- Create: `apps/viewer/tsconfig.json`
- Create: `apps/viewer/vite.config.ts`
- Create: `apps/viewer/index.html`

### Task 4.2: Viewer App

**Files:**
- `apps/viewer/src/main.tsx`
- `apps/viewer/src/App.tsx`
- `apps/viewer/src/services/rendezvous-client.ts`
- `apps/viewer/src/services/vdo-viewer.ts`
- `apps/viewer/src/services/control-protocol.ts`
- `apps/viewer/src/services/quality-client.ts`
- `apps/viewer/src/services/statistics.ts`
- `apps/viewer/src/services/reconnect-controller.ts`
- `apps/viewer/src/stores/`
- `apps/viewer/src/components/`

**Spec:** Sections 12.2, 12.4, 14, 15, 18, 20

---

## Phase 5: Scripts and Build

### Task 5.1: Build Scripts

**Files:**
- Create: `scripts/package.json`
- Create: `scripts/copy-vdo-sdk.mjs`
- Create: `scripts/verify-vdo-sdk.mjs`
- Create: `scripts/provision-share.mjs`
- Create: `scripts/package-release.mjs`

---

## Phase 6: Documentation

### Task 6.1: Core Documentation

**Files:**
- Create: `docs/architecture.md`
- Create: `docs/evidence-register.md`
- Create: `docs/dependency-baseline.md`
- Create: `docs/vdo-sdk-integration.md`
- Create: `docs/control-api.md`
- Create: `docs/quality-control-matrix.md`
- Create: `docs/security.md`
- Create: `docs/privacy.md`
- Create: `docs/licensing.md`
- Create: `docs/deployment.md`
- Create: `docs/windows-testing.md`
- Create: `docs/troubleshooting.md`
- Create: `docs/known-limitations.md`

---

## Phase 7: Testing Infrastructure

### Task 7.1: Unit Tests

Write comprehensive unit tests following spec section 26.1.

### Task 7.2: Integration Tests

Write integration tests following spec section 26.2.
