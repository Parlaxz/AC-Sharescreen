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
