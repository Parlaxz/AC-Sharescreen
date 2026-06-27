// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  normalizeShortcutBinding,
  sendShortcutWithFallback,
  type ShortcutBinding,
} from "../src/main/shortcut-sender.js";

describe("shortcut sender", () => {
  it("normalizes modifier casing and key casing", () => {
    const binding: ShortcutBinding = {
      modifiers: ["Alt" as never, "SHIFT" as never],
      key: "m",
    };

    expect(normalizeShortcutBinding(binding)).toEqual({
      modifiers: ["alt", "shift"],
      key: "M",
    });
  });

  it("uses the helper path when the helper succeeds", async () => {
    const helper = {
      sendShortcut: vi.fn().mockResolvedValue({ success: true }),
    };
    const directSend = vi.fn().mockResolvedValue({ success: true, source: "direct" });

    const result = await sendShortcutWithFallback(
      { modifiers: ["alt"], key: "M" },
      {
        currentHelper: helper,
        ensureHelper: vi.fn(),
        directSend,
      },
    );

    expect(helper.sendShortcut).toHaveBeenCalledWith(["alt"], "M");
    expect(directSend).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, source: "helper" });
  });

  it("falls back to direct SendInput when helper startup fails", async () => {
    const ensureHelper = vi.fn().mockRejectedValue(new Error("helper startup failed"));
    const directSend = vi.fn().mockResolvedValue({ success: true, source: "direct" });

    const result = await sendShortcutWithFallback(
      { modifiers: ["Alt" as never], key: "m" },
      {
        currentHelper: null,
        ensureHelper,
        directSend,
      },
    );

    expect(ensureHelper).toHaveBeenCalledOnce();
    expect(directSend).toHaveBeenCalledWith({ modifiers: ["alt"], key: "M" });
    expect(result).toEqual({ success: true, source: "direct" });
  });

  it("falls back to direct SendInput when helper send fails", async () => {
    const helper = {
      sendShortcut: vi.fn().mockResolvedValue({ success: false, error: "uipi-blocked" }),
    };
    const directSend = vi.fn().mockResolvedValue({ success: true, source: "direct" });

    const result = await sendShortcutWithFallback(
      { modifiers: ["alt"], key: "D" },
      {
        currentHelper: helper,
        ensureHelper: vi.fn(),
        directSend,
      },
    );

    expect(helper.sendShortcut).toHaveBeenCalledWith(["alt"], "D");
    expect(directSend).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, source: "direct" });
  });

  it("returns a useful error when both helper and direct send fail", async () => {
    const helper = {
      sendShortcut: vi.fn().mockResolvedValue({ success: false, error: "helper-failed" }),
    };
    const directSend = vi.fn().mockResolvedValue({ success: false, error: "direct-failed" });

    const result = await sendShortcutWithFallback(
      { modifiers: ["alt"], key: "M" },
      {
        currentHelper: helper,
        ensureHelper: vi.fn(),
        directSend,
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("helper-failed");
    expect(result.error).toContain("direct-failed");
  });
});
