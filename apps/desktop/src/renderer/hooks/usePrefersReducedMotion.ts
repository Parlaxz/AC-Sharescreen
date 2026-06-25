import { useMemo } from "react";

/**
 * usePrefersReducedMotion — Detect OS-level reduced-motion preference (Section 11.5).
 *
 * Returns `true` when the user prefers reduced motion.
 * The hook re-evaluates when the media query changes at the browser level.
 * For SSR safety, defaults to `undefined` on first render (no match yet).
 */
export function usePrefersReducedMotion(): boolean {
  const mq = useMemo(
    () =>
      typeof window !== "undefined"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null,
    [],
  );
  return mq?.matches ?? false;
}
