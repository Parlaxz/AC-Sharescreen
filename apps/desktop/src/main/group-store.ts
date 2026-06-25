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

const LocalGroupRecordSchema = z.object({
  groupId: z.string().uuid(),
  controlRoomId: z.string().min(1),
  encryptedGroupSecret: z.string().min(1),
  sharedState: GroupSharedStateSchema,
  lastClock: HybridTimestampSchema,
  joinedAt: z.number().int().positive(),
  notificationsEnabled: z.boolean(),
  creatorDeviceId: z.string().optional(),
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
  private records: Map<string, LocalGroupRecord>;
  private secureStore: SecureStore;

  constructor(secureStore: SecureStore, basePath?: string) {
    this.secureStore = secureStore;
    const userData = basePath ?? app.getPath("userData");
    this.filePath = path.join(userData, "groups.json");
    this.backupPath = path.join(userData, "groups.json.bak");
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
    const tryRead = (filePath: string): LocalGroupRecord[] | null => {
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
        if (needsPersist && validated.length > 0) {
          // Persist migrated data silently
          try {
            this.writeAtomic(validated);
          } catch {
            // best-effort
          }
        }
        return validated;
      } catch {
        return null;
      }
    };

    let records = tryRead(this.filePath);
    if (!records) {
      records = tryRead(this.backupPath);
      if (records) {
        try {
          this.writeAtomic(records);
        } catch {
          // best-effort recovery
        }
      }
    }
    if (!records) records = [];
    for (const r of records) {
      map.set(r.groupId, r);
    }
    return map;
  }

  private writeAtomic(records: LocalGroupRecord[]): void {
    const tmpPath = this.filePath + ".tmp";
    const json = JSON.stringify(records, null, 2);
    fs.writeFileSync(tmpPath, json, "utf-8");
    if (fs.existsSync(this.filePath)) {
      fs.copyFileSync(this.filePath, this.backupPath);
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  private persist(): void {
    this.writeAtomic(Array.from(this.records.values()));
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
    this.records.set(input.groupId, record);
    this.persist();
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
    this.records.set(input.invite.groupId, record);
    this.persist();
    return record;
  }

  updateSharedState(groupId: string, state: GroupSharedState): void {
    const record = this.records.get(groupId);
    if (!record) return;
    record.sharedState = state;
    this.persist();
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
    record.lastClock = incoming;
    this.persist();
  }

  setNotificationsEnabled(groupId: string, enabled: boolean): void {
    const record = this.records.get(groupId);
    if (!record) return;
    record.notificationsEnabled = enabled;
    this.persist();
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
        bootstrapName: record.sharedState.name.value,
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
    this.records.delete(groupId);
    this.persist();
  }
}
