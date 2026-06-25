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
 * | Esc             | Close overlay or exit fullscreen |
 *
 * Returns command palette state that the App component uses to render
 * the CommandPalette component.
 */
export function useKeyboardShortcuts() {
  const navigate = useStore((s) => s.navigate);
  const toggleContextPanel = useStore((s) => s.toggleContextPanel);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const isSharing = useStore((s) => s.isSharing);
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);

  const handler = useCallback((event: KeyboardEvent) => {
    // Ignore if user is typing in an input/textarea/contenteditable
    const target = event.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) {
      return;
    }

    const ctrl = event.ctrlKey || event.metaKey;
    const alt = event.altKey;

    // Ctrl+K — Command palette
    if (ctrl && event.key === "k") {
      event.preventDefault();
      // Dispatch a custom event so App.tsx can manage the state
      window.dispatchEvent(new CustomEvent("screenlink:toggle-command-palette"));
      return;
    }

    // Ctrl+, — Settings
    if (ctrl && event.key === ",") {
      event.preventDefault();
      navigate("settings");
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
      toggleFocusMode();
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
        useStore.getState().setSelectedGroupId(groupId);
        useStore.getState().setGroupNavPage("overview");
      }
      return;
    }

    // Esc — Close overlay or exit fullscreen (Section 14)
    if (event.key === "Escape") {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      }
      return;
    }
  }, [navigate, toggleContextPanel, toggleFocusMode, isSharing, setOpenShareSetup]);

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);
}
