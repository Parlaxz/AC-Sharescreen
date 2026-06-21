import { desktopCapturer } from "electron";

export interface CaptureSourceDTO {
  id: string;
  name: string;
  displayId: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

/**
 * Enumerate available screen and window capture sources.
 * Returns DTOs safe to send over IPC (no native objects).
 */
export async function enumerateSources(): Promise<CaptureSourceDTO[]> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    kind: source.id.startsWith("screen:") ? "screen" : "window",
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    appIconDataUrl: source.appIcon?.toDataURL() ?? null,
  }));
}

// ── Source Fingerprinting ──────────────────────────────────────────────────

export interface SourceFingerprint {
  kind: "screen" | "window";
  sourceId: string;
  displayId: string;
  name: string;
  bounds?: { x: number; y: number; width: number; height: number };
  size?: { width: number; height: number };
  scaleFactor?: number;
  isPrimary?: boolean;
  appName?: string; // for windows
}

export function getSourceFingerprint(source: {
  id: string;
  name: string;
  displayId: string;
}): SourceFingerprint {
  const isScreen = source.id.startsWith("screen:");
  return {
    kind: isScreen ? "screen" : "window",
    sourceId: source.id,
    displayId: source.displayId,
    name: source.name,
  };
}

export function matchSourceByFingerprint(
  fingerprint: SourceFingerprint,
  currentSources: Array<{ id: string; name: string; displayId: string }>,
): { id: string; exactMatch: boolean } | null {
  // First try exact ID match
  const exact = currentSources.find(s => s.id === fingerprint.sourceId);
  if (exact) return { id: exact.id, exactMatch: true };

  // For screens, require exactly one unique displayId match
  if (fingerprint.kind === "screen") {
    const displayMatches = currentSources.filter(
      s => s.displayId === fingerprint.displayId && s.id.startsWith("screen:")
    );
    if (displayMatches.length === 1) {
      return { id: displayMatches[0]!.id, exactMatch: false };
    }
    // Zero or multiple matches — ambiguous, require manual selection
    return null;
  }

  // For windows, do NOT match by name alone — too error-prone.
  // Window matching requires native HWND/PID resolution (Phase 2A).
  return null;
}
