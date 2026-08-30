import { app } from "electron";
import path from "path";
import fs from "fs";
import { SecureStore } from "./secure-store.js";
  import {
  GroupSharedStateSchema,
  HybridTimestampSchema,
  type GroupSharedState,
  type HybridTimestamp,
  makeLwwWithHash,
  createDefaultGroupQualitySettings,
  createDefaultVideoQualitySettings,
  createDefaultAudioEncodingSettings,
  formatGroupInviteLink,
  type GroupInviteV1,
} from "@screenlink/shared";
import { z } from "zod";

const RENAME_RETRY_WINDOW_MS = 250;
const RENAME_RETRY_DELAY_MS = 10;

const QuickShareSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["screen", "window"]),
  displayId: z.string().nullable(),
}).nullable();

const LocalGroupRecordSchema = z.object({
  groupId: z.string().uuid(),
  controlRoomId: z.string().min(1),
  encryptedGroupSecret: z.string().min(1),
  sharedState: GroupSharedStateSchema,
  lastClock: HybridTimestampSchema,
  joinedAt: z.number().int().positive(),
  notificationsEnabled: z.boolean(),
  creatorDeviceId: z.string().optional(),
  quickShareShortcut: z.string().nullable().optional(),
  quickJoinShortcut: z.string().nullable().optional(),
  quickShareSource: QuickShareSourceSchema.optional(),
  quickShareDefaultPresetId: z.string().nullable().optional(),
});

export interface LocalGroupRecord {
  groupId: string;
  controlRoomId: string;
  encryptedGroupSecret: string;
  sharedState: GroupSharedState;
  lastClock: HybridTimestamp;
  joinedAt: number;
  notificationsEnabled: boolean;
  creatorDeviceId?: string;
  quickShareShortcut?: string | null;
  quickJoinShortcut?: string | null;
  quickShareSource?: {
    id: string;
    name: string;
    kind: "screen" | "window";
    displayId: string | null;
  } | null;
  quickShareDefaultPresetId?: string | null;
}

export interface GroupConnectionConfig {
  groupId: string;
  controlRoomId: string;
  groupSecret: string;
  nodeId: string;
}

export class GroupStore {
  private filePath: string;
  private backupPath: string;
  private tempPath: string;
  private records: Map<string, LocalGroupRecord>;
  private secureStore: SecureStore;

  constructor(secureStore: SecureStore, basePath?: string) {
    this.secureStore = secureStore;
    const userData = basePath ?? app.getPath("userData");
    this.filePath = path.join(userData, "groups.json");
    this.backupPath = path.join(userData, "groups.json.bak");
    this.tempPath = this.filePath + ".tmp";
    this.records = this.load();
  }

  /**
   * Detect compact quality settings form (Phase 2/early Phase 3) and migrate
   * to the nested GroupQualitySettings schema with video/audio sub-objects.
   */
  private migrateCompactQuality(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const obj = value as Record<string, unknown>;
    // Compact form has videoBitrateKbps at the top level (not nested under "video")
    if ("videoBitrateKbps" in obj && typeof obj.videoBitrateKbps === "number" && !("schemaVersion" in obj)) {
      const video = createDefaultVideoQualitySettings();
      const audio = createDefaultAudioEncodingSettings();
      // Override from compact fields
      if (typeof obj.videoBitrateKbps === "number") video.videoBitrateKbps = obj.videoBitrateKbps as number;
      if (typeof obj.maxWidth === "number") video.sendWidth = obj.maxWidth as number;
      if (typeof obj.maxHeight === "number") video.sendHeight = obj.maxHeight as number;
      if (typeof obj.maxFps === "number") video.sendFps = obj.maxFps as number;
      if (typeof obj.captureWidth === "number") video.captureWidth = obj.captureWidth as number;
      if (typeof obj.captureHeight === "number") video.captureHeight = obj.captureHeight as number;
      if (typeof obj.captureFps === "number") video.captureFps = obj.captureFps as number;
      if (typeof obj.degradationPreference === "string") video.degradationPreference = obj.degradationPreference as never;
      if (typeof obj.contentHint === "string") video.contentHint = obj.contentHint as never;
      if (typeof obj.audioEnabled === "boolean") audio.fec = obj.audioEnabled as boolean;
      return { schemaVersion: 1 as const, video, audio };
    }
    return value;
  }

  private load(): Map<string, LocalGroupRecord> {
    const map = new Map<string, LocalGroupRecord>();
    const tryRead = (filePath: string): { records: LocalGroupRecord[]; needsPersist: boolean } | null => {
      if (!fs.existsSync(filePath)) return null;
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        let needsPersist = false;
        const validated: LocalGroupRecord[] = [];
        for (const item of parsed) {
          // Phase 2/early Phase 3 migration: convert compact quality settings
          if (item && typeof item === "object") {
            const itemObj = item as Record<string, unknown>;
            if (itemObj.sharedState && typeof itemObj.sharedState === "object") {
              const ss = itemObj.sharedState as Record<string, unknown>;
              if (ss.defaultQuality && typeof ss.defaultQuality === "object") {
                const dq = ss.defaultQuality as Record<string, unknown>;
                const migrated = this.migrateCompactQuality(dq.value);
                if (migrated !== dq.value) {
                  dq.value = migrated;
                  needsPersist = true;
                }
              }
            }
          }
          const result = LocalGroupRecordSchema.safeParse(item);
          if (result.success) {
            validated.push(result.data as LocalGroupRecord);
          }
        }
        return { records: validated, needsPersist: needsPersist && validated.length > 0 };
      } catch {
        return null;
      }
    };

    const primary = tryRead(this.filePath);
    const temp = tryRead(this.tempPath);
    let loaded = temp ?? primary;
    if (temp) {
      // A valid temp file is a complete pending snapshot from an interrupted
      // write, so prefer it over the possibly stale primary. Re-promote it
      // through the normal atomic path, but keep the in-memory snapshot if
      // promotion is still blocked by the filesystem.
      try {
        this.writeAtomic(temp.records, true);
      } catch {
        // best-effort recovery; the valid temp snapshot is still loaded below
      }
    } else if (primary) {
      if (primary.needsPersist) {
        try {
          this.writeAtomic(primary.records);
        } catch {
          // best-effort migration
        }
      }
    } else {
      loaded = tryRead(this.backupPath);
      if (loaded) {
        try {
          this.writeAtomic(loaded.records);
        } catch {
          // best-effort recovery
        }
      }
    }
    for (const r of loaded?.records ?? []) {
      map.set(r.groupId, r);
    }
    return map;
  }

  private writeAtomic(records: LocalGroupRecord[], preserveTempOnFailure = false): void {
    const tmpPath = this.tempPath;
    const json = JSON.stringify(records, null, 2);
    fs.writeFileSync(tmpPath, json, "utf-8");
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }
    const deadline = Date.now() + RENAME_RETRY_WINDOW_MS;
    let delayMs = RENAME_RETRY_DELAY_MS;
    try {
      while (true) {
        try {
          fs.renameSync(tmpPath, this.filePath);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if ((code !== "EPERM" && code !== "EBUSY") || Date.now() >= deadline) {
            throw error;
          }

          const remaining = deadline - Date.now();
          const delay = Math.min(delayMs, remaining);
          if (delay <= 0) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
          delayMs = Math.min(delayMs * 2, RENAME_RETRY_DELAY_MS * 4);
        }
      }
    } catch (error) {
      if (!preserveTempOnFailure) {
        // Do not remove the temp file while retries may still succeed. Once
        // the bounded retry window is exhausted, remove it when possible so a
        // stale temp file cannot be mistaken for a pending write.
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // Best effort: the original rename error is the useful failure.
        }
      }
      throw error;
    }
  }

  private persist(records: Map<string, LocalGroupRecord> = this.records): void {
    this.writeAtomic(Array.from(records.values()));
  }

  list(): LocalGroupRecord[] {
    return Array.from(this.records.values());
  }

  get(groupId: string): LocalGroupRecord | null {
    return this.records.get(groupId) ?? null;
  }

  async create(input: {
    groupId: string;
    controlRoomId: string;
    groupSecret: string;
    nodeId: string;
    groupName: string;
    joinedAt?: number;
    displayName?: string;
  }): Promise<LocalGroupRecord> {
    if (this.records.has(input.groupId)) {
      return this.records.get(input.groupId)!;
    }
    const joinedAt = input.joinedAt ?? Date.now();
    const now = joinedAt;
    const initialStamp: HybridTimestamp = {
      wallTimeMs: now,
      counter: 0,
      nodeId: input.nodeId,
    };
    const sharedState: GroupSharedState = {
      schemaVersion: 1,
      groupId: input.groupId,
      name: await makeLwwWithHash(input.groupName, initialStamp, input.nodeId),
      defaultQuality: await makeLwwWithHash(
        createDefaultGroupQualitySettings(),
        initialStamp,
        input.nodeId,
      ),
      members: {},
    };
    // Add creator as a member
    sharedState.members[input.nodeId] = {
      deviceId: input.nodeId,
      displayName: input.displayName ?? input.nodeId,
      firstSeenAt: joinedAt,
      profileStamp: initialStamp,
    };
    const encrypted = this.secureStore.encrypt(input.groupSecret);
    if (!encrypted) {
      throw new Error("Secure storage unavailable — cannot store group secret");
    }
    const record: LocalGroupRecord = {
      groupId: input.groupId,
      controlRoomId: input.controlRoomId,
      encryptedGroupSecret: encrypted.toString("base64"),
      sharedState,
      lastClock: initialStamp,
      joinedAt,
      notificationsEnabled: true,
      creatorDeviceId: input.nodeId,
    };
    const nextRecords = new Map(this.records);
    nextRecords.set(input.groupId, record);
    this.persist(nextRecords);
    this.records = nextRecords;
    return record;
  }

  async import(input: {
    invite: {
      groupId: string;
      controlRoomId: string;
      groupSecret: string;
      bootstrapName: string;
      bootstrapNameStamp: HybridTimestamp;
      bootstrapSettings: ReturnType<typeof createDefaultGroupQualitySettings>;
      bootstrapSettingsStamp: HybridTimestamp;
      bootstrapCreator: GroupInviteV1["bootstrapCreator"];
    };
    nodeId: string;
    displayName: string;
    joinedAt?: number;
  }): Promise<LocalGroupRecord> {
    if (this.records.has(input.invite.groupId)) {
      return this.records.get(input.invite.groupId)!;
    }
    const joinedAt = input.joinedAt ?? Date.now();
    const initialStamp: HybridTimestamp = {
      wallTimeMs: joinedAt,
      counter: 0,
      nodeId: input.nodeId,
    };
    const sharedState: GroupSharedState = {
      schemaVersion: 1,
      groupId: input.invite.groupId,
      name: await makeLwwWithHash(input.invite.bootstrapName, input.invite.bootstrapNameStamp, ""),
      defaultQuality: await makeLwwWithHash(
        input.invite.bootstrapSettings,
        input.invite.bootstrapSettingsStamp,
        "",
      ),
      members: {},
    };
    // Add bootstrap creator from invite as a member
    if (input.invite.bootstrapCreator) {
      const bc = input.invite.bootstrapCreator;
      sharedState.members[bc.deviceId] = {
        deviceId: bc.deviceId,
        displayName: bc.displayName,
        firstSeenAt: bc.firstSeenAt,
        profileStamp: bc.profileStamp,
      };
    }
    // Add self as a member
    sharedState.members[input.nodeId] = {
      deviceId: input.nodeId,
      displayName: input.displayName,
      firstSeenAt: joinedAt,
      profileStamp: initialStamp,
    };
    const encrypted = this.secureStore.encrypt(input.invite.groupSecret);
    if (!encrypted) {
      throw new Error("Secure storage unavailable — cannot store group secret");
    }
    const record: LocalGroupRecord = {
      groupId: input.invite.groupId,
      controlRoomId: input.invite.controlRoomId,
      encryptedGroupSecret: encrypted.toString("base64"),
      sharedState,
      lastClock: initialStamp,
      joinedAt,
      notificationsEnabled: true,
    };
    const nextRecords = new Map(this.records);
    nextRecords.set(input.invite.groupId, record);
    this.persist(nextRecords);
    this.records = nextRecords;
    return record;
  }

  updateSharedState(groupId: string, state: GroupSharedState): void {
    const record = this.records.get(groupId);
    if (!record) return;
    const updatedRecord = { ...record, sharedState: state };
    const nextRecords = new Map(this.records);
    nextRecords.set(groupId, updatedRecord);
    this.persist(nextRecords);
    Object.assign(record, updatedRecord);
  }

  updateClock(groupId: string, stamp: HybridTimestamp): void {
    const record = this.records.get(groupId);
    if (!record) return;
    const incoming: HybridTimestamp = {
      wallTimeMs: Math.max(record.lastClock.wallTimeMs, stamp.wallTimeMs),
      counter: Math.max(record.lastClock.counter, stamp.counter) + 1,
      nodeId: record.lastClock.nodeId,
    };
    if (stamp.wallTimeMs > record.lastClock.wallTimeMs) {
      incoming.counter = stamp.counter + 1;
    } else if (
      stamp.wallTimeMs === record.lastClock.wallTimeMs &&
      stamp.counter >= record.lastClock.counter
    ) {
      incoming.counter = stamp.counter + 1;
    }
    const updatedRecord = { ...record, lastClock: incoming };
    const nextRecords = new Map(this.records);
    nextRecords.set(groupId, updatedRecord);
    this.persist(nextRecords);
    Object.assign(record, updatedRecord);
  }

  setNotificationsEnabled(groupId: string, enabled: boolean): void {
    const record = this.records.get(groupId);
    if (!record) return;
    const updatedRecord = { ...record, notificationsEnabled: enabled };
    const nextRecords = new Map(this.records);
    nextRecords.set(groupId, updatedRecord);
    this.persist(nextRecords);
    Object.assign(record, updatedRecord);
  }

  getConnectionConfig(groupId: string, nodeId: string): GroupConnectionConfig | null {
    const record = this.records.get(groupId);
    if (!record) return null;
    try {
      const buf = Buffer.from(record.encryptedGroupSecret, "base64");
      const secret = this.secureStore.decrypt(buf);
      if (!secret) return null;
      return {
        groupId: record.groupId,
        controlRoomId: record.controlRoomId,
        groupSecret: secret,
        nodeId,
      };
    } catch {
      return null;
    }
  }

  getInviteLink(groupId: string): string | null {
    const record = this.records.get(groupId);
    if (!record) return null;
    try {
      const buf = Buffer.from(record.encryptedGroupSecret, "base64");
      const groupSecret = this.secureStore.decrypt(buf);
      if (!groupSecret) return null;
      // Resolve bootstrap creator from stored creatorDeviceId
      let bootstrapCreator: GroupInviteV1["bootstrapCreator"];
      const creatorId = record.creatorDeviceId;
      const creatorMember = creatorId ? record.sharedState.members[creatorId] : undefined;
      if (creatorMember) {
        bootstrapCreator = {
          deviceId: creatorMember.deviceId,
          displayName: creatorMember.displayName,
          firstSeenAt: creatorMember.firstSeenAt,
          profileStamp: creatorMember.profileStamp,
        };
      } else {
        // Fallback: use first member or empty (should not happen after migration)
        const firstMember = Object.values(record.sharedState.members)[0];
        if (firstMember) {
          bootstrapCreator = {
            deviceId: firstMember.deviceId,
            displayName: firstMember.displayName,
            firstSeenAt: firstMember.firstSeenAt,
            profileStamp: firstMember.profileStamp,
          };
        } else {
          bootstrapCreator = {
            deviceId: "",
            displayName: "",
            firstSeenAt: 0,
            profileStamp: { wallTimeMs: 0, counter: 0, nodeId: "" },
          };
        }
      }

      const invite: GroupInviteV1 = {
        version: 1,
        groupId: record.groupId,
        controlRoomId: record.controlRoomId,
        groupSecret,
        bootstrapName: record.sharedState.name.value.trim().slice(0, 100),
        bootstrapNameStamp: record.sharedState.name.stamp,
        bootstrapSettings: record.sharedState.defaultQuality.value,
        bootstrapSettingsStamp: record.sharedState.defaultQuality.stamp,
        bootstrapCreator,
      };
      return formatGroupInviteLink(invite);
    } catch {
      return null;
    }
  }

  leave(groupId: string): void {
    if (!this.records.has(groupId)) return;
    const nextRecords = new Map(this.records);
    nextRecords.delete(groupId);
    this.persist(nextRecords);
    this.records = nextRecords;
  }

  // ── Per-group quick action shortcut settings ───────────────────────────

  getQuickShareShortcut(groupId: string): string | null {
    return this.records.get(groupId)?.quickShareShortcut ?? null;
  }

  getQuickJoinShortcut(groupId: string): string | null {
    return this.records.get(groupId)?.quickJoinShortcut ?? null;
  }

  getQuickShareSource(groupId: string): LocalGroupRecord["quickShareSource"] {
    return this.records.get(groupId)?.quickShareSource ?? null;
  }

  getQuickShareDefaultPresetId(groupId: string): string | null {
    return this.records.get(groupId)?.quickShareDefaultPresetId ?? null;
  }

  getGroupShortcutConfig(groupId: string): {
    quickShareShortcut: string | null;
    quickJoinShortcut: string | null;
    quickShareSource: LocalGroupRecord["quickShareSource"];
    quickShareDefaultPresetId: string | null;
  } {
    const record = this.records.get(groupId);
    if (!record) {
      return { quickShareShortcut: null, quickJoinShortcut: null, quickShareSource: null, quickShareDefaultPresetId: null };
    }
    return {
      quickShareShortcut: record.quickShareShortcut ?? null,
      quickJoinShortcut: record.quickJoinShortcut ?? null,
      quickShareSource: record.quickShareSource ?? null,
      quickShareDefaultPresetId: record.quickShareDefaultPresetId ?? null,
    };
  }

  updateGroupShortcutConfig(
    groupId: string,
    config: {
      quickShareShortcut?: string | null;
      quickJoinShortcut?: string | null;
      quickShareSource?: { id: string; name: string; kind: "screen" | "window"; displayId: string | null } | null;
      quickShareDefaultPresetId?: string | null;
    },
  ): void {
    const record = this.records.get(groupId);
    if (!record) return;
    const updatedRecord = { ...record };
    if ("quickShareShortcut" in config) updatedRecord.quickShareShortcut = config.quickShareShortcut ?? null;
    if ("quickJoinShortcut" in config) updatedRecord.quickJoinShortcut = config.quickJoinShortcut ?? null;
    if ("quickShareSource" in config) updatedRecord.quickShareSource = config.quickShareSource ?? null;
    if ("quickShareDefaultPresetId" in config) updatedRecord.quickShareDefaultPresetId = config.quickShareDefaultPresetId ?? null;
    const nextRecords = new Map(this.records);
    nextRecords.set(groupId, updatedRecord);
    this.persist(nextRecords);
    Object.assign(record, updatedRecord);
  }
}
