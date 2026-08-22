/**
 * Keyboard shortcut binding shared between main and renderer.
 * Matches the preload API shape used for IPC serialization.
 */
export interface ShortcutBinding {
  modifiers: Array<"alt" | "ctrl" | "shift" | "win">;
  key: string;
}
