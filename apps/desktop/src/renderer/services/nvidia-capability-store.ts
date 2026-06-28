/**
 * nvidia-capability-store.ts
 *
 * External store for NVIDIA RTX VSR capability state.
 * Uses the "external store" pattern for useSyncExternalStore in React.
 *
 * - getSnapshot() — returns current capability state
 * - subscribe() — registers a change listener
 * - probe() — async probe via IPC/helper
 * - invalidate() — resets cached state for re-probe
 */

export type CapabilityReason =
  | "unsupported-os"
  | "unsupported-architecture"
  | "not-nvidia"
  | "unsupported-gpu"
  | "driver-too-old"
  | "helper-missing"
  | "helper-failed"
  | "sdk-not-built"
  | "runtime-missing"
  | "model-missing"
  | "effect-creation-failed"
  | "incompatible-runtime";

export interface NvidiaCapabilityState {
  available: boolean;
  reason: CapabilityReason;
  adapterName: string | null;
  driverVersion: string | null;
  supportedModes: string[];
  supportedQualities: string[];
  probing: boolean;
  probed: boolean;
}

// ─── Store ────────────────────────────────────────────────────────────────

let state: NvidiaCapabilityState = {
  available: false,
  reason: "sdk-not-built",
  adapterName: null,
  driverVersion: null,
  supportedModes: [],
  supportedQualities: [],
  probing: false,
  probed: false,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

// ─── Public API ────────────────────────────────────────────────────────────

export function getNvidiaCapabilitySnapshot(): NvidiaCapabilityState {
  return state;
}

export function subscribeToNvidiaCapability(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export async function probeNvidiaCapability(): Promise<NvidiaCapabilityState> {
  if (state.probing) return state;
  state = { ...state, probing: true };
  notify();

  try {
    const api = (window as unknown as {
      screenlink?: { probeNvidiaVsrCapability?: () => Promise<{ available: boolean; reason: string; adapterName?: string; driverVersion?: string; supportedModes?: string; supportedQualities?: string }> }
    }).screenlink;

    if (!api?.probeNvidiaVsrCapability) {
      state = { ...state, available: false, reason: "helper-missing", probing: false, probed: true };
      notify();
      return state;
    }

    const result = await api.probeNvidiaVsrCapability();
    state = {
      available: result.available,
      reason: (result.reason as CapabilityReason) || "helper-missing",
      adapterName: result.adapterName ?? null,
      driverVersion: result.driverVersion ?? null,
      supportedModes: result.supportedModes ? result.supportedModes.split(",").map(s => s.trim()) : [],
      supportedQualities: result.supportedQualities ? result.supportedQualities.split(",").map(s => s.trim()) : [],
      probing: false,
      probed: true,
    };
  } catch {
    state = { ...state, probing: false, probed: true };
  }

  notify();
  return state;
}

export function invalidateNvidiaCapability(): void {
  state = {
    available: false,
    reason: "sdk-not-built",
    adapterName: null,
    driverVersion: null,
    supportedModes: [],
    supportedQualities: [],
    probing: false,
    probed: false,
  };
  notify();
}
