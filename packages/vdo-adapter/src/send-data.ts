import { ProtocolError, MAX_CONTROL_PAYLOAD_SIZE } from "@screenlink/shared";
import type { VDONinjaSDK } from "./sdk-types.js";

export async function sendControlMessage(
  sdk: VDONinjaSDK,
  payload: unknown,
  targetUuid: string,
  targetType: "publisher" | "viewer",
): Promise<void> {
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_CONTROL_PAYLOAD_SIZE) {
    throw new ProtocolError("Control message exceeds max size");
  }

  await sdk.sendData(payload, {
    uuid: targetUuid,
    type: targetType,
    allowFallback: false,
  });
}
