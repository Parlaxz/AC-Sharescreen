import React, { useEffect, useState } from "react";
import { useStore } from "../stores/main-store.js";
import { getGroupConnectionManager } from "../App.js";

interface GroupRecord {
  groupId: string;
  controlRoomId: string;
  encryptedGroupSecret: string;
  sharedState: {
    name: { value: string };
    members: Record<string, { deviceId: string; displayName: string }>;
  };
  notificationsEnabled: boolean;
}

export function Groups() {
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const setSelectedGroupId = useStore((s) => s.setSelectedGroupId);
  const connectionStateById = useStore((s) => s.groupConnectionStateById);
  const onlineDeviceIdsByGroup = useStore((s) => s.onlineDeviceIdsByGroup);

  const refresh = async () => {
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (!api) return;
    const list = (await api.listGroups()) as GroupRecord[];
    setGroups(list);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onConnectGroup = async (record: GroupRecord) => {
    const api = (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;
    if (!api) return;
    const config = await api.getGroupConnectionConfig(record.groupId) as { groupId: string; controlRoomId: string; groupSecret: string; nodeId: string } | null;
    if (!config) return;
    const identity = await api.getDeviceIdentity();
    if (!identity) return;
    const connManager = getGroupConnectionManager();
    if (connManager) {
      await connManager.addGroup({
        groupId: config.groupId,
        controlRoomId: config.controlRoomId,
        groupSecret: config.groupSecret,
        nodeId: identity.deviceId,
        displayName: identity.displayName,
      });
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
      await refresh();
      if (result.record) {
        await onConnectGroup(result.record);
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
      await refresh();
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
    const connManager = getGroupConnectionManager();
    if (connManager) {
      await connManager.removeGroup(groupId);
    }
    await api.leaveGroup(groupId);
    await refresh();
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

      {error && <p className="error">{error}</p>}

      <div className="group-list">
        {groups.length === 0 ? (
          <p>You have no groups yet. Create or join a group to start sharing.</p>
        ) : (
          groups.map((g) => {
            const onlineIds = onlineDeviceIdsByGroup[g.groupId] ?? [];
            const connState = connectionStateById[g.groupId];
            const members = Object.values(g.sharedState?.members ?? {});
            return (
              <div
                key={g.groupId}
                className={`group-card card ${selectedGroupId === g.groupId ? "selected" : ""}`}
                onClick={() => setSelectedGroupId(g.groupId)}
              >
                <h3>{g.sharedState?.name?.value ?? "(unnamed)"}</h3>
                <p className="connection-state">
                  {connState ? connState.state : "idle"} · {onlineIds.length} online · {members.length} known user{members.length === 1 ? "" : "s"}
                </p>
                <div className="member-list compact">
                  {sortedMembers(g.sharedState?.members ?? {}, onlineIds).slice(0, 8).map((m) => (
                    <span key={m.deviceId} className={`member-tag ${onlineIds.includes(m.deviceId) ? "online" : "offline"}`}>
                      {m.displayName}
                    </span>
                  ))}
                </div>
                <div className="actions">
                  <button onClick={(e) => { e.stopPropagation(); void onCopyInvite(g.groupId); }}>Copy Group Link</button>
                  <button disabled>Group Settings</button>
                  <button onClick={(e) => { e.stopPropagation(); void onLeaveGroup(g.groupId); }}>Leave Group</button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
