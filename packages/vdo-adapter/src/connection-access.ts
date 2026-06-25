import { CompatibilityError } from "@screenlink/shared";
import type { VDONinjaSDK, PeerGroup } from "./sdk-types.js";

export function getPeerGroup(sdk: VDONinjaSDK, peerUuid: string): PeerGroup {
  if (!(sdk.connections instanceof Map)) {
    throw new CompatibilityError("sdk.connections is not a Map");
  }

  const group = sdk.connections.get(peerUuid);
  if (!group) {
    throw new CompatibilityError(`No peer group found for UUID: ${peerUuid}`);
  }

  return group;
}

export function getPublisherConnection(sdk: VDONinjaSDK, peerUuid: string): RTCPeerConnection {
  const group = getPeerGroup(sdk, peerUuid);
  if (!group.publisher?.pc) {
    throw new CompatibilityError("Publisher PC not found for peer");
  }
  if (!(group.publisher.pc instanceof RTCPeerConnection)) {
    throw new CompatibilityError("Publisher .pc is not an RTCPeerConnection");
  }
  return group.publisher.pc;
}

export function getViewerConnection(sdk: VDONinjaSDK, peerUuid: string): RTCPeerConnection {
  const group = getPeerGroup(sdk, peerUuid);
  if (!group.viewer?.pc) {
    throw new CompatibilityError("Viewer PC not found for peer");
  }
  if (!(group.viewer.pc instanceof RTCPeerConnection)) {
    throw new CompatibilityError("Viewer .pc is not an RTCPeerConnection");
  }
  return group.viewer.pc;
}

export function getVideoSender(pc: RTCPeerConnection): RTCRtpSender | undefined {
  return pc.getSenders().find(s => s.track?.kind === "video");
}

export function getAudioSender(pc: RTCPeerConnection): RTCRtpSender | undefined {
  return pc.getSenders().find(s => s.track?.kind === "audio");
}

/**
 * Get the RTCPeerConnection for a specific media peer UUID.
 * Works for both publishers and viewers.
 */
export function getPeerConnection(sdk: VDONinjaSDK, mediaPeerUuid: string): RTCPeerConnection | null {
  const group = sdk.connections.get(mediaPeerUuid);
  if (!group) return null;
  return group.publisher?.pc ?? group.viewer?.pc ?? null;
}

/**
 * Get the video RTCRtpSender for a specific peer connection.
 * In a publishing (host) context, the video sender is sending TO this peer.
 * In a viewing context, it's the sender on the viewer's peer connection.
 */
export function getVideoSenderForPeer(pc: RTCPeerConnection, _mediaPeerUuid: string): RTCRtpSender | null {
  // mediaPeerUuid is retained in the API signature for future per-peer sender selection.
  // Currently each RTCPeerConnection represents one peer, so we find the first video sender.
  return pc.getSenders().find(s => s.track?.kind === "video") ?? null;
}
