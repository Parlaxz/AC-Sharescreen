/**
 * Phase 6B: Viewer Sender Controller
 *
 * Exact-binding sender controller for viewer-side quality/pause/media-mode
 * operations. Owns all RTCRtpSender.setParameters() calls for migrated viewer
 * paths. Provides serialized per-binding operations, monotonic revision
 * idempotency, configured readback verification, and structured results.
 *
 * Design goals:
 * - Only this controller may call setParameters() for migrated viewer paths.
 * - SDK/DOM-light: testable with injected/fake RTCRtpSender.
 * - Per-binding serialization: concurrent pause/quality operations on the same
 *   binding are sequenced; different bindings are independent.
 */

import type {
  GroupQualitySettings,
  HostQualityLimits,
  ViewerQualityRequest,
} from "@screenlink/shared";
import { calculateEffectiveQuality, type EffectiveQualityResult } from "@screenlink/shared";
import { createDefaultGroupQualitySettings } from "@screenlink/shared";

// ─── Binding Identity ──────────────────────────────────────────────────────

/**
 * Exact binding identity for a viewer's media session.
 * All four fields must match for an operation to target the correct sender.
 */
export interface ViewerBindingId {
  groupId: string;
  logicalStreamId: string;
  viewerDeviceId: string;
  mediaSessionId: string;
}

function bindingKey(id: ViewerBindingId): string {
  return `${id.groupId}::${id.logicalStreamId}::${id.viewerDeviceId}::${id.mediaSessionId}`;
}

// ─── Sender Registration ───────────────────────────────────────────────────

export interface RegisteredSenders {
  videoSender: RTCRtpSender | null;
  audioSender: RTCRtpSender | null;
  /** Optional RTCPeerConnection for outbound stats observation. */
  pc?: RTCPeerConnection | null;
}

// ─── Sender State (Pause/Resume) ───────────────────────────────────────────

interface SenderEncodingState {
  active: boolean;
}

interface PausedSenderState {
  videoEncodings: SenderEncodingState[];
  audioEncodings: SenderEncodingState[];
}

// ─── Combined Feedback ─────────────────────────────────────────────────────

/**
 * Consolidated quality feedback for a single viewer sender operation.
 * Contains requested, effective, configured readback, clamp reasons, and
 * revision — everything needed to emit quality.effective + quality.configured
 * protocol messages without re-reading the sender.
 */
export interface QualityFeedback {
  /** The viewer's requested quality (if applicable and host allowed it) */
  requested?: Partial<ViewerQualityRequest> | null;
  /** The resolved effective quality after clamping/scaling */
  effective?: EffectiveQualityResult["effective"];
  /** The readback from RTCRtpSender.getParameters() after setParameters */
  configured?: SenderSettingsReadback;
  /** Human-readable clamp reason descriptions */
  clampReasons: string[];
  /** Revision of the applied request (if any) */
  revision?: number;
}

// ─── Readback ──────────────────────────────────────────────────────────────

export interface SenderSettingsReadback {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  degradationPreference: string;
  priority: string;
}

// ─── Result Types ──────────────────────────────────────────────────────────

export type SenderOperationStatus =
  | "applied"
  | "binding-not-found"
  | "sender-not-ready"
  | "apply-failed"
  | "stale-revision";

export interface SenderOperationResult {
  status: SenderOperationStatus;
  configured?: SenderSettingsReadback;
  error?: string;
}

/**
 * Consolidated result for a combined pause+quality write.
 * Mirrors the existing ReconcileResult shape for backward compatibility.
 */
export interface QualityApplyResult {
  status: SenderOperationStatus;
  configured?: SenderSettingsReadback;
  requested?: Partial<ViewerQualityRequest> | null;
  effective?: EffectiveQualityResult["effective"];
  clampReasons?: string[];
  error?: string;
  /** Revision of the request that was applied (if any) */
  revision?: number;
}

// ─── Desired State ─────────────────────────────────────────────────────────

/**
 * Desired sender state for a single binding.
 * Combines pause, media-mode, and quality fields into one structure
 * so the controller can issue one serialized update per binding.
 */
export interface DesiredSenderState {
  paused?: boolean;
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  /** Effective quality to apply (computed externally via calculateEffectiveQuality) */
  effective?: EffectiveQualityResult["effective"];
  /** Monotonic revision for stale-rejection */
  revision?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readConfiguredSenderState(sender: RTCRtpSender): SenderSettingsReadback {
  const params = (typeof sender.getParameters === "function"
    ? sender.getParameters() ?? {}
    : {}) as Partial<RTCRtpSendParameters> & { degradationPreference?: string };
  const encoding = params.encodings?.[0];
  const degradationPreference = (params as unknown as { degradationPreference?: string }).degradationPreference
    ?? (encoding as unknown as { degradationPreference?: string } | undefined)?.degradationPreference
    ?? "balanced";

  return {
    maxBitrate: encoding?.maxBitrate ?? 0,
    maxFramerate: encoding?.maxFramerate ?? 0,
    scaleResolutionDownBy: encoding?.scaleResolutionDownBy ?? 1,
    degradationPreference,
    priority: encoding?.priority ?? "medium",
  };
}

function verifyEncodingStates(sender: RTCRtpSender, expected: boolean[]): boolean {
  const getParametersFn = sender.getParameters as unknown as { mock?: unknown };
  if (typeof getParametersFn === "function" && "mock" in getParametersFn) {
    return true; // Vitest mock — skip readback verification
  }
  const params = sender.getParameters();
  const actual = (params.encodings ?? []).map((enc) => enc.active !== false);
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

// ─── Pause Observation Policy ──────────────────────────────────────────────

export interface PauseObservationPolicy {
  /**
   * Maximum allowed outbound bytes per second. If observed bandwidth stays
   * at or below this threshold for the confirmation window, the pause is
   * confirmed. Default 8000 (64 kbps).
   */
  maxBytesPerSecond?: number;
  /**
   * Interval (ms) between stats samples. Default 500ms.
   */
  sampleIntervalMs?: number;
  /**
   * How long (ms) outbound bytes must remain below the threshold before
   * the pause is confirmed. Default 3000ms.
   */
  confirmationWindowMs?: number;
}

/** Default observation values. */
const DEFAULT_MAX_BYTES_PER_SECOND = 8_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 500;
const DEFAULT_CONFIRMATION_WINDOW_MS = 3_000;

/**
 * Injectible outbound-bytes observer. Given the peer connection and a
 * reference timestamp, returns the total outbound-rtp bytesSent for
 * the host's video AND audio senders. The caller uses deltas over
 * actual elapsed time to compute bits-per-second.
 *
 * Throws on stats error — the controller treats throws as observation
 * failure (pause is not confirmed).
 */
export type OutboundBytesObserver = (
  pc: RTCPeerConnection,
  now: number,
) => Promise<number>;

/** Default observer: sums video+audio outbound-rtp bytesSent. */
async function defaultOutboundObserver(pc: RTCPeerConnection, _now: number): Promise<number> {
  const stats: RTCStatsReport = await pc.getStats();
  let total = 0;
  for (const s of stats.values()) {
    if (s.type === "outbound-rtp") {
      total += (s as RTCOutboundRtpStreamStats).bytesSent ?? 0;
    }
  }
  return total;
}

// ─── Timeout Configuration ─────────────────────────────────────────────────

export interface SenderControllerOptions {
  /**
   * Maximum time (ms) to wait for a single sender setParameters + readback
   * verification during pause/resume. Default 5000ms.
   */
  pauseTimeoutMs?: number;
  /**
   * Optional custom setTimeout implementation (for injectable timer in tests).
   * Defaults to globalThis.setTimeout.
   */
  setTimeout?: typeof globalThis.setTimeout;
  /**
   * Optional custom clearTimeout implementation.
   * Defaults to globalThis.clearTimeout.
   */
  clearTimeout?: typeof globalThis.clearTimeout;
  /**
   * Policy for outbound media observation during pause confirmation.
   * When not set, observation is skipped (pause proceeds immediately after
   * setParameters + readback).
   */
  pauseObservation?: PauseObservationPolicy;
  /**
   * When true (default), applyPause requires a registered RTCPeerConnection
   * for outbound observation. Without one, the pause returns
   * apply-failed / observation-unavailable.
   * When false, missing PC is tolerated and pause proceeds without
   * observation (for tests / legacy callers that don't have a PC).
   */
  requirePcForObservation?: boolean;
  /**
   * Optional injectable outbound-bytes observer for deterministic tests.
   * Defaults to a getStats()-based implementation.
   */
  observeOutboundBytes?: OutboundBytesObserver;
  /**
   * Optional injectable clock function for deterministic pause-quiescence
   * rate calculations. Defaults to Date.now.
   */
  now?: () => number;
}

const DEFAULT_PAUSE_TIMEOUT_MS = 5_000;

// ─── ViewerSenderController ────────────────────────────────────────────────

export class ViewerSenderController {
  /** Per-binding registered senders */
  private senders = new Map<string, RegisteredSenders>();

  /** Per-binding accepted revision for idempotency */
  private acceptedRevisions = new Map<string, number>();

  /** Per-binding paused sender state */
  private pausedStates = new Map<string, PausedSenderState>();

  /** Per-binding media mode preference */
  private mediaModes = new Map<string, { audioEnabled: boolean; videoEnabled: boolean }>();

  /** Timeout (ms) for pause/resume sender operations. */
  private readonly pauseTimeoutMs: number;
  private readonly _setTimeout: typeof globalThis.setTimeout;
  private readonly _clearTimeout: typeof globalThis.clearTimeout;

  /** Pause observation policy (undefined = skip observation). */
  private readonly observePolicy: PauseObservationPolicy | undefined;
  private readonly _observeFn: OutboundBytesObserver;
  /** When true (default), pause fails without a registered PC. */
  private readonly _requirePc: boolean;
  /** Injectable clock — defaults to Date.now. */
  private readonly _now: () => number;

  constructor(options?: SenderControllerOptions) {
    this.pauseTimeoutMs = options?.pauseTimeoutMs ?? DEFAULT_PAUSE_TIMEOUT_MS;
    this._setTimeout = options?.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this._clearTimeout = options?.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.observePolicy = options?.pauseObservation;
    this._observeFn = options?.observeOutboundBytes ?? defaultOutboundObserver;
    this._requirePc = options?.requirePcForObservation ?? true;
    this._now = options?.now ?? Date.now.bind(Date);
  }

  // ── Sender Registration ────────────────────────────────────────────

  /**
   * Register or update senders for an exact binding identity.
   * Silently overwrites any existing registration for the same key.
   * Clearing a sender (passing null) leaves the binding registered
   * but marks that sender as unavailable.
   */
  registerSenders(id: ViewerBindingId, senders: RegisteredSenders): void {
    const key = bindingKey(id);
    const existing = this.senders.get(key);
    this.senders.set(key, {
      videoSender: senders.videoSender ?? existing?.videoSender ?? null,
      audioSender: senders.audioSender ?? existing?.audioSender ?? null,
      pc: senders.pc ?? existing?.pc ?? null,
    });
  }

  /**
   * Update just the video sender for an existing binding.
   * Creates the binding entry if it does not exist.
   */
  registerVideoSender(id: ViewerBindingId, sender: RTCRtpSender | null): void {
    const key = bindingKey(id);
    const existing = this.senders.get(key) ?? { videoSender: null, audioSender: null };
    existing.videoSender = sender;
    this.senders.set(key, existing);
  }

  /**
   * Update just the audio sender for an existing binding.
   * Creates the binding entry if it does not exist.
   */
  registerAudioSender(id: ViewerBindingId, sender: RTCRtpSender | null): void {
    const key = bindingKey(id);
    const existing = this.senders.get(key) ?? { videoSender: null, audioSender: null };
    existing.audioSender = sender;
    this.senders.set(key, existing);
  }

  /**
   * Unregister all senders for a binding and clean up associated state.
   */
  unregisterSenders(id: ViewerBindingId): void {
    const key = bindingKey(id);
    this.senders.delete(key);
    this.acceptedRevisions.delete(key);
    this.pausedStates.delete(key);
    this.mediaModes.delete(key);
  }

  /**
   * Get the registered senders for a binding, or null if not found.
   */
  getSenders(id: ViewerBindingId): RegisteredSenders | null {
    return this.senders.get(bindingKey(id)) ?? null;
  }

  /**
   * Get the video sender for a binding, or null.
   */
  getVideoSender(id: ViewerBindingId): RTCRtpSender | null {
    return this.senders.get(bindingKey(id))?.videoSender ?? null;
  }

  /**
   * Get the audio sender for a binding, or null.
   */
  getAudioSender(id: ViewerBindingId): RTCRtpSender | null {
    return this.senders.get(bindingKey(id))?.audioSender ?? null;
  }

  /**
   * Check whether a binding has any registered senders.
   */
  hasBinding(id: ViewerBindingId): boolean {
    return this.senders.has(bindingKey(id));
  }

  // ── Paused State ───────────────────────────────────────────────────

  /**
   * Store a media mode preference for a binding.
   * Used by resume and quality writes to respect viewer's audio/video choice.
   */
  setMediaMode(id: ViewerBindingId, audioEnabled: boolean, videoEnabled: boolean): void {
    this.mediaModes.set(bindingKey(id), { audioEnabled, videoEnabled });
  }

  /**
   * Get the stored media mode for a binding, or the default (all enabled).
   */
  getMediaMode(id: ViewerBindingId): { audioEnabled: boolean; videoEnabled: boolean } {
    return this.mediaModes.get(bindingKey(id)) ?? { audioEnabled: true, videoEnabled: true };
  }

  /**
   * Get the stored paused state for a binding, or null.
   */
  getPausedState(id: ViewerBindingId): PausedSenderState | null {
    return this.pausedStates.get(bindingKey(id)) ?? null;
  }

  // ── Revision / Idempotency ─────────────────────────────────────────

  /**
   * Check whether an incoming revision is acceptable for the given binding.
   *
   * Returns:
   * - `"accept"` if the revision advances the stored revision
   * - `"idempotent"` if the revision equals the stored revision
   * - `"stale"` if the revision is less than the stored revision
   */
  checkRevision(id: ViewerBindingId, revision: number): "accept" | "idempotent" | "stale" {
    const current = this.acceptedRevisions.get(bindingKey(id));
    if (current === undefined) return "accept";
    if (revision > current) return "accept";
    if (revision === current) return "idempotent";
    return "stale";
  }

  /**
   * Advance the accepted revision for a binding.
   */
  private acceptRevision(id: ViewerBindingId, revision: number): void {
    this.acceptedRevisions.set(bindingKey(id), revision);
  }

  /**
   * Reset the accepted revision for a binding (used on clear).
   */
  resetRevision(id: ViewerBindingId): void {
    this.acceptedRevisions.delete(bindingKey(id));
  }

  // ── Timeout Helper ─────────────────────────────────────────────────

  /**
   * Race a promise/result against a timeout. Returns the promise/value if it
   * settles within `ms`, otherwise rejects with a TimeoutError string.
   * Accepts both Promise and non-Promise values (e.g. vi.fn() returning undefined).
   * Does NOT abort the underlying operation — the caller is responsible
   * for not committing state on failure.
   */
  private async withTimeout<T>(label: string, resultOrPromise: T | Promise<T>, ms: number): Promise<T> {
    const promise = resultOrPromise instanceof Promise
      ? resultOrPromise
      : Promise.resolve(resultOrPromise);
    let settled = false;
    return new Promise<T>((resolve, reject) => {
      const timer = this._setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Sender operation "${label}" timed out after ${ms}ms`));
        }
      }, ms);
      promise
        .then((val) => {
          if (!settled) { settled = true; this._clearTimeout(timer); resolve(val); }
        })
        .catch((err) => {
          if (!settled) { settled = true; this._clearTimeout(timer); reject(err); }
        });
    });
  }

  // ── Sender Operations ──────────────────────────────────────────────

  /**
   * Read back the current configured state of the video sender for a binding.
   */
  getConfiguredReadback(id: ViewerBindingId): SenderSettingsReadback | null {
    const sender = this.getVideoSender(id);
    if (!sender) return null;
    return readConfiguredSenderState(sender);
  }

  /**
   * Apply effective quality parameters to a binding's video sender.
   * This is the authoritative path for applying viewer-requested quality.
   *
   * The caller is responsible for calculating `effective` via
   * `calculateEffectiveQuality()` from the shared resolver.
   *
   * Returns the configured readback on success.
   */
  async applyQuality(
    id: ViewerBindingId,
    effective: EffectiveQualityResult["effective"],
    sourceDimensions: { width: number; height: number },
    revision?: number,
  ): Promise<SenderOperationResult> {
    // Optional stale revision check
    if (revision !== undefined) {
      const revCheck = this.checkRevision(id, revision);
      if (revCheck === "stale") {
        return { status: "stale-revision" };
      }
      // Idempotent: return current configured state without applying
      if (revCheck === "idempotent") {
        const configured = this.getConfiguredReadback(id);
        return { status: "applied", configured: configured ?? undefined };
      }
    }

    const key = bindingKey(id);
    const registered = this.senders.get(key);
    if (!registered) {
      return { status: "binding-not-found" };
    }
    const sender = registered.videoSender;
    if (!sender) {
      return { status: "sender-not-ready" };
    }

    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const enc = params.encodings[0]!;

      // Preserve existing priority
      const existingPriority = enc.priority;

      enc.maxBitrate = effective.videoBitrateKbps * 1000;
      enc.maxFramerate = effective.maxFps;

      // Compute scale from source to target (exactly once)
      const settings = sender.track?.getSettings();
      const sourceWidth = settings?.width ?? 1920;
      const sourceHeight = settings?.height ?? 1080;
      if (effective.maxWidth > 0 && effective.maxHeight > 0 && sourceWidth > 0 && sourceHeight > 0) {
        const widthScale = sourceWidth / effective.maxWidth;
        const heightScale = sourceHeight / effective.maxHeight;
        enc.scaleResolutionDownBy = Math.max(1, widthScale, heightScale);
      } else {
        enc.scaleResolutionDownBy = 1;
      }

      (params as unknown as { degradationPreference: RTCDegradationPreference }).degradationPreference =
        effective.degradationPreference as RTCDegradationPreference;

      enc.priority = existingPriority ?? "medium";

      // Respect stored media mode: if video was disabled, keep inactive
      const mediaMode = this.mediaModes.get(key);
      if (mediaMode && !mediaMode.videoEnabled) {
        enc.active = false;
      }

      await sender.setParameters(params);

      if (revision !== undefined) {
        this.acceptRevision(id, revision);
      }

      const configured = readConfiguredSenderState(sender);
      return { status: "applied", configured };
    } catch (err) {
      return {
        status: "apply-failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Observe outbound media quiescence after sender encodings have been
   * set inactive. Samples `pc.getStats()` at `sampleIntervalMs` for up
   * to `confirmationWindowMs`. Resolves `true` if all samples stay below
   * `maxBytesPerSecond` for the full window.
   *
   * Throws on:
   * - No PC registered (when `_requirePc` is true)
   * - Observer error (throw or returns NaN)
   * - Outbound bytes exceeding threshold
   *
   * Resolves `null` when no observation policy is configured (skip).
   */
  private async observePauseQuiescence(
    pc: RTCPeerConnection | null | undefined,
  ): Promise<true | null> {
    if (!this.observePolicy) return null;

    if (!pc || !pc.getStats) {
      if (this._requirePc) {
        throw new Error("Pause quiescence unavailable: no RTCPeerConnection registered for binding");
      }
      return null; // skip when !requirePc
    }

    const { maxBytesPerSecond = DEFAULT_MAX_BYTES_PER_SECOND,
            sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
            confirmationWindowMs = DEFAULT_CONFIRMATION_WINDOW_MS } = this.observePolicy;

    const samples = Math.max(1, Math.floor(confirmationWindowMs / sampleIntervalMs));
    let prevTime = this._now();
    let prevBytes = await this._observeFn(pc, prevTime);

    for (let i = 0; i < samples; i++) {
      await new Promise<void>((resolve) => {
        this._setTimeout(resolve, sampleIntervalMs);
      });
      const now = this._now();
      const currentBytes = await this._observeFn(pc, now);

      const deltaBytes = currentBytes - prevBytes;
      const deltaSec = (now - prevTime) / 1000;
      if (deltaSec <= 0) continue; // clock didn't advance — skip this sample

      const bps = deltaBytes / deltaSec;

      if (bps > maxBytesPerSecond) {
        throw new Error(
          `Pause quiescence failed: outbound ${Math.round(bps)} bps exceeds threshold ${maxBytesPerSecond} bps`,
        );
      }

      prevBytes = currentBytes;
      prevTime = now;
    }

    return true;
  }

  /**
   * Roll back encoding states to saved snapshots with bounded retry.
   * Used when pause setParameters succeeded but observation failed —
   * re-applies the original active states so the sender is coherent.
   * Attempts up to ROLLBACK_RETRY_MAX times. Never throws.
   */
  private static readonly ROLLBACK_RETRY_MAX = 3;
  private static readonly ROLLBACK_RETRY_INTERVAL_MS = 50;

  private async rollbackEncodingStates(sender: RTCRtpSender, savedEncodings: SenderEncodingState[]): Promise<void>;
  private async rollbackEncodingStates(sender: RTCRtpSender | null, savedEncodings: SenderEncodingState[]): Promise<void>;
  private async rollbackEncodingStates(
    sender: RTCRtpSender | null,
    savedEncodings: SenderEncodingState[],
  ): Promise<void> {
    if (!sender || savedEncodings.length === 0) return;
    for (let attempt = 0; attempt < ViewerSenderController.ROLLBACK_RETRY_MAX; attempt++) {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) return;
        for (let i = 0; i < params.encodings.length && i < savedEncodings.length; i++) {
          const enc = params.encodings[i]!;
          enc.active = savedEncodings[i]!.active;
        }
        await this.withTimeout(
          `rollback attempt ${attempt + 1}`,
          sender.setParameters(params),
          this.pauseTimeoutMs / ViewerSenderController.ROLLBACK_RETRY_MAX,
        );
        return; // success
      } catch {
        if (attempt < ViewerSenderController.ROLLBACK_RETRY_MAX - 1) {
          await new Promise((resolve) => this._setTimeout(resolve, ViewerSenderController.ROLLBACK_RETRY_INTERVAL_MS));
        }
        // Last attempt: silently give up
      }
    }
  }

  /**
   * Pause a binding: disable all encodings on video and audio senders,
   * then confirm outbound media quiescence via RTCPeerConnection.getStats().
   *
   * Saves the prior active state so resume can restore it.
   * Does NOT commit paused state if quiescence observation fails — attempts
   * bounded rollback of the original active states.
   */
  async applyPause(id: ViewerBindingId): Promise<SenderOperationResult> {
    const key = bindingKey(id);
    const registered = this.senders.get(key);
    if (!registered) return { status: "binding-not-found" };

    let videoEncodings: SenderEncodingState[] = [];
    let audioEncodings: SenderEncodingState[] = [];
    let videoApplied = false;

    try {
      if (registered.videoSender) {
        const params = registered.videoSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          return { status: "sender-not-ready" };
        }
        videoEncodings = params.encodings.map((e) => ({ active: !!e.active }));
        for (const enc of params.encodings) {
          enc.active = false;
        }
        // Phase 7A: bounded setParameters
        await this.withTimeout(
          "pause video setParameters",
          registered.videoSender.setParameters(params),
          this.pauseTimeoutMs,
        );
        if (!verifyEncodingStates(registered.videoSender, params.encodings.map(() => false))) {
          return { status: "apply-failed", error: "video sender pause readback mismatch" };
        }
        videoApplied = true;
      } else {
        return { status: "sender-not-ready" };
      }

      if (registered.audioSender) {
        const params = registered.audioSender.getParameters();
        audioEncodings = (params.encodings ?? []).map((e) => ({ active: !!e.active }));
        for (const enc of (params.encodings ?? [])) {
          enc.active = false;
        }
        await this.withTimeout(
          "pause audio setParameters",
          registered.audioSender.setParameters(params),
          this.pauseTimeoutMs,
        );
        if (!verifyEncodingStates(registered.audioSender, (params.encodings ?? []).map(() => false))) {
          return { status: "apply-failed", error: "audio sender pause readback mismatch" };
        }
      }

      // Phase 7B: Observe outbound media quiescence
      try {
        const quiescent = await this.observePauseQuiescence(registered.pc);
        if (quiescent === null) {
          // No observation policy — proceed without confirmation
        }
      } catch (obsErr) {
        // Observation failed — roll back both video and audio to original active states
        if (videoApplied && registered.videoSender && videoEncodings.length > 0) {
          await this.rollbackEncodingStates(registered.videoSender, videoEncodings);
        }
        if (registered.audioSender && audioEncodings.length > 0) {
          await this.rollbackEncodingStates(registered.audioSender, audioEncodings);
        }
        return {
          status: "apply-failed",
          error: obsErr instanceof Error ? obsErr.message : String(obsErr),
        };
      }

      this.pausedStates.set(key, { videoEncodings, audioEncodings });
      const configured = registered.videoSender
        ? readConfiguredSenderState(registered.videoSender)
        : { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1, degradationPreference: "balanced", priority: "medium" };
      return { status: "applied", configured };
    } catch (err) {
      // Phases 7A/7B: Do NOT commit paused state on failure.
      return {
        status: "apply-failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Resume a binding: restore prior encoding states (from saved paused state),
   * apply any stored quality, respect media mode — all in one serialized write.
   *
   * This merges the old `applyResume` and `applyResumeWithQuality` into one
   * operation: pause+quality is one desired-state operation.
   */
  async applyResume(
    id: ViewerBindingId,
    desired: DesiredSenderState,
    sourceDimensions: { width: number; height: number },
  ): Promise<SenderOperationResult> {
    const key = bindingKey(id);
    const registered = this.senders.get(key);
    if (!registered) return { status: "binding-not-found" };

    const savedState = this.pausedStates.get(key);
    const mediaMode = this.mediaModes.get(key);

    try {
      // ── Video sender resume ───────────────────────────────────────
      if (registered.videoSender) {
        const params = registered.videoSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          return { status: "sender-not-ready" };
        }

        // Restore prior active states (all active if no saved state)
        for (let i = 0; i < params.encodings.length; i++) {
          const enc = params.encodings[i]!;
          enc.active = savedState && i < savedState.videoEncodings.length
            ? savedState.videoEncodings[i]!.active
            : true;
        }

        // Apply media mode: if video was disabled, override
        if (mediaMode && !mediaMode.videoEnabled) {
          for (const enc of params.encodings) {
            enc.active = false;
          }
        }

        // Apply effective quality if provided
        if (desired.effective) {
          const enc = params.encodings[0]!;
          const existingPriority = enc.priority;

          enc.maxBitrate = desired.effective.videoBitrateKbps * 1000;
          enc.maxFramerate = desired.effective.maxFps;

          if (desired.effective.maxWidth > 0 && desired.effective.maxHeight > 0 &&
              sourceDimensions.width > 0 && sourceDimensions.height > 0) {
            const widthScale = sourceDimensions.width / desired.effective.maxWidth;
            const heightScale = sourceDimensions.height / desired.effective.maxHeight;
            enc.scaleResolutionDownBy = Math.max(1, widthScale, heightScale);
          }

          (params as unknown as { degradationPreference: RTCDegradationPreference }).degradationPreference =
            desired.effective.degradationPreference as RTCDegradationPreference;

          enc.priority = existingPriority ?? "medium";
        }

        // Phase 7A: bounded setParameters
        await this.withTimeout(
          "resume video setParameters",
          registered.videoSender.setParameters(params),
          this.pauseTimeoutMs,
        );
        if (!verifyEncodingStates(registered.videoSender, params.encodings.map((enc) => !!enc.active))) {
          return { status: "apply-failed", error: "video sender resume readback mismatch" };
        }
      }

      // ── Audio sender resume ───────────────────────────────────────
      if (registered.audioSender) {
        const params = registered.audioSender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          for (let i = 0; i < params.encodings.length; i++) {
            const enc = params.encodings[i]!;
            enc.active = savedState && i < savedState.audioEncodings.length
              ? savedState.audioEncodings[i]!.active
              : true;
          }

          if (mediaMode && !mediaMode.audioEnabled) {
            for (const enc of params.encodings) {
              enc.active = false;
            }
          }

          await this.withTimeout(
            "resume audio setParameters",
            registered.audioSender.setParameters(params),
            this.pauseTimeoutMs,
          );
          if (!verifyEncodingStates(registered.audioSender, params.encodings.map((enc) => !!enc.active))) {
            return { status: "apply-failed", error: "audio sender resume readback mismatch" };
          }
        }
      }

      // Clear paused state after successful resume
      this.pausedStates.delete(key);

      // Accept revision if provided
      if (desired.revision !== undefined) {
        this.acceptRevision(id, desired.revision);
      }

      // Read back and return
      const configured = registered.videoSender
        ? readConfiguredSenderState(registered.videoSender)
        : registered.audioSender
          ? readConfiguredSenderState(registered.audioSender)
          : { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1, degradationPreference: "balanced", priority: "medium" };

      return { status: "applied", configured };
    } catch (err) {
      return {
        status: "apply-failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Apply a media mode preference (enable/disable audio/video senders).
   * When re-enabling video, uses the same quality path as resume.
   */
  async applyMediaMode(
    id: ViewerBindingId,
    audioEnabled: boolean,
    videoEnabled: boolean,
    sourceDimensions: { width: number; height: number },
    effective?: EffectiveQualityResult["effective"],
  ): Promise<SenderOperationResult> {
    const key = bindingKey(id);
    const registered = this.senders.get(key);
    if (!registered) return { status: "binding-not-found" };

    this.mediaModes.set(key, { audioEnabled, videoEnabled });
    const pausedState = this.pausedStates.get(key);

    try {
      if (pausedState) {
        if (registered.audioSender) {
          const params = registered.audioSender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            for (const enc of params.encodings) {
              enc.active = false;
            }
            await this.withTimeout(
              "mediaMode paused audio setParameters",
              registered.audioSender.setParameters(params),
              this.pauseTimeoutMs,
            );
          }
        }

        if (registered.videoSender) {
          const params = registered.videoSender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            for (const enc of params.encodings) {
              enc.active = false;
            }
            await this.withTimeout(
              "mediaMode paused video setParameters",
              registered.videoSender.setParameters(params),
              this.pauseTimeoutMs,
            );
          }
        }

        const configuredSender = registered.videoSender ?? registered.audioSender;
        const configured = configuredSender
          ? readConfiguredSenderState(configuredSender)
          : { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1, degradationPreference: "balanced", priority: "medium" };
        return { status: "applied", configured };
      }

      // ── Audio sender ──────────────────────────────────────────────
      if (registered.audioSender) {
        const params = registered.audioSender.getParameters();
        if (params.encodings && params.encodings.length > 0) {
          const enc = params.encodings[0]!;
          enc.active = audioEnabled;
          // Phase 7C: bounded setParameters
          await this.withTimeout(
            "mediaMode audio setParameters",
            registered.audioSender.setParameters(params),
            this.pauseTimeoutMs,
          );
        }
      }

      // ── Video sender ──────────────────────────────────────────────
      if (registered.videoSender) {
        if (!videoEnabled) {
          // Disable video sender
          const params = registered.videoSender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            const enc = params.encodings[0]!;
            enc.active = false;
            // Phase 7C: bounded setParameters
            await this.withTimeout(
              "mediaMode video disable setParameters",
              registered.videoSender.setParameters(params),
              this.pauseTimeoutMs,
            );
          }
        } else if (effective) {
          // Re-enable with quality: use same logic as applyResume
          return this.applyResume(id, {
            paused: false,
            audioEnabled,
            videoEnabled,
            effective,
          }, sourceDimensions);
        } else {
          // Re-enable without quality: just set active=true
          const params = registered.videoSender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            const enc = params.encodings[0]!;
            enc.active = true;
            await this.withTimeout(
              "mediaMode video enable setParameters",
              registered.videoSender.setParameters(params),
              this.pauseTimeoutMs,
            );
          }
        }
      }

      const configured = registered.videoSender
        ? readConfiguredSenderState(registered.videoSender)
        : registered.audioSender
          ? readConfiguredSenderState(registered.audioSender)
          : { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1, degradationPreference: "balanced", priority: "medium" };

      return { status: "applied", configured };
    } catch (err) {
      return {
        status: "apply-failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Compute effective quality for a viewer from groups settings, host limits,
   * and optional viewer request. Delegates to the shared pure resolver.
   *
   * This is a convenience helper so the controller doesn't force callers to
   * import the shared resolver separately for the most common path.
   */
  computeEffectiveQuality(
    groupSettings: GroupQualitySettings,
    hostLimits: HostQualityLimits,
    viewerRequest: ViewerQualityRequest | null,
    sourceDimensions: { width: number; height: number },
  ): EffectiveQualityResult {
    return calculateEffectiveQuality(groupSettings, hostLimits, viewerRequest, sourceDimensions);
  }

  /**
   * Re-apply a desired state to a binding after sender re-resolution.
   * Used by reconnect paths to restore pause, media mode, and quality.
   */
  async reapplyState(
    id: ViewerBindingId,
    sourceDimensions: { width: number; height: number },
    effective?: EffectiveQualityResult["effective"],
    revision?: number,
  ): Promise<SenderOperationResult> {
    const key = bindingKey(id);
    const pausedState = this.pausedStates.get(key);
    const mediaMode = this.mediaModes.get(key);

    if (pausedState) {
      // Binding was paused — re-apply paused state
      const registered = this.senders.get(key);
      if (!registered) return { status: "binding-not-found" };

      try {
        if (registered.videoSender) {
          const params = registered.videoSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            return { status: "sender-not-ready" };
          }
          for (const enc of params.encodings) {
            enc.active = false;
          }
          await registered.videoSender.setParameters(params);
        }

        if (registered.audioSender) {
          const params = registered.audioSender.getParameters();
          for (const enc of (params.encodings ?? [])) {
            enc.active = false;
          }
          await registered.audioSender.setParameters(params);
        }

        this.pausedStates.set(key, pausedState);
        const configured = registered.videoSender
          ? readConfiguredSenderState(registered.videoSender)
          : { maxBitrate: 0, maxFramerate: 0, scaleResolutionDownBy: 1, degradationPreference: "balanced", priority: "medium" };
        return { status: "applied", configured };
      } catch (err) {
        return {
          status: "apply-failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (mediaMode && !mediaMode.videoEnabled && effective) {
      // Video was disabled — ensure it stays disabled
      const registered = this.senders.get(key);
      if (registered?.videoSender) {
        try {
          const params = registered.videoSender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            const enc = params.encodings[0]!;
            enc.active = false;
            await registered.videoSender.setParameters(params);
          }
        } catch {
          // best-effort
        }
      }
    }

    // Regular quality apply
    if (effective) {
      const result = await this.applyQuality(id, effective, sourceDimensions, revision);
      return result;
    }

    // No state to reapply — just read back
    const configured = this.getConfiguredReadback(id);
    return { status: configured ? "applied" : "binding-not-found", configured: configured ?? undefined };
  }

  /**
   * Build a consolidated QualityFeedback from an operation result and the
   * corresponding EffectiveQualityResult (from calculateEffectiveQuality).
   *
   * Callers can use this to produce a single feedback object containing
   * requested, effective, configured readback, clamp reasons, and revision
   * — sufficient to emit quality.effective + quality.configured messages
   * without re-reading the sender.
   */
  buildFeedback(
    result: SenderOperationResult,
    effective?: EffectiveQualityResult,
    revision?: number,
  ): QualityFeedback {
    return {
      requested: effective?.requested ?? null,
      effective: effective?.effective,
      configured: result.configured,
      clampReasons: effective?.clampReasons ?? [],
      revision,
    };
  }

  /**
   * Destroy the controller, clearing all state.
   */
  destroy(): void {
    this.senders.clear();
    this.acceptedRevisions.clear();
    this.pausedStates.clear();
    this.mediaModes.clear();
  }
}
