// @vitest-environment node
/**
 * Tests for the SDK event-shape normalizers.
 *
 * The installed `@vdoninja/sdk` 1.3.18 emits events as Event objects whose
 * payload lives inside `event.detail`. The renderer's narrow SDK alias
 * must extract peer UUIDs and data from those event objects without ever
 * letting `String(event)` produce the literal `[object Object]`.
 */
import { describe, it, expect } from "vitest";
import { extractPeerUuid, extractDataAndUuid } from "../src/renderer/services/sdk-event-normalizer.js";

describe("extractPeerUuid", () => {
  it("accepts a direct string UUID", () => {
    const r = extractPeerUuid("peer-abc-123");
    expect(r).toEqual({ uuid: "peer-abc-123", valid: true, malformed: false });
  });

  it("rejects an empty string", () => {
    const r = extractPeerUuid("");
    expect(r.valid).toBe(false);
    expect(r.uuid).toBeNull();
  });

  it("rejects a whitespace-only string", () => {
    const r = extractPeerUuid("   ");
    expect(r.valid).toBe(false);
    expect(r.uuid).toBeNull();
  });

  it("rejects the literal '[object Object]'", () => {
    const r = extractPeerUuid("[object Object]");
    expect(r.valid).toBe(false);
    expect(r.uuid).toBeNull();
  });

  it("extracts uuid from an Event-style object with detail.uuid", () => {
    const r = extractPeerUuid({ detail: { uuid: "peer-abc-123" } });
    expect(r).toEqual({ uuid: "peer-abc-123", valid: true, malformed: false });
  });

  it("extracts uuid from a plain object with .uuid", () => {
    const r = extractPeerUuid({ uuid: "peer-xyz" });
    expect(r).toEqual({ uuid: "peer-xyz", valid: true, malformed: false });
  });

  it("extracts uuid from a CustomEvent-like shape", () => {
    const ev: { detail: { uuid: string; connection: unknown } } = {
      detail: { uuid: "peer-custom", connection: { id: "peer-custom" } },
    };
    const r = extractPeerUuid(ev);
    expect(r.uuid).toBe("peer-custom");
    expect(r.valid).toBe(true);
  });

  it("rejects an object whose detail.uuid is empty", () => {
    const r = extractPeerUuid({ detail: { uuid: "" } });
    expect(r.valid).toBe(false);
    expect(r.uuid).toBeNull();
  });

  it("rejects a plain object that lacks any uuid field", () => {
    const r = extractPeerUuid({ foo: "bar" });
    expect(r.valid).toBe(false);
    expect(r.uuid).toBeNull();
  });

  it("rejects non-string non-object values", () => {
    expect(extractPeerUuid(42).valid).toBe(false);
    expect(extractPeerUuid(null).valid).toBe(false);
    expect(extractPeerUuid(undefined).valid).toBe(false);
    expect(extractPeerUuid(true).valid).toBe(false);
  });

  it("rejects `String({detail:{uuid:'x'}})` like the renderer would", () => {
    // What happens if the renderer accidentally did String(eventObject)?
    const ev = { detail: { uuid: "peer-x" } };
    const directString = String(ev); // → "[object Object]"
    const r = extractPeerUuid(directString);
    expect(r.valid).toBe(false);
    // The would-be UUID is never a peer identifier
    expect(r.uuid).toBeNull();
  });
});

describe("extractDataAndUuid", () => {
  it("extracts data and uuid from a single-arg Event object", () => {
    const data = { type: "group.hello", foo: "bar" };
    const r = extractDataAndUuid({ detail: { data, uuid: "peer-1" } }, undefined);
    expect(r.data).toBe(data);
    expect(r.uuid).toBe("peer-1");
    expect(r.malformed).toBe(false);
  });

  it("extracts data and uuid from a 2-arg callback (data, peerUuid)", () => {
    const data = { type: "stream.started" };
    const r = extractDataAndUuid(data, "peer-2");
    expect(r.data).toBe(data);
    expect(r.uuid).toBe("peer-2");
    expect(r.malformed).toBe(false);
  });

  it("returns malformed when peerArg is '[object Object]'", () => {
    const r = extractDataAndUuid({ some: "payload" }, "[object Object]");
    expect(r.malformed).toBe(true);
    expect(r.uuid).toBeNull();
  });

  it("returns malformed when no UUID can be located", () => {
    const r = extractDataAndUuid({ some: "payload" }, undefined);
    expect(r.malformed).toBe(true);
    expect(r.uuid).toBeNull();
  });

  it("extracts uuid when data carries a detail payload with uuid", () => {
    const r = extractDataAndUuid(
      { detail: { data: { type: "x" }, uuid: "peer-3" } },
      undefined,
    );
    expect(r.data).toEqual({ type: "x" });
    expect(r.uuid).toBe("peer-3");
  });

  it("treats a single-arg object with .uuid and .data as valid", () => {
    const r = extractDataAndUuid(
      { uuid: "peer-4", data: { type: "stream.heartbeat" } },
      undefined,
    );
    expect(r.uuid).toBe("peer-4");
    expect(r.malformed).toBe(false);
  });
});
