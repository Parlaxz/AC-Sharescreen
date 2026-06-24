import React, { useEffect, useState } from "react";
import { useStore } from "../stores/main-store.js";

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

  const refresh = async () => {
    const list = (await (window as unknown as { screenlink: { listGroups: () => Promise<unknown[]> } }).screenlink.listGroups()) as GroupRecord[];
    setGroups(list);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async () => {
    setError(null);
    try {
      const result = (await (window as unknown as { screenlink: { createGroup: (i: { groupName: string }) => Promise<{ invite: unknown; link?: string }> } }).screenlink.createGroup({ groupName: newName.trim() || "Group" })) as { invite: unknown; link?: string };
      setInviteLink(result.link ?? null);
      setNewName("");
      setCreating(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const onJoin = async () => {
    setError(null);
    try {
      await (window as unknown as { screenlink: { joinGroup: (i: { link: string }) => Promise<unknown> } }).screenlink.joinGroup({ link: joinLink.trim() });
      setJoinLink("");
      setJoining(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const onCopyInvite = async (groupId: string) => {
    try {
      const result = (await (window as unknown as { screenlink: { getGroupInvite: (id: string) => Promise<{ link: string } | null> } }).screenlink.getGroupInvite(groupId)) as { link: string } | null;
      if (result?.link) {
        await navigator.clipboard.writeText(result.link);
        setInviteLink(result.link);
      }
    } catch (e) {
      setError(String(e));
    }
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
        <div className="dialog">
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
        <div className="dialog">
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
        <div className="dialog">
          <h2>Group Created</h2>
          <p>Copy this link and share it with anyone you want to invite.</p>
          <textarea readOnly value={inviteLink} rows={3} />
          <div className="actions">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(inviteLink);
              }}
            >
              Copy Group Link
            </button>
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
            const members = Object.values(g.sharedState?.members ?? {});
            const onlineCount = 0; // tracked separately by GroupConnectionManager in renderer
            const knownCount = members.length;
            return (
              <div
                key={g.groupId}
                className={`group-card ${selectedGroupId === g.groupId ? "selected" : ""}`}
                onClick={() => setSelectedGroupId(g.groupId)}
              >
                <h3>{g.sharedState?.name?.value ?? "(unnamed)"}</h3>
                <p>
                  {onlineCount} online · {knownCount} known user{knownCount === 1 ? "" : "s"}
                </p>
                <div className="actions">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onCopyInvite(g.groupId);
                    }}
                  >
                    Copy Group Link
                  </button>
                  <button disabled>Group Settings</button>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      await (window as unknown as { screenlink: { leaveGroup: (id: string) => Promise<void> } }).screenlink.leaveGroup(g.groupId);
                      await refresh();
                    }}
                  >
                    Leave Group
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
