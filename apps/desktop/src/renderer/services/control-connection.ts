/**
 * Phase 3: Pairing is removed. This stub exists only to satisfy legacy
 * renderer imports during the migration. The GroupConnectionManager will
 * replace this functionality in a follow-up.
 */

export type ControlConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected";

export interface ControlConnection {
  start(): void;
  stop(): void;
  status(): ControlConnectionStatus;
}

export function getControlConnection(): ControlConnection {
  return {
    start() {},
    stop() {},
    status() {
      return "disconnected";
    },
  };
}

export function destroyControlConnection(): void {}

export function restartControlConnection(): void {}
