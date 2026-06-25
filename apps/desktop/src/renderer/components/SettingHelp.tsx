import React, { useState, useRef, useEffect } from "react";
import type { HelpEntry } from "../quality-setting-help.js";

interface Props {
  help: HelpEntry;
}

export function SettingHelp({ help }: Props) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = () => setVisible(false);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escapeHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escapeHandler);
    };
  }, [visible]);

  return (
    <div className="setting-help" ref={ref}>
      <button
        className="help-button"
        onClick={() => setVisible(!visible)}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        aria-describedby={visible ? "help-content" : undefined}
      >
        ?
      </button>
      {visible && (
        <div className="help-popup" id="help-content" role="tooltip">
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
            {help.perViewer ? "Per viewer" : "Host/group wide"} ·{" "}
            {help.liveSafe ? "Live safe" : "Restart required"}
          </p>
        </div>
      )}
    </div>
  );
}
