import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

interface KeyRecorderProps {
  /** Current combo string like "Alt+M" or "Ctrl+Shift+S" */
  value: string;
  /** Called with the formatted combo string when capture completes */
  onChange: (value: string) => void;
  /** Disable interaction */
  disabled?: boolean;
  /** Placeholder shown when value is empty (default: "Click to set") */
  placeholder?: string;
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/**
 * Map a native `KeyboardEvent.key` to a concise display label.
 */
function getKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.startsWith("Arrow")) return key.slice(5);
  if (key === "Escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * Map a native modifier-name to the abbreviated form used in combo strings.
 */
function getModLabel(mod: string): string {
  switch (mod) {
    case "Control":
      return "Ctrl";
    case "Alt":
      return "Alt";
    case "Shift":
      return "Shift";
    case "Meta":
      return "Win";
    default:
      return mod;
  }
}

export function KeyRecorder({
  value,
  onChange,
  disabled = false,
  placeholder = "Click to set",
}: KeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [heldMods, setHeldMods] = useState<string[]>([]);
  const containerRef = useRef<HTMLButtonElement>(null);
  const onChangeRef = useRef(onChange);

  // Keep callback ref in sync so the listener always calls the latest onChange
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // If the component becomes disabled mid-recording, cancel immediately
  useEffect(() => {
    if (disabled && recording) {
      setRecording(false);
      setHeldMods([]);
    }
  }, [disabled, recording]);

  const stopRecording = useCallback(() => {
    setRecording(false);
    setHeldMods([]);
  }, []);

  // ─── Window keydown handler ───────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;

      // Prevent the keystroke from reaching other handlers (e.g. global
      // shortcuts that might interfere with recording).
      e.preventDefault();
      e.stopPropagation();

      // Snapshot currently held modifiers from the event flags.
      const held: string[] = [];
      if (e.altKey) held.push("Alt");
      if (e.ctrlKey) held.push("Ctrl");
      if (e.shiftKey) held.push("Shift");
      if (e.metaKey) held.push("Win");
      setHeldMods(held);

      const key = e.key;

      // Esc / Tab → cancel without firing onChange.
      if (key === "Escape" || key === "Tab") {
        stopRecording();
        return;
      }

      // If the pressed key is itself a modifier just keep tracking.
      if (MODIFIER_KEYS.has(key)) {
        return;
      }

      // Non-modifier pressed → finalize capture.
      const label = getKeyLabel(key);
      const combo = [...held, label].join("+");
      stopRecording();
      onChangeRef.current(combo);
    },
    [recording, stopRecording],
  );

  // ─── Window keyup handler (keeps held-modifier display in sync) ──────
  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;
      const held: string[] = [];
      if (e.altKey) held.push("Alt");
      if (e.ctrlKey) held.push("Ctrl");
      if (e.shiftKey) held.push("Shift");
      if (e.metaKey) held.push("Win");
      setHeldMods(held);
    },
    [recording],
  );

  // ─── Click-outside detection ─────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (
        recording &&
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        stopRecording();
      }
    },
    [recording, stopRecording],
  );

  // ─── Attach / detach window listeners ────────────────────────────────
  useEffect(() => {
    if (!recording) return;

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("mousedown", handleMouseDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      document.removeEventListener("mousedown", handleMouseDown, true);
    };
  }, [recording, handleKeyDown, handleKeyUp, handleMouseDown]);

  // ─── Cleanup on unmount ──────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (recording) stopRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Click to start recording ────────────────────────────────────────
  const handleClick = () => {
    if (disabled || recording) return;
    setRecording(true);
    setHeldMods([]);
  };

  // ─── Dynamic display text ────────────────────────────────────────────
  const showHeldMods = recording && heldMods.length > 0;
  const displayText = recording
    ? showHeldMods
      ? `${heldMods.join(" + ")} + …`
      : "Press keys…"
    : value || placeholder;

  return (
    <button
      ref={containerRef}
      type="button"
      data-recording={recording ? "true" : undefined}
      onClick={handleClick}
      disabled={disabled}
      className={cn(
        /* --- match Input sizing & base look --- */
        "relative inline-flex items-center gap-1.5 h-9 w-full rounded-standard border px-3 py-1 text-sm text-left",
        "transition-colors duration-150 ease-out",
        /* --- idle (value set or empty) --- */
        !recording && !disabled && [
          "bg-surface-2 border-border-subtle",
          value ? "text-text-primary" : "text-text-muted",
          "hover:bg-surface-hover hover:border-border-strong",
          "cursor-pointer",
        ],
        /* --- recording --- */
        recording && "bg-surface-2 border-accent cursor-default",
        /* --- disabled --- */
        disabled && "opacity-50 cursor-not-allowed text-text-muted",
      )}
    >
      {/* ── Main label ─────────────────────────────────────────────── */}
      <span className="flex-1 truncate">{displayText}</span>

      {/* ── Esc-to-cancel hint ─────────────────────────────────────── */}
      {recording && (
        <span className="text-[10px] leading-none text-text-muted whitespace-nowrap">
          Esc to cancel
        </span>
      )}

      {/* ── Pulsing accent ring (only while recording) ────────────── */}
      {recording && (
        <motion.span
          className="absolute inset-0 rounded-standard pointer-events-none"
          aria-hidden
          style={{ boxShadow: `0 0 0 1px rgba(76, 141, 255, 0.3)` }}
          animate={{
            boxShadow: [
              "0 0 0 1px rgba(76, 141, 255, 0.25)",
              "0 0 0 2px rgba(76, 141, 255, 0.65)",
              "0 0 0 1px rgba(76, 141, 255, 0.25)",
            ],
          }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
    </button>
  );
}
