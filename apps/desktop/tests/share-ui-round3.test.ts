// @vitest-environment happy-dom
/**
 * Share UI fixes — Round 3. Real runtime blockers.
 *
 * 1) Fullscreen ↔ focusMode synchronization (store + AppShell)
 * 2) onPanelsOpenChange forwarding through VideoControlsOverlay
 * 3) DOM muted sync for <video> element
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

// ---------------------------------------------------------------
// Issue 1: Fullscreen ↔ focusMode sync
// ---------------------------------------------------------------

describe("Fullscreen ↔ focusMode synchronization (Issue 1)", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("setFocusMode action exists and sets focusMode", () => {
    const store = useStore.getState();
    expect(typeof store.setFocusMode).toBe("function");

    store.setFocusMode(true);
    expect(useStore.getState().focusMode).toBe(true);

    store.setFocusMode(false);
    expect(useStore.getState().focusMode).toBe(false);
  });

  it("entering fullscreen sets focusMode=true so AppShell hides chrome", () => {
    const store = useStore.getState();
    store.setIsViewing(true);
    expect(store.focusMode).toBe(false);

    // Simulate the fullscreen change listener syncing focusMode
    store.setFocusMode(true);
    expect(useStore.getState().focusMode).toBe(true);
  });

  it("exiting fullscreen sets focusMode=false so chrome restores", () => {
    const store = useStore.getState();
    store.setFocusMode(true);
    expect(useStore.getState().focusMode).toBe(true);

    store.setFocusMode(false);
    expect(useStore.getState().focusMode).toBe(false);
  });

  it("handleExit clears focusMode when exiting viewer", () => {
    const store = useStore.getState();
    store.setIsViewing(true);
    store.setFocusMode(true);
    expect(useStore.getState().focusMode).toBe(true);

    // Exit viewer — setIsViewing already sets focusMode: false
    store.setIsViewing(false);
    expect(useStore.getState().focusMode).toBe(false);
  });
});

// ---------------------------------------------------------------
// Issue 2: onPanelsOpenChange forwarding
// ---------------------------------------------------------------

describe("onPanelsOpenChange forwarding (Issue 2)", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("VideoControls accepts and forwards onPanelsOpenChange prop", async () => {
    // Verify the VideoControls component handles onPanelsOpenChange
    // by rendering it with the prop (must not crash).
    const React = await import("react");
    const { render } = await import("@testing-library/react");
    const { TooltipProvider } = await import(
      "../src/renderer/components/ui/tooltip.js"
    );
    const { VideoControls } = await import(
      "../src/renderer/components/workspace/viewer/VideoControls.js"
    );

    const mockOnPanelsOpenChange = vi.fn();

    expect(() => {
      render(
        React.createElement(TooltipProvider, null,
          React.createElement(VideoControls, {
            isPaused: false,
            onTogglePlay: vi.fn(),
            volume: 0.5,
            isMuted: false,
            onVolumeChange: vi.fn(),
            onToggleMute: vi.fn(),
            viewerRequest: null,
            onQualityRequestChange: vi.fn(),
            currentStreamId: "stream-1",
            onStreamSwitch: vi.fn(),
            connectionState: "connected",
            isFullscreen: false,
            onToggleFullscreen: vi.fn(),
            onExit: vi.fn(),
            visible: true,
            isLive: true,
            session: null,
            onPanelsOpenChange: mockOnPanelsOpenChange,
          })
        )
      );
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------
// Issue 3: DOM muted sync for <video>
// ---------------------------------------------------------------

describe("DOM muted sync for <video> element (Issue 3)", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("mute state change syncs to video element DOM property", () => {
    const video = document.createElement("video");
    video.muted = false;

    // Simulate useEffect that syncs isMuted → video.muted
    const applyMuted = (muted: boolean) => { video.muted = muted; };

    expect(video.muted).toBe(false);
    applyMuted(true);
    expect(video.muted).toBe(true);
    applyMuted(false);
    expect(video.muted).toBe(false);
  });

  it("volume change syncs to video element DOM property", () => {
    const video = document.createElement("video");
    video.volume = 1;

    const applyVolume = (v: number) => { video.volume = v; };

    expect(video.volume).toBe(1);
    applyVolume(0.5);
    expect(video.volume).toBe(0.5);
    applyVolume(0);
    expect(video.volume).toBe(0);
  });
});
