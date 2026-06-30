// SPDX-License-Identifier: MIT
/**
 * processor-api.ts
 *
 * Shared interface for exposing ViewerImageProcessor capabilities to
 * components (e.g. ViewerWorkspace) without importing the processor class
 * directly.  The EnhancedVideoSurface component populates a MutableRefObject
 * of this type when the processor is created, so the parent can subscribe
 * to frame events and await configuration acknowledgement for benchmark
 * orchestration.
 */

import type { FrameEventListener, ConfigAppliedEvent } from "./frame-events";

export interface ProcessorAPI {
  /**
   * Subscribe to per-frame lifecycle events from the active processor.
   * Returns an unsubscribe function.  The listener fires for every captured,
   * processed, dropped, or presented frame.
   */
  subscribeFrameEvents: (listener: FrameEventListener) => () => void;

  /**
   * Subscribe to configuration-applied events and resolve when the next
   * configuration is acknowledged by the backend, or null on timeout.
   * The subscription is automatically cleaned up after the first matching
   * event or timeout, so each call is isolated.
   *
   * @param timeoutMs  Maximum time to wait (default 5000).  Returns null
   *                   if the timeout fires before a config-applied event.
   */
  waitForConfigApplied: (timeoutMs?: number) => Promise<ConfigAppliedEvent | null>;
}
