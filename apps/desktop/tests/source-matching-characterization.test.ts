import { describe, it, expect } from "vitest";
import { matchSourceByFingerprint } from "../src/main/capture-source-manager.js";

describe("Current source matching behavior (characterization)", () => {
  it("matchSourceByFingerprint matches windows by name as fallback", () => {
    const fingerprint = {
      kind: "window" as const,
      sourceId: "window:12345",
      displayId: "",
      name: "Chrome",
    };
    const sources = [
      { id: "window:99999", name: "Chrome", displayId: "" },
    ];
    const result = matchSourceByFingerprint(fingerprint, sources);
    expect(result).not.toBeNull();
    expect(result!.exactMatch).toBe(false);
    expect(result!.id).toBe("window:99999");
  });
});
