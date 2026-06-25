import React, { useState } from "react";
import { useStore } from "../stores/main-store.js";
import { getRuntime } from "../services/phase3-runtime.js";
import type { GroupSharedState, HybridTimestamp } from "@screenlink/shared";
import { GroupSettingsDialog } from "../components/GroupSettingsDialog.js";

interface GroupRecord {
  groupId: string;
  controlRoomId: string;
  encryptedGroupSecret: string;
  sharedState: GroupSharedState;
  lastClock: HybridTimestamp;
  notificationsEnabled: boolean;
}

export function Groups() {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsGroupId, setSettingsGroupId] = useState<string | null>(null);

  // Store-driven: read groups from normalized store, not from local state
  const groupsById = useStore((s) => s.groupsById);
  const groupOrder = useStore((s) => s.groupOrder);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const setSelectedGroupId = useStore((s) => s.setSelectedGroupId);
  const connectionStateById = useStore((s) => s.groupConnectionStateById);
  const onlineDeviceIdsByGroup = useStore((s) => s.onlineDeviceIdsByGroup);

  // Helper: add group to store
  const addGroupToStore = (groupId: string, name: string, members: Record<string, { deviceId: string; displayName: string }>) => {
    const store = useStore.getState();
    const groupsById = { ...store.groupsById };
    const groupOrder = [...store.groupOrder];
    groupsById[groupId] = { id: groupId, name, members };
    if (!groupOrder.includes(groupId)) groupOrder.push(groupId);
    store.setGroups(groupsById, groupOrder);
  };

  // Helper: remove group from store
  const removeGroupFromStore = (groupId: string) => {
    const store = useStore.getState();
    const groupsById = { ...store.groupsById };
    const groupOrder = [...store.groupOrder];
    delete groupsById[groupId];
    store.setGroups(groupsById, groupOrder.filter((id) => id !== groupId));
  };

  const onConnectGroup = async (record: GroupRecord) => {
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (!api) return;
    const [config, identity] = await Promise.all([
      api.getGroupConnectionConfig(record.groupId) as Promise<{ groupId: string; controlRoomId: string; groupSecret: string; nodeId: string } | null>,
      api.getDeviceIdentity(),
    ]);
    if (!config || !identity) return;
    const runtime = getRuntime();
    if (runtime) {
      await runtime.addGroup(
        {
          groupId: config.groupId,
          controlRoomId: config.controlRoomId,
          groupSecret: config.groupSecret,
          nodeId: identity.deviceId,
          displayName: identity.displayName,
        },
        record.sharedState,
        record.lastClock,
      );
    }
  };

  const onCreate = async () => {
    setError(null);
    try {
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      if (!api) return;
      const result = (await api.createGroup({ groupName: newName.trim() || "Group" })) as { record: GroupRecord; invite: unknown; link?: string };
      if (result.invite) {
        const link = (result as unknown as { invite: { groupId: string }; link?: string }).link;
        setInviteLink(link ?? null);
      }
      setNewName("");
      setCreating(false);

      // Update store immediately with the new group
      if (result.record) {
        const record = result.record;
        addGroupToStore(
          record.groupId,
          record.sharedState.name.value,
          Object.fromEntries(
            Object.entries(record.sharedState.members).map(([k, v]) => [
              k,
              { deviceId: v.deviceId, displayName: v.displayName },
            ]),
          ),
        );
        await onConnectGroup(record);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const onJoin = async () => {
    setError(null);
    try {
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      if (!api) return;
      const record = (await api.joinGroup({ link: joinLink.trim() })) as GroupRecord;
      setJoinLink("");
      setJoining(false);

      // Update store immediately with the joined group
      addGroupToStore(
        record.groupId,
        record.sharedState.name.value,
        Object.fromEntries(
          Object.entries(record.sharedState.members).map(([k, v]) => [
            k,
            { deviceId: v.deviceId, displayName: v.displayName },
          ]),
        ),
      );
      await onConnectGroup(record);
    } catch (e) {
      setError(String(e));
    }
  };

  const onCopyInvite = async (groupId: string) => {
    try {
      const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
      if (!api) return;
      const result = (await api.getGroupInvite(groupId)) as { link: string } | null;
      if (result?.link) {
        await navigator.clipboard.writeText(result.link);
        setInviteLink(result.link);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const onLeaveGroup = async (groupId: string) => {
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (!api) return;
    const runtime = getRuntime();
    if (runtime) {
      await runtime.removeGroup(groupId);
    }
    await api.leaveGroup(groupId);
    removeGroupFromStore(groupId);
  };

  const sortedMembers = (members: Record<string, { deviceId: string; displayName: string }>, online: string[]) => {
    const all = Object.values(members);
    const onlineSet = new Set(online);
    const onlineList = all.filter((m) => onlineSet.has(m.deviceId));
    const offlineList = all.filter((m) => !onlineSet.has(m.deviceId));
    return [
      ...onlineList.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      ...offlineList.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    ];
  };

  const groups = groupOrder.map((id) => groupsById[id]).filter(Boolean);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Groups</h1>
        <div className="actions">
          <button onClick={() => setCreating(true)}>Create Group</button>
          <button onClick={() => setJoining(true)}>Join Group</button>
        </div>
      </header>

      {creating && (
        <div className="dialog card">
          <h2>Create Group</h2>
          <input
            type="text"
            placeholder="Group name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={100}
          />
          <div className="actions">
            <button onClick={onCreate}>Create</button>
            <button onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      )}

      {joining && (
        <div className="dialog card">
          <h2>Join Group</h2>
          <input
            type="text"
            placeholder="Paste group link or code"
            value={joinLink}
            onChange={(e) => setJoinLink(e.target.value)}
          />
          <div className="actions">
            <button onClick={onJoin}>Join Group</button>
            <button onClick={() => setJoining(false)}>Cancel</button>
          </div>
        </div>
      )}

      {inviteLink && (
        <div className="dialog card">
          <h2>Group Created</h2>
          <p>Copy this link and share it with anyone you want to invite.</p>
          <textarea readOnly value={inviteLink} rows={3} />
          <div className="actions">
            <button onClick={async () => { await navigator.clipboard.writeText(inviteLink); }}>Copy Group Link</button>
            <button onClick={() => setInviteLink(null)}>Done</button>
          </div>
        </div>
      )}

      {settingsGroupId && (
        <GroupSettingsDialog
          groupId={settingsGroupId}
          onClose={() => setSettingsGroupId(null)}
        />
      )}

      {error && <p className="error">{error}</p>}

      <div className="group-list">
        {groups.length === 0 ? (
          <p>You have no groups yet. Create or join a group to start sharing.</p>
        ) : (
          groups.map((g) => {
            const onlineIds = onlineDeviceIdsByGroup[g.id] ?? [];
            const connState = connectionStateById[g.id];
            const membersList = Object.values(g.members);
            return (
              <div
                key={g.id}
                className={`group-card card ${selectedGroupId === g.id ? "selected" : ""}`}
                onClick={() => setSelectedGroupId(g.id)}
              >
                <h3>{g.name || "(unnamed)"}</h3>
                <p className="connection-state">
                  {connState ? connState.state : "idle"} · {onlineIds.length} online · {membersList.length} known user{membersList.length === 1 ? "" : "s"}
                </p>
                <div className="member-list compact">
                  {sortedMembers(g.members, onlineIds).slice(0, 8).map((m) => (
                    <span key={m.deviceId} className={`member-tag ${onlineIds.includes(m.deviceId) ? "online" : "offline"}`}>
                      {m.displayName}
                    </span>
                  ))}
                </div>
                <div className="actions">
                  <button onClick={(e) => { e.stopPropagation(); void onCopyInvite(g.id); }}>Copy Group Link</button>
                  <button onClick={(e) => {
                    e.stopPropagation();
                    setSettingsGroupId(g.id);
                  }}>Group Settings</button>
                  <button onClick={(e) => { e.stopPropagation(); void onLeaveGroup(g.id); }}>Leave Group</button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
