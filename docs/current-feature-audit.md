# ScreenLink Current-Feature Audit

Date: 2026-06-21
Git: No repository (unversioned workspace)

## Feature Inventory

See full audit report in conversation transcript. Key findings:

### Implemented and Working
- Screen sharing (HostPublisher flow)
- Remote viewing (ViewerClient flow)
- Auto-watch friend (autoWatchFriend → auto startViewing)
- Pairing create/import/copy/export/reset
- Control connection (VDO.Ninja data channel via announce)
- 12 control protocol message types
- Quality presets UI (all 5 presets + custom sliders)
- Fullscreen video (double-click + button)
- Source picker (grid with thumbnails)
- Close-to-tray behavior
- Launch at login
- Dev profiles (--dev-profile alice/bob)
- Multi-instance (--multi-instance)
- Source fingerprint generation + persistence

### Stubbed / Placeholder
- applyQualityToSender() — accepts without applying
- Diagnostics logs — static placeholder text
- Viewers table — always shows "—" for RTT/loss/relay

### Missing
- Windows notifications (new Notification never called)
- WebRTC stats pipeline (pollStats() exists but unused)
- TURN/relay detection (candidateType not checked)
- Quality persistence (lastPresetId never saved)
- Source fingerprint restore (matchSourceByFingerprint unused)
- Per-viewer sender parameter application
- Global quality change application
- Heartbeat/ping for control channel
- Viewer tracking (viewers array never populated)
