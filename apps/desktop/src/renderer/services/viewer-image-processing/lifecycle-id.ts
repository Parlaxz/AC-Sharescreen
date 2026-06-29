// SPDX-License-Identifier: MIT
/**
 * Monotonic ID generation and dev-gated structured logging for lifecycle
 * observability across the GPU enhancement pipeline.
 */

let _nextId = 0;

/**
 * Returns a monotonically increasing identifier for stable instance tracking
 * across logs and diagnostics. Starts at 1. Not suitable for crypto/security.
 */
export function nextMonotonicId(): number {
  _nextId += 1;
  return _nextId;
}

// ─── Dev-gated structured logging ─────────────────────────────────────────

let _loggingEnabled = false;

/** Enable lifecycle logging (typically called during test setup or dev mode). */
export function enableLifecycleLogging(): void {
  _loggingEnabled = true;
}

/** Disable lifecycle logging. */
export function disableLifecycleLogging(): void {
  _loggingEnabled = false;
}

const LOG_PREFIX = "[lc]";

/**
 * Emit a structured lifecycle log entry.
 * In production this is a no-op unless enableLifecycleLogging() has been called.
 *
 * @param source  Short string identifying the class/component (e.g. "Processor", "Backend", "Surface")
 * @param event   Short event name (e.g. "mount", "destroy", "videoElementChange")
 * @param details Optional key-value pairs with captured previous/current values
 */
export function lifecycleLog(
  source: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  if (!_loggingEnabled) return;
  const ts = performance.now().toFixed(1);
  if (details && Object.keys(details).length > 0) {
    console.debug(`${LOG_PREFIX}[${source}] [${ts}ms] ${event}`, details);
  } else {
    console.debug(`${LOG_PREFIX}[${source}] [${ts}ms] ${event}`);
  }
}
