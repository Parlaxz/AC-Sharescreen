import { describe, it, expect } from "vitest";
import {
  parseViewerUrl,
  buildViewerUrl,
  isViewerUrl,
} from "@screenlink/shared";

describe("parseViewerUrl", () => {
  it("parses basic viewer url fragment", () => {
    const result = parseViewerUrl("#v=1&share=abc123&token=xyz789");
    expect(result).toEqual({
      version: 1,
      shareId: "abc123",
      token: "xyz789",
    });
  });

  it("parses viewer url with all optional params", () => {
    const result = parseViewerUrl(
      "#v=1&share=abc&token=def&name=Ahmed&preset=egypt-data-saver",
    );
    expect(result).toEqual({
      version: 1,
      shareId: "abc",
      token: "def",
      name: "Ahmed",
      preset: "egypt-data-saver",
    });
  });

  it("returns null for empty string", () => {
    expect(parseViewerUrl("")).toBeNull();
  });

  it("returns null for invalid fragment", () => {
    expect(parseViewerUrl("#invalid")).toBeNull();
  });

  it("returns null when share param is missing", () => {
    expect(parseViewerUrl("#v=1&token=abc")).toBeNull();
  });

  it("returns null when token param is missing", () => {
    expect(parseViewerUrl("#v=1&share=abc")).toBeNull();
  });

  it("returns null when version is not 1", () => {
    expect(parseViewerUrl("#v=2&share=abc&token=def")).toBeNull();
  });
});

describe("buildViewerUrl", () => {
  it("builds a correct viewer URL with fragment", () => {
    const url = buildViewerUrl("https://viewer.app", {
      version: 1,
      shareId: "abc",
      token: "def",
    });
    expect(url).toBe("https://viewer.app#v=1&share=abc&token=def");
  });

  it("builds URL with optional name and preset", () => {
    const url = buildViewerUrl("https://viewer.app", {
      version: 1,
      shareId: "abc",
      token: "def",
      name: "Ahmed",
      preset: "egypt-data-saver",
    });
    expect(url).toBe(
      "https://viewer.app#v=1&share=abc&token=def&name=Ahmed&preset=egypt-data-saver",
    );
  });

  it("strips trailing slash from base URL", () => {
    const url = buildViewerUrl("https://viewer.app/", {
      version: 1,
      shareId: "x",
      token: "y",
    });
    expect(url).toBe("https://viewer.app#v=1&share=x&token=y");
  });
});

describe("isViewerUrl", () => {
  it("returns true for valid viewer url", () => {
    expect(isViewerUrl("#v=1&share=x")).toBe(true);
  });

  it("returns false for other fragments", () => {
    expect(isViewerUrl("#other")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isViewerUrl("")).toBe(false);
  });
});
