import React, { useEffect, useState } from "react";
import { motion, useMotionValue, useSpring } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * AnimatedNumber â€” Smoothly tweens between numeric values using framer-motion.
 *
 * Uses useMotionValue + useSpring to interpolate the displayed number
 * with a spring animation. Renders in a <motion.span> with monospace +
 * tabular-nums styling for stable width and aligned digits.
 *
 * Usage:
 *   <AnimatedNumber value={bitrate} />
 *   <AnimatedNumber value={bytes} format="bytes" />
 *   <AnimatedNumber value={fps} decimals={1} />
 *
 * Composed entirely from Watermelon styling + framer-motion.
 */
interface AnimatedNumberProps {
  /** The numeric value to animate to */
  value: number;
  /** Number of decimal places (default 0) */
  decimals?: number;
  /** Formatting style */
  format?: "number" | "bytes" | "bitrate" | "duration";
  /** Additional className */
  className?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBitrate(kbps: number): string {
  const Bps = kbps * 125; // kbps * 1000 / 8
  if (Bps < 1000) return `${Math.round(Bps)} B/s`;
  const kBps = Bps / 1000;
  if (kBps < 1000) return `${kBps.toFixed(1)} kB/s`;
  return `${(kBps / 1000).toFixed(2)} MB/s`;
}

function formatDuration(seconds: number): string {
  if (seconds < 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function AnimatedNumber({
  value,
  decimals = 0,
  format = "number",
  className,
}: AnimatedNumberProps) {
  const motionValue = useMotionValue(value);
  const springValue = useSpring(motionValue, {
    stiffness: 120,
    damping: 18,
    mass: 0.5,
  });
  const [displayValue, setDisplayValue] = useState(value);

  useEffect(() => {
    motionValue.set(value);
  }, [value, motionValue]);

  useEffect(() => {
    const unsubscribe = springValue.on("change", (latest) => {
      setDisplayValue(latest);
    });
    return unsubscribe;
  }, [springValue]);

  const formatted = (() => {
    const num = displayValue;
    switch (format) {
      case "bytes":
        return formatBytes(num);
      case "bitrate":
        return formatBitrate(num);
      case "duration":
        return formatDuration(num);
      default:
        return num.toFixed(decimals);
    }
  })();

  return (
    <motion.span
      className={cn(
        "font-mono tabular-nums text-text-primary",
        className,
      )}
    >
      {formatted}
    </motion.span>
  );
}
