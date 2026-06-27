import { useEffect, useCallback } from "react";
import { useStore } from "@/stores/main-store";

/**
 * useKeyboardShortcuts — Global keyboard shortcut bindings (Section 14).
 *
 * | Shortcut        | Action                           |
 * |-----------------|----------------------------------|
 * | Ctrl+K          | Open command palette             |
 * | Ctrl+,          | Open settings                    |
 * | Ctrl+`          | Toggle context panel             |
 * | Ctrl+Shift+F    | Toggle viewer focus mode         |
 * | Ctrl+Shift+S    | Start or stop sharing            |
 * | Alt+1…9         | Select group by position         |
 * | Esc             | Leave fullscreen → close overlays |
 *
 * Viewer-specific (on viewer page only, ignored while typing in inputs):
 * | F              | Toggle fullscreen (Electron)    |
 * | M              | Toggle mute                     |
 * | I              | Toggle diagnostics panel        |
 * | S              | Toggle viewer settings panel    |
 * | Esc            | Leave fullscreen → close overlays |
 *
 * All shortcuts are ignored while the user is typing in an input, textarea,
 * select, or contenteditable element.
 */
export function useKeyboardShortcuts() {
  const navigate = useStore((s) => s.navigate);
  const toggleContextPanel = useStore((s) => s.toggleContextPanel);
  const isSharing = useStore((s) => s.isSharing);
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);

  const handler = useCallback((event: KeyboardEvent) => {
    // Ignore if user is typing in an input/textarea/select/contenteditable
    const target = event.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable
    ) {
      return;
    }

    const ctrl = event.ctrlKey || event.metaKey;
    const alt = event.altKey;

    // Ctrl+K — Command palette
    if (ctrl && event.key === "k") {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent("screenlink:toggle-command-palette"));
      return;
    }

    // Ctrl+, — Settings
    if (ctrl && event.key === ",") {
      event.preventDefault();
      navigate("user-settings");
      return;
    }

    // Ctrl+` — Toggle context panel
    if (ctrl && event.key === "`") {
      event.preventDefault();
      toggleContextPanel();
      return;
    }

    // Ctrl+Shift+F — Toggle viewer focus mode (Section 14)
    if (ctrl && event.shiftKey && event.key === "F") {
      event.preventDefault();
      useStore.getState().toggleFocusMode();
      return;
    }

    // Ctrl+Shift+S — Start or stop sharing (Section 14)
    if (ctrl && event.shiftKey && event.key === "S") {
      event.preventDefault();
      if (isSharing) {
        useStore.getState().setIsSharing(false);
      } else {
        setOpenShareSetup(true);
      }
      return;
    }

    // Alt+1…9 — Select group by position (Section 14)
    if (alt && event.key >= "1" && event.key <= "9") {
      event.preventDefault();
      const index = parseInt(event.key, 10) - 1;
      const groupOrder = useStore.getState().groupOrder;
      const groupId = groupOrder[index];
      if (groupId) {
        const s = useStore.getState();
        s.setSelectedGroupId(groupId);
        s.setGroupNavPage("overview");
        s.navigate("overview");
      }
      return;
    }

    // ── Viewer-specific shortcuts (only when on viewer page) ──────────
    const page = useStore.getState().currentPage;
    if (page === "viewer") {
      // F — Toggle fullscreen (Electron fullscreen state, not document.fullscreenElement)
      if (event.key === "f" || event.key === "F") {
        if (!ctrl && !alt && !event.shiftKey) {
          event.preventDefault();
          const api = (window as unknown as { screenlink?: { toggleFullscreen: () => Promise<boolean> } }).screenlink;
          if (api) {
            void api.toggleFullscreen();
          } else if (document.fullscreenElement) {
            void document.exitFullscreen();
          } else {
            void document.documentElement.requestFullscreen();
          }
          return;
        }
      }

      // M — Toggle mute
      if ((event.key === "m" || event.key === "M") && !ctrl && !alt && !event.shiftKey) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("screenlink:viewer-toggle-mute"));
        return;
      }

      // I — Toggle diagnostics panel
      if ((event.key === "i" || event.key === "I") && !ctrl && !alt && !event.shiftKey) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("screenlink:viewer-toggle-info"));
        return;
      }

      // S — Toggle viewer settings panel (lowercase s only, not Shift+S)
      if (event.key === "s" && !ctrl && !alt && !event.shiftKey) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("screenlink:viewer-toggle-settings"));
        return;
      }

      // Esc — Leave fullscreen first, then close overlays if not fullscreen
      if (event.key === "Escape") {
        const api = (window as unknown as { screenlink?: { toggleFullscreen: () => Promise<boolean>; isFullscreen?: () => boolean } }).screenlink;
        // If fullscreen, exit fullscreen first (Escape)
        if (document.fullscreenElement) {
          if (api) {
            void api.toggleFullscreen();
          } else {
            void document.exitFullscreen();
          }
          return;
        }
        // Close any open overlays by dispatching escape event
        window.dispatchEvent(new CustomEvent("screenlink:viewer-escape"));
        return;
      }
    }

    // Global Esc — handle fullscreen exit from any page
    if (event.key === "Escape" && document.fullscreenElement) {
      event.preventDefault();
      const api = (window as unknown as { screenlink?: { toggleFullscreen: () => Promise<boolean> } }).screenlink;
      if (api) {
        void api.toggleFullscreen();
      } else {
        void document.exitFullscreen();
      }
      return;
    }
  }, [navigate, toggleContextPanel, isSharing, setOpenShareSetup]);

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);
}
