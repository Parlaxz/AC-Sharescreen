import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/**
 * Animation variants for `motion.div` / `motion.span` etc.
 *
 * When `useReducedMotion` returns true, large translations are removed
 * and spring overshoot is eliminated. Short opacity transitions are preserved
 * so that state changes remain clear (Section 11.5).
 */
export interface MotionVariants {
  initial?: Record<string, unknown>;
  animate?: Record<string, unknown>;
  exit?: Record<string, unknown>;
  transition?: Record<string, unknown>;
}

/**
 * Reduced-motion safe transition.
 * Removes large translate values, keeps opacity for status feedback.
 */
const REDUCED_INITIAL: Record<string, unknown> = { opacity: 0 };
const REDUCED_ANIMATE: Record<string, unknown> = { opacity: 1 };
const REDUCED_EXIT: Record<string, unknown> = { opacity: 0 };
const REDUCED_TRANSITION = { duration: 0.1, ease: "easeInOut" as const };

/**
 * useReducedMotionVariant — Wrap your motion variants so they
 * respect `prefers-reduced-motion: reduce`.
 *
 * @example
 * ```tsx
 * const variants = useReducedMotionVariant({
 *   initial: { opacity: 0, y: -8 },
 *   animate: { opacity: 1, y: 0 },
 *   exit: { opacity: 0, y: 8 },
 *   transition: { type: "spring", stiffness: 300, damping: 25 },
 * });
 *
 * <motion.div {...variants}>...</motion.div>
 * ```
 */
export function useReducedMotionVariant<T extends MotionVariants>(
  variants: T,
): T {
  const prefersReduced = usePrefersReducedMotion();

  if (!prefersReduced) return variants;

  return {
    initial: { ...REDUCED_INITIAL, ...variants.initial },
    animate: { ...REDUCED_ANIMATE, ...variants.animate },
    exit: { ...REDUCED_EXIT, ...variants.exit },
    transition: REDUCED_TRANSITION,
  } as unknown as T;
}

/**
 * usePresenceTransition — Standardised presence transition config
 * that respects reduced motion.
 */
export function usePresenceTransition() {
  const prefersReduced = usePrefersReducedMotion();

  return prefersReduced
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.1 },
      }
    : {
        initial: { opacity: 0, y: -6, scale: 0.97 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 4, scale: 0.97 },
        transition: { type: "spring", stiffness: 350, damping: 28 },
      };
}
