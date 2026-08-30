import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_INPUT_PERMISSIONS,
  RemoteInputPermissionsSchema,
  StreamStartedPayloadSchema,
  StreamInputPermissionsChangedPayloadSchema,
  ViewerInputRequestPayloadSchema,
  createDefaultRemoteInputPermissions,
  normalizeRemoteInputPermissions,
} from "@screenlink/shared";

const permissions = {
  arrowLeft: true,
  arrowRight: false,
  space: true,
  d: false,
  s: true,
};

describe("remote input contracts", () => {
  it("defaults to a fresh all-denied policy", () => {
    const first = createDefaultRemoteInputPermissions();
    first.space = true;
    expect(createDefaultRemoteInputPermissions()).toEqual(DEFAULT_REMOTE_INPUT_PERMISSIONS);
    expect(first).not.toBe(DEFAULT_REMOTE_INPUT_PERMISSIONS);
  });

  it("validates and copies a complete permissions policy", () => {
    const copied = normalizeRemoteInputPermissions(permissions);
    expect(copied).toEqual(permissions);
    expect(copied).not.toBe(permissions);
    expect(() => normalizeRemoteInputPermissions({ ...permissions, extra: true })).toThrow();
    expect(RemoteInputPermissionsSchema.safeParse(permissions).success).toBe(true);
  });

  it("keeps omitted lifecycle permissions backward compatible", () => {
    const result = StreamStartedPayloadSchema.safeParse({
      logicalStreamId: "stream",
      mediaSessionId: "session",
      groupId: "group",
      hostDeviceId: "host",
      hostDisplayName: "Host",
      sourceKind: "screen",
      sourceName: "Display",
      startedAt: 1,
      appliedSettingsRevision: 0,
      heartbeatSequence: 0,
      streamRevision: 0,
      mediaJoinMetadata: "",
      replacesSessionId: null,
    });
    expect(result.success).toBe(true);
  });

  it("strictly validates permission-change and viewer-request payloads", () => {
    expect(StreamInputPermissionsChangedPayloadSchema.safeParse({
      groupId: "group",
      logicalStreamId: "stream",
      permissions,
    }).success).toBe(true);
    expect(ViewerInputRequestPayloadSchema.safeParse({
      groupId: "group",
      logicalStreamId: "stream",
      viewerDeviceId: "viewer",
      key: "ArrowLeft",
      permissions,
    }).success).toBe(false);
  });
});
