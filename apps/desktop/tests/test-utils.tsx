/**
 * Test utilities for ScreenLink desktop renderer tests.
 *
 * Provides a minimal environment for testing React components
 * without requiring a full JSDOM/browser setup.
 */
import React from "react";

// Re-export React Testing Library equivalents if available
export { React };

// Minimal screen/log helpers for node-env tests
export const screen = {
  getByText: (_text: string) => null,
  queryByText: (_text: string) => null,
};

export const fireEvent = {
  click: (_el: unknown) => {},
  change: (_el: unknown) => {},
};

export const waitFor = async (cb: () => unknown) => {
  await cb();
};

/**
 * Render a component in a non-DOM environment.
 * Returns the component function for inspection.
 */
export function renderComponent(Component: React.ComponentType<unknown>, _props: Record<string, unknown> = {}) {
  return { container: null, Component };
}

/**
 * Mock the screenlink API on window for tests.
 */
export function mockScreenlinkApi(overrides: Record<string, unknown> = {}): void {
  const api = {
    getSettings: () => Promise.resolve(null),
    updateSettings: (partial: Record<string, unknown>) => Promise.resolve(),
    getDeviceIdentity: () => Promise.resolve({ deviceId: "test-device", displayName: "Test User", createdAt: Date.now() }),
    updateDisplayName: (name: string) => Promise.resolve({ deviceId: "test-device", displayName: name, createdAt: Date.now() }),
    ...overrides,
  };
  (globalThis as any).__mockScreenlinkApi = api;
}
