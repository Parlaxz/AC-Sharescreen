import { app } from "electron";
import path from "path";
import fs from "fs";
import { SecureStore } from "./secure-store.js";
  import {
  GroupSharedStateSchema,
  HybridTimestampSchema,
  type GroupSharedState,
  type HybridTimestamp,
  makeLww,
  createDefaultGroupQualitySettings,
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
});

export interface LocalGroupRecord {
  groupId: string;
  controlRoomId: string;
  encryptedGroupSecret: string;
  sharedState: GroupSharedState;
  lastClock: HybridTimestamp;
  joinedAt: number;
  notificationsEnabled: boolean;
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

  private load(): Map<string, LocalGroupRecord> {
    const map = new Map<string, LocalGroupRecord>();
    const tryRead = (filePath: string): LocalGroupRecord[] | null => {
      if (!fs.existsSync(filePath)) return null;
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const validated: LocalGroupRecord[] = [];
        for (const item of parsed) {
          const result = LocalGroupRecordSchema.safeParse(item);
          if (result.success) {
            validated.push(result.data as LocalGroupRecord);
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

  create(input: {
    groupId: string;
    controlRoomId: string;
    groupSecret: string;
    nodeId: string;
    groupName: string;
    joinedAt?: number;
  }): LocalGroupRecord {
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
      name: makeLww(input.groupName, initialStamp, input.nodeId),
      defaultQuality: makeLww(
        createDefaultGroupQualitySettings(),
        initialStamp,
        input.nodeId,
      ),
      members: {},
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
    };
    this.records.set(input.groupId, record);
    this.persist();
    return record;
  }

  import(input: {
    invite: {
      groupId: string;
      controlRoomId: string;
      groupSecret: string;
      bootstrapName: string;
      bootstrapNameStamp: HybridTimestamp;
      bootstrapSettings: ReturnType<typeof createDefaultGroupQualitySettings>;
      bootstrapSettingsStamp: HybridTimestamp;
    };
    nodeId: string;
    joinedAt?: number;
  }): LocalGroupRecord {
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
      name: makeLww(input.invite.bootstrapName, input.invite.bootstrapNameStamp, ""),
      defaultQuality: makeLww(
        input.invite.bootstrapSettings,
        input.invite.bootstrapSettingsStamp,
        "",
      ),
      members: {},
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

  leave(groupId: string): void {
    if (!this.records.has(groupId)) return;
    this.records.delete(groupId);
    this.persist();
  }
}
