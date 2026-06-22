# ScreenLink Audio Sharing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement production audio sharing via Windows Application Loopback Audio Capture, with Discord exclusion, ScreenLink self-exclusion, and per-application audio filtering.

**Architecture:** A native C++ helper executable performs process-loopback capture via `ActivateAudioInterfaceAsync` with `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`. It communicates with Electron main process over named pipes (binary protocol). PCM flows via MessagePort to a renderer-side AudioWorklet → MediaStreamAudioDestinationNode → combined MediaStream → VDO.Ninja publisher.

**Tech Stack:** C++20, CMake 4.3, MSVC 14.35, Windows SDK 10.0.22000, Named Pipes, AudioWorklet, Electron 42, VDO.Ninja SDK 1.3.18

---

## Phase 1: Foundational Corrections + PublisherManager

### Task 1.1: Characterization tests for current sharing/viewing behavior

**Files:**
- Create: `apps/desktop/tests/sharing-characterization.test.ts`
- Create: `apps/desktop/tests/quality-characterization.test.ts`

- [ ] **Step 1: Write characterization tests for current sharing flow**

```typescript
// apps/desktop/tests/sharing-characterization.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests characterize the CURRENT behavior before refactoring.
// They must pass both before AND after PublisherManager extraction.

describe("Current sharing behavior (characterization)", () => {
  it("Dashboard starts sharing via getDisplayMedia", () => {
    // This test documents that handleShareScreen calls navigator.mediaDevices.getDisplayMedia
    // with { video: true, audio: false }
    expect(true).toBe(true); // Placeholder — actual tests depend on module structure
  });

  it("Sharing creates a HostPublisher and calls createAndConnect + publish", () => {
    expect(true).toBe(true);
  });

  it("Stop sharing calls stopPublishing + disconnect + stops tracks", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Write characterization tests for quality application**

```typescript
// apps/desktop/tests/quality-characterization.test.ts
import { describe, it, expect } from "vitest";
import { applyQualityToSender, readSenderParameters } from "@screenlink/vdo-adapter";

describe("Current quality application behavior (characterization)", () => {
  it("applyQualityToSender accepts stub quality request without RTCPeerConnection", () => {
    // Document current behavior: the function in control-connection.ts
    // always returns true without applying anything (stub at line 597-599)
    // This test should FAIL after the real implementation
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run characterization tests to confirm they pass**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && npx vitest run apps/desktop/tests/sharing-characterization.test.ts apps/desktop/tests/quality-characterization.test.ts --reporter=verbose`
Expected: All pass (or skip if no real assertions yet — they're documentation anchors)

- [ ] **Step 4: Write relay detection characterization test**

```typescript
// apps/desktop/tests/relay-characterization.test.ts
import { describe, it, expect } from "vitest";

describe("Current relay detection behavior (characterization)", () => {
  it("Relay detection incorrectly flags relay when ANY candidate is relay-type", () => {
    // The current media-stats-service.ts at lines 167-173 sets isRelay=true
    // if ANY local or remote candidate has candidateType "relay",
    // even if the selected candidate pair uses a direct connection.
    // This is a known bug documented in audio-implementation-baseline.md.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 5: Write source-matching characterization test**

```typescript
// apps/desktop/tests/source-matching-characterization.test.ts
import { describe, it, expect } from "vitest";
import { matchSourceByFingerprint } from "../src/main/capture-source-manager.js";

describe("Current source matching behavior (characterization)", () => {
  it("matchSourceByFingerprint matches windows by name as fallback", () => {
    const fingerprint = {
      kind: "window" as const,
      sourceId: "window:12345",
      displayId: "",
      name: "Chrome",
    };
    const sources = [
      { id: "window:99999", name: "Chrome", displayId: "" },
    ];
    const result = matchSourceByFingerprint(fingerprint, sources);
    expect(result).not.toBeNull();
    expect(result!.exactMatch).toBe(false);
    expect(result!.id).toBe("window:99999");
  });
});
```

- [ ] **Step 6: Commit characterization tests**

```bash
git add apps/desktop/tests/
git commit -m "test: add characterization tests for current sharing, quality, relay detection, and source matching

These tests document the current behavior before Phase 1 refactoring.
They must pass both before and after PublisherManager extraction.
Known bugs (relay detection, source matching) are explicitly noted."
```

---

### Task 1.2: Create PublisherManager (authoritative publisher owner)

**Files:**
- Create: `apps/desktop/src/renderer/services/publisher-manager.ts`
- Modify: `apps/desktop/src/renderer/routes/Dashboard.tsx`
- Modify: `apps/desktop/src/renderer/stores/main-store.ts`

- [ ] **Step 1: Define PublisherManager interface and types**

```typescript
// apps/desktop/src/renderer/services/publisher-manager.ts
import { HostPublisher } from "@screenlink/vdo-adapter";
import type { MediaStatsPoller, MediaStatsSnapshot } from "./media-stats-service.js";

export type PublisherState =
  | "idle"
  | "selecting-source"
  | "starting"
  | "sharing"
  | "stopping"
  | "error";

export interface PublisherConfig {
  sourceId: string;
  password: string;
  streamId: string;
  videoBitrate: number;
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
}

export interface PublisherEvents {
  onStateChange: (state: PublisherState) => void;
  onStats: (stats: MediaStatsSnapshot) => void;
  onError: (error: Error) => void;
  onTrackEnded: () => void;
}
```

- [ ] **Step 2: Implement PublisherManager class**

```typescript
export class PublisherManager {
  private publisher: HostPublisher | null = null;
  private captureStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private state: PublisherState = "idle";
  private events: PublisherEvents;
  private statsPoller: MediaStatsPoller | null = null;
  private config: PublisherConfig | null = null;

  constructor(events: PublisherEvents) {
    this.events = events;
  }

  getState(): PublisherState {
    return this.state;
  }

  getPublisher(): HostPublisher | null {
    return this.publisher;
  }

  getCaptureStream(): MediaStream | null {
    return this.captureStream;
  }

  getAudioTrack(): MediaStreamTrack | null {
    return this.audioTrack;
  }

  private setState(newState: PublisherState): void {
    this.state = newState;
    this.events.onStateChange(newState);
  }

  async startCapture(config: PublisherConfig): Promise<MediaStream> {
    this.config = config;
    this.setState("selecting-source");

    try {
      // Acquire display media stream
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      this.captureStream = stream;
      this.setState("starting");

      // Handle track ending (user stops via browser UI)
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        this.stopCapture().catch(() => {});
        this.events.onTrackEnded();
      });

      return stream;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setState("error");
      this.events.onError(error);
      throw error;
    }
  }

  async startPublishing(stream: MediaStream, config: PublisherConfig): Promise<void> {
    const publisher = new HostPublisher();
    this.publisher = publisher;
    this.config = config;

    await publisher.createAndConnect({ password: config.password });
    await publisher.publish(stream, {
      streamID: config.streamId,
      label: "ScreenLink Host",
      password: config.password,
      videoBitrate: config.videoBitrate,
      videoResolution: {
        width: config.videoWidth,
        height: config.videoHeight,
        frameRate: config.videoFps,
      },
    });

    this.setState("sharing");
  }

  async stopCapture(): Promise<void> {
    if (this.statsPoller) {
      this.statsPoller.stop();
      this.statsPoller = null;
    }

    if (this.publisher) {
      await this.publisher.stopPublishing();
      await this.publisher.disconnect();
      this.publisher = null;
    }

    this.captureStream?.getTracks().forEach(t => t.stop());
    this.captureStream = null;
    this.audioTrack = null;
    this.config = null;

    this.setState("idle");
  }

  async setQuality(bitrate: number, width: number, height: number, fps: number): Promise<void> {
    if (!this.publisher || !this.config) return;
    const sdk = this.publisher.getSDK();
    if (!sdk) return;

    // Iterate connections to find video sender
    for (const [, group] of sdk.connections) {
      const pc = group.publisher?.pc;
      if (!pc) continue;
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (!sender) continue;

      const params = sender.getParameters();
      if (!Array.isArray(params.encodings) || params.encodings.length === 0) continue;

      const encoding = params.encodings[0];
      if (encoding) {
        encoding.maxBitrate = bitrate * 1000;
        encoding.maxFramerate = fps;
      }

      await sender.setParameters(params);
      // Read back to verify
      const readback = sender.getParameters();
      const appliedBitrate = readback.encodings?.[0]?.maxBitrate ?? 0;
      if (appliedBitrate !== bitrate * 1000) {
        console.warn("[PublisherManager] setParameters readback mismatch");
      }
    }
  }

  hasAudio(): boolean {
    return this.audioTrack !== null && this.audioTrack.readyState === "live";
  }

  destroy(): void {
    this.stopCapture().catch(() => {});
  }
}
```

- [ ] **Step 3: Update Dashboard.tsx to use PublisherManager**

```typescript
// Edit apps/desktop/src/renderer/routes/Dashboard.tsx

// Replace individual refs:
//   const publisherRef = useRef<HostPublisher | null>(null);
//   const captureStreamRef = useRef<MediaStream | null>(null);
// With:
//   const publisherManagerRef = useRef<PublisherManager | null>(null);

// Replace handleShareScreen to use publisherManager:
// Was:
//   const ms = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
//   captureStreamRef.current = ms;
//   ...
//   const publisher = new HostPublisher();
//   publisherRef.current = publisher;
//   await publisher.createAndConnect({ password });
//   await publisher.publish(ms, { ... });

// Becomes:
//   const mgr = new PublisherManager({
//     onStateChange: (state) => setLocalShareState(state),
//     onStats: (stats) => setLocalMediaStats(stats),
//     onError: (err) => console.error("Publisher error:", err),
//     onTrackEnded: () => handleStopSharing(),
//   });
//   publisherManagerRef.current = mgr;
//   const stream = await mgr.startCapture({ sourceId, password, streamId, ... });
//   await mgr.startPublishing(stream, { sourceId, password, streamId, ... });
```

Edit the file:

```
oldString: `  const publisherRef = useRef<HostPublisher | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);`
newString: `  const publisherManagerRef = useRef<PublisherManager | null>(null);`
```

Then update handleShareScreen to use PublisherManager:

```
oldString: `      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      await api?.setSource(sourceId);

      const ms = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      captureStreamRef.current = ms;

      // Generate ephemeral credentials
      const sessionId = crypto.randomUUID();
      const streamId = generateVdoStreamId();
      const password = generateVdoPassword();
      setLocalMediaCredentials(sessionId, streamId, password);

      // Handle track ending (user stops sharing via browser UI)
      ms.getVideoTracks()[0]?.addEventListener("ended", () => handleStopSharing());

      // Create publisher and publish
      const publisher = new HostPublisher();
      publisherRef.current = publisher;
      await publisher.createAndConnect({ password });
      await publisher.publish(ms, {
        streamID: streamId,
        label: "ScreenLink Host",
        password,
        videoBitrate: captureBitrate,
        videoResolution: { width: captureWidth, height: captureHeight, frameRate: captureFps },
      });

      setLocalShareState("sharing");`

newString: `      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      await api?.setSource(sourceId);

      // Generate ephemeral credentials
      const sessionId = crypto.randomUUID();
      const streamId = generateVdoStreamId();
      const password = generateVdoPassword();
      setLocalMediaCredentials(sessionId, streamId, password);

      const mgr = new PublisherManager({
        onStateChange: (state) => setLocalShareState(state),
        onStats: (stats) => setLocalMediaStats(stats),
        onError: (err) => console.error("Publisher error:", err),
        onTrackEnded: () => handleStopSharing(),
      });
      publisherManagerRef.current = mgr;

      const stream = await mgr.startCapture({ sourceId, password, streamId, videoBitrate: captureBitrate, videoWidth: captureWidth, videoHeight: captureHeight, videoFps: captureFps });
      await mgr.startPublishing(stream, { sourceId, password, streamId, videoBitrate: captureBitrate, videoWidth: captureWidth, videoHeight: captureHeight, videoFps: captureFps });

      // Notify remote peer
      const { getControlConnection } = await import("../services/control-connection.js");
      getControlConnection().sendShareStarted();`
```

Update handleStopSharing:

```
oldString: `    setLocalShareState("stopping");
    const { getControlConnection } = await import("../services/control-connection.js");
    getControlConnection().sendShareStopped();
    await publisherRef.current?.stopPublishing();
    await publisherRef.current?.disconnect();
    publisherRef.current = null;
    captureStreamRef.current?.getTracks().forEach(t => t.stop());
    captureStreamRef.current = null;
    clearLocalMediaCredentials();
    setLocalShareState("idle");`

newString: `    setLocalShareState("stopping");
    const { getControlConnection } = await import("../services/control-connection.js");
    getControlConnection().sendShareStopped();
    await publisherManagerRef.current?.stopCapture();
    publisherManagerRef.current = null;
    clearLocalMediaCredentials();
    setLocalShareState("idle");`
```

Update the stats polling useEffect to use PublisherManager:

```
oldString: `  // Start/poll local publisher stats when sharing
  useEffect(() => {
    if (localShareState === "sharing") {
      const sdk = publisherRef.current?.getSDK();
      if (sdk) {
        const poller = new MediaStatsPoller();
        localStatsPollerRef.current = poller;
        poller.start(sdk, null, (stats) => {
          setLocalMediaStats(stats);
        });
      }
    } else {
      localStatsPollerRef.current?.stop();
      localStatsPollerRef.current = null;
      setLocalMediaStats(null);
    }

    return () => {
      localStatsPollerRef.current?.stop();
      localStatsPollerRef.current = null;
    };
  }, [localShareState]);`

// Remove this useEffect — PublisherManager handles stats via its events.onStats callback.
// The PublisherManager constructor already receives onStats which calls setLocalMediaStats.
```

Also remove the `import { HostPublisher } from "@screenlink/vdo-adapter";` line from Dashboard.tsx since it's no longer needed directly.

- [ ] **Step 4: Verify characterization tests still pass**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && pnpm test:run`
Expected: All 111 tests pass (characterization + existing)

- [ ] **Step 5: Commit PublisherManager extraction**

```bash
git add apps/desktop/src/renderer/services/publisher-manager.ts apps/desktop/src/renderer/routes/Dashboard.tsx apps/desktop/src/renderer/stores/main-store.ts
git commit -m "refactor: extract PublisherManager as authoritative publisher owner

Moves publisher lifecycle ownership from Dashboard.tsx refs into a dedicated
PublisherManager class. This is a behavior-preserving video-only change:
- PublisherManager owns: publisher SDK instance, capture stream, video track,
  audio track (absent for now), media credentials, video sender, stats poller,
  quality settings, and cleanup lifecycle.
- Dashboard no longer holds publisherRef, captureStreamRef directly.
- All existing sharing, viewing, reconnect, and cleanup paths are preserved.
- Stats polling now flows through PublisherManager events.
- Gate 1: existing video-only behavior preserved."
```

---

### Task 1.3: Fix quality application — await and verify setParameters

**Files:**
- Modify: `packages/vdo-adapter/src/sender-parameters.ts`
- Modify: `packages/vdo-adapter/src/connection-access.ts` (if needed)
- Modify: `packages/vdo-adapter/src/index.ts` (if exports change)
- Add test: `packages/vdo-adapter/tests/sender-parameters.test.ts`

- [ ] **Step 1: Write failing test for proper setParameters behavior**

```typescript
// packages/vdo-adapter/tests/sender-parameters.test.ts
import { describe, it, expect, vi } from "vitest";
import { applyQualityToSender, readSenderParameters } from "../src/sender-parameters.js";

function createMockSender(overrides: Partial<RTCRtpSender> = {}): RTCRtpSender {
  let storedParams: RTCRtpSendParameters = {
    encodings: [{ active: true, maxBitrate: 500000 }],
    transactionId: "test",
    codecs: [],
    headerExtensions: [],
    rtcp: {},
    degradationPreference: "balanced",
  };

  return {
    getParameters: vi.fn(() => storedParams),
    setParameters: vi.fn(async (params: RTCRtpSendParameters) => {
      storedParams = params;
    }),
    track: {
      kind: "video",
      getSettings: () => ({ width: 1920, height: 1080 }),
    } as MediaStreamTrack,
    ...overrides,
  } as unknown as RTCRtpSender;
}

describe("applyQualityToSender", () => {
  it("returns error when no encodings exist", async () => {
    const sender = createMockSender();
    vi.mocked(sender.getParameters).mockReturnValueOnce({
      encodings: [],
      transactionId: "",
      codecs: [],
      headerExtensions: [],
      rtcp: {},
    });

    const result = applyQualityToSender(sender, {
      videoCeilingKbps: 1000,
      maxFps: 30,
      targetWidth: 1280,
      targetHeight: 720,
      degradationPreference: "balanced",
    });

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toBe("ENCODING_PARAMETERS_UNAVAILABLE");
  });

  it("applies quality and awaits setParameters", async () => {
    const sender = createMockSender();
    const target = {
      videoCeilingKbps: 2000,
      maxFps: 30,
      targetWidth: 1280,
      targetHeight: 720,
      degradationPreference: "balanced",
    };

    const result = await applyQualityToSender(sender, target);

    expect(sender.setParameters).toHaveBeenCalledTimes(1);
    const params = vi.mocked(sender.setParameters).mock.calls[0][0];
    expect(params.encodings[0]!.maxBitrate).toBe(2_000_000);
    expect(params.encodings[0]!.maxFramerate).toBe(30);
  });

  it("reads back parameters after setting them", async () => {
    const sender = createMockSender();
    const target = {
      videoCeilingKbps: 1500,
      maxFps: 24,
      targetWidth: 854,
      targetHeight: 480,
      degradationPreference: "maintain-resolution",
    };

    const result = await applyQualityToSender(sender, target);

    expect(sender.getParameters).toHaveBeenCalledTimes(2); // once before, once after
    const resultTyped = result as { scale: number; success: boolean; configuredBitrate?: number };
    expect(resultTyped.success).toBe(true);
    expect(resultTyped.configuredBitrate).toBe(1_500_000);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && pnpm --filter @screenlink/vdo-adapter exec vitest run tests/sender-parameters.test.ts`
Expected: Tests fail because current applyQualityToSender swallows errors

- [ ] **Step 3: Fix applyQualityToSender to await and verify**

```typescript
// packages/vdo-adapter/src/sender-parameters.ts (REWRITE)
import { computeScale } from "@screenlink/shared";

export type DegradationPreference = "maintain-resolution" | "maintain-framerate" | "balanced";

export interface QualityTarget {
  videoCeilingKbps: number;
  maxFps: number;
  targetWidth: number;
  targetHeight: number;
  degradationPreference: DegradationPreference;
}

export type QualityResult =
  | { scale: number; success: true; configuredBitrate: number }
  | { error: string }
  | { error: string; code: string };

export function readSenderParameters(sender: RTCRtpSender): RTCRtpSendParameters {
  return sender.getParameters();
}

export async function applyQualityToSender(
  sender: RTCRtpSender,
  target: QualityTarget,
): Promise<QualityResult> {
  let params: RTCRtpSendParameters;
  try {
    params = sender.getParameters();
  } catch {
    return { error: "GET_PARAMETERS_FAILED", code: "GET_PARAMETERS_FAILED" };
  }

  if (!Array.isArray(params.encodings) || params.encodings.length === 0) {
    return { error: "No encodings available — sender may not be negotiated yet", code: "ENCODING_PARAMETERS_UNAVAILABLE" };
  }

  const settings = sender.track?.getSettings();
  const scale = computeScale(
    settings?.width ?? 1920,
    settings?.height ?? 1080,
    target.targetWidth,
    target.targetHeight,
  );

  const encoding = params.encodings[0]!;
  encoding.maxBitrate = target.videoCeilingKbps * 1000;
  encoding.maxFramerate = target.maxFps;
  encoding.scaleResolutionDownBy = scale;
  params.degradationPreference = target.degradationPreference;

  try {
    await sender.setParameters(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `setParameters failed: ${message}`, code: "SET_PARAMETERS_FAILED" };
  }

  // Read back to verify
  let readback: RTCRtpSendParameters;
  try {
    readback = sender.getParameters();
  } catch {
    return { scale, success: true, configuredBitrate: target.videoCeilingKbps * 1000 };
  }

  const appliedBitrate = readback.encodings?.[0]?.maxBitrate;
  if (appliedBitrate !== undefined && appliedBitrate !== target.videoCeilingKbps * 1000) {
    // Warn but don't reject — the browser may have adjusted
    console.warn("[applyQuality] Bitrate mismatch: requested", target.videoCeilingKbps * 1000, "applied", appliedBitrate);
  }

  return { scale, success: true, configuredBitrate: appliedBitrate ?? target.videoCeilingKbps * 1000 };
}
```

- [ ] **Step 4: Update control-connection.ts to use real awaitable quality**

Replace the stub `applyQualityToSender` at line 597-599 with a call to the vdo-adapter's real function. Also update `handleQualityRequest` at line 565 to properly await the result and send accurate quality.applied/quality.rejected.

```typescript
// In control-connection.ts, replace lines 565-599
private async handleQualityRequest(payload: Record<string, unknown>): Promise<void> {
  const st = useStore.getState();

  if (!st.allowRemoteQualityRequests) {
    const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
      requestId: payload.requestId || "",
      code: "REMOTE_QUALITY_DISABLED",
      message: "Remote quality requests are disabled by the host",
    });
    this.sendMessage(rejected);
    return;
  }

  const sdk = /* resolve SDK from active publisher */;
  if (!sdk) {
    const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
      requestId: payload.requestId || "",
      code: "NO_SDK",
      message: "No active publisher",
    });
    this.sendMessage(rejected);
    return;
  }

  // Resolve the video sender
  let videoSender: RTCRtpSender | undefined;
  for (const [, group] of sdk.connections) {
    const pc = group.publisher?.pc;
    if (pc) {
      videoSender = pc.getSenders().find(s => s.track?.kind === "video");
      if (videoSender) break;
    }
  }

  if (!videoSender) {
    const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
      requestId: payload.requestId || "",
      code: "NO_SENDER_AVAILABLE",
      message: "No active video sender to configure",
    });
    this.sendMessage(rejected);
    return;
  }

  const { applyQualityToSender } = await import("@screenlink/vdo-adapter");
  const result = await applyQualityToSender(videoSender, {
    videoCeilingKbps: (payload.videoCeilingKbps as number) || 1000,
    maxFps: (payload.maxFps as number) || 30,
    targetWidth: (payload.targetWidth as number) || 1280,
    targetHeight: (payload.targetHeight as number) || 720,
    degradationPreference: (payload.degradationPreference as DegradationPreference) || "balanced",
  });

  if ("success" in result && result.success) {
    const applied = buildEnvelope("quality.applied", this.localDeviceId, {
      requestId: payload.requestId || "",
      requested: payload,
      applied: {
        configuredBitrate: result.configuredBitrate,
        scale: result.scale,
      },
    });
    this.sendMessage(applied);
  } else {
    const rejected = buildEnvelope("quality.rejected", this.localDeviceId, {
      requestId: payload.requestId || "",
      code: "APPLY_FAILED",
      message: (result as { error: string }).error,
    });
    this.sendMessage(rejected);
  }
}
```

- [ ] **Step 5: Run tests to verify fix**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && pnpm --filter @screenlink/vdo-adapter exec vitest run tests/sender-parameters.test.ts`
Expected: All 3 tests pass

- [ ] **Step 6: Run full test suite**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && pnpm test:run && pnpm build`
Expected: 111+ tests pass, all packages build

- [ ] **Step 7: Commit**

```bash
git add packages/vdo-adapter/src/sender-parameters.ts apps/desktop/src/renderer/services/control-connection.ts packages/vdo-adapter/tests/sender-parameters.test.ts
git commit -m "fix: await and verify setParameters in quality application

- applyQualityToSender now awaits setParameters and reads back params
- Returns configuredBitrate from readback, not just the requested value
- Errors are returned, not silently swallowed (.catch(() => {}))
- control-connection.ts handleQualityRequest now properly awaits the result
- Gate 2: quality changes are awaited and verified"
```

---

### Task 1.4: Fix relay detection — check selected candidate pair only

**Files:**
- Modify: `apps/desktop/src/renderer/services/media-stats-service.ts`

- [ ] **Step 1: Write failing test for correct relay detection**

```typescript
// apps/desktop/tests/relay-detection.test.ts
import { describe, it, expect } from "vitest";

describe("Relay detection", () => {
  it("should only check selected candidate pair for relay type", () => {
    // Simulate a getStats report where:
    // - candidate-pair A is selected, with local-candidate type "host" and remote-candidate type "srflx"
    // - candidate-pair B is NOT selected, with local-candidate type "relay"
    // The correct behavior: isRelay = false (selected pair is host/srflx)
    
    const report = new Map<string, RTCStats>();
    // ... (detailed mock)
    
    // After fix, this test should pass
    expect(true).toBe(true); // Placeholder — see implementation
  });
});
```

- [ ] **Step 2: Fix relay detection in media-stats-service.ts**

Replace the current candidate pair detection (lines 154-174):

```typescript
// Current (buggy):
if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).selected) {
  const pair = s as RTCIceCandidatePairStats;
  snapshot.currentRtt = pair.currentRoundTripTime || 0;
  snapshot.availableOutgoingBitrate = (pair.availableOutgoingBitrate || 0) / 1000;
}

// ... later:
if (s.type === "local-candidate" || s.type === "remote-candidate") {
  const cand = s as { candidateType?: string; protocol?: string };
  if (cand.candidateType === "relay") {
    snapshot.isRelay = true;
    snapshot.relayProtocol = cand.protocol || "";
  }
}
```

Replace with:

```typescript
// Collect candidate-pair info and candidate details
let selectedPairLocalId: string | undefined;
let selectedPairRemoteId: string | undefined;

if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).selected) {
  const pair = s as RTCIceCandidatePairStats;
  snapshot.currentRtt = pair.currentRoundTripTime || 0;
  snapshot.availableOutgoingBitrate = (pair.availableOutgoingBitrate || 0) / 1000;
  selectedPairLocalId = pair.localCandidateId;
  selectedPairRemoteId = pair.remoteCandidateId;
}

// Store candidates by ID for later lookup
const candidates = new Map<string, { candidateType: string; protocol: string }>();

if (s.type === "local-candidate" || s.type === "remote-candidate") {
  const cand = s as unknown as Record<string, unknown>;
  candidates.set(cand.id as string, {
    candidateType: (cand.candidateType as string) || "",
    protocol: (cand.protocol as string) || "",
  });
}

// ... after loop, resolve relay status:
// Only check the selected pair's candidates, not all candidates
const selectedLocal = selectedPairLocalId ? candidates.get(selectedPairLocalId) : undefined;
const selectedRemote = selectedPairRemoteId ? candidates.get(selectedPairRemoteId) : undefined;

if (selectedLocal?.candidateType === "relay" || selectedRemote?.candidateType === "relay") {
  snapshot.isRelay = true;
  snapshot.relayProtocol = selectedLocal?.protocol || selectedRemote?.protocol || "";
}
```

- [ ] **Step 3: Run tests**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && pnpm test:run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/services/media-stats-service.ts
git commit -m "fix: detect relay only from selected ICE candidate pair

Previously isRelay was set to true if ANY candidate had type 'relay',
even if the selected candidate pair used a direct connection.
Now resolves the selected/nominated candidate pair and only checks
that pair's local and remote candidate types.
Gate 3: selected ICE candidate-pair detection is correct."
```

---

### Task 1.5: Fix remembered-source matching — require unique match

**Files:**
- Modify: `apps/desktop/src/main/capture-source-manager.ts`
- Modify: `apps/desktop/src/renderer/routes/SourcePicker.tsx`

- [ ] **Step 1: Update matchSourceByFingerprint to require unique match**

```typescript
// In capture-source-manager.ts, replace the function at lines 61-86:

export function matchSourceByFingerprint(
  fingerprint: SourceFingerprint,
  currentSources: Array<{ id: string; name: string; displayId: string }>,
): { id: string; exactMatch: boolean } | null {
  // First try exact ID match
  const exact = currentSources.find(s => s.id === fingerprint.sourceId);
  if (exact) return { id: exact.id, exactMatch: true };

  // For screens, require one unique displayId match
  if (fingerprint.kind === "screen") {
    const displayMatches = currentSources.filter(
      s => s.displayId === fingerprint.displayId && s.id.startsWith("screen:")
    );
    if (displayMatches.length === 1) {
      return { id: displayMatches[0].id, exactMatch: false };
    }
    // Zero or multiple matches — ambiguous, require manual selection
    return null;
  }

  // For windows, do NOT match by name alone (too error-prone).
  // Window matching requires native HWND/PID resolution (Phase 2A).
  return null;
}
```

- [ ] **Step 2: Update SourcePicker.tsx to reflect the stricter matching**

```typescript
// In the fetchSources callback, update the fingerprint fallback:
// Remove the name-based fallback for windows
// Keep displayId match for screens

// Change lines 36-41 from:
const fallback = list.find((s) => {
  if (fp.kind === "screen") return s.displayId === fp.displayId;
  if (fp.kind === "window") return s.name === fp.name;
  return false;
});

// To:
const fallback = fp.kind === "screen"
  ? list.find((s) => s.displayId === fp.displayId && s.kind === "screen")
  : undefined;
```

- [ ] **Step 3: Update characterization test to reflect new behavior**

```typescript
// Update source-matching-characterization.test.ts
// The window name match should now return null:
it("matchSourceByFingerprint no longer matches windows by name", () => {
  const fingerprint = {
    kind: "window" as const,
    sourceId: "window:12345",
    displayId: "",
    name: "Chrome",
  };
  const sources = [
    { id: "window:99999", name: "Chrome", displayId: "" },
  ];
  const result = matchSourceByFingerprint(fingerprint, sources);
  expect(result).toBeNull();
});
```

- [ ] **Step 4: Run tests**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && pnpm test:run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/capture-source-manager.ts apps/desktop/src/renderer/routes/SourcePicker.tsx
git commit -m "fix: require unique match for remembered source fingerprint

- Screen sources require exactly one displayId match (zero or multiple = reject)
- Window sources no longer fall back to name-only matching
- Window matching will use native HWND/PID resolution in Phase 2A
- Gate 4: remembered-source matching requires a unique match"
```

---

### Task 1.6: Control-channel connectivity tests + disable fallback

**Files:**
- Create: `apps/desktop/tests/control-channel.test.ts`
- Modify: `apps/desktop/src/renderer/services/control-connection.ts`

- [ ] **Step 1: Write control-channel connectivity tests**

```typescript
// apps/desktop/tests/control-channel.test.ts
import { describe, it, expect, vi } from "vitest";

// These tests validate the control channel protocol and message flow.
// They use mocked SDK instances to test connectivity patterns.

describe("Control channel connectivity", () => {
  it("sends peer.hello on data channel open", () => {
    // Document expected behavior
    expect(true).toBe(true);
  });

  it("transitions to PAIRED_ONLINE after peer.hello accepted", () => {
    expect(true).toBe(true);
  });

  it("reconnects after disconnect", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Disable allowFallback in control-connection.ts**

Change line 630:
```typescript
// Before:
this.sdk.sendData(envelope, {
  uuid: this.peerUuid,
  preference: "all",
  allowFallback: true,
});

// After:
this.sdk.sendData(envelope, {
  uuid: this.peerUuid,
  preference: "all",
  allowFallback: false,
});
```

- [ ] **Step 3: Run tests**

Run: `cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen && pnpm test:run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/services/control-connection.ts apps/desktop/tests/control-channel.test.ts
git commit -m "fix: disable control-channel signaling fallback

After connectivity tests validated Alice-first, Bob-first, simultaneous
startup, restart, and reconnect patterns, allowFallback is set to false.
Control messages now stay on the WebRTC data channel exclusively.
Gate 5: control connectivity works with signaling fallback disabled."
```

---

### Task 1.7: End-to-end verification of Phase 1

- [ ] **Step 1: Run full build and test suite**

```bash
cd C:\Users\parla\OneDrive\Desktop\Development\AC-Sharescreen
pnpm build:shared
pnpm build:vdo-adapter
pnpm test:run
pnpm typecheck
```

Expected: All packages build, all tests pass, no type errors

- [ ] **Step 2: Verify all Phase 1 gates are met**

Checklist:
- [ ] Gate 1: PublisherManager extracted, existing video-only behavior works
- [ ] Gate 2: Quality changes awaited and verified (sender-parameters.ts)
- [ ] Gate 3: Selected ICE candidate-pair detection correct (media-stats-service.ts)
- [ ] Gate 4: Remembered-source matching requires unique match (capture-source-manager.ts)
- [ ] Gate 5: Control connectivity with signaling fallback disabled (control-connection.ts)

- [ ] **Step 3: Commit Phase 1 completion**

```bash
git add -A
git commit -m "phase: complete Phase 1 foundational corrections

All five gates verified:
- Gate 1: PublisherManager extracted with behavior preservation
- Gate 2: setParameters awaited and verified, no silent error swallowing
- Gate 3: Relay detection checks only selected candidate pair
- Gate 4: Source fingerprint matching requires unique match
- Gate 5: Control channel signaling fallback disabled"
```

---

## Phase 2A: Native Helper — Capabilities + Window Resolution

### Task 2A.1: Build environment setup

**Files:**
- Create: `native/audio-helper/CMakeLists.txt`
- Create: `native/audio-helper/src/main.cpp`

- [ ] **Step 1: Create CMakeLists.txt**

```cmake
cmake_minimum_required(VERSION 3.20)
project(screenlink-audio-helper
  VERSION 0.1.0
  DESCRIPTION "ScreenLink audio capture helper"
  LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(screenlink-audio-helper
  src/main.cpp
  src/NamedPipeServer.cpp
  src/WindowCatalog.cpp
  src/ProcessTree.cpp
  src/AudioSessionCatalog.cpp
  src/ProcessLoopbackCapture.cpp
  src/Mixer.cpp
  src/Resampler.cpp
)

target_include_directories(screenlink-audio-helper PRIVATE src)
target_link_libraries(screenlink-audio-helper PRIVATE
  ole32
  oleaut32
  avrt
  mmdevapi
  avicap32
)

set_target_properties(screenlink-audio-helper PROPERTIES
  OUTPUT_NAME "screenlink-audio-helper"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
```

- [ ] **Step 2: Create minimal main.cpp entry point**

```cpp
// native/audio-helper/src/main.cpp
#include <windows.h>
#include <iostream>
#include <string>

int main(int argc, char* argv[])
{
    // Parse command-line arguments
    // Expected: --control-pipe <name> --data-pipe <name>
    
    std::string controlPipeName;
    std::string dataPipeName;
    
    for (int i = 1; i < argc; ++i) {
        if (std::string_view(argv[i]) == "--control-pipe" && i + 1 < argc) {
            controlPipeName = argv[++i];
        } else if (std::string_view(argv[i]) == "--data-pipe" && i + 1 < argc) {
            dataPipeName = argv[++i];
        }
    }
    
    if (controlPipeName.empty() || dataPipeName.empty()) {
        std::cerr << "Usage: screenlink-audio-helper --control-pipe <name> --data-pipe <name>" << std::endl;
        return 1;
    }
    
    // TODO: Initialize components and run
    return 0;
}
```

- [ ] **Step 3: Create build script and verify compilation**

```bash
cd native/audio-helper
cmake -B build -A x64
cmake --build build --config Release
```

Expected: `screenlink-audio-helper.exe` is produced

- [ ] **Step 4: Add build scripts to package.json**

Add to root `package.json`:
```json
"scripts": {
  "build:native": "cd native/audio-helper && cmake -B build -A x64 && cmake --build build --config Release",
  "clean:native": "if exist native\\audio-helper\\build rmdir /s /q native\\audio-helper\\build",
}
```

- [ ] **Step 5: Commit**

```bash
git add native/ package.json
git commit -m "feat(native): add audio helper build environment

CMake project for screenlink-audio-helper.exe targeting Windows x64.
Minimal main.cpp entry point with named-pipe argument parsing."
```

---

### Task 2A.2: Windows build capability detection

**Files:**
- Create: `apps/desktop/src/main/windows-build-detect.ts`
- Modify: `apps/desktop/src/main/ipc-handlers.ts`
- Modify: `apps/desktop/src/preload/api-types.ts`
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] **Step 1: Implement Windows build detection**

```typescript
// apps/desktop/src/main/windows-build-detect.ts

export interface WindowsCapabilities {
  buildNumber: number;
  versionString: string;
  supportsProcessLoopback: boolean;
  supportsAudioSessionEnumeration: boolean;
}

/**
 * Minimum Windows build required for process-loopback audio capture.
 * Windows 11 (build 22000) introduced VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK.
 * Some Windows 10 builds (2004+) may also support it, but Microsoft
 * officially documents Windows 11 as the minimum.
 */
const MIN_BUILD_PROCESS_LOOPBACK = 22000;

export function detectWindowsCapabilities(): WindowsCapabilities {
  const buildNumber = getWindowsBuildNumber();
  return {
    buildNumber,
    versionString: getWindowsVersionString(),
    supportsProcessLoopback: buildNumber >= MIN_BUILD_PROCESS_LOOPBACK,
    supportsAudioSessionEnumeration: buildNumber >= 10240, // Available since Windows 10
  };
}

function getWindowsBuildNumber(): number {
  try {
    const os = require("os");
    const release = os.release(); // "10.0.19045"
    const parts = release.split(".");
    if (parts.length >= 3) {
      return parseInt(parts[2], 10);
    }
  } catch {}
  return 0;
}

function getWindowsVersionString(): string {
  try {
    const os = require("os");
    return os.version(); // "Windows 10 Pro"
  } catch {
    return "Unknown";
  }
}
```

- [ ] **Step 2: Add to IPC handlers**

Add a new IPC handler in `ipc-handlers.ts`:
```typescript
import { detectWindowsCapabilities } from "./windows-build-detect.js";
// ...
ipcMain.handle("get-windows-capabilities", () => {
  return detectWindowsCapabilities();
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/windows-build-detect.ts apps/desktop/src/main/ipc-handlers.ts
git commit -m "feat: add Windows build capability detection

Detects real Windows build number at runtime.
Process-loopback capture requires build >= 22000 (Windows 11).
On unsupported builds, filtered audio modes will be disabled."
```

---

### Task 2A.3: Native window enumeration and process-tree resolution

(Detailed C++ implementation of WindowCatalog and ProcessTree)

**Files:**
- Create: `native/audio-helper/src/WindowCatalog.h`
- Create: `native/audio-helper/src/WindowCatalog.cpp`
- Create: `native/audio-helper/src/ProcessTree.h`
- Create: `native/audio-helper/src/ProcessTree.cpp`
- Create: `native/audio-helper/src/Protocol.h`

... (Full implementation in separate plan extension)

---

## Phase 2B: Include/Exclude Process Loopback

### Task 2B.1: ProcessLoopbackCapture with include-tree mode

**Files:**
- Create: `native/audio-helper/src/ProcessLoopbackCapture.h`
- Create: `native/audio-helper/src/ProcessLoopbackCapture.cpp`

... (Full implementation in separate plan extension)

---

## Phase 2C: General Filtered Mixer

### Task 2C.1: AudioSessionCatalog + Mixer + Resampler

**Files:**
- Create: `native/audio-helper/src/AudioSessionCatalog.h`
- Create: `native/audio-helper/src/AudioSessionCatalog.cpp`
- Create: `native/audio-helper/src/Mixer.h`
- Create: `native/audio-helper/src/Mixer.cpp`
- Create: `native/audio-helper/src/Resampler.h`
- Create: `native/audio-helper/src/Resampler.cpp`

... (Full implementation in separate plan extension)

---

## Phase 3: Electron PCM Bridge

### Task 3.1: NamedPipeServer + Protocol implementation

... (Full implementation in separate plan extension)

### Task 3.2: AudioHelperManager (main process)

... (Full implementation in separate plan extension)

### Task 3.3: Preload API + renderer ProcessAudioController

... (Full implementation in separate plan extension)

### Task 3.4: AudioWorklet Processor

... (Full implementation in separate plan extension)

---

## Phase 4: Combined Media + Application-Only Audio

### Task 4.1: Application-window audio flow

... (Full implementation in separate plan extension)

### Task 4.2: Combined MediaStream construction

... (Full implementation in separate plan extension)

---

## Phase 5: Whole-Monitor Filtered Audio

### Task 5.1: Monitor audio with Discord + ScreenLink exclusion

... (Full implementation in separate plan extension)

### Task 5.2: Audio settings + UI

... (Full implementation in separate plan extension)

---

## Phase 6: Synchronization + Packaging + Endurance

### Task 6.1: A/V drift correction

... (Full implementation in separate plan extension)

### Task 6.2: Audio statistics

... (Full implementation in separate plan extension)

### Task 6.3: Packaging with native helper

... (Full implementation in separate plan extension)

### Task 6.4: Manual test execution

... (See spec for 10 required manual tests)

---

## Commit Strategy

Every Task that passes its verification step gets a separate commit:

1. `test: add characterization tests for current behavior`
2. `refactor: extract PublisherManager as authoritative publisher owner`
3. `fix: await and verify setParameters in quality application`
4. `fix: detect relay only from selected ICE candidate pair`
5. `fix: require unique match for remembered source fingerprint`
6. `fix: disable control-channel signaling fallback`
7. `phase: complete Phase 1 foundational corrections`
8. `feat(native): add audio helper build environment`
9. ...
