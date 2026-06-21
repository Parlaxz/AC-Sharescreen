import { describe, it, expect } from "vitest";
import {
  ScreenLinkError,
  ValidationError,
  CompatibilityError,
  ProtocolError,
} from "@screenlink/shared";

describe("ScreenLinkError", () => {
  it("has correct properties", () => {
    const err = new ScreenLinkError("CUSTOM_CODE", "custom error message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ScreenLinkError");
    expect(err.code).toBe("CUSTOM_CODE");
    expect(err.message).toBe("custom error message");
    expect(err.details).toEqual({});
  });

  it("accepts optional details", () => {
    const err = new ScreenLinkError("CODE", "msg", { foo: "bar" });
    expect(err.details).toEqual({ foo: "bar" });
  });

  it("toJSON returns the correct shape", () => {
    const err = new ScreenLinkError("CODE", "msg", { key: "val" });
    expect(err.toJSON()).toEqual({
      name: "ScreenLinkError",
      code: "CODE",
      message: "msg",
      details: { key: "val" },
    });
  });
});

describe("ValidationError", () => {
  it("extends ScreenLinkError with VALIDATION_ERROR code", () => {
    const err = new ValidationError("invalid input");
    expect(err).toBeInstanceOf(ScreenLinkError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ValidationError");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("invalid input");
    expect(err.details).toEqual({});
  });
});

describe("CompatibilityError", () => {
  it("extends ScreenLinkError with COMPATIBILITY_ERROR code", () => {
    const err = new CompatibilityError("incompatible browser");
    expect(err).toBeInstanceOf(ScreenLinkError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CompatibilityError");
    expect(err.code).toBe("COMPATIBILITY_ERROR");
    expect(err.message).toBe("incompatible browser");
    expect(err.details).toEqual({});
  });
});

describe("ProtocolError", () => {
  it("extends ScreenLinkError with PROTOCOL_ERROR code", () => {
    const err = new ProtocolError("unexpected message");
    expect(err).toBeInstanceOf(ScreenLinkError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProtocolError");
    expect(err.code).toBe("PROTOCOL_ERROR");
    expect(err.message).toBe("unexpected message");
    expect(err.details).toEqual({});
  });
});
