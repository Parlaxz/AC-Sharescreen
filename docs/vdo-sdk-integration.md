# VDO.Ninja SDK Integration

## Loading

The SDK is NOT bundled through Vite or imported as an ES module. Instead:

1. `@vdoninja/sdk@1.3.18` is installed as an npm dependency (for license + hash verification)
2. The raw `vdoninja-sdk.min.js` is copied byte-for-byte to each app's `public/vendor/` directory
3. Loaded via `<script src="/vendor/vdoninja-sdk-1.3.18.min.js"></script>` in HTML
4. Excluded from Vite transformation

## Version Assertion

At runtime, `window.VDONinjaSDK.VERSION` is checked against `"1.3.18"`. 
A mismatch throws `VDONINJA_SDK_VERSION_MISMATCH` error.

## SDK Exception

The AGPL SDK Exception applies to unmodified official `vdoninja-sdk.js` and `vdoninja-sdk.min.js` files.
The exception and AGPL license text are shipped alongside the SDK.

## Compatibility Adapter

All SDK access goes through `@screenlink/vdo-adapter` which:
- Provides typed interfaces for the SDK API
- Wraps SDK construction/connection/publish/view
- Safely accesses the undocumented `sdk.connections` Map
- Provides sender parameter management
- Polls WebRTC stats

## Prohibited

- Direct WebSocket access to `wss://wss.vdo.ninja`
- Sending application data through signaling fallback
- Modifying the SDK file
- Using the SDK as a bundled ES module import
