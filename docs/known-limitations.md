# Known Limitations

## VDO.Ninja SDK

- SDK is documented as "still in development and may contain bugs"
- `sdk.connections` is undocumented internal state
- `sdk.getStats()` behavior is not verified against 1.3.18

## Security

- No viewer-only credential in SDK architecture
- Fragment tokens visible to page JS, extensions, clipboard
- Token rotation doesn't disconnect already-connected WebRTC peers

## Features

- Per-viewer audio network toggle requires runtime verification
- Hardware encoder detection unavailable via standard WebRTC stats
- Codec preference is negotiated, not guaranteed
- Actual bitrate/FPS may differ from configured values due to network conditions

## Platform

- Windows only (no macOS/Linux support planned)
- Requires Windows 10 or 11
- No per-application audio isolation
- Display fingerprint not guaranteed stable across reboots
