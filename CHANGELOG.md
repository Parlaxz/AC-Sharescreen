# Changelog

## 0.5.0 — 2026-06-29

### New
- Version bumped to 0.5.0.

## 0.4.0 — 2026-06-27

### New
- **Bottom bar redesigned:** Replaced the connected icon with a diagnostics panel, added real-time internet usage display (hover shows total), settings cog, and mute/deafen Discord buttons (deafen can optionally mute the share audio too), and a lock toggle to prevent the bar from auto-hiding.
- **Stream quality controls reworked:** Renamed resolution presets (640x360 → 360p, 426x240 → 240p, 256x144 → 144p), added FPS and bitrate sliders to the quality menu, made presets appear as labeled options. Bitrate slider now caps at the user's custom max setting, and the bitrate field supports direct typing. The quality form no longer disappears on apply.
- **Stream viewing page cleaned up:** Removed the top bar entirely — the fullscreen button now lives in the bottom bar. Video now always prioritizes full-height layout so the bottom bar remains visible.
- **One-click update install:** Added a combined "Check, Download & Install" button beside the existing check-update button.
- **Right-click fullscreen toggle:** Right-clicking during a share screen now toggles fullscreen on/off.
- **Group refresh button:** Added a refresh button in group views that messages all members to check if someone is sharing their screen.
- **Connected text removed:** The "Connected" label in the bottom bar has been removed for a cleaner look.

### Fixed
- **Apply button reliability:** The quality settings apply button now works consistently — settings are always applied when clicked.
- **Layout prioritization:** Video always prioritizes full height so the bottom bar never gets pushed off-screen.

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
