import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import {
  Plus,
  UserPlus,
  Copy,
  Settings,
  LogOut,
  Users,
  Folder,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useStore } from "@/stores/main-store";
import { getInitials } from "@/lib/utils";
import { MembersList } from "./MembersList.js";
import { copyGroupInviteFromUi } from "@/services/invite-copy";
import { joinGroupAction } from "@/services/group-actions";

/**
 * GroupsWorkspace — Watermelon-only groups management page (replaces legacy routes/Groups.tsx).
 *
 * Two modes:
 *   - When a group is selected: shows the group's members (MembersList)
 *   - When no group is selected: shows the group list with create/join actions
 *
 * Composed from Watermelon: Card, Button, Input, Label, Dialog, Avatar, Badge,
 * DropdownMenu, ScrollArea, Separator.
 */
export function GroupsWorkspace() {
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const groupsById = useStore((s) => s.groupsById);
  const groupOrder = useStore((s) => s.groupOrder);
  const activeStreamsByGroup = useStore((s) => s.activeStreamsByGroup);
  const setSelectedGroupId = useStore((s) => s.setSelectedGroupId);

  // Create/join dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [joinLink, setJoinLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  const groups = groupOrder
    .map((id) => groupsById[id])
    .filter((g): g is NonNullable<typeof g> => g !== undefined);

  const handleCreate = useCallback(async () => {
    setError(null);
    try {
      const api = (
        window as unknown as { screenlink?: import("../../../preload/api-types.js").ScreenLinkAPI }
      ).screenlink;
      if (!api) {
        toast.error("API not available");
        return;
      }
      // createGroupAction calls api.createGroup, attaches the record to
      // the runtime, updates the store, AND calls store.selectGroup()
      // which navigates to the freshly-created group's overview page.
      // We need the invite link to copy to the clipboard, so call the
      // IPC directly first and then attach the resulting record.
      const trimmed = newName.trim() || "Group";
      const result = (await api.createGroup({
        groupName: trimmed,
      })) as {
        record?: Parameters<typeof import("@/services/group-record-helper").attachGroupRecordToRuntime>[0];
        invite?: unknown;
        link?: string;
      };
      if (result.link) {
        await api.clipboardWriteText(result.link);
        toast("Group created! Invite link copied");
      } else {
        toast("Group created");
      }
      if (result.record) {
        const { attachGroupRecordToRuntime } = await import(
          "@/services/group-record-helper"
        );
        await attachGroupRecordToRuntime(result.record);
      }
      setNewName("");
      setCreateOpen(false);
    } catch (e) {
      setError(String(e));
      toast.error(String(e));
    }
  }, [newName]);

  const handleJoin = useCallback(async () => {
    setError(null);
    try {
      const api = (
        window as unknown as { screenlink?: import("../../../preload/api-types.js").ScreenLinkAPI }
      ).screenlink;
      if (!api) {
        toast.error("API not available");
        return;
      }
      // joinGroupAction attaches the record to the runtime, updates the
      // store, and navigates to the joined group's overview.
      await joinGroupAction(joinLink.trim());
      setJoinLink("");
      setJoinOpen(false);
      toast("Joined group");
    } catch (e) {
      setError(String(e));
      toast.error(String(e));
    }
  }, [joinLink]);

  const handleCopyInviteLink = useCallback(async (groupId: string) => {
    await copyGroupInviteFromUi(groupId, "Invite link copied");
  }, []);

  const handleLeaveGroup = useCallback(
    async (groupId: string) => {
      try {
        const api = (
          window as unknown as { screenlink?: import("../../../preload/api-types.js").ScreenLinkAPI }
        ).screenlink;
        if (api) {
          await api.leaveGroup(groupId);
        }
        // Remove from store
        const store = useStore.getState();
        const newGroupsById = { ...store.groupsById };
        delete newGroupsById[groupId];
        store.setGroups(
          newGroupsById,
          store.groupOrder.filter((id) => id !== groupId),
        );
        if (store.selectedGroupId === groupId) {
          store.setSelectedGroupId(null);
        }
        toast("Left group");
      } catch (e) {
        toast.error(String(e));
      }
    },
    [],
  );

  // ── If a group is selected, show its members ─────────────────────
  if (selectedGroupId) {
    return (
      <div className="h-full overflow-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedGroupId(null)}
            >
              &larr; All groups
            </Button>
            <h1 className="text-xl font-semibold text-text-primary">
              {groupsById[selectedGroupId]?.name ?? "Group"}
            </h1>
          </div>
        </div>
        <MembersList groupId={selectedGroupId} />
      </div>
    );
  }

  // ── No group selected: show group list with create/join ──────────
  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Groups</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Create group
          </Button>
          <Button variant="outline" onClick={() => setJoinOpen(true)}>
            <UserPlus className="h-4 w-4" />
            Join group
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-danger bg-danger-muted p-3 rounded-compact">
          {error}
        </div>
      )}

      {/* Group list */}
      {groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center text-center py-12 gap-3">
            <div className="h-12 w-12 rounded-dialog bg-surface-3 flex items-center justify-center">
              <Folder className="h-6 w-6 text-text-muted" />
            </div>
            <div>
              <h2 className="text-base font-medium text-text-primary">
                No groups yet
              </h2>
              <p className="text-sm text-text-secondary mt-1">
                Create your first group to start sharing with others.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create your first group
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout">
            {groups.map((g) => {
              const memberCount = Object.keys(g.members).length;
              const activeShares = (activeStreamsByGroup[g.id] ?? []).length;
              return (
                <motion.div
                  key={g.id}
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                >
                  <Card className="h-full flex flex-col">
                    <CardContent className="p-5 flex-1">
                      <div className="flex items-start gap-3">
                        <Avatar className="h-10 w-10 rounded-lg flex-shrink-0">
                          <AvatarFallback className="rounded-lg bg-surface-3 text-xs font-semibold">
                            {getInitials(g.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text-primary truncate">
                              {g.name || "(unnamed)"}
                            </span>
                            {activeShares > 0 && (
                              <Badge
                                variant="success"
                                className="text-[10px] px-1.5 py-0"
                              >
                                {activeShares}{" "}
                                {activeShares === 1 ? "share" : "shares"}
                              </Badge>
                            )}
                          </div>
                          <span className="block text-xs text-text-muted mt-0.5">
                            <Users className="h-3 w-3 inline mr-0.5" />
                            {memberCount}{" "}
                            {memberCount === 1 ? "member" : "members"}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                    <Separator />
                    <div className="flex items-center gap-1 p-2">
                      <Button
                        variant="default"
                        size="sm"
                        className="flex-1"
                        onClick={() => setSelectedGroupId(g.id)}
                      >
                        Select
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="px-2">
                            <Settings className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="bottom" align="end">
                          <DropdownMenuItem
                            onClick={() => setSelectedGroupId(g.id)}
                          >
                            <Settings className="h-4 w-4" />
                            Group settings
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleCopyInviteLink(g.id)}
                          >
                            <Copy className="h-4 w-4" />
                            Copy invite link
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-danger"
                            onClick={() => handleLeaveGroup(g.id)}
                          >
                            <LogOut className="h-4 w-4" />
                            Leave group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* ─── Create dialog ──────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create group</DialogTitle>
            <DialogDescription>
              Create a new group to share your screen with others.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-group-name">Group name</Label>
              <Input
                id="new-group-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My group"
                maxLength={100}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleCreate} disabled={!newName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Join dialog ────────────────────────────────────────── */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Join group</DialogTitle>
            <DialogDescription>
              Paste a group link or invite code to join an existing group.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="join-link">Invite link or code</Label>
              <Input
                id="join-link"
                value={joinLink}
                onChange={(e) => setJoinLink(e.target.value)}
                placeholder="Paste invite link or code"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleJoin} disabled={!joinLink.trim()}>
              Join
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
