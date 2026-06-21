import { describe, it, expect } from "vitest";
import { matchSourceByFingerprint } from "../src/main/capture-source-manager.js";

const screenA: SourceFingerprint = {
  kind: "screen",
  sourceId: "screen:12345",
  displayId: "display-0",
  name: "Screen 1",
};
const screenB: SourceFingerprint = {
  kind: "screen",
  sourceId: "screen:67890",
  displayId: "display-1",
  name: "Screen 2",
};
const windowFp: SourceFingerprint = {
  kind: "window",
  sourceId: "window:abcde",
  displayId: "",
  name: "Chrome",
};

type SourceFingerprint = {
  kind: "screen" | "window";
  sourceId: string;
  displayId: string;
  name: string;
};

describe("Source matching (unique match required)", () => {
  it("exact ID match returns exactMatch: true", () => {
    const sources = [
      { id: "screen:12345", name: "Screen 1", displayId: "display-0" },
    ];
    const result = matchSourceByFingerprint(screenA, sources);
    expect(result).toEqual({ id: "screen:12345", exactMatch: true });
  });

  it("exact ID match takes priority over displayId match", () => {
    const sources = [
      { id: "screen:99999", name: "Screen 1", displayId: "display-0" },
      { id: "screen:12345", name: "Renamed", displayId: "display-0" },
    ];
    const result = matchSourceByFingerprint(screenA, sources);
    expect(result).toEqual({ id: "screen:12345", exactMatch: true });
  });

  it("screen with one displayId match returns it", () => {
    const sources = [
      { id: "screen:99999", name: "Screen 1", displayId: "display-0" },
    ];
    const result = matchSourceByFingerprint(screenA, sources);
    expect(result).toEqual({ id: "screen:99999", exactMatch: false });
  });

  it("screen with zero displayId matches returns null", () => {
    const sources = [
      { id: "screen:99999", name: "Screen 1", displayId: "display-9" },
    ];
    const result = matchSourceByFingerprint(screenA, sources);
    expect(result).toBeNull();
  });

  it("screen with multiple displayId matches returns null", () => {
    const sources = [
      { id: "screen:99998", name: "Screen A", displayId: "display-0" },
      { id: "screen:99999", name: "Screen B", displayId: "display-0" },
    ];
    const result = matchSourceByFingerprint(screenA, sources);
    expect(result).toBeNull();
  });

  it("screen matches require id starts with screen:", () => {
    const sources = [
      { id: "window:99999", name: "Screen 1", displayId: "display-0" },
    ];
    const result = matchSourceByFingerprint(screenA, sources);
    expect(result).toBeNull();
  });

  it("windows no longer match by name alone", () => {
    const sources = [
      { id: "window:99999", name: "Chrome", displayId: "" },
    ];
    const result = matchSourceByFingerprint(windowFp, sources);
    expect(result).toBeNull();
  });
});
