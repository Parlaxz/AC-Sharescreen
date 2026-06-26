# Changelog

## 0.2.3 — 2026-06-26

### New
- **Self-viewing:** You can now click "Watch" on your own active share to preview your stream locally. The viewer pipes the capture stream directly instead of routing through the VDO relay, so there's zero added latency.
- **Member presence notifications:** When a member joins a group, an online notification is broadcast to all connected peers. Notifications are queued for offline users and replayed when they come back online. Incoming `group.member.online` messages fire desktop notifications ("X is online in group").

### Fixed
- **Group navigation on create:** Creating a group now navigates to that group's overview page immediately (via `selectedGroupId` + `currentPage: "overview"`). Same for joining a group via invite.
- **PCM audio crash:** Fixed `Cannot read properties of undefined (reading 'slice')` in `ProcessAudioController.handlePcmPacket`. The raw `ArrayBuffer` from `PcmBridge` has no `.buffer` property; the code now handles both `ArrayBuffer` and typed-array views defensively.
- **Instant stream badge on stop:** When the host stops sharing, the "Live" / "Sharing" badges now clear immediately. The local registry is updated before the mesh broadcast, so the UI never waits on a slow peer.
- **Stale audio packet handling:** Invalid PCM packets (missing or empty `pcmData`) are silently dropped instead of crashing the audio pipeline.

### Changed
- **Message protocol:** Added `group.member.joined` and `group.member.online` message types with strict Zod schemas.
- **ViewerSession refactor:** Cleaner separation of the join flow — self-viewing and remote viewing share the same entry point with a runtime-device-identity check.
