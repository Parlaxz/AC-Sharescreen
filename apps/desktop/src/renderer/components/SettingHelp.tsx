import React, { useState, useRef, useEffect, useId, useCallback } from "react";
import type { HelpEntry } from "../quality-setting-help.js";

interface Props {
  help: HelpEntry;
}

export function SettingHelp({ help }: Props) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const descriptionId = `${popupId}-desc`;

  // Toggle visibility
  const toggle = useCallback(() => setVisible((v) => !v), []);

  const close = useCallback(() => setVisible(false), []);

  // Show on hover/focus
  const show = useCallback(() => setVisible(true), []);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Add listener on next tick to avoid immediate close from same click
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("keydown", escapeHandler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escapeHandler);
    };
  }, [visible, close]);

  return (
    <div className="setting-help" ref={ref}>
      <button
        className="help-button"
        onClick={toggle}
        onMouseEnter={show}
        onMouseLeave={close}
        onFocus={show}
        onBlur={(e) => {
          // Only close if focus is leaving the entire help group
          if (!ref.current?.contains(e.relatedTarget as Node)) {
            close();
          }
        }}
        aria-describedby={visible ? descriptionId : undefined}
        aria-expanded={visible}
        aria-label={`Help: ${help.title}`}
        type="button"
      >
        ?
      </button>
      {visible && (
        <div
          className="help-popup"
          id={descriptionId}
          role="tooltip"
          aria-hidden={!visible}
        >
          <h4>{help.title}</h4>
          <p>
            <strong>What it changes:</strong> {help.whatItChanges}
          </p>
          <p>
            <strong>Higher value:</strong> {help.higherValue}
          </p>
          <p>
            <strong>Lower value:</strong> {help.lowerValue}
          </p>
          <p>
            <strong>Tradeoff:</strong> {help.tradeoff}
          </p>
          <div className="help-tags">
            <span>Bandwidth: {help.bandwidth}</span>
            <span>Sharpness: {help.sharpness}</span>
            <span>Motion: {help.motion}</span>
            <span>CPU: {help.cpu}</span>
            <span>Latency: {help.latency}</span>
            <span>Compatibility: {help.compatibility}</span>
          </div>
          <p>
            {help.perViewer ? "Per viewer" : "Host/group wide"} &middot;{" "}
            {help.liveSafe ? "Live safe" : "Restart required"}
          </p>
        </div>
      )}
    </div>
  );
}
