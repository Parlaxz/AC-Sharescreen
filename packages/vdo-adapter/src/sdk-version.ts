import { CompatibilityError } from "@screenlink/shared";
import "./sdk-global.js";

export const EXPECTED_SDK_VERSION = "1.3.18";

export function assertSDKVersion(): void {
  const ctor =
    typeof window !== "undefined"
      ? (window as Window).VDONinjaSDK ?? (window as Window).VDONinja
      : null;

  if (!ctor) {
    throw new CompatibilityError("VDONinjaSDK not found on window");
  }

  // VERSION is a static property on the constructor per VDO.Ninja SDK 1.3.18
  const version = ctor.VERSION;

  if (version !== EXPECTED_SDK_VERSION) {
    throw new CompatibilityError(
      `VDONINJA_SDK_VERSION_MISMATCH: expected ${EXPECTED_SDK_VERSION}, got ${version ?? "unknown"}`,
    );
  }
}

export function getSDKConstructor(): NonNullable<Window["VDONinjaSDK"]> {
  assertSDKVersion();
  const ctor = (window as Window).VDONinjaSDK ?? (window as Window).VDONinja;
  // assertSDKVersion guarantees ctor is truthy and version-matched
  return ctor!;
}
