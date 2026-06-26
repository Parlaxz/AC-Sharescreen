/**
 * SDK event-shape normalization helpers.
 *
 * The installed `@vdoninja/sdk` 1.3.18 emits events as Event objects whose
 * payload lives inside `event.detail`. Callers that bind via `sdk.on(...)`
 * (or `addEventListener`) therefore receive `(event)` with the payload
 * fields under `event.detail`. The data channel events use the shape
 * `{ data, uuid, streamID }`; peer connection events use `{ uuid, connection }`.
 *
 * The renderer's narrow SDK alias must extract those fields without ever
 * letting `String(event)` produce the unhelpful literal `[object Object]`.
 *
 * Helpers here are pure and tested in isolation.
 */

/** Shape of the detail object emitted for `peerConnected` / `peerDisconnected`. */
export interface PeerEventDetail {
  uuid?: unknown;
  connection?: unknown;
  [key: string]: unknown;
}

/** Shape of the detail object emitted for `dataReceived`. */
export interface DataEventDetail {
  data?: unknown;
  uuid?: unknown;
  streamID?: unknown;
  [key: string]: unknown;
}

/**
 * Result of extracting a peer UUID from a raw SDK event argument.
 * The raw argument can be a string UUID (rare), an Event object whose
 * detail.uuid is the UUID, or any other value (which we reject).
 */
export interface ExtractedPeerUuid {
  uuid: string | null;
  /** True when the input was recognized as carrying a UUID. */
  valid: boolean;
  /** True when the input was an event object with a malformed UUID. */
  malformed: boolean;
}

/**
 * Coerce a raw value into a non-empty trimmed string.
 * Returns null for non-string values or empty/whitespace-only strings.
 */
function coerceUuidString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "[object Object]") return null;
  return trimmed;
}

/**
 * Extract a peer UUID from the first argument that the SDK passes to
 * peer-related event listeners.
 *
 * Accepts:
 *   - a direct string UUID (legacy test mocks)
 *   - an Event object whose `detail.uuid` is the UUID
 *   - a plain object whose `uuid` is the UUID
 *
 * Rejects:
 *   - `[object Object]` (would be produced by `String(eventObject)`)
 *   - empty or whitespace-only strings
 *   - anything else not matching the recognized shapes
 */
export function extractPeerUuid(raw: unknown): ExtractedPeerUuid {
  // 1) Direct string UUID (test mocks, defensive case)
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && trimmed !== "[object Object]") {
      return { uuid: trimmed, valid: true, malformed: false };
    }
    return { uuid: null, valid: false, malformed: true };
  }

  // 2) Event object or detail-like object
  if (raw && typeof raw === "object") {
    // 2a) CustomEvent / Event shapes carry the payload under `.detail`
    const detail = (raw as { detail?: unknown }).detail;
    if (detail && typeof detail === "object") {
      const uuid = coerceUuidString((detail as PeerEventDetail).uuid);
      if (uuid) return { uuid, valid: true, malformed: false };
    }
    // 2b) Plain object exposing `.uuid` directly
    const direct = coerceUuidString((raw as PeerEventDetail).uuid);
    if (direct) return { uuid: direct, valid: true, malformed: false };
  }

  return { uuid: null, valid: false, malformed: true };
}

/**
 * Extract the data and sender UUID from a data channel event.
 *
 * The SDK emits `dataReceived` with the full envelope under `event.detail.data`
 * and the sender's UUID under `event.detail.uuid`.
 *
 * Returns `data === null` AND `uuid === null` when the event cannot be
 * normalized; callers must treat that case as a drop, not a UUID `[object Object]`.
 */
export function extractDataAndUuid(
  dataArg: unknown,
  peerArg: unknown,
): { data: unknown; uuid: string | null; malformed: boolean } {
  // The SDK calls listeners with a single Event whose detail is { data, uuid, ... }
  if (dataArg && typeof dataArg === "object" && "detail" in (dataArg as object)) {
    const detail = (dataArg as { detail?: DataEventDetail }).detail;
    if (detail && typeof detail === "object") {
      const data = (detail as DataEventDetail).data;
      const uuidResult = extractPeerUuid(detail);
      if (uuidResult.valid) {
        return { data, uuid: uuidResult.uuid, malformed: false };
      }
    }
    return { data: null, uuid: null, malformed: true };
  }

  // Legacy 2-arg callback shape: (data, peerUuid)
  if (peerArg !== undefined) {
    const uuidResult = extractPeerUuid(peerArg);
    if (uuidResult.valid) {
      return { data: dataArg, uuid: uuidResult.uuid, malformed: false };
    }
    return { data: null, uuid: null, malformed: true };
  }

  // Single-arg object with data + uuid directly
  if (dataArg && typeof dataArg === "object") {
    const obj = dataArg as DataEventDetail;
    const uuidResult = extractPeerUuid(obj);
    if (uuidResult.valid) {
      return { data: (obj as DataEventDetail).data ?? obj, uuid: uuidResult.uuid, malformed: false };
    }
  }

  return { data: null, uuid: null, malformed: true };
}
