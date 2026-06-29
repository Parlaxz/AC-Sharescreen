export * from "./errors.js";
export * from "./ids.js";
export * from "./schemas.js";
export * from "./presets.js";
// Re-export value exports from control-protocol.js (avoiding names that
// conflict with the newer control-messages.js protocol definitions)
export {
  CONTROL_MESSAGE_TYPES,
  MAX_CONTROL_PAYLOAD_SIZE,
  QUALITY_REQUEST_INTERVAL_MS,
  QUALITY_REQUEST_MAX_PER_MINUTE,
  GLOBAL_REQUEST_INTERVAL_MS,
  ViewerHelloPayloadSchema,
  HostHelloPayloadSchema,
  QualityCurrentPayloadSchema,
  QualityAppliedPayloadSchema,
  QualityRejectedPayloadSchema,
  PolicyUpdatedPayloadSchema,
  GlobalChangeStartedPayloadSchema,
  GlobalChangeCompletedPayloadSchema,
  GlobalChangeFailedPayloadSchema,
  HostStoppingPayloadSchema,
  PingPayloadSchema,
  PongPayloadSchema,
  validateControlPayload,
} from "./control-protocol.js";
export type {
  ViewerHelloPayload,
  HostHelloPayload,
  QualityRequestPayload,
  QualityCurrentPayload,
  QualityAppliedPayload,
  QualityRejectedPayload,
  PolicyUpdatedPayload,
  GlobalChangeStartedPayload,
  GlobalChangeCompletedPayload,
  GlobalChangeFailedPayload,
  HostStoppingPayload,
  PingPayload,
  PongPayload,
  ViewerHelloPayloadParsed,
  HostHelloPayloadParsed,
  QualityRequestPayloadParsed,
  QualityCurrentPayloadParsed,
  QualityAppliedPayloadParsed,
  QualityRejectedPayloadParsed,
  PolicyUpdatedPayloadParsed,
  GlobalChangeStartedPayloadParsed,
  GlobalChangeCompletedPayloadParsed,
  GlobalChangeFailedPayloadParsed,
  HostStoppingPayloadParsed,
  PingPayloadParsed,
  PongPayloadParsed,
  ControlEnvelopeParsed,
} from "./control-protocol.js";
export * from "./urls.js";
export * from "./bitrate.js";
export * from "./stats.js";
export * from "./settings.js";
export * from "./audio-capabilities.js";
export * from "./control-messages.js";

// ── Phase 3: Group / Quality / Sync ────────────────────────────────────────

// device-identity.js exports getDefaultDevDisplayName (used by main process for dev profiles)
export {
  DeviceIdentitySchema,
  generateDeviceIdentity,
  updateDeviceDisplayName,
  getDefaultDevDisplayName,
} from "./device-identity.js";
export type {
  DeviceIdentity,
} from "./device-identity.js";

export * from "./hybrid-logical-clock.js";
export * from "./quality-settings.js";
export * from "./group-link.js";
export * from "./groups.js";
export * from "./quality-presets.js";
export * from "./group-sync.js";

// group-control-messages.js uses selective re-exports to avoid name conflicts
// with control-messages.js (DEDUP_WINDOW_MS, buildEnvelope).
export {
  GROUP_PROTOCOL_VERSION,
  GROUP_CONTROL_MESSAGE_TYPES,
  MAX_GROUP_CONTROL_PAYLOAD_BYTES,
  DEDUP_WINDOW_MS,
  DEDUP_MAX_ENTRIES,
  GroupControlEnvelopeSchema,
  GroupHelloPayloadSchema,
  GroupHelloResponsePayloadSchema,
  GroupStateUpdatePayloadSchema,
  GroupStateSummaryPayloadSchema,
  GroupStateSummarySchema,
  MemberVersionSchema,
  GroupStateRequestPayloadSchema,
  GroupMemberUpdatePayloadSchema,
  GroupMemberJoinedPayloadSchema,
  GroupMemberOnlinePayloadSchema,
  GroupPresencePayloadSchema,
  StreamStateRequestPayloadSchema,
  StreamStateSnapshotPayloadSchema,
  StreamStartedPayloadSchema,
  StreamHeartbeatPayloadSchema,
  StreamStoppedPayloadSchema,
  StreamRestartRequestPayloadSchema,
  StreamRestartedPayloadSchema,
  StreamRestartResultPayloadSchema,
  StreamSourceChangedPayloadSchema,
  StreamJoinRequestPayloadSchema,
  StreamJoinResponsePayloadSchema,
  StreamBindAckPayloadSchema,
  StreamLeavePayloadSchema,
  MediaBindPayloadSchema,
  ViewerPausedPayloadSchema,
  QualityViewerRequestPayloadSchema,
  QualityViewerClearPayloadSchema,
  QualityEffectivePayloadSchema,
  QualityConfiguredPayloadSchema,
  QualityObservedPayloadSchema,
  MAC_KEY_BYTES,
  deriveMacKey,
  signEnvelope,
  verifyEnvelope,
  serializeForMac,
  buildEnvelope,
  validateEnvelope,
  DedupSet,
  parseGroupMessagePayload,
  utf8ByteLength,
  bytesToHex,
} from "./group-control-messages.js";
export type {
  GroupControlMessageType,
  GroupControlEnvelope,
  GroupControlEnvelopeInput,
  GroupControlPayloadMap,
} from "./group-control-messages.js";

// Phase 2: NVIDIA Quality Level Canonical Mapping
export {
  canonicalQualityLevel,
  decomposeQualityLevel,
  isValidQualityLevel,
  nvidiaOutputDimensions,
  NVIDIA_PROCESSING_MODES,
  NVIDIA_QUALITIES,
} from "./nvidia-quality.js";
export type {
  NvidiaProcessingMode,
  NvidiaQuality,
} from "./nvidia-quality.js";
