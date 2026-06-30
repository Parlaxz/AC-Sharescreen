import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes with conflict resolution.
 * Uses clsx for conditional classes and tailwind-merge for deduplication.
 *
 * @example
 *   cn("px-4 py-2", someCondition && "bg-accent", className)
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}


export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function getInitials(name: string, maxParts = 2): string {
  if (!name || name.trim() == "") return "?";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, maxParts)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "?";
}

export function formatBitrateBps(bps: number | null): string {
  if (bps === null || bps === 0) return "—";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1000).toFixed(1)} kbps`;
}

export function formatBitrateKbps(kbps: number | null): string {
  if (kbps === null || kbps === 0) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

