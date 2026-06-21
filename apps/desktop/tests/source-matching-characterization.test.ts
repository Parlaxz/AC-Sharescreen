import { describe, it, expect } from "vitest";
import { matchSourceByFingerprint } from "../src/main/capture-source-manager.js";

describe("Source matching (unique match required)", () => {
  it("matchSourceByFingerprint no longer matches windows by name", () => {
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
    expect(result).toBeNull();
  });
});
