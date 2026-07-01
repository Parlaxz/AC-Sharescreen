export type {
  VDONinjaSDK,
  VDONinjaSDKConstructorOptions,
  PublishOptions,
  ViewOptions,
  SendDataOptions,
  ConnectionEntry,
  PeerGroup,
  SDKEvent,
} from "./sdk-types.js";

export type { HostPublisherOptions } from "./host-publisher.js";

export type {
  DegradationPreference,
  QualityTarget,
  QualityResult,
} from "./sender-parameters.js";

export type {
  StatsSnapshot,
  CodecVerificationState,
  InboundRtpCodecEvidence,
  PreviousSample,
} from "./media-stats.js";

export {
  EXPECTED_SDK_VERSION,
  assertSDKVersion,
  getSDKConstructor,
} from "./sdk-version.js";

export {
  getPeerGroup,
  getPublisherConnection,
  getViewerConnection,
  getVideoSender,
  getAudioSender,
  getPeerConnection,
  getVideoSenderForPeer,
} from "./connection-access.js";

export {
  readSenderParameters,
  applyQualityToSender,
} from "./sender-parameters.js";

export { HostPublisher } from "./host-publisher.js";

export { ViewerClient } from "./viewer-client.js";

export { sendControlMessage } from "./send-data.js";

export {
  getSenderVideoCapabilities,
  getReceiverVideoCapabilities,
  getCommonVideoCodecCapabilities,
  applyCodecPreferences,
  intersectSenderAndReceiverCodecs,
  applyCodecPreferencesToTransceiverBeforeOffer,
  getAutoCodecOrder,
} from "./codec-capabilities.js";
export type { CodecPreferenceRecord } from "./codec-capabilities.js";

export {
  pollStats,
  resolveActiveCodecFromStats,
  collectCodecEvidence,
} from "./media-stats.js";
