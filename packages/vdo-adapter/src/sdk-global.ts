import type { VDONinjaSDK, VDONinjaSDKConstructorOptions } from "./sdk-types.js";

declare global {
  interface Window {
    VDONinjaSDK: (new (options: VDONinjaSDKConstructorOptions) => VDONinjaSDK) & { VERSION?: string };
    VDONinja: (new (options: VDONinjaSDKConstructorOptions) => VDONinjaSDK) & { VERSION?: string };
  }
}

export {};
