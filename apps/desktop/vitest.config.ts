import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    // Use forked processes per file to prevent vi.mock module caching
    // conflicts when multiple test files mock the same module
    // (e.g. @screenlink/vdo-adapter).
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
});
