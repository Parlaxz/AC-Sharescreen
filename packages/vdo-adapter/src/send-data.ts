import { ProtocolError, MAX_CONTROL_PAYLOAD_SIZE } from "@screenlink/shared";
import type { VDONinjaSDK } from "./sdk-types.js";

/**
 * Send a control message via the VDO Ninja SDK data channel.
 *
 * Uses `preference: "any"` (SDK 1.3.18) instead of the deprecated `type` field
 * so the SDK can route through any available data channel rather than forcing
 * a specific connection type. This is critical for the media.bind message
 * which must reach the host publisher.
 *
 * The caller is responsible for ensuring the data channel is open before
 * invoking this function. If `allowFallback` is true, the SDK may fall back
 * to alternative routing if the primary data channel is unavailable.
 */
export async function sendControlMessage(
  sdk: VDONinjaSDK,
  payload: unknown,
  targetUuid: string,
): Promise<void> {
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_CONTROL_PAYLOAD_SIZE) {
    throw new ProtocolError("Control message exceeds max size");
  }

  await sdk.sendData(payload, {
    uuid: targetUuid,
    preference: "any",
    allowFallback: true,
  });
}
