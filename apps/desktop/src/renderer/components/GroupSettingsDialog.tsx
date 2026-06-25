import React, { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../stores/main-store.js";
import { getRuntime } from "../services/phase3-runtime.js";

interface Props {
  groupId: string;
  onClose: () => void;
}

/**
 * GroupSettingsDialog (Stage 11)
 *
 * Replaces prompt()-based Group Settings with a proper dialog.
 * - Reads group state from store (reactive)
 * - Saves via runtime.getSyncService().performLocalEdit(), not direct persistence
 * - Shows conflict banner if dirty form receives newer remote state
 * - Accessible: role="dialog", aria-modal, initial focus, focus trap, focus restore
 */
export function GroupSettingsDialog({ groupId, onClose }: Props) {
  const groupsById = useStore((s) => s.groupsById);
  const group = groupsById[groupId];

  const [name, setName] = useState(group?.name ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const initialNameRef = useRef(group?.name ?? "");
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusableRef = useRef<HTMLInputElement>(null);
  const previousActiveElement = useRef<Element | null>(null);

  // Save previous focus and restore on unmount
  useEffect(() => {
    previousActiveElement.current = document.activeElement;
    // Focus the first focusable element after mount
    const timer = setTimeout(() => {
      firstFocusableRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      // Restore focus to the element that opened the dialog
      if (previousActiveElement.current instanceof HTMLElement) {
        previousActiveElement.current.focus();
      }
    };
  }, []);

  // Track remote state changes to detect conflicts
  useEffect(() => {
    const unsub = useStore.subscribe((state, prevState) => {
      if (!dirty) return;
      const newGroup = (state as Record<string, unknown>).groupsById as Record<string, { name: string }> | undefined;
      const oldGroup = (prevState as Record<string, unknown>).groupsById as Record<string, { name: string }> | undefined;
      const newName = newGroup?.[groupId]?.name;
      const oldName = oldGroup?.[groupId]?.name;
      if (newName && newName !== oldName && newName !== name) {
        setConflict(true);
      }
    });
    return unsub;
  }, [groupId, dirty, name]);

  // Focus trap: close on Escape, trap Tab cycling
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError("Group name cannot be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const runtime = getRuntime();
      if (!runtime) {
        setError("Runtime not initialized");
        setSaving(false);
        return;
      }

      await runtime.getSyncService().performLocalEdit(groupId, (state) => ({
        name: { value: name.trim() },
      }));

      setDirty(false);
      setConflict(false);
      initialNameRef.current = name.trim();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [groupId, name]);

  return (
    <div
      className="dialog-overlay"
      role="presentation"
    >
      <div
        className="dialog card group-settings-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-settings-title"
      >
        <div className="dialog-header">
          <h2 id="group-settings-title">Group Settings</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {conflict && (
          <div className="conflict-banner" style={{
            background: "var(--warning-bg, #fff3cd)",
            border: "1px solid var(--warning-border, #ffc107)",
            padding: "0.5rem",
            borderRadius: "4px",
            marginBottom: "0.75rem",
            fontSize: "0.85rem",
          }}>
            <strong>Conflict detected:</strong> The group state has changed remotely while you were editing. Saving will overwrite the remote change.
          </div>
        )}

        <div className="field-row">
          <label htmlFor="group-settings-name">Group Name</label>
          <input
            id="group-settings-name"
            ref={firstFocusableRef}
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); markDirty(); }}
            maxLength={100}
          />
        </div>

        {error && <p className="error">{error}</p>}

        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <button onClick={handleSave} disabled={!dirty || saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
