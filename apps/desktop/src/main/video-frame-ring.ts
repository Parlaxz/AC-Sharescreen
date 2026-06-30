/**
 * video-frame-ring — Main-side TypeScript integration for the native
 * Win32 named file-mapping ring buffer addon.
 *
 * This module wraps the native @screenlink/video-frame-ring addon and
 * provides a typed API for creating/opening/managing named file-mapping
 * ring buffers with a fixed three-slot layout (Input A, Input B, Output).
 *
 * Ownership: narrow — no CUDA, no UI, no enhancement policy.
 * This slice owns: native addon loading, mapping lifecycle, slot access.
 */

import { createRequire } from "node:module";
import path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

export const FRAME_RING_PROTOCOL_VERSION = "1.0.0";
export const SLOT_COUNT = 3;
export const SLOT_INPUT_A = 0;
export const SLOT_INPUT_B = 1;
export const SLOT_OUTPUT = 2;
export const DEFAULT_SLOT_PAYLOAD_SIZE = 4 * 1024 * 1024; // 4 MiB

// ─── Error codes (mirrors native FrameRingErrorCode) ─────────────────────────

export enum FrameRingErrorCode {
  None = 0,
  InvalidArgument = 1,
  MappingFailed = 2,
  ViewFailed = 3,
  SlotOverflow = 4,
  SessionMismatch = 5,
  NotInitialized = 6,
  AlreadyInitialized = 7,
  EventFailed = 8,
  SessionGuidFailed = 9,
}

// ─── Error class ─────────────────────────────────────────────────────────────

export class FrameRingError extends Error {
  public readonly code: FrameRingErrorCode;

  constructor(message: string, code: FrameRingErrorCode) {
    super(message);
    this.name = "FrameRingError";
    this.code = code;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FrameRingCreateResult {
  /** The random per-session mapping name (without "Local\\" prefix). */
  name: string;
  /** Hex-encoded session GUID (32 hex chars). */
  sessionGuid: string;
  /** Number of slots (always 3). */
  slotCount: number;
  /** Per-slot payload capacity in bytes. */
  slotPayloadSize: number;
}

export interface FrameRingCreateOptions {
  /** Per-slot payload size in bytes (default: 4 MiB). */
  slotPayloadSize?: number;
  /**
   * Optional explicit mapping name. If omitted, a random GUID-based name
   * is generated (recommended for session isolation).
   */
  mappingName?: string;
}

// ─── Native addon interface (from .node addon) ────────────────────────────────

interface NativeFrameRing {
  new (): NativeFrameRingInstance;
}

interface NativeFrameRingInstance {
  /** Create a new mapping with optional slot payload size. */
  create(slotPayloadSize?: number): FrameRingCreateResult;
  /** Open an existing mapping by name + session GUID. */
  open(mappingName: string, sessionGuid: string): void;
  /** Close/unmap all handles. */
  close(): void;
  /** Get a shared-memory Buffer view into a slot's payload region. */
  getSlotBuffer(slotIndex: number): Buffer | null;
  /** Copy data into a slot. Returns bytes written. */
  copyToSlot(slotIndex: number, data: Buffer | Uint8Array): number;
  /** Read a COPY of the output slot data (safe — returns new Buffer). */
  readOutputSlot(): Buffer | null;
  /** Mark a slot as having a frame ready for consumers. */
  setFrameReady(slotIndex: number): void;
  /** Validate all slots have matching version/magic/session. */
  validateAllSlots(): boolean;
  /** Check if the mapping is open and valid. */
  isValid(): boolean;
  /** Mapping name (without prefix). */
  readonly name: string;
  /** Number of slots (always 3). */
  readonly slotCount: number;
  /** Per-slot payload size. */
  readonly slotPayloadSize: number;
  /** Session GUID as hex string, or null if not initialized. */
  readonly sessionGuid: string | null;
}

// ─── Module-level state ──────────────────────────────────────────────────────

let nativeAddonModule: { FrameRing: NativeFrameRing } | null = null;
let addonLoadAttempted = false;

// ─── Addon path resolution ───────────────────────────────────────────────────

/**
 * Resolve the path to the native video-frame-ring addon.
 * In development, looks in the native build output directory.
 * In packaged apps, looks in the extraResources directory.
 */
function resolveAddonPath(): string {
  // Check for the module path from cmake-js convention
  // For dev: native/video-frame-ring/build/Release/screenlink-video-frame-ring.node
  const candidates = [
    // Development path (cmake-js standard)
    path.resolve(
      __dirname, "..", "..", "..", "..",
      "native", "video-frame-ring",
      "build", "Release",
      "screenlink-video-frame-ring.node",
    ),
    // Development path (direct)
    path.resolve(
      process.cwd(),
      "native", "video-frame-ring",
      "build", "Release",
      "screenlink-video-frame-ring.node",
    ),
  ];

  // In a packaged app, check extraResources
  try {
    const { app } = require("electron") as typeof import("electron");
    if (app.isPackaged) {
      candidates.unshift(
        path.join(process.resourcesPath, "screenlink-video-frame-ring.node"),
      );
    }
  } catch {
    // Not in Electron context — fall through to dev paths
  }

  for (const candidate of candidates) {
    try {
      require("fs").accessSync(candidate);
      return candidate;
    } catch {
      // Try next candidate
    }
  }

  // Return default dev path (caller will handle load failure)
  return candidates[0]!;
}

// ─── Lazy addon loader ───────────────────────────────────────────────────────

/**
 * Load the native addon. Must be called from the Electron main process
 * (Node.js context with native module support).
 */
function loadNativeAddon(): { FrameRing: NativeFrameRing } {
  if (nativeAddonModule) return nativeAddonModule;
  if (addonLoadAttempted) {
    throw new FrameRingError(
      "Native addon previously failed to load",
      FrameRingErrorCode.MappingFailed,
    );
  }

  addonLoadAttempted = true;
  const addonPath = resolveAddonPath();

  try {
    const require = createRequire(import.meta.url);
    nativeAddonModule = require(addonPath) as { FrameRing: NativeFrameRing };
    return nativeAddonModule;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new FrameRingError(
      `Failed to load native addon: ${message}`,
      FrameRingErrorCode.MappingFailed,
    );
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Create a new named file-mapping ring buffer.
 * Generates a random per-session mapping name if not provided.
 *
 * @returns The created mapping name and session details.
 * @throws {FrameRingError} on failure.
 */
export function createFrameRing(
  options?: FrameRingCreateOptions,
): FrameRingCreateResult {
  const addon = loadNativeAddon();
  const ring = new addon.FrameRing();

  try {
    const result = ring.create(options?.slotPayloadSize ?? DEFAULT_SLOT_PAYLOAD_SIZE);
    return result;
  } catch (err: unknown) {
    ring.close();

    if (err instanceof FrameRingError) throw err;

    const napiErr = err as { message?: string; code?: number };
    const message = napiErr.message ?? "Unknown error";
    const code: FrameRingErrorCode =
      typeof napiErr.code === "number"
        ? (napiErr.code as FrameRingErrorCode)
        : FrameRingErrorCode.MappingFailed;

    // Wrap N-API errors into our typed error
    const wrapped = new FrameRingError(message, code);
    // Re-throw with our error name so callers can catch by type
    wrapped.stack = err instanceof Error ? err.stack : undefined;
    throw wrapped;
  }
}

export interface FrameRingMapping {
  /** Mapping name (without "Local\\" prefix). */
  readonly name: string;
  /** Hex-encoded session GUID. */
  readonly sessionGuid: string | null;
  /** Per-slot payload capacity in bytes. */
  readonly slotPayloadSize: number;

  /** Open an existing mapping (for the consumer/host side). */
  open(mappingName: string, sessionGuid: string): void;
  /** Close all handles. Safe to call multiple times. */
  close(): void;

  /** Get a shared-memory Buffer view into a slot's payload. */
  getSlotBuffer(slotIndex: number): Buffer | null;
  /** Copy input data into a slot. Returns bytes written. */
  copyToSlot(slotIndex: number, data: Buffer | Uint8Array): number;
  /** Read a copy of the output slot's valid data. */
  readOutputSlot(): Buffer | null;
  /** Mark a slot's frame as ready. */
  setFrameReady(slotIndex: number): void;
  /** Validate all slots have matching version/magic/session. */
  validateAllSlots(): boolean;
  /** Whether the mapping is open and valid. */
  isValid(): boolean;
}

/**
 * Thin wrapper holding a native FrameRing instance.
 */
export class VideoFrameRing implements FrameRingMapping {
  private readonly _native: NativeFrameRingInstance;

  constructor() {
    const addon = loadNativeAddon();
    this._native = new addon.FrameRing();
  }

  get name(): string {
    return this._native.name;
  }

  get sessionGuid(): string | null {
    return this._native.sessionGuid;
  }

  get slotPayloadSize(): number {
    return this._native.slotPayloadSize;
  }

  get slotCount(): number {
    return this._native.slotCount;
  }

  /** @inheritdoc */
  open(mappingName: string, sessionGuid: string): void {
    try {
      this._native.open(mappingName, sessionGuid);
    } catch (err: unknown) {
      this._wrapAndThrow(err);
    }
  }

  /** @inheritdoc */
  close(): void {
    try {
      this._native.close();
    } catch {
      // Swallow errors on close — best effort cleanup
    }
  }

  /** @inheritdoc */
  getSlotBuffer(slotIndex: number): Buffer | null {
    try {
      return this._native.getSlotBuffer(slotIndex);
    } catch (err: unknown) {
      this._wrapAndThrow(err);
    }
  }

  /** @inheritdoc */
  copyToSlot(slotIndex: number, data: Buffer | Uint8Array): number {
    try {
      return this._native.copyToSlot(slotIndex, data as Buffer);
    } catch (err: unknown) {
      this._wrapAndThrow(err);
    }
  }

  /** @inheritdoc */
  readOutputSlot(): Buffer | null {
    try {
      return this._native.readOutputSlot();
    } catch (err: unknown) {
      this._wrapAndThrow(err);
    }
  }

  /** @inheritdoc */
  setFrameReady(slotIndex: number): void {
    try {
      this._native.setFrameReady(slotIndex);
    } catch (err: unknown) {
      this._wrapAndThrow(err);
    }
  }

  /** @inheritdoc */
  validateAllSlots(): boolean {
    try {
      return this._native.validateAllSlots();
    } catch {
      return false;
    }
  }

  /** @inheritdoc */
  isValid(): boolean {
    try {
      return this._native.isValid();
    } catch {
      return false;
    }
  }

  /**
   * Clean up. Call when shutting down to ensure handles are released.
   */
  [Symbol.dispose](): void {
    this.close();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _wrapAndThrow(err: unknown): never {
    if (err instanceof FrameRingError) throw err;
    const napiErr = err as { message?: string; code?: number };
    const message = napiErr.message ?? "Unknown error";
    const code: FrameRingErrorCode =
      typeof napiErr.code === "number"
        ? (napiErr.code as FrameRingErrorCode)
        : FrameRingErrorCode.NotInitialized;

    const wrapped = new FrameRingError(message, code);
    wrapped.stack = err instanceof Error ? err.stack : undefined;
    throw wrapped;
  }
}
