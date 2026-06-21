# ScreenLink Feature Reconstruction Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Reconstruct missing desktop features: notifications, real quality application, WebRTC stats, TURN detection, source fingerprint restore, tray improvements.

**Architecture:** Electron desktop app with VDO.Ninja SDK control channel (data-only via announce). Independent local/remote state machines.

---

### Phase A: Control Connection Verification + Base Improvements

Task A1: Verify announce() creates peer connection and data channel. Add contract tests for startup orders (Alice first, Bob first, simultaneous).

Task A2: Add ping/pong heartbeat to control connection.

### Phase B: Notifications + Tray

Task B1: Implement Electron notifications for friend online/share/stop events.

Task B2: Improve tray menu with dynamic states, quality submenu, auto-watch toggle.

### Phase C: Real Quality Application

Task C1: Create publisher-manager service owning publisher SDK, senders, stats.

Task C2: Wire applyQualityToSender to real RTCRtpSender via publisher manager.

### Phase D: WebRTC Stats + TURN Detection

Task D1: Wire pollStats() into Dashboard/Viewer, display bitrate/loss/jitter.

Task D2: Implement ICE candidate-pair analysis for direct/TURN detection.

### Phase E: Source Fingerprint + Settings

Task E1: Wire matchSourceByFingerprint into source picker restore flow.

Task E2: Persist quality preset selection to settings.

Task E3: Clean up legacy store fields.
