import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { useStore } from "@/stores/main-store";
import { joinGroupAction } from "@/services/group-actions";

/**
 * JoinGroupDialog — Shared dialog for joining a group via invite link.
 *
 * Uses the real joinGroup preload API. On success:
 * - Updates the store immediately
 * - Selects the joined group
 * - Navigates to the group overview
 * - Closes the dialog
 * - Shows success toast
 *
 * Can be opened from HomePage and GroupRail via the shared
 * openJoinGroupDialog store flag.
 */
export function JoinGroupDialog() {
  const open = useStore((s) => s.openJoinGroupDialog);
  const setOpen = useStore((s) => s.setOpenJoinGroupDialog);

  const [inviteLink, setInviteLink] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = useCallback(async () => {
    const trimmed = inviteLink.trim();
    if (!trimmed || joining) return;

    setJoining(true);
    setError(null);

    try {
      await joinGroupAction(trimmed);
      toast.success("Joined group");
      setOpen(false);
      setInviteLink("");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to join group";
      setError(message);
    } finally {
      setJoining(false);
    }
  }, [inviteLink, joining, setOpen]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setOpen(open);
      if (!open) {
        setInviteLink("");
        setError(null);
      }
    },
    [setOpen],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !joining && inviteLink.trim()) {
        e.preventDefault();
        void handleJoin();
      }
    },
    [handleJoin, joining, inviteLink],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Join group</DialogTitle>
          <DialogDescription>
            Paste an invite link to join an existing group.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="join-invite-link">Invite link</Label>
            <Input
              id="join-invite-link"
              value={inviteLink}
              onChange={(e) => setInviteLink(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="https://screenlink.app/invite/…"
              disabled={joining}
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={joining}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="default"
            disabled={!inviteLink.trim() || joining}
            onClick={handleJoin}
          >
            {joining ? "Joining…" : "Join group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
