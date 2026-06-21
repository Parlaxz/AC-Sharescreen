# Security Model

## Trust Model

ScreenLink is designed for **trusted friends**. Anyone with the permanent viewer link
can watch while sharing is active. Do not post the link publicly.

## Credentials

- Share ID: 16 random bytes, base64url
- Host Token: 32 random bytes, base64url (stored encrypted with Electron safeStorage)
- Viewer Token: 32 random bytes, base64url (in fragment portion of URL)
- VDO Stream ID/Password: 32 random bytes, regenerated every session
- Session ID: UUID v4, per session

## Session Encryption

Session payloads stored in Durable Objects are encrypted with AES-256-GCM:
- Master key: 32-byte Worker secret
- Per-share key: HKDF-SHA-256 with shareId as salt
- Messages: AES-256-GCM with 12-byte random IV

## Transport Security

- All API calls over HTTPS
- VDO.Ninja signaling over WSS
- WebRTC with DTLS-SRTP
- ICE with optional TURN relay

## Limitations

- The SDK does not support viewer-only credentials for the SDK API
- A technically capable viewer with current VDO credentials could potentially publish
- Credential rotation reduces exposure but doesn't provide role separation
- Fragment tokens are accessible to page JS, extensions, DevTools, history, clipboard
